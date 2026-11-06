import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probeEngine } from "../src/engines.ts";
import { startGateway } from "../src/gateway.ts";
import { RunLedger } from "../src/ledger.ts";
import { buildDeployment, commitDeployment, hardwareFromHost } from "../src/manifest.ts";
import { challengeFor } from "../src/publisher.ts";
import { verifyRunBody } from "../src/transcript.ts";
import { runSpecFromChallenge } from "../src/verifier.ts";
import type { DeploymentCommitment } from "../src/types.ts";

function startMockEngine() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model", owned_by: "mock" }] }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const last = [...(body.messages ?? [])].reverse().find((message: { role: string }) => message.role === "user");
      const text = `echo: ${String(last?.content ?? "")}`;

      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "echo: " } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: String(last?.content ?? "") } }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  return server;
}

async function setup() {
  const engine = startMockEngine();
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const enginePort = (engine.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${enginePort}`;

  const probe = await probeEngine({ endpoint, engine: "openai-compatible", model: "test-model" });
  const deployment: DeploymentCommitment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromHost("cpu", "test host"),
      createdAt: "2026-11-06T00:00:00.000Z",
    }),
  );

  const dir = mkdtempSync(join(tmpdir(), "rarext-runtime-gateway-"));
  const gateway = await startGateway({ deployment, ledgerDir: dir, port: 0 });
  return { engine, gateway, deployment, dir, endpoint };
}

async function teardown(context: Awaited<ReturnType<typeof setup>>) {
  await context.gateway.close();
  await new Promise<void>((resolve) => context.engine.close(() => resolve()));
  rmSync(context.dir, { recursive: true, force: true });
}

async function waitForRecords(dir: string, count: number): Promise<RunLedger> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ledger = new RunLedger(dir);
    if (ledger.records().length >= count) return ledger;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return new RunLedger(dir);
}

test("the gateway forwards inference and records an exact transcript", async () => {
  const context = await setup();
  try {
    const response = await fetch(`${context.gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0,
        seed: 7,
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.choices[0].message.content, "echo: hello");
    assert.equal(response.headers.get("x-rarext-deployment"), context.deployment.digest);

    const runDigest = response.headers.get("x-rarext-run");
    assert.match(String(runDigest), /^[0-9a-f]{64}$/);

    const ledger = new RunLedger(context.dir);
    const record = ledger.latest();
    assert.equal(record?.digest, runDigest);
    assert.equal(record?.body.response.text, "echo: hello");
    assert.equal(record?.body.sampling.seed, 7);

    const verification = verifyRunBody(record?.body, runSpecFromChallenge(challengeFor(context.deployment)));
    assert.equal(verification.correct, true);
    assert.equal(ledger.verify().ok, true);

    const health = await (await fetch(`${context.gateway.url}/health`)).json();
    assert.equal(health.ledger.runs, 1);

    const runs = await (await fetch(`${context.gateway.url}/v1/rarext/runs`)).json();
    assert.equal(runs.count, 1);
    assert.equal(runs.records[0].text, "echo: hello");
  } finally {
    await teardown(context);
  }
});

test("the Anthropic Messages surface translates both ways and still records", async () => {
  const context = await setup();
  try {
    const response = await fetch(`${context.gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.type, "message");
    assert.equal(body.content[0].text, "echo: hi");
    assert.equal(response.headers.get("x-rarext-attested"), null); // no publisher configured

    const record = new RunLedger(context.dir).latest();
    assert.equal(record?.body.response.text, "echo: hi");
    // The transcript stores the upstream OpenAI exchange, which is what a
    // replay sends and what the verifier hashes. Anthropic sampling has no seed
    // here, so the run is hashed but not replayable — an honest null.
    assert.equal((record?.body.request.body as { model?: string }).model, "test-model");
    assert.equal(record?.body.replay, null);
  } finally {
    await teardown(context);
  }
});

test("OpenAI streaming is teed to the client and recorded as an SSE transcript", async () => {
  const context = await setup();
  try {
    const response = await fetch(`${context.gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "streamed" }],
        temperature: 0,
        seed: 9,
        stream: true,
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /echo: /);
    assert.match(text, /\[DONE\]/);

    const record = (await waitForRecords(context.dir, 1)).latest();
    assert.equal((record?.body.response.body as { kind?: string }).kind, "sse");
    assert.equal(record?.body.response.text, "echo: streamed");
  } finally {
    await teardown(context);
  }
});

test("the gateway refuses a model its deployment did not commit", async () => {
  const context = await setup();
  try {
    const response = await fetch(`${context.gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "some-other-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /will not serve/);
    assert.equal(new RunLedger(context.dir).records().length, 0);
  } finally {
    await teardown(context);
  }
});

test("an Anthropic stream is refused before any inference happens", async () => {
  const context = await setup();
  try {
    const response = await fetch(`${context.gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /stream:false/);
  } finally {
    await teardown(context);
  }
});
