#!/usr/bin/env node
/**
 * cloud-native.mjs — RAREXT AI as a cloud model, declared by capability.
 *
 * No weights, no GGUF, no local engine: a model lives behind an endpoint and is
 * described by what it can do (`rarext.cloud-model.v1`). The gateway talks to it
 * over RAREXT's own architecture-free wire (`rarext.cloud-infer.v1`), surfaces the
 * answer as OpenAI, records and verifies the run, and holds zero model bytes.
 *
 *   npm run demo:cloud-native
 */
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const { buildCloudModelCard, validateCloudModelCard, CLOUD_MODEL_KIND } = await import(
  root + "apps/runtime/src/cloud-model.ts"
);
const { CLOUD_INFER_KIND } = await import(root + "apps/runtime/src/cloud-protocol.ts");
const { probeEngine } = await import(root + "apps/runtime/src/engines.ts");
const { startGateway } = await import(root + "apps/runtime/src/gateway.ts");
const { RunLedger } = await import(root + "apps/runtime/src/ledger.ts");
const { buildDeployment, commitDeployment, hardwareFromCloud } = await import(root + "apps/runtime/src/manifest.ts");
const { challengeFor } = await import(root + "apps/runtime/src/publisher.ts");
const { verifyRunBody } = await import(root + "apps/runtime/src/transcript.ts");
const { runSpecFromChallenge } = await import(root + "apps/runtime/src/verifier.ts");

let failed = 0;
const check = (ok, message) => {
  if (!ok) {
    failed += 1;
    console.error(`  [FAIL] ${message}`);
  }
};

const MODEL_ID = "future-model";

// ── A RAREXT-native cloud model. It speaks only rarext.cloud-infer.v1. ──────
const seen = [];
const nativeServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "rarext-cloud" }] }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/rarext-cloud/infer") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const native = JSON.parse(raw || "{}");
    seen.push(native);
    const last = [...(native.messages ?? [])].reverse().find((message) => message.role === "user");
    const text = `cloud-native says: ${String(last?.content ?? "")}`;
    if (native.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      text.split(" ").forEach((word, index) => {
        response.write(
          `data: ${JSON.stringify({
            kind: CLOUD_INFER_KIND,
            id: "cloud-demo",
            model: native.model,
            delta: { text: index === 0 ? word : ` ${word}` },
            finish_reason: null,
          })}\n\n`,
        );
      });
      response.write(
        `data: ${JSON.stringify({
          kind: CLOUD_INFER_KIND,
          id: "cloud-demo",
          model: native.model,
          delta: {},
          finish_reason: "stop",
          usage: { input_tokens: 3, output_tokens: text.split(" ").length },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        kind: CLOUD_INFER_KIND,
        id: "cloud-demo",
        model: native.model,
        output: {
          text,
          tool_calls: null,
          finish_reason: "stop",
          logprobs: native.decode?.logprobs
            ? [{ token: "cloud-native", logprob: -0.05, top: [{ token: "cloud-native", logprob: -0.05 }] }]
            : null,
        },
        usage: { input_tokens: 3, output_tokens: text.split(" ").length },
        attestation: { scheme: "rarext.opaque.v1", digest: "demo-operator-card" },
      }),
    );
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => nativeServer.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${nativeServer.address().port}`;
const ledgerDir = mkdtempSync(join(tmpdir(), "rarext-cloud-native-"));
let gateway = null;

try {
  // 1. The model's contract, committed by capability.
  const card = buildCloudModelCard({
    id: MODEL_ID,
    provider: "demo-cloud",
    protocol: "rarext-cloud",
    endpoint,
    capabilities: { tools: true, parallel_tool_calls: true, response_format: true, logprobs: true, context_length: 131072 },
    operator: { handle: "demo-cloud", measurement: null },
    attestation: { scheme: "rarext.opaque.v1", digest: "demo-operator-card" },
    createdAt: "2026-11-14T00:00:00.000Z",
  });
  check(card.kind === CLOUD_MODEL_KIND && validateCloudModelCard(card).length === 0, "the cloud model card is valid");

  // 2. Prove the contract refuses to be a weight file.
  let refused = false;
  try {
    buildCloudModelCard({ id: "x", provider: "p", protocol: "rarext-cloud", endpoint, format: "gguf" });
  } catch {
    refused = true;
  }
  check(refused, "a cloud model refuses to carry a local weight format");

  // 3. Deploy the probe and serve it from the control plane.
  const probe = await probeEngine({ endpoint, engine: "rarext-cloud", model: MODEL_ID });
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromCloud(endpoint),
      placement: "remote",
      labels: { execution: "cloud", upstreamProtocol: "rarext-cloud", fixture: "loopback" },
      createdAt: "2026-11-14T00:00:00.000Z",
    }),
  );
  gateway = await startGateway({ deployment, ledgerDir, port: 0 });

  const info = await (await fetch(`${gateway.url}/v1/deployment`)).json();
  check(info.capabilities?.protocol === "rarext-cloud", "the deployment advertises the native protocol");
  check(
    info.cloud_model?.kind === CLOUD_MODEL_KIND && validateCloudModelCard(info.cloud_model).length === 0,
    "the deployment advertises a valid capability-declared model card",
  );

  // 4. A non-streaming chat, surfaced as OpenAI.
  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "hello cloud" }], temperature: 0, seed: 1 }),
  });
  const body = await response.json();
  check(response.status === 200, `chat answered ${response.status}`);
  check(response.headers.get("x-rarext-cloud") === "rarext-cloud", "the native protocol is named on the response");
  check(body.choices?.[0]?.message?.content === "cloud-native says: hello cloud", "the answer came back as OpenAI");
  check(body.rarext_cloud_attestation?.digest === "demo-operator-card", "the operator's opaque attestation rode along");

  // 5. A stream, translated from native frames to OpenAI chunks.
  const stream = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "stream it" }], stream: true }),
  });
  const sse = await stream.text();
  const streamedText = sse
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)))
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
    .join("");
  check(streamedText === "cloud-native says: stream it", "the streamed chunks reassemble the full answer");
  check(sse.includes("data: [DONE]"), "the stream terminates with [DONE]");

  // 6. The run is recorded and verifies exactly like any other RAREXT run.
  const ledger = new RunLedger(ledgerDir);
  const record = ledger.latest();
  const verdict = verifyRunBody(record?.body, runSpecFromChallenge(challengeFor(deployment)));
  check(verdict.correct === true, "the recorded run verifies against the deployment challenge");

  // 7. No local weights, anywhere.
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        check(!/\.(gguf|rarext|safetensors|bin|pt|onnx)$/i.test(entry.name), `a weight-like file was written: ${child}`);
        check(statSync(child).size < 1024 * 1024, `a large file was written: ${child}`);
      }
    }
  };
  walk(ledgerDir);
  check(seen.length === 2 && seen.every((request) => request.kind === CLOUD_INFER_KIND), "only the native wire was used");

  console.log("RAREXT cloud-native AI — no weights, no local engine\n");
  console.log(`  model         ${card.id} · provider ${card.provider} · protocol ${card.protocol}`);
  console.log(`  identity      ${card.identity}`);
  console.log(
    `  capabilities  chat ${card.capabilities.chat} · streaming ${card.capabilities.streaming} · tools ${card.capabilities.tools} · ` +
      `logprobs ${card.capabilities.logprobs} · context ${card.capabilities.context_length}`,
  );
  console.log(`  deployment    ${deployment.placement} · engine ${deployment.engine.name} · digest ${deployment.digest.slice(0, 16)}…`);
  console.log(`  chat          "${body.choices[0].message.content}"`);
  console.log(`  stream        "${streamedText}"`);
  console.log(`  native frames ${seen.length} request(s), all ${CLOUD_INFER_KIND}`);
  console.log(`  run           ${record?.digest.slice(0, 16)}… verifies ${verdict.correct}`);
  console.log(`  local weights none (control plane holds no model bytes)`);
} finally {
  if (gateway !== null) await gateway.close();
  await new Promise((resolve) => nativeServer.close(() => resolve()));
  rmSync(ledgerDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} cloud-native check(s) FAILED`);
  process.exit(1);
}
console.log("\nCloud-native ok: a capability-declared model served over RAREXT's own wire, with no local weights.");
