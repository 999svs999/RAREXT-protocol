import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLOUD_MODEL_KIND,
  buildCloudModelCard,
  cloudModelDigest,
  cloudModelFromDeployment,
  cloudProtocolFor,
  validateCloudModelCard,
  type CloudModelCard,
} from "../src/cloud-model.ts";
import {
  CLOUD_INFER_KIND,
  assembleNativeStream,
  nativeCloudUrl,
  openAiChunkFromNativeFrame,
  openAiCompletionFromNative,
  parseNativeStream,
  toNativeCloudRequest,
  type NativeCloudRequest,
  type NativeCloudResponse,
  type NativeCloudStreamFrame,
} from "../src/cloud-protocol.ts";
import { probeEngine } from "../src/engines.ts";
import { startGateway } from "../src/gateway.ts";
import { RunLedger } from "../src/ledger.ts";
import { buildDeployment, commitDeployment, hardwareFromCloud } from "../src/manifest.ts";
import { challengeFor } from "../src/publisher.ts";
import { verifyRunBody } from "../src/transcript.ts";
import { runSpecFromChallenge } from "../src/verifier.ts";
import type { DeploymentCommitment, EngineProbe } from "../src/types.ts";

test("a RAREXT cloud model is declared by capability, never by weights", () => {
  const card = buildCloudModelCard({
    id: "future-1",
    provider: "acme-cloud",
    protocol: "rarext-cloud",
    endpoint: "https://ai.example.com/v1",
    capabilities: { tools: true, parallel_tool_calls: true, context_length: 131072, input_modalities: ["text"] },
    createdAt: "2026-11-14T00:00:00.000Z",
  });

  assert.equal(card.kind, CLOUD_MODEL_KIND);
  assert.equal(card.endpoint, "https://ai.example.com", "the /v1 suffix is normalized away");
  assert.equal(card.capabilities.chat, true);
  assert.equal(card.capabilities.tools, true);
  assert.equal(card.capabilities.context_length, 131072);
  assert.deepEqual(validateCloudModelCard(card), []);
  assert.match(card.identity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(card.identity, cloudModelDigest(card));

  // Identity is content-addressed: a changed capability changes the digest.
  const other = buildCloudModelCard({
    id: "future-1",
    provider: "acme-cloud",
    protocol: "rarext-cloud",
    endpoint: "https://ai.example.com/v1",
    capabilities: { tools: true, parallel_tool_calls: true, context_length: 65536, input_modalities: ["text"] },
    createdAt: "2026-11-14T00:00:00.000Z",
  });
  assert.notEqual(other.identity, card.identity);

  // A tampered card fails its own identity check.
  const tampered = { ...card, capabilities: { ...card.capabilities, embeddings: true } };
  assert.match(validateCloudModelCard(tampered).join("\n"), /identity does not match/);
});

test("a cloud model refuses the vocabulary of a local weight file", () => {
  for (const field of ["architecture", "format", "quantization", "sizeBytes", "weightsDigest", "family", "parameters"]) {
    assert.throws(
      () =>
        buildCloudModelCard({
          id: "x",
          provider: "p",
          protocol: "rarext-cloud",
          endpoint: "https://e.example",
          [field]: "anything",
        }),
      new RegExp(`remove "${field}"`),
      `${field} must be refused by name`,
    );
    const errors = validateCloudModelCard({
      kind: CLOUD_MODEL_KIND,
      version: 1,
      id: "x",
      provider: "p",
      protocol: "rarext-cloud",
      endpoint: "https://e.example",
      [field]: "anything",
    });
    assert.match(errors.join("\n"), new RegExp(`cannot carry "${field}"`));
  }

  // An opaque provider commitment is allowed — RAREXT stores but never interprets it.
  const card = buildCloudModelCard({
    id: "x",
    provider: "p",
    protocol: "rarext-cloud",
    endpoint: "https://e.example",
    attestation: { scheme: "rarext.opaque.v1", digest: "whatever-the-provider-publishes" },
  });
  assert.deepEqual(card.attestation, { scheme: "rarext.opaque.v1", digest: "whatever-the-provider-publishes" });
  assert.deepEqual(validateCloudModelCard(card), []);
});

test("cloud protocol resolution prefers an explicit label, then the engine", () => {
  assert.equal(cloudProtocolFor("rarext-cloud"), "rarext-cloud");
  assert.equal(cloudProtocolFor("anthropic"), "anthropic");
  assert.equal(cloudProtocolFor("openai-compatible"), "openai");
  assert.equal(cloudProtocolFor("openai-compatible", { upstreamProtocol: "rarext-cloud" }), "rarext-cloud");
  assert.equal(cloudProtocolFor("rarext-cloud", { upstreamProtocol: "nonsense" }), "rarext-cloud");
});

test("the native wire round-trips requests and responses without weight vocabulary", () => {
  const request = toNativeCloudRequest({
    model: "future-1",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
    temperature: 0,
    top_p: 0.9,
    top_k: 40,
    max_tokens: 64,
    seed: 7,
    stop: ["</s>"],
    logprobs: true,
    top_logprobs: 3,
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    response_format: { type: "json_object" },
    stream: false,
    // Unknown fields are dropped, because the native wire is a closed contract.
    some_provider_extension: { weight_format: "gguf" },
  });
  assert.equal(request.kind, CLOUD_INFER_KIND);
  assert.equal(request.decode.temperature, 0);
  assert.equal(request.decode.top_k, 40);
  assert.equal(request.decode.max_tokens, 64);
  assert.deepEqual(request.decode.stop, ["</s>"]);
  assert.equal(request.decode.logprobs, true);
  assert.equal(request.tools.length, 1);
  assert.deepEqual(request.response_format, { type: "json_object" });
  assert.equal(JSON.stringify(request).includes("gguf"), false, "no weight vocabulary survived translation");

  const native: NativeCloudResponse = {
    kind: CLOUD_INFER_KIND,
    id: "cloud-1",
    model: "future-1",
    output: {
      text: "hello there",
      tool_calls: null,
      finish_reason: "stop",
      logprobs: [{ token: "hello", logprob: -0.2, top: [{ token: "hello", logprob: -0.2 }] }],
    },
    usage: { input_tokens: 4, output_tokens: 2 },
    attestation: { scheme: "rarext.opaque.v1", digest: "abc" },
  };
  const completion = openAiCompletionFromNative(native, "fallback") as {
    choices: Array<{ message: { content: string }; finish_reason: string; logprobs?: { content: unknown[] } }>;
    usage: { total_tokens: number };
    rarext_cloud_attestation?: unknown;
  };
  assert.equal(completion.choices[0]!.message.content, "hello there");
  assert.equal(completion.choices[0]!.finish_reason, "stop");
  assert.equal(completion.choices[0]!.logprobs?.content.length, 1);
  assert.equal(completion.usage.total_tokens, 6);
  assert.deepEqual(completion.rarext_cloud_attestation, { scheme: "rarext.opaque.v1", digest: "abc" });

  // A tool call becomes an OpenAI tool call, with content null.
  const toolNative: NativeCloudResponse = {
    ...native,
    output: { text: "", tool_calls: [{ id: "c1", name: "f", arguments: '{"x":1}' }], finish_reason: "tool_calls", logprobs: null },
  };
  const toolCompletion = openAiCompletionFromNative(toolNative, "future-1") as {
    choices: Array<{ message: { content: unknown; tool_calls?: Array<{ function: { name: string } }> }; finish_reason: string }>;
  };
  assert.equal(toolCompletion.choices[0]!.message.content, null);
  assert.equal(toolCompletion.choices[0]!.finish_reason, "tool_calls");
  assert.equal(toolCompletion.choices[0]!.message.tool_calls?.[0]!.function.name, "f");

  // Streaming frames translate, assemble, and parse back.
  const frames: NativeCloudStreamFrame[] = [
    { kind: CLOUD_INFER_KIND, id: "cloud-1", model: "future-1", delta: { text: "hel" }, finish_reason: null },
    { kind: CLOUD_INFER_KIND, id: "cloud-1", model: "future-1", delta: { text: "lo" }, finish_reason: null },
    { kind: CLOUD_INFER_KIND, id: "cloud-1", model: "future-1", delta: {}, finish_reason: "stop", usage: { input_tokens: 4, output_tokens: 2 } },
  ];
  const chunks = frames.map((frame, index) => openAiChunkFromNativeFrame(frame, index) as {
    choices: Array<{ delta: { content?: string; role?: string }; finish_reason: string | null }>;
  });
  assert.equal(chunks[0]!.choices[0]!.delta.role, "assistant");
  assert.deepEqual(
    chunks.map((chunk) => chunk.choices[0]!.delta.content ?? "").join(""),
    "hello",
  );
  assert.equal(chunks.at(-1)!.choices[0]!.finish_reason, "stop");
  const assembled = assembleNativeStream(frames, "future-1");
  assert.equal(assembled.output.text, "hello");
  assert.equal(assembled.output.finish_reason, "stop");
  assert.equal(assembled.usage.output_tokens, 2);
  const sse = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  assert.equal(parseNativeStream(sse).length, 3);
  assert.equal(nativeCloudUrl("https://ai.example.com/v1"), "https://ai.example.com/v1/rarext-cloud/infer");
});

/** A RAREXT-native cloud model: it speaks only `rarext.cloud-infer.v1`. */
function startNativeCloudModel(options: {
  id?: string;
  reply?: (request: NativeCloudRequest) => NativeCloudResponse;
  frames?: (request: NativeCloudRequest) => NativeCloudStreamFrame[];
}) {
  const id = options.id ?? "future-1";
  const seen: NativeCloudRequest[] = [];
  const lastUser = (request: NativeCloudRequest): string => {
    const messages = request.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === "user") return String(messages[i]!.content ?? "");
    }
    return request.prompt ?? "";
  };
  const defaultReply = (request: NativeCloudRequest): NativeCloudResponse => ({
    kind: CLOUD_INFER_KIND,
    id: "cloud-reply",
    model: request.model,
    output: {
      text: `native: ${lastUser(request)}`,
      tool_calls: null,
      finish_reason: "stop",
      logprobs: request.decode.logprobs
        ? [{ token: "native", logprob: -0.1, top: [{ token: "native", logprob: -0.1 }] }]
        : null,
    },
    usage: { input_tokens: 3, output_tokens: 2 },
    attestation: { scheme: "rarext.opaque.v1", digest: "native-fixture" },
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id, object: "model", owned_by: "rarext-cloud" }] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/rarext-cloud/infer") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const native = JSON.parse(raw || "{}") as NativeCloudRequest;
      seen.push(native);
      if (native.stream === true) {
        const frames =
          options.frames?.(native) ??
          (() => {
            const reply = (options.reply ?? defaultReply)(native);
            const words = reply.output.text.split(" ");
            const list: NativeCloudStreamFrame[] = words.map((word, index) => ({
              kind: CLOUD_INFER_KIND,
              id: reply.id,
              model: reply.model,
              delta: { text: index === 0 ? word : ` ${word}` },
              finish_reason: null,
            }));
            list.push({
              kind: CLOUD_INFER_KIND,
              id: reply.id,
              model: reply.model,
              delta: {},
              finish_reason: reply.output.finish_reason,
              usage: reply.usage,
            });
            return list;
          })();
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify((options.reply ?? defaultReply)(native)));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  return { server, seen, id };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

/** Refuse to call a directory full of weight-like files a "cloud only" run. */
function assertNoLocalWeights(dir: string): void {
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        assert.equal(
          /\.(gguf|rarext|safetensors|bin|pt|onnx)$/i.test(entry.name),
          false,
          `a cloud run wrote a weight file: ${child}`,
        );
        assert.ok(statSync(child).size < 1024 * 1024, `a cloud run wrote a large file: ${child}`);
      }
    }
  };
  walk(dir);
}

async function nativeDeployment(endpoint: string): Promise<DeploymentCommitment> {
  const probe: EngineProbe = await probeEngine({ endpoint, engine: "rarext-cloud", model: "future-1" });
  assert.deepEqual(probe.apis, ["openai"], "a RAREXT-native cloud model advertises only the surface it serves");
  return commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromCloud(endpoint),
      placement: "remote",
      labels: { execution: "cloud", upstreamProtocol: "rarext-cloud", fixture: "loopback" },
      createdAt: "2026-11-14T00:00:00.000Z",
    }),
  );
}

test("a RAREXT-native cloud model is served end to end with no local weights", async () => {
  const cloud = startNativeCloudModel({});
  const endpoint = await listen(cloud.server);
  const ledgerDir = mkdtempSync(join(tmpdir(), "rarext-native-cloud-"));
  try {
    const deployment = await nativeDeployment(endpoint);
    const gateway = await startGateway({ deployment, ledgerDir, port: 0 });

    try {
      // The deployment advertises the whole capability contract, weight-free.
      const info = (await (await fetch(`${gateway.url}/v1/deployment`)).json()) as {
        capabilities: { protocol: string };
        cloud_model: CloudModelCard;
      };
      assert.equal(info.capabilities.protocol, "rarext-cloud");
      assert.equal(info.cloud_model.kind, CLOUD_MODEL_KIND);
      assert.deepEqual(validateCloudModelCard(info.cloud_model), []);
      assert.equal(info.cloud_model.protocol, "rarext-cloud");
      assert.equal(
        JSON.stringify(info.cloud_model).match(/gguf|weightsDigest|architecture/),
        null,
        "the advertised card carries no weight vocabulary",
      );

      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "future-1",
          messages: [{ role: "user", content: "hello" }],
          temperature: 0,
          seed: 4,
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-rarext-placement"), "remote");
      assert.equal(response.headers.get("x-rarext-cloud"), "rarext-cloud");
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        rarext_cloud_attestation?: unknown;
      };
      assert.equal(body.choices[0]!.message.content, "native: hello");
      assert.deepEqual(body.rarext_cloud_attestation, { scheme: "rarext.opaque.v1", digest: "native-fixture" });

      // The gateway spoke the native wire, and only the native wire.
      assert.equal(cloud.seen.length, 1);
      const native = cloud.seen[0]!;
      assert.equal(native.kind, CLOUD_INFER_KIND);
      assert.equal(native.decode.seed, 4);
      assert.equal(native.decode.temperature, 0);

      // The run is recorded and verifies exactly like any other RAREXT run.
      const record = new RunLedger(ledgerDir).latest();
      assert.equal(
        verifyRunBody(record?.body, runSpecFromChallenge(challengeFor(deployment))).correct,
        true,
      );
      assert.equal((record?.body.request.body as { model?: string }).model, "future-1");

      // A streamed request translates native frames into OpenAI chunks.
      const stream = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "future-1", messages: [{ role: "user", content: "hi there" }], stream: true }),
      });
      assert.equal(stream.status, 200);
      const raw = await stream.text();
      assert.match(raw, /data: \[DONE\]/);
      const chunks = raw
        .split("\n\n")
        .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }> });
      assert.equal(
        chunks.map((chunk) => chunk.choices[0]!.delta.content ?? "").join(""),
        "native: hi there",
        "the native frames reassemble into the full answer",
      );
      assert.equal([...chunks].reverse().find((chunk) => chunk.choices[0]!.finish_reason !== null)!.choices[0]!.finish_reason, "stop");

      // The Anthropic surface names why it is unavailable, rather than failing obscurely.
      const anthropic = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "future-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(anthropic.status, 501);
      assert.match(((await anthropic.json()) as { error: { message: string } }).error.message, /rarext-cloud/);

      // Embeddings are refused, not guessed.
      const embeddings = await fetch(`${gateway.url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "future-1", input: "hi" }),
      });
      assert.equal(embeddings.status, 501);

      // No weight bytes anywhere: the control plane holds none.
      assertNoLocalWeights(ledgerDir);
    } finally {
      await gateway.close();
    }
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("a native cloud model's tool call reaches an OpenAI client", async () => {
  const cloud = startNativeCloudModel({
    reply: (request) => ({
      kind: CLOUD_INFER_KIND,
      id: "cloud-tool",
      model: request.model,
      output: {
        text: "",
        tool_calls: [{ id: "call_1", name: "get_time", arguments: '{"zone":"UTC"}' }],
        finish_reason: "tool_calls",
        logprobs: null,
      },
      usage: { input_tokens: 2, output_tokens: 3 },
      attestation: null,
    }),
  });
  const endpoint = await listen(cloud.server);
  const ledgerDir = mkdtempSync(join(tmpdir(), "rarext-native-tool-"));
  try {
    const deployment = await nativeDeployment(endpoint);
    const gateway = await startGateway({ deployment, ledgerDir, port: 0 });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "future-1",
          messages: [{ role: "user", content: "time?" }],
          tools: [{ type: "function", function: { name: "get_time", parameters: { type: "object" } } }],
        }),
      });
      const body = (await response.json()) as {
        choices: Array<{ message: { content: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }>;
      };
      assert.equal(body.choices[0]!.finish_reason, "tool_calls");
      assert.equal(body.choices[0]!.message.content, null);
      assert.equal(body.choices[0]!.message.tool_calls?.[0]!.function.name, "get_time");
      assert.deepEqual(JSON.parse(body.choices[0]!.message.tool_calls![0]!.function.arguments), { zone: "UTC" });

      // The tool declaration was carried on the native wire, not dropped.
      assert.equal(cloud.seen[0]!.tools.length, 1);
    } finally {
      await gateway.close();
    }
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("the cloud model card describes a committed deployment", async () => {
  const cloud = startNativeCloudModel({});
  const endpoint = await listen(cloud.server);
  try {
    const deployment = await nativeDeployment(endpoint);
    const card = cloudModelFromDeployment(deployment, { protocol: "rarext-cloud", providerHandle: "acme-cloud" });
    assert.equal(card.provider, "acme-cloud");
    assert.equal(card.protocol, "rarext-cloud");
    assert.equal(card.capabilities.tools, true);
    assert.deepEqual(validateCloudModelCard(card), []);
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
  }
});
