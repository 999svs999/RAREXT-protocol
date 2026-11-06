import assert from "node:assert/strict";
import test from "node:test";

import { probeEngineCatalog, pullOllamaModel } from "../src/engines.ts";
import type { PullProgress } from "../src/engines.ts";

const DIGEST = "a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67";

function ndjson(lines: string[], trailingNewline = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n") + (trailingNewline ? "\n" : "")));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function tagsResponse(): Response {
  return new Response(
    JSON.stringify({
      models: [
        {
          name: "qwen2.5:0.5b",
          model: "qwen2.5:0.5b",
          digest: DIGEST,
          size: 397821319,
          details: {
            family: "qwen2",
            parameter_size: "494.03M",
            quantization_level: "Q4_K_M",
            format: "gguf",
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("pullOllamaModel streams progress and returns the model the engine now reports", async () => {
  const calls: string[] = [];
  let pullBody: unknown = null;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);

    if (url === "http://127.0.0.1:11434/api/pull") {
      pullBody = JSON.parse(String(init?.body));
      // The last event deliberately has no trailing newline, so the reader's
      // final flush is what consumes it.
      return ndjson(
        [
          JSON.stringify({ status: "pulling manifest" }),
          JSON.stringify({
            status: "downloading",
            digest: `sha256:${DIGEST}`,
            total: 100,
            completed: 40,
          }),
          JSON.stringify({ status: "success" }),
        ],
        false,
      );
    }

    if (url === "http://127.0.0.1:11434/api/tags") return tagsResponse();
    if (url === "http://127.0.0.1:11434/api/version") {
      return new Response(JSON.stringify({ version: "0.23.2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const progress: PullProgress[] = [];
  const model = await pullOllamaModel({
    endpoint: "127.0.0.1:11434",
    model: "qwen2.5:0.5b",
    fetchImpl,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(pullBody, { name: "qwen2.5:0.5b", stream: true });
  assert.deepEqual(
    progress.map((event) => event.status),
    ["pulling manifest", "downloading", "success"],
  );
  assert.equal(progress[1]!.completed, 40);
  assert.equal(progress[1]!.total, 100);
  assert.equal(progress[1]!.digest, `sha256:${DIGEST}`);

  assert.equal(model.id, "qwen2.5:0.5b");
  assert.equal(model.family, "qwen2");
  assert.equal(model.parameters, "494.03M");
  assert.equal(model.quantization, "Q4_K_M");
  assert.equal(model.sizeBytes, 397821319);
  assert.equal(model.weightsDigest, `sha256:${DIGEST}`);

  // The pull is followed by a fresh probe; the digest comes from the engine's
  // own tag list, never from the download events.
  assert.ok(calls.includes("http://127.0.0.1:11434/api/pull"));
  assert.ok(calls.includes("http://127.0.0.1:11434/api/tags"));
});

test("pullOllamaModel surfaces an error event from the engine", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/pull")) {
      return ndjson([
        JSON.stringify({ status: "pulling manifest" }),
        JSON.stringify({ error: "model 'missing:1b' not found" }),
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    pullOllamaModel({ endpoint: "127.0.0.1:11434", model: "missing:1b", fetchImpl }),
    /refused to pull missing:1b: model 'missing:1b' not found/,
  );
});

test("pullOllamaModel refuses a non-2xx answer without claiming a download", async () => {
  const fetchImpl = (async () =>
    new Response("pull is disabled", { status: 403 })) as unknown as typeof fetch;

  await assert.rejects(
    pullOllamaModel({ endpoint: "127.0.0.1:11434", model: "qwen2.5:0.5b", fetchImpl }),
    /refused to pull qwen2\.5:0\.5b: HTTP 403 — pull is disabled/,
  );
});

test("pullOllamaModel requires a model id", async () => {
  await assert.rejects(
    pullOllamaModel({ endpoint: "127.0.0.1:11434", model: "  " }),
    /a model id is required to pull/,
  );
});

test("probeEngineCatalog lists every model without refusing a multi-model engine", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);

    if (url.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: [
            { name: "small:1b", digest: "a".repeat(64), size: 1_000, details: { quantization_level: "Q4_K_M" } },
            { name: "large:8b", digest: "b".repeat(64), size: 5_000, details: { quantization_level: "Q8_0" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.23.2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const catalog = await probeEngineCatalog({ endpoint: "127.0.0.1:11434", fetchImpl });

  assert.equal(catalog.engine.name, "ollama");
  assert.equal(catalog.engine.version, "0.23.2");
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["small:1b", "large:8b"],
  );
  assert.deepEqual(
    catalog.models.map((model) => model.weightsDigest),
    [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
  );
});
