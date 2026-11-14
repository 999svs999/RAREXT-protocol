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

    if (request.method === "POST" && url.pathname === "/v1/embeddings") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      response.writeHead(200, {
        "content-type": "application/json",
        "x-rarext-receipt": "mock-receipt",
      });
      response.end(
        JSON.stringify({
          object: "list",
          data: inputs.map((input: unknown, index: number) => ({
            object: "embedding",
            index,
            // Deterministic in the input, so a repeat request is identical.
            embedding: Array.from({ length: 4 }, (_, j) => ((String(input).length + j) % 11) / 11),
          })),
          model: body.model,
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const last = [...(body.messages ?? [])].reverse().find((message: { role: string }) => message.role === "user");
      const text = `echo: ${String(last?.content ?? "")}`;
      const tools = Array.isArray(body.tools) ? body.tools : [];
      // Honour tool_choice: a pinned function calls that function, "none" never
      // calls one, and "auto"/"required" call the first declared tool.
      const pinned =
        body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.function
          ? body.tool_choice.function.name
          : undefined;
      const choiceName =
        typeof pinned === "string"
          ? pinned
          : body.tool_choice === "none"
            ? null
            : tools.length > 0
              ? (tools[0]?.function?.name ?? null)
              : null;

      if (tools.length > 0 && typeof choiceName === "string") {
        const name = choiceName;
        const args = '{"city":"Paris"}';
        // A prompt that says "two" makes the mock emit two tool calls, so the
        // parallel-tool-use limit has something to limit.
        const wantTwo = String(last?.content ?? "").includes("two");
        const toolCalls = wantTwo
          ? [
              { index: 0, id: "call_mock", type: "function", function: { name, arguments: args } },
              {
                index: 1,
                id: "call_mock_2",
                type: "function",
                function: { name: tools[1]?.function?.name ?? name, arguments: '{"zone":"UTC"}' },
              },
            ]
          : [{ index: 0, id: "call_mock", type: "function", function: { name, arguments: args } }];
        if (body.stream === true) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { tool_calls: toolCalls } }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              rarext_trace: { kind: "rarext.decode-trace.v1", tokens: [9, 9], digest: "mock" },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "chatcmpl-tool",
            object: "chat.completion",
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: toolCalls.map((call) => ({
                    id: call.id,
                    type: call.type,
                    function: call.function,
                  })),
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        );
        return;
      }

      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "echo: " } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: String(last?.content ?? "") } }] })}\n\n`,
        );
        // A real engine's final chunk also carries the decode trace; the mock
        // emits one so the gateway's translation of it is exercised.
        response.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            rarext_trace: { kind: "rarext.decode-trace.v1", tokens: [2, 3], digest: "mock" },
          })}\n\n`,
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
          // Echo the response_format so a test can prove the gateway forwards it.
          ...(body.response_format === undefined ? {} : { received_response_format: body.response_format }),
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

test("an Anthropic tool call streams as a tool_use block and reconstructs", async () => {
  const context = await setup();
  try {
    const tools = [
      {
        name: "get_weather",
        description: "weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ];
    const messages = [{ role: "user", content: "weather in Paris?" }];
    type AnthropicBlock = { type: string; id?: string; name?: string; input?: unknown; text?: string };

    // Non-streaming: the OpenAI tool call becomes an Anthropic tool_use block.
    const plain = (await (
      await fetch(`${context.gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", max_tokens: 64, tools, messages }),
      })
    ).json()) as { stop_reason: string; content: AnthropicBlock[] };
    assert.equal(plain.stop_reason, "tool_use");
    const tool = plain.content.find((block) => block.type === "tool_use");
    assert.ok(tool !== undefined, "the message carries a tool_use block");
    assert.equal(tool!.id, "call_mock");
    assert.equal(tool!.name, "get_weather");
    assert.deepEqual(tool!.input, { city: "Paris" });

    // Streaming: the tool call arrives as a tool_use content block.
    const streamAnthropic = async () => {
      const response = await fetch(`${context.gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", max_tokens: 64, tools, messages, stream: true }),
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      return raw
        .split("\n\n")
        .filter((frame) => frame.trim() !== "")
        .map((frame) => ({
          name: /^event: (.*)$/m.exec(frame)![1]!,
          data: JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as Record<string, unknown>,
        }));
    };

    const events = await streamAnthropic();
    assert.deepEqual(
      events.map((event) => event.name),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
      "a tool call has no text block: start, one input_json_delta, stop",
    );
    const start = events[1]!.data.content_block as { type: string; id: string; name: string; input: unknown };
    assert.equal(start.type, "tool_use");
    assert.equal(start.id, tool!.id);
    assert.equal(start.name, tool!.name);
    assert.deepEqual(start.input, {});
    const delta = events[2]!.data.delta as { type: string; partial_json: string };
    assert.equal(delta.type, "input_json_delta");
    const messageDelta = events[4]!.data as { delta: { stop_reason: string } };
    assert.equal(messageDelta.delta.stop_reason, "tool_use");

    // The streamed block reconstructs the non-streaming tool call exactly.
    assert.deepEqual(JSON.parse(delta.partial_json), tool!.input);

    // Reproducible (ignoring the per-run message id), and recorded.
    const again = await streamAnthropic();
    assert.deepEqual(again.map((event) => event.name), events.map((event) => event.name));
    assert.equal(
      (again[2]!.data.delta as { partial_json: string }).partial_json,
      delta.partial_json,
    );
    assert.equal((again[4]!.data as { delta: { stop_reason: string } }).delta.stop_reason, "tool_use");
    const ledger = await waitForRecords(context.dir, 2);
    assert.ok(
      ledger.records().some((record) => {
        const body = record.body.response.body as {
          choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
        } | null;
        return (body?.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0;
      }),
      "the recorded stream carries the tool call",
    );
  } finally {
    await teardown(context);
  }
});

test("Anthropic tool_choice is translated to the OpenAI shape and honoured", async () => {
  const context = await setup();
  try {
    const tools = [
      { name: "get_weather", description: "weather", input_schema: { type: "object" } },
      { name: "get_time", description: "time", input_schema: { type: "object" } },
    ];
    const messages = [{ role: "user", content: "hi" }];
    type Block = { type: string; name?: string };
    const call = (toolChoice: unknown) =>
      fetch(`${context.gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          max_tokens: 64,
          tools,
          messages,
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        }),
      });
    const toolName = async (toolChoice: unknown): Promise<string | null> => {
      const response = await call(toolChoice);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { content: Block[] };
      return body.content.find((block) => block.type === "tool_use")?.name ?? null;
    };

    // `auto` and `any` (-> required) call a declared tool; a pinned tool is used.
    assert.equal(await toolName({ type: "auto" }), "get_weather");
    assert.equal(await toolName({ type: "any" }), "get_weather");
    assert.equal(await toolName({ type: "tool", name: "get_time" }), "get_time");
    assert.equal(await toolName(undefined), "get_weather");

    // A translated tool_choice reaches the upstream: the recorded request body
    // carries the OpenAI shape, not the Anthropic one.
    const ledger = await waitForRecords(context.dir, 4);
    const choices = ledger
      .records()
      .map((record) => (record.body.request.body as { tool_choice?: unknown }).tool_choice);
    assert.ok(choices.includes("auto"), "auto -> auto");
    assert.ok(choices.includes("required"), "any -> required");
    assert.ok(
      choices.some(
        (value) => JSON.stringify(value) === JSON.stringify({ type: "function", function: { name: "get_time" } }),
      ),
      "tool -> function",
    );

    // The OpenAI string form passes through, and `none` never calls a tool.
    const none = await call("none");
    assert.equal(none.status, 200);
    const noneBody = (await none.json()) as { content: Block[] };
    assert.equal(noneBody.content.some((block) => block.type === "tool_use"), false);
    const withNone = await waitForRecords(context.dir, 5);
    assert.ok(
      withNone.records().some((record) => (record.body.request.body as { tool_choice?: unknown }).tool_choice === "none"),
    );

    // An undeclared tool is refused before any inference, like Anthropic does.
    const refused = await call({ type: "tool", name: "missing_tool" });
    assert.equal(refused.status, 400);
    assert.match(
      ((await refused.json()) as { error: { message: string } }).error.message,
      /not a declared tool/,
    );
  } finally {
    await teardown(context);
  }
});

test("the gateway forwards embeddings and passes response_format through", async () => {
  const context = await setup();
  try {
    const embed = async (input: unknown) => {
      const response = await fetch(`${context.gateway.url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", input }),
      });
      return response;
    };

    const response = await embed(["hi", "there"]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-rarext-deployment"), context.deployment.digest);
    const body = (await response.json()) as {
      object: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    assert.equal(body.object, "list");
    assert.equal(body.model, "test-model");
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.data.map((entry) => entry.index), [0, 1]);
    assert.ok(
      body.data.every(
        (entry) =>
          entry.object === "embedding" &&
          entry.embedding.length === 4 &&
          entry.embedding.every((value) => typeof value === "number" && Number.isFinite(value)),
      ),
      "every embedding is a finite float vector",
    );
    assert.equal(body.usage.prompt_tokens, 2);

    // The provider's own receipt is passed through, so a caller can still
    // verify who produced the vectors.
    assert.equal(response.headers.get("x-rarext-receipt"), "mock-receipt");

    // Deterministic: the same input yields the same vectors.
    const again = (await (await embed(["hi", "there"])).json()) as typeof body;
    assert.deepEqual(again.data, body.data);

    // A model the deployment did not commit is refused before any forwarding.
    assert.equal((await embed("hi")).status, 200); // a bare string input is fine
    const wrong = await fetch(`${context.gateway.url}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "some-other-model", input: "hi" }),
    });
    assert.equal(wrong.status, 400);

    // response_format rides along on the chat surface the gateway forwards.
    const chat = (await (
      await fetch(`${context.gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          response_format: { type: "json_object" },
        }),
      })
    ).json()) as { received_response_format?: unknown };
    assert.deepEqual(chat.received_response_format, { type: "json_object" });
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

test("an Anthropic stream is translated per token and reconstructs the message", async () => {
  const context = await setup();
  try {
    const streamOnce = async () => {
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
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const raw = await response.text();
      return raw
        .split("\n\n")
        .filter((frame) => frame.trim() !== "")
        .map((frame) => {
          const name = /^event: (.*)$/m.exec(frame)![1]!;
          const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as Record<string, unknown>;
          return { name, data };
        });
    };
    const deltaText = (events: Awaited<ReturnType<typeof streamOnce>>): string =>
      events
        .filter((event) => event.name === "content_block_delta")
        .map((event) => (event.data as { delta: { text: string } }).delta.text)
        .join("");

    const events = await streamOnce();
    assert.deepEqual(
      events.map((event) => event.name),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
      "the Anthropic event sequence is complete and ordered",
    );
    const start = events[0]!.data as { message: { role: string; content: unknown[]; stop_reason: unknown } };
    assert.equal(start.message.role, "assistant");
    assert.deepEqual(start.message.content, []);
    assert.equal(start.message.stop_reason, null);
    const deltas = events.filter((event) => event.name === "content_block_delta");
    assert.equal(deltas.length, 2, "one content_block_delta per engine token delta");
    assert.ok(
      deltas.every((event) => (event.data as { delta: { type: string } }).delta.type === "text_delta"),
    );
    const text = deltaText(events);
    const messageDelta = events.at(-2)!.data as {
      delta: { stop_reason: string; stop_sequence: unknown };
      usage: { output_tokens: number };
    };
    assert.equal(messageDelta.delta.stop_reason, "end_turn");
    assert.equal(messageDelta.delta.stop_sequence, null);
    assert.ok(messageDelta.usage.output_tokens > 0);

    // The stream reconstructs the non-streaming message exactly.
    const plain = (await (
      await fetch(`${context.gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
      })
    ).json()) as { content: Array<{ text: string }>; stop_reason: string };
    assert.equal(plain.content[0]!.text, text);
    assert.equal(plain.stop_reason, "end_turn");

    // Reproducible, and recorded as a run like any other answer.
    const again = await streamOnce();
    assert.equal(deltaText(again), text);
    const ledger = await waitForRecords(context.dir, 2);
    assert.ok(
      ledger.records().some((record) => record.body.response.text === text),
      "the streamed answer is in the ledger",
    );
    // The stream's decode trace is carried into the recorded run, so a streamed
    // answer is replayable, not just readable.
    assert.ok(
      ledger
        .records()
        .some((record) => {
          const body = record.body.response.body as { rarext_trace?: { kind?: string } } | null;
          return body?.rarext_trace?.kind === "rarext.decode-trace.v1";
        }),
      "the recorded stream carries the decode trace",
    );
  } finally {
    await teardown(context);
  }
});

test("Anthropic parallel tool use is off for a named tool or when asked", async () => {
  const context = await setup();
  try {
    const tools = [
      { name: "get_weather", description: "weather", input_schema: { type: "object" } },
      { name: "get_time", description: "time", input_schema: { type: "object" } },
    ];
    type Block = { type: string; name?: string };
    // "two" makes the mock emit two tool calls, so the limit has an effect.
    const messages = [{ role: "user", content: "two tools please" }];
    const call = (toolChoice: unknown, stream = false) =>
      fetch(`${context.gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          max_tokens: 64,
          tools,
          messages,
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
          ...(stream ? { stream: true } : {}),
        }),
      });
    const blocks = async (toolChoice: unknown): Promise<Block[]> => {
      const response = await call(toolChoice);
      assert.equal(response.status, 200);
      return ((await response.json()) as { content: Block[] }).content.filter((block) => block.type === "tool_use");
    };

    // Parallel tool use allowed: both calls come back.
    assert.equal((await blocks({ type: "auto" })).length, 2);

    // `disable_parallel_tool_use` limits the answer to one tool_use block.
    const limited = await blocks({ type: "any", disable_parallel_tool_use: true });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]!.name, "get_weather");

    // A named tool is a single call, and it is the named one.
    const named = await blocks({ type: "tool", name: "get_time" });
    assert.equal(named.length, 1);
    assert.equal(named[0]!.name, "get_time");

    // `{type:"none"}` never calls a tool at all.
    const none = await call({ type: "none" });
    const noneBody = (await none.json()) as { content: Block[] };
    assert.equal(noneBody.content.some((block) => block.type === "tool_use"), false);
    const withNone = await waitForRecords(context.dir, 4);
    assert.ok(
      withNone.records().some((record) => (record.body.request.body as { tool_choice?: unknown }).tool_choice === "none"),
      "none reached the upstream as none",
    );

    // The stream is limited too: exactly one tool_use block, stop_reason tool_use.
    const streamed = await call({ type: "any", disable_parallel_tool_use: true }, true);
    const raw = await streamed.text();
    const events = raw
      .split("\n\n")
      .filter((frame) => frame.trim() !== "")
      .map((frame) => ({
        name: /^event: (.*)$/m.exec(frame)![1]!,
        data: JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as Record<string, unknown>,
      }));
    const starts = events.filter((event) => event.name === "content_block_start");
    assert.equal(starts.length, 1, "one content block in the stream");
    const block = starts[0]!.data.content_block as Block;
    assert.equal(block.type, "tool_use");
    assert.equal(block.name, "get_weather");
    assert.equal((events.at(-2)!.data as { delta: { stop_reason: string } }).delta.stop_reason, "tool_use");
    assert.equal(
      events.filter((event) => event.name === "content_block_stop").length,
      1,
      "exactly one block closed",
    );
  } finally {
    await teardown(context);
  }
});

test("the Anthropic surface refuses a multimodal block by name", async () => {
  const context = await setup();
  try {
    const call = (content: unknown, system?: unknown) =>
      fetch(`${context.gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          max_tokens: 32,
          messages: [{ role: "user", content }],
          ...(system === undefined ? {} : { system }),
        }),
      });

    const image = await call([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    assert.equal(image.status, 400);
    const imageBody = (await image.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(imageBody.type, "error");
    assert.equal(imageBody.error.type, "invalid_request_error");
    assert.match(imageBody.error.message, /image content parts are not supported/);
    assert.match(imageBody.error.message, /no vision or audio tower/);

    const document = await call([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }]);
    assert.equal(document.status, 400);
    assert.match(((await document.json()) as { error: { message: string } }).error.message, /document/);

    // A system prompt carrying a block is checked too.
    const system = await call([{ type: "text", text: "hi" }], [{ type: "image", source: {} }]);
    assert.equal(system.status, 400);
    assert.match(((await system.json()) as { error: { message: string } }).error.message, /content in system/);

    // None of the refusals reached the engine, so nothing was recorded.
    assert.equal(new RunLedger(context.dir).records().length, 0, "a refused request records no run");

    // A text-only block list still works and records.
    const text = await call([{ type: "text", text: "hi" }]);
    assert.equal(text.status, 200);
    const body = (await text.json()) as { content: Array<{ type: string; text: string }> };
    assert.equal(body.content[0]!.text, "echo: hi");
    await waitForRecords(context.dir, 1);
  } finally {
    await teardown(context);
  }
});
