import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { upstreamHeaders, upstreamShapeFromLabels } from "../src/cloud.ts";
import { probeEngine, probeEngineCatalog } from "../src/engines.ts";
import { startGateway } from "../src/gateway.ts";
import { RunLedger } from "../src/ledger.ts";
import {
  buildDeployment,
  commitDeployment,
  hardwareFromCloud,
  hardwareFromHost,
  isLoopbackEndpoint,
  validateDeployment,
} from "../src/manifest.ts";
import { challengeFor } from "../src/publisher.ts";
import { verifyDeploymentBody, verifyRunBody } from "../src/transcript.ts";
import { runSpecFromChallenge } from "../src/verifier.ts";
import type { DeploymentCommitment, EngineProbe } from "../src/types.ts";

const remoteProbe: EngineProbe = {
  engine: { name: "openai-compatible", version: "2026-11", endpoint: "https://api.example.com" },
  model: {
    id: "cloud-model",
    family: "cloud",
    parameters: null,
    quantization: "FP8",
    format: null,
    sizeBytes: null,
    weightsDigest: null,
    contextLength: null,
  },
  apis: ["openai", "anthropic"],
  models: [],
};

test("a cloud deployment records remote placement and no local memory", () => {
  assert.equal(isLoopbackEndpoint("http://127.0.0.1:8080"), true);
  assert.equal(isLoopbackEndpoint("http://localhost:8080"), true);
  assert.equal(isLoopbackEndpoint("https://api.example.com"), false);

  const hardware = hardwareFromCloud("https://api.example.com/v1");
  assert.equal(hardware.backend, "cloud");
  assert.equal(hardware.memoryBytes, null);
  assert.equal(hardware.device, "api.example.com");

  const deployment = commitDeployment(
    buildDeployment({
      probe: remoteProbe,
      hardware,
      placement: "remote",
      createdAt: "2026-11-07T00:00:00.000Z",
    }),
  );
  const verdict = verifyDeploymentBody(deployment, runSpecFromChallenge(challengeFor(deployment)));
  assert.equal(verdict.correct, true);
  assert.ok(verdict.details.checks.includes("placement.remote"));
});

test("a manifest cannot claim remote placement while recording local memory", () => {
  const manifest = buildDeployment({
    probe: remoteProbe,
    hardware: hardwareFromHost("cpu", "this host"),
    placement: "remote",
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  const errors = validateDeployment(manifest);
  assert.match(errors.join("\n"), /hardware\.backend must be "cloud"/);
  assert.match(errors.join("\n"), /memoryBytes must be null/);
});

test("a remote card cannot point at loopback unless it is marked a fixture", () => {
  const probe: EngineProbe = {
    ...remoteProbe,
    engine: { ...remoteProbe.engine, endpoint: "http://127.0.0.1:1234" },
  };
  const at = (labels?: Record<string, string>) =>
    commitDeployment(
      buildDeployment({
        probe,
        hardware: hardwareFromCloud("http://127.0.0.1:1234"),
        placement: "remote",
        ...(labels === undefined ? {} : { labels }),
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

  const unmarked = at();
  const rejected = verifyDeploymentBody(unmarked, runSpecFromChallenge(challengeFor(unmarked)));
  assert.equal(rejected.correct, false);
  const failures = (rejected.proof as { failures?: string[] } | null)?.failures ?? [];
  assert.ok(failures.includes("placement.fixture"));

  const marked = at({ execution: "cloud", fixture: "loopback" });
  const accepted = verifyDeploymentBody(marked, runSpecFromChallenge(challengeFor(marked)));
  assert.equal(accepted.correct, true);
  assert.ok(accepted.details.checks.includes("placement.fixture"));
});

test("probing a remote endpoint forwards its auth and protocol headers", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: href, headers });
    if (href.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: "cloud-model", owned_by: "provider" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ version: "2026-11" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const headers = upstreamHeaders({ api: "openai", auth: "bearer", token: "secret" });
  const catalog = await probeEngineCatalog({
    endpoint: "https://api.example.com",
    engine: "openai-compatible",
    headers,
    fetchImpl,
  });

  assert.equal(catalog.engine.name, "openai-compatible");
  assert.equal(catalog.models[0]?.id, "cloud-model");
  assert.equal(calls[0]?.headers.authorization, "Bearer secret");

  const anthropicHeaders = upstreamHeaders({ api: "anthropic", auth: "x-api-key", token: "anthropic-key" });
  const anthropic = await probeEngineCatalog({
    endpoint: "https://anthropic.example.com",
    engine: "anthropic",
    headers: anthropicHeaders,
    fetchImpl,
  });
  assert.equal(anthropic.engine.name, "anthropic");
  assert.equal(anthropic.apis.includes("anthropic"), true);
  assert.equal(calls.at(-1)?.headers["x-api-key"], "anthropic-key");
  assert.equal(calls.at(-1)?.headers["anthropic-version"], "2023-06-01");
});

test("a remote deployment's labels carry the upstream shape that serve reuses", () => {
  assert.deepEqual(
    upstreamShapeFromLabels({ upstreamApi: "anthropic", upstreamAuth: "x-api-key" }, "openai-compatible"),
    { api: "anthropic", auth: "x-api-key" },
  );
  assert.deepEqual(
    upstreamShapeFromLabels({ upstreamApi: "openai", upstreamAuth: "bearer" }, "anthropic"),
    { api: "openai", auth: "bearer" },
  );
  assert.deepEqual(
    upstreamShapeFromLabels({ upstreamApi: "openai", upstreamAuth: "none" }, "openai-compatible"),
    { api: "openai", auth: "none" },
  );

  // Missing or malformed labels fall back to the engine's native shape, never
  // to an unauthenticated request by accident.
  assert.deepEqual(upstreamShapeFromLabels(undefined, "anthropic"), {
    api: "anthropic",
    auth: "x-api-key",
  });
  assert.deepEqual(
    upstreamShapeFromLabels({ upstreamApi: "gopher", upstreamAuth: "password" }, "openai-compatible"),
    { api: "openai", auth: "bearer" },
  );
});

async function startOpenAiCloud(requireToken: string) {
  const seenAuth: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    seenAuth.push(request.headers.authorization);

    if (request.headers.authorization !== `Bearer ${requireToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad key" }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "cloud-model", owned_by: "provider" }] }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const last = [...(body.messages ?? [])].reverse().find((message: { role: string }) => message.role === "user");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-cloud",
          object: "chat.completion",
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: `cloud: ${String(last?.content ?? "")}` }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        }),
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, endpoint: `http://127.0.0.1:${port}`, seenAuth };
}

test("a cloud gateway requires a client token, forwards the upstream key, and reports remote placement", async () => {
  const cloud = await startOpenAiCloud("upstream-secret");
  const dir = mkdtempSync(join(tmpdir(), "rarext-runtime-cloud-"));

  try {
    const upstream = upstreamHeaders({ api: "openai", auth: "bearer", token: "upstream-secret" });
    const probe = await probeEngine({
      endpoint: cloud.endpoint,
      engine: "openai-compatible",
      model: "cloud-model",
      headers: upstream,
    });
    const deployment: DeploymentCommitment = commitDeployment(
      buildDeployment({
        probe,
        hardware: hardwareFromCloud(cloud.endpoint),
        placement: "remote",
        labels: { execution: "cloud", fixture: "loopback" },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    const gateway = await startGateway({
      deployment,
      ledgerDir: dir,
      host: "0.0.0.0",
      port: 0,
      publicUrl: "https://ai.example.com",
      gatewayToken: "client-secret",
      upstreamHeaders: upstream,
      upstreamApi: "openai",
    });

    try {
      assert.equal(gateway.url, "https://ai.example.com");
      const local = `http://127.0.0.1:${gateway.port}`;

      const denied = await fetch(`${local}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cloud-model", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(denied.status, 401);

      const response = await fetch(`${local}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer client-secret",
        },
        body: JSON.stringify({
          model: "cloud-model",
          messages: [{ role: "user", content: "hi" }],
          temperature: 0,
          seed: 5,
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.choices[0].message.content, "cloud: hi");
      assert.equal(response.headers.get("x-rarext-placement"), "remote");

      // The gateway sent the operator's key upstream, not the client's.
      assert.ok(cloud.seenAuth.includes("Bearer upstream-secret"));

      const record = new RunLedger(dir).latest();
      const spec = runSpecFromChallenge(challengeFor(deployment));
      assert.equal(verifyRunBody(record?.body, spec).correct, true);
      assert.equal((record?.body.request.body as { model?: string }).model, "cloud-model");

      const health = await (await fetch(`${local}/health`)).json();
      assert.equal(health.placement, "remote");
      assert.equal(health.auth.gateway, true);
      assert.equal(health.auth.upstream, true);
    } finally {
      await gateway.close();
    }
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a native Anthropic upstream is forwarded as Messages and recorded as such", async () => {
  const seen: Array<{ path: string; key: string | undefined; version: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    seen.push({
      path: url.pathname,
      key: request.headers["x-api-key"] as string | undefined,
      version: request.headers["anthropic-version"] as string | undefined,
    });

    if (request.headers["x-api-key"] !== "anthropic-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "claude-cloud", type: "model", display_name: "Claude Cloud" }] }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const last = [...(body.messages ?? [])].reverse().find((message: { role: string }) => message.role === "user");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg_cloud",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: `anthropic-cloud: ${String(last?.content ?? "")}` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "rarext-runtime-anthropic-"));

  try {
    const headers = upstreamHeaders({ api: "anthropic", auth: "x-api-key", token: "anthropic-key" });
    const probe = await probeEngine({
      endpoint,
      engine: "anthropic",
      model: "claude-cloud",
      headers,
    });
    const deployment = commitDeployment(
      buildDeployment({
        probe,
        hardware: hardwareFromCloud(endpoint),
        placement: "remote",
        labels: { execution: "cloud", upstreamApi: "anthropic", upstreamAuth: "x-api-key", fixture: "loopback" },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    // Serve without repeating the deploy flags: the manifest labels carry the
    // upstream shape, and the key stays in the environment.
    const shape = upstreamShapeFromLabels(deployment.labels, deployment.engine.name);
    const gateway = await startGateway({
      deployment,
      ledgerDir: dir,
      port: 0,
      upstreamApi: shape.api,
      upstreamHeaders: upstreamHeaders({ ...shape, token: "anthropic-key" }),
    });

    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-cloud",
          max_tokens: 32,
          temperature: 0,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.content[0].text, "anthropic-cloud: hello");

      const record = new RunLedger(dir).latest();
      assert.equal(record?.body.api, "anthropic");
      assert.equal(
        verifyRunBody(record?.body, runSpecFromChallenge(challengeFor(deployment))).correct,
        true,
      );
      assert.ok(seen.some((entry) => entry.path === "/v1/messages" && entry.key === "anthropic-key"));
      assert.ok(seen.every((entry) => entry.version === "2023-06-01"));

      // An OpenAI-shaped client cannot silently reach an Anthropic-only engine.
      const openai = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-cloud", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(openai.status, 501);
    } finally {
      await gateway.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
