#!/usr/bin/env node
/**
 * demo-native-ai.mjs — RAREXT answers with a model RAREXT grew itself.
 *
 * No Qwen, no llama.cpp, no Ollama, no downloaded checkpoint, no framework. The
 * model is a `rarext.native-lm.v1` container produced by
 * `scripts/train-native-lm.mjs` from RAREXT's own documents, and it is executed
 * by RAREXT's own engine artifact inside a `node:vm` with no `require` and no
 * filesystem. This script checks that end to end and prints the receipt.
 *
 *   npm run demo:native
 *   npm run demo:native -- bench/native/rarext-native-1.rnlm
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..") + "/";
const { loadEngine } = await import(root + "apps/runtime/src/engine-bundle.ts");

const containerPath = process.argv[2] ?? join(root, "bench/native/rarext-native-1.rnlm");
const reportPath = containerPath.replace(/\.rnlm$/, ".json");

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "[ok  ]" : "[FAIL]"} ${label}${detail ? `   ${detail}` : ""}`);
  if (!ok) failed += 1;
};

if (!existsSync(containerPath)) {
  console.error(`no container at ${containerPath} — run: node scripts/train-native-lm.mjs`);
  process.exit(1);
}
const container = readFileSync(containerPath);
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
const digest = createHash("sha256").update(container).digest("hex");

console.log("RAREXT AI · a model RAREXT trained itself\n");
console.log(`  container ${containerPath.replace(root, "").replace(/^\//, "")}`);
console.log(`  bytes     ${container.length.toLocaleString()}`);
console.log(`  sha256    ${digest}`);
console.log("");

// ── the container is the committed one, and it declares its own lineage ─────
const engine = loadEngine(readFileSync(join(root, "apps/runtime/engines/rarext-native-lm-engine.js")));
const model = { kind: "gguf", bytes: new Uint8Array(container) };
const info = engine.describe(model);

check(info.kind === "rarext.native-lm.v1", "container declares its own kind", info.kind);
check(info.lineage.pretrained === false, "not a pretrained model", `pretrained=${info.lineage.pretrained}`);
check(info.lineage.externalModelBytes === 0, "zero external model bytes on the path", `${info.lineage.externalModelBytes}`);
check(
  !/GGUF|safetensors|qwen|llama\.cpp|ollama/i.test(container.toString("latin1")),
  "container holds no third-party model vocabulary",
);
if (report) {
  check(digest === report.containerSha256, "container matches its training report", digest.slice(0, 16) + "…");
  const corpus = readFileSync(join(root, "bench/native/corpus.txt"));
  const corpusDigest = createHash("sha256").update(corpus).digest("hex");
  check(
    corpusDigest === info.training.corpusSha256 && corpusDigest === report.corpus.sha256,
    "trained on RAREXT's own corpus snapshot",
    `sha256 ${corpusDigest.slice(0, 16)}…`,
  );
}
console.log(`\n  architecture ${info.architecture} · ${info.parameters.toLocaleString()} params · context ${info.contextLength} · vocab ${info.vocab}`);
console.log(`  trained by   ${info.lineage.trainedBy}`);
console.log(`  held loss    ${info.training.finalHeldLoss} nats/byte · ${info.training.finalHeldBitsPerByte} bits/byte\n`);

// ── the model is RAREXT's own tokenizer: bytes in, bytes out ────────────────
const phrase = "the protocol";
check(
  engine.decode(model, engine.encode(model, phrase)) === phrase,
  "encode/decode round-trips (byte tokenizer, no borrowed vocab)",
);

// ── greedy is deterministic; a sampled run replays from its seed ────────────
const prompt = "RAREXT is ";
const greedyA = engine.run(model, { prompt, steps: 96, logprobs: true, topLogprobs: 3 });
const greedyB = engine.run(model, { prompt, steps: 96 });
check(JSON.stringify(greedyA.tokens) === JSON.stringify(greedyB.tokens), "greedy run is deterministic");
console.log(`  → ${JSON.stringify(greedyA.text)}`);

const sampleCfg = { prompt: "The protocol ", steps: 80, seed: 42, temperature: 0.9, topK: 40, topP: 0.95 };
const sampledA = engine.run(model, sampleCfg);
const sampledB = engine.run(model, { ...sampleCfg });
const sampledOther = engine.run(model, { ...sampleCfg, seed: 7 });
check(JSON.stringify(sampledA.tokens) === JSON.stringify(sampledB.tokens), "sampled run replays byte-for-byte from its seed");
check(JSON.stringify(sampledA.tokens) !== JSON.stringify(sampledOther.tokens), "a different seed changes the run");
check(sampledA.text !== greedyA.text.slice(0, sampledA.text.length), "sampling is not the greedy run");
console.log(`  → seed 42 ${JSON.stringify(sampledA.text)}`);

// ── decoding controls the protocol already promises ─────────────────────────
check(greedyA.logprobs.length === greedyA.tokens.length, "logprobs align with the decode trace", `${greedyA.logprobs.length} scored`);
check(greedyA.logprobs.every((e) => e.top.length === 3), "topLogprobs carries alternatives", `first ${greedyA.logprobs[0].logprob.toFixed(3)}`);

const pinnedText = "RAREXT";
const pinned = engine.run(model, { prompt: "RAREXT is ", steps: 6, pinnedTokens: engine.encode(model, pinnedText) });
check(engine.decode(model, pinned.tokens) === pinnedText, "pinnedTokens fix the emitted bytes", JSON.stringify(engine.decode(model, pinned.tokens)));

const stopped = engine.run(model, { prompt, steps: 96, stop: ["the "] });
check(!stopped.text.includes("the "), "stop sequence ends the run", `finish=${stopped.finishReason}`);

const embA = engine.embed(model, { text: "verifiable builds" });
const embB = engine.embed(model, { text: "verifiable builds" });
check(embA.dimensions === info.dim && JSON.stringify(embA.embedding) === JSON.stringify(embB.embedding), "embeddings come from the model's own weights and are reproducible", `${embA.dimensions} dims`);

// ── the scaling dial: capability moves with compute, nothing is borrowed ────
const points = ["scale-s", "scale-m", "rarext-native-1"]
  .map((label) => {
    const p = join(root, "bench/native", `${label}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  })
  .filter(Boolean);
if (points.length > 1) {
  console.log("\n  capability is a dial RAREXT turns (same architecture, more compute):");
  for (const p of points) {
    console.log(`    ${p.label.padEnd(18)} steps ${String(p.config.steps).padStart(6)}  held ${p.final.heldLoss} nats/byte  bits/byte ${p.final.bitsPerByte}`);
  }
}

console.log("");
if (failed === 0) {
  console.log("RAREXT AI ran a language model it trained from its own corpus, on its own engine, with no third-party model anywhere.");
} else {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
