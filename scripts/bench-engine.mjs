#!/usr/bin/env node
/**
 * bench-engine.mjs — measure a committed container, with no third-party engine.
 *
 * It reports, on the same weights:
 *
 *   1. the RAREXT engine end to end — tokens, ms/token, tokens/second;
 *   2. the SAME container streamed from disk through a bounded reader, and
 *      checks the two decodes are identical token for token;
 *   3. a reference output-projection pass written the obvious way
 *      (materialize each row with the engine's own dequantizer, then dot it),
 *      so the engine's whole-model step can be compared against it;
 *   4. the committed work per token (multiply-accumulates over the container).
 *
 * The deterministic part gets a canonical fingerprint; the timings are
 * measurements on this host, written as evidence, never as a promise. The file
 * is `bench/engine-bench.json`.
 *
 *   npm run bench:engine
 *   RAREXT_BENCH_MODEL=/path/to/model.rarext RAREXT_BENCH_STEPS=64 npm run bench:engine
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const { loadEngine } = await import(root + "apps/runtime/src/engine-bundle.ts");
const { benchmarkEngine, benchFingerprint } = await import(root + "apps/runtime/src/bench.ts");
const { canonicalize } = await import(root + "packages/core/src/canonical.ts");

const path = process.env.RAREXT_BENCH_MODEL ?? process.env.RAREXT_WEB4_GGUF ?? "/tmp/tinyllama-q8.rarext";
if (!existsSync(path)) {
  console.error(`no committed container at ${path}; set RAREXT_BENCH_MODEL`);
  process.exit(1);
}

const engine = loadEngine(readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js"));
const bytes = new Uint8Array(readFileSync(path));
const magic = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
const kind = magic === "RXHF" ? "hf" : "gguf";
const sizeBytes = statSync(path).size;

const fd = openSync(path, "r");
const readAt = (offset, length) => {
  const want = Math.max(0, Math.min(length, sizeBytes - offset));
  if (want === 0) return new Uint8Array(0);
  const buffer = Buffer.allocUnsafe(want);
  const read = readSync(fd, buffer, 0, want, offset);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
};

let result;
try {
  result = benchmarkEngine(
    engine,
    { kind, bytes },
    {
      id: path.split("/").pop(),
      prompt: process.env.RAREXT_BENCH_PROMPT ?? "abcdefgh",
      steps: Number(process.env.RAREXT_BENCH_STEPS ?? 16) || 16,
      repeats: 3,
      streamer: () => ({ readAt, sizeBytes }),
    },
  );
} finally {
  closeSync(fd);
}

const fmt = (value, digits = 2) => value.toFixed(digits);
console.log(`RAREXT engine benchmark — ${path}`);
console.log(
  `model ${result.model.id} · ${result.model.kind} · ${result.model.bytes} bytes · ` +
    `${result.model.tensorCount} tensors · ${result.macsPerToken.toLocaleString("en-US")} MACs/token\n`,
);
console.log(
  `  engine        ${fmt(result.engine.tokensPerSecond)} tok/s  ` +
    `${fmt(result.engine.msPerToken, 3)} ms/token  (${result.engine.tokens} tokens)`,
);
if (result.streamed !== null) {
  console.log(
    `  streamed      ${fmt(result.streamed.tokensPerSecond)} tok/s  ` +
      `${fmt(result.streamed.msPerToken, 3)} ms/token  · identical ${result.streamed.identical} · ` +
      `peak resident ${result.streamed.peakResidentBytes} bytes`,
  );
} else {
  console.log(`  streamed      (not measured: ${result.notes[0] ?? "no reader supplied"})`);
}
console.log(
  `  reference     ${fmt(result.reference.rowsPerSecond)} rows/s  ` +
    `${fmt(result.reference.msPerRow, 4)} ms/row  · ${result.reference.rows} rows ` +
    `(${result.reference.tensor})`,
);
console.log(
  `\n  engine step / reference projection per token: ${fmt(result.comparison.engineStepOverReferenceProjection, 3)}`,
);
console.log(`  ${result.comparison.note}\n`);

let failed = 0;
const check = (ok, message) => {
  if (ok) return;
  failed += 1;
  console.error(`  [FAIL] ${message}`);
};
check(result.engine.tokens > 0, "the engine produced no tokens");
check(result.engine.tokensPerSecond > 0, "the engine throughput was not positive");
check(result.macsPerToken > 0, "the container reported no weight arithmetic");
check(result.reference.rowsPerSecond > 0, "the reference pass ran no rows");
check(result.streamed === null || result.streamed.identical, "the streamed decode differed from the resident one");

const fingerprint = benchFingerprint(result);
const outDir = join(root, "bench");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "engine-bench.json");
writeFileSync(outPath, `${canonicalize({ fingerprint, result })}\n`);
console.log(`  fingerprint ${fingerprint}`);
console.log(`  wrote ${outPath}`);

if (failed > 0) {
  console.error(`\n${failed} benchmark check(s) FAILED`);
  process.exit(1);
}
console.log("\nBenchmark ok: engine, streamed, and reference all measured on the same weights.");
