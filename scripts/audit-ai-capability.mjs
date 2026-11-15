#!/usr/bin/env node
/**
 * audit-ai-capability.mjs — what RAREXT AI can actually do, measured.
 *
 * The question this answers is not "is the model good?" but "which capabilities
 * does the stack implement, and can a stranger check the answer?" It stands up a
 * real RAREXT node, shards a real container into content-addressed blobs, starts
 * a provider that fetches and verifies every shard, and then probes the OpenAI
 * surface it advertises: completions, chat, streaming, sampling controls, stop,
 * tools, JSON-schema output, logprobs, embeddings, multimodal refusal, and
 * seeded replay.
 *
 * Everything is a live HTTP request against the provider. A capability that is
 * only asserted in code is not counted, and a refusal is reported as a result
 * rather than hidden.
 *
 *   npm run audit:ai
 *   RAREXT_AUDIT_MODEL=/tmp/model.rarext RAREXT_AUDIT_STEPS=12 npm run audit:ai
 *
 * The engine is served as a RAREXT artifact too, so the provider runs the exact
 * engine bytes it fetched, not whatever the box happens to have. That is the
 * difference between "a model answered" and "this model, this engine, this run".
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../apps/api/src/app.ts";
import { PlacementRegistry } from "../apps/api/src/placements.ts";
import { BlobStore } from "../apps/api/src/storage.ts";
import { RarextStore } from "../apps/api/src/store.ts";
import { loadEngine } from "../apps/runtime/src/engine-bundle.ts";
import {
  buildEngineBundle,
  ENGINE_ARTIFACT_RUNTIME_GGUF,
  uploadEngineBundle,
} from "../apps/runtime/src/engine-bundle.ts";
import { buildModelBundle, uploadBundle } from "../apps/runtime/src/model-bundle.ts";
import { startProvider } from "../apps/runtime/src/provider.ts";

const root = new URL("..", import.meta.url).pathname;
const modelPath = process.env.RAREXT_AUDIT_MODEL ?? "/tmp/qwen05-q8.rarext";
const steps = Number(process.env.RAREXT_AUDIT_STEPS ?? 12) || 12;
if (!existsSync(modelPath)) {
  console.error(`no container at ${modelPath}; set RAREXT_AUDIT_MODEL`);
  process.exit(1);
}

const bytes = readFileSync(modelPath);
const engineSource = readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js");
const engine = loadEngine(engineSource);
const magic = bytes.subarray(0, 4).toString("latin1");
const model = { kind: magic === "RXHF" ? "hf" : "gguf", bytes: new Uint8Array(bytes) };
const parsed = model.kind === "hf" ? engine.parseContainer(model.bytes) : engine.parseGguf(model.bytes);
const arch = String(parsed.kv["general.architecture"] ?? "unknown");
const contextLength = Number(parsed.kv[`${arch}.context_length`] ?? 0);
const weightsDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const engineDigest = `sha256:${createHash("sha256").update(engineSource).digest("hex")}`;

const results = [];
const record = (id, label, ok, detail, critical = true) => {
  results.push({ id, label, ok, detail, critical });
  const mark = ok ? "ok  " : critical ? "FAIL" : "gap ";
  console.log(`  [${mark}] ${label.padEnd(38)} ${detail}`);
};

// ── A real node, a real bundle, a real provider ───────────────────────────
const state = mkdtempSync(join(tmpdir(), "rarext-ai-audit-"));
const blobStore = new BlobStore(join(state, "blobs"));
const node = createApp({
  store: new RarextStore(),
  blobs: blobStore,
  placements: new PlacementRegistry(join(state, "placements")),
});
node.listen(0, "127.0.0.1");
await once(node, "listening");
const base = `http://127.0.0.1:${node.address().port}`;

console.log(`RAREXT AI capability audit`);
console.log(`  model   ${modelPath}`);
console.log(`          ${arch} · ${bytes.length.toLocaleString()} bytes · context ${contextLength || "undeclared"}`);
console.log(`  weights ${weightsDigest.slice(0, 26)}…`);
console.log(`  engine  ${engineDigest.slice(0, 26)}… (content-addressed, served by the provider)`);
console.log(`  node    ${base}\n`);

const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
  source: engineSource,
  name: "rarext-gguf-engine",
  engineVersion: "audit",
  runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
  chunkBytes: 512 * 1024,
  createdAt: "2026-11-15T00:00:00.000Z",
});
await uploadEngineBundle({ registry: base, bundle: engineBundle, chunks: engineChunks });

const { bundle, chunks } = buildModelBundle({
  bytes,
  model: {
    id: "qwen2.5-0.5b-instruct-q8",
    family: "qwen2",
    parameters: "0.49B",
    quantization: "Q8_0",
    format: model.kind === "hf" ? "rarext-hf" : "gguf",
    sizeBytes: null,
    weightsDigest: null,
    contextLength: contextLength || null,
  },
  execution: { kind: "engine", engine: "rarext", engineModel: null },
  chunkBytes: 8 * 1024 * 1024,
  createdAt: "2026-11-15T00:00:00.000Z",
});
await uploadBundle({ registry: base, bundle, chunks });

const provider = await startProvider({
  bundle,
  registry: base,
  stateDir: join(state, "provider"),
  port: 0,
  engineBundle,
  log: () => {},
});
console.log(`  provider fetched and verified ${bundle.shards.length} shards / ${bundle.totalBytes.toLocaleString()} bytes`);
console.log(`  serving ${provider.url}\n`);

const post = async (path, body) => {
  const response = await fetch(provider.url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An SSE body is parsed by the caller.
  }
  return { response, text, json };
};

const runChat = async (body) =>
  post("/v1/chat/completions", {
    model: bundle.model.id,
    temperature: 0,
    max_tokens: steps,
    ...body,
  });

try {
  // 1. The advertised surface, read from the model card rather than assumed.
  const models = await (await fetch(`${provider.url}/v1/models`)).json();
  const capabilities = models.data?.[0]?.capabilities ?? {};
  record(
    "models",
    "GET /v1/models advertises capabilities",
    capabilities.chat === true && capabilities.streaming === true && capabilities.logprobs === true,
    JSON.stringify({
      chat: capabilities.chat,
      completions: capabilities.completions,
      streaming: capabilities.streaming,
      embeddings: capabilities.embeddings,
      tools: capabilities.tools,
      logprobs: capabilities.logprobs,
      grammar: capabilities.grammar,
      multimodal: capabilities.multimodal,
    }),
  );

  // 2. Instruction/factual quality on the same weights, greedy.
  const factual = await post("/v1/completions", {
    model: bundle.model.id,
    prompt: "The capital of France is",
    max_tokens: 8,
    temperature: 0,
  });
  const factualText = factual.json?.choices?.[0]?.text ?? "";
  record(
    "completion",
    "text completion · factual prompt",
    /Paris/.test(factualText),
    JSON.stringify(factualText.slice(0, 80)),
  );

  // 3. Streaming is token-by-token, and its concatenation is the non-stream text.
  const chatBody = {
    messages: [{ role: "user", content: "Name three primary colors, separated by commas." }],
    max_tokens: 24,
    temperature: 0,
    seed: 1234,
  };
  const plain = await runChat(chatBody);
  const plainText = plain.json?.choices?.[0]?.message?.content ?? "";
  const plainTokens = plain.json?.rarext_trace?.tokens ?? [];
  const streamed = await runChat({ ...chatBody, stream: true });
  const events = streamed.text
    .split("\n\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
  const contentChunks = events.filter((event) => typeof event.choices?.[0]?.delta?.content === "string" && event.choices[0].delta.content !== "");
  const streamText = contentChunks.map((event) => event.choices[0].delta.content).join("");
  const final = events.find((event) => event.choices?.[0]?.finish_reason != null);
  record(
    "streaming",
    "SSE stream · one chunk per decoded token",
    contentChunks.length === plainTokens.length && streamText === plainText && contentChunks.length > 1,
    `${contentChunks.length} chunks vs ${plainTokens.length} trace tokens · concat ${streamText === plainText ? "equal" : "DIFFERS"} · finish=${final?.choices?.[0]?.finish_reason}`,
  );

  // 4. Sampling controls actually change the distribution, and a seed replays.
  const sampled = (seed) =>
    runChat({
      messages: [{ role: "user", content: "Write one sentence about the ocean." }],
      max_tokens: 16,
      temperature: 0.9,
      top_k: 40,
      top_p: 0.9,
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      seed,
    });
  const first = await sampled(7);
  const again = await sampled(7);
  const other = await sampled(8);
  const firstText = first.json?.choices?.[0]?.message?.content ?? "";
  const againText = again.json?.choices?.[0]?.message?.content ?? "";
  const otherText = other.json?.choices?.[0]?.message?.content ?? "";
  record(
    "determinism",
    "seeded sample replays byte-for-byte",
    firstText === againText && firstText.length > 0,
    firstText === againText ? "same seed, identical text" : "same seed DIVERGED",
  );
  record(
    "sampling",
    "temperature/top-k/top-p/penalties applied",
    firstText !== otherText,
    firstText !== otherText ? "different seed, different text" : "different seed, same text (possible but suspicious)",
    false,
  );

  // 5. stop ends the run, and the stop text is not returned. The prompt ends
  //    in a completion the model reliably produces before the delimiter.
  const stopped = await post("/v1/completions", {
    model: bundle.model.id,
    prompt: "The capital of France is",
    max_tokens: 12,
    temperature: 0,
    stop: ["."],
  });
  const stoppedText = stopped.json?.choices?.[0]?.text ?? "";
  record(
    "stop",
    "stop sequence ends the run",
    !stoppedText.includes(".") && stopped.json?.choices?.[0]?.finish_reason === "stop",
    `finish=${stopped.json?.choices?.[0]?.finish_reason} · ${JSON.stringify(stoppedText.slice(0, 60))}`,
  );

  // 6. Logprobs are per token, aligned to the decode trace.
  const logged = await runChat({
    messages: [{ role: "user", content: "Say hello." }],
    max_tokens: 6,
    temperature: 0,
    logprobs: true,
    top_logprobs: 3,
  });
  const content = logged.json?.choices?.[0]?.logprobs?.content ?? [];
  const loggedTokens = logged.json?.rarext_trace?.tokens?.length ?? 0;
  record(
    "logprobs",
    "per-token logprobs + alternatives",
    content.length === loggedTokens &&
      content.length > 0 &&
      content.every((entry) => entry.logprob <= 0) &&
      content.every((entry) => Array.isArray(entry.top_logprobs) && entry.top_logprobs.length > 0),
    `${content.length} scored tokens vs ${loggedTokens} trace tokens · first=${content[0]?.logprob?.toFixed(3) ?? "n/a"}`,
  );

  // 7. Structured output: a schema constrains the decode, not a post-hoc filter.
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
    additionalProperties: false,
  };
  const structured = await runChat({
    messages: [{ role: "user", content: "Return the name Ada and the age 36." }],
    max_tokens: 48,
    temperature: 0,
    // `strict: true` is what makes this a constrained decode rather than a
    // polite request; without it the schema is not enforced by design.
    response_format: { type: "json_schema", json_schema: { name: "person", strict: true, schema } },
  });
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(structured.json?.choices?.[0]?.message?.content ?? "");
  } catch {
    parsedJson = null;
  }
  record(
    "structured",
    "JSON-schema constrained output",
    parsedJson !== null && typeof parsedJson.name === "string" && Number.isInteger(parsedJson.age),
    parsedJson === null
      ? `not JSON: ${JSON.stringify((structured.json?.choices?.[0]?.message?.content ?? "").slice(0, 80))}`
      : JSON.stringify(parsedJson),
  );

  // 8. Tool calling: the protocol is exercised live. A 0.5B model may miss it,
  //    which is a model limit, not a runtime one, so this is not critical.
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Current weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ];
  const toolCall = await runChat({
    messages: [{ role: "user", content: "What is the weather in Paris? Call get_weather." }],
    tools,
    tool_choice: { type: "function", function: { name: "get_weather" } },
    max_tokens: 40,
    temperature: 0,
  });
  const call = toolCall.json?.choices?.[0]?.message?.tool_calls?.[0];
  record(
    "tools",
    "tool call (name + JSON arguments)",
    call?.function?.name === "get_weather" && typeof call?.function?.arguments === "string",
    call === undefined
      ? `no call; model said ${JSON.stringify((toolCall.json?.choices?.[0]?.message?.content ?? "").slice(0, 60))}`
      : `${call.function.name}(${call.function.arguments})`,
    false,
  );

  // 9. Embeddings come from the same verified bytes; there is no second model.
  const embeddings = await post("/v1/embeddings", {
    model: bundle.model.id,
    input: ["the capital of France", "Paris"],
  });
  const vectors = embeddings.json?.data ?? [];
  const dim = vectors[0]?.embedding?.length ?? 0;
  record(
    "embeddings",
    "embeddings from the same weights",
    vectors.length === 2 && dim > 0 && vectors.every((entry) => entry.embedding.every(Number.isFinite)),
    `${vectors.length} vectors · ${dim} dims`,
  );

  // 10. A capability it does NOT have is refused by name, not faked in text.
  const multimodal = await runChat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
    max_tokens: 8,
  });
  record(
    "multimodal",
    "vision/audio refused by name",
    multimodal.response.status === 400 && multimodal.json?.error?.code === "unsupported_content_part",
    `HTTP ${multimodal.response.status} · ${multimodal.json?.error?.code ?? multimodal.text.slice(0, 60)}`,
  );

  // 11. Context: the container declares a window, and a prompt inside it runs.
  //     (Truncation of an OVER-long prompt is a unit test on a small container;
  //     asking this host to prefill a 32k-token prompt would take hours, so the
  //     audit does not pretend to measure it.)
  const inside = await runChat({
    messages: [{ role: "user", content: "word ".repeat(96) }],
    max_tokens: 4,
    temperature: 0,
  });
  record(
    "context",
    "declared context window is served",
    inside.response.status === 200 && (inside.json?.usage?.prompt_tokens ?? 0) > 0,
    `declared ${contextLength || "fallback 4096"} · prompt_tokens ${inside.json?.usage?.prompt_tokens ?? 0}`,
  );

  // 12. Throughput on this host, measured on the same weights.
  const perfPrompt = "Explain why the sky is blue.";
  const started = performance.now();
  const direct = engine.run(model, { prompt: perfPrompt, steps: 8, temperature: 0 });
  const elapsed = performance.now() - started;
  const tokensPerSecond = direct.tokens.length / (elapsed / 1000);
  record(
    "throughput",
    "engine throughput on this host",
    tokensPerSecond > 0,
    `${tokensPerSecond.toFixed(2)} tok/s · ${(elapsed / direct.tokens.length).toFixed(0)} ms/token · ${direct.tokens.length} tokens`,
    false,
  );

  // The comparison that makes the throughput number mean something: the same
  // model class on the same host through a different runtime, when one is up.
  if (process.env.RAREXT_AUDIT_SKIP_OLLAMA !== "1") {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const tags = await fetch("http://127.0.0.1:11434/api/tags", { signal: controller.signal });
      clearTimeout(timer);
      if (tags.ok) {
        const tagData = await tags.json();
        const modelName =
          process.env.RAREXT_AUDIT_OLLAMA_MODEL ??
          tagData.models?.find((entry) => /qwen2\.5:0\.5b/.test(entry.name))?.name;
        if (modelName) {
          const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: modelName,
              prompt: perfPrompt,
              stream: false,
              options: { temperature: 0, num_predict: 16, seed: 42 },
            }),
          });
          const data = await response.json();
          const rate = data.eval_count / (data.eval_duration / 1e9);
          record(
            "comparison",
            `same 0.5B model via llama.cpp (${modelName}, Q4_K_M)`,
            Number.isFinite(rate) && rate > 0,
            `${rate.toFixed(1)} tok/s · ${(1000 / rate).toFixed(0)} ms/token · ${data.eval_count} tokens`,
            false,
          );
        }
      }
    } catch {
      record("comparison", "same model via llama.cpp (ollama)", false, "not running", false);
    }
  }

  // 13. The receipt: the answer is signed, and the bundle it came from is named.
  const health = await (await fetch(`${provider.url}/health`)).json();
  record(
    "receipt",
    "health names bundle + engine fingerprint",
    health.ok === true && typeof health.engineFingerprint === "string" && health.weightsDigest === weightsDigest,
    `bundle ${String(health.bundle).slice(0, 18)}… · engine ${String(health.engineFingerprint).slice(0, 18)}…`,
  );
} finally {
  await provider.close();
  node.closeAllConnections();
  await new Promise((resolve) => node.close(resolve));
  rmSync(state, { recursive: true, force: true });
}

const critical = results.filter((entry) => entry.critical);
const failed = critical.filter((entry) => !entry.ok);
const passed = results.filter((entry) => entry.ok).length;

const summary = {
  kind: "rarext.ai-capability-audit.v1",
  createdAt: new Date().toISOString(),
  model: { path: modelPath, arch, bytes: bytes.length, contextLength, weightsDigest },
  engine: { digest: engineDigest, artifact: engineBundle.artifactDigest },
  host: { platform: process.platform, arch: process.arch, memoryBytes: (await import("node:os")).totalmem() },
  passed,
  total: results.length,
  results,
};
mkdirSync(root + "bench", { recursive: true });
writeFileSync(root + "bench/ai-capability.json", JSON.stringify(summary, null, 2) + "\n");

console.log(`\n${passed}/${results.length} probes passed · ${failed.length} critical failure(s)`);
console.log(`wrote bench/ai-capability.json`);
if (failed.length > 0) process.exit(1);
