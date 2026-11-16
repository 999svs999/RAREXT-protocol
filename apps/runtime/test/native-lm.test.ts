import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadEngine } from "../src/engine-bundle.ts";

/**
 * The RAREXT-native language model: a model RAREXT trained from a seeded
 * initialization on its own corpus, run by RAREXT's own engine artifact. These
 * tests hold the line on the two claims that matter — that nothing is borrowed,
 * and that the run is deterministic and replayable — and on the training being
 * reproducible byte for byte.
 */

const REPO = new URL("../../../", import.meta.url).pathname;
const ENGINE = readFileSync(new URL("../engines/rarext-native-lm-engine.js", import.meta.url));
const CONTAINER = new URL("../../../bench/native/rarext-native-1.rnlm", import.meta.url);
const REPORT = new URL("../../../bench/native/rarext-native-1.json", import.meta.url);

function model(): { engine: ReturnType<typeof loadEngine>; handle: { kind: "gguf"; bytes: Uint8Array } } {
  const engine = loadEngine(ENGINE);
  const bytes = new Uint8Array(readFileSync(CONTAINER));
  return { engine, handle: { kind: "gguf", bytes } };
}

test("the native model is RAREXT's own: not pretrained, no external bytes", () => {
  const { engine, handle } = model();
  const info = engine.describe!(handle);
  assert.equal(info.kind, "rarext.native-lm.v1");
  assert.equal(info.family, "rarext-native");
  assert.equal(info.lineage.pretrained, false, "the container declares pretrained=false");
  assert.equal(info.lineage.externalModelBytes, 0, "the container counts zero external model bytes");
  assert.ok(info.parameters > 1000 && info.parameters < 1_000_000, `small on purpose: ${info.parameters} params`);
  assert.ok(Number.isFinite(info.training.finalHeldLoss), "the training record carries a held loss");
  // No third-party model vocabulary anywhere in the bytes.
  const latin = Buffer.from(handle.bytes).toString("latin1");
  assert.equal(/GGUF|safetensors|qwen|llama\.cpp|ollama/i.test(latin), false);
});

test("the native model is trained on RAREXT's own corpus snapshot", () => {
  const { engine, handle } = model();
  const info = engine.describe!(handle);
  const corpus = readFileSync(new URL("../../../bench/native/corpus.txt", import.meta.url));
  const digest = createHash("sha256").update(corpus).digest("hex");
  assert.equal(info.training.corpusSha256, digest, "header records the corpus it was grown from");
  const report = JSON.parse(readFileSync(REPORT, "utf8")) as { containerSha256: string; corpus: { sha256: string } };
  assert.equal(report.corpus.sha256, digest);
  assert.equal(
    createHash("sha256").update(readFileSync(CONTAINER)).digest("hex"),
    report.containerSha256,
    "the committed container matches its training report",
  );
});

test("the native tokenizer is bytes: encode/decode round-trips without a borrowed vocab", () => {
  const { engine, handle } = model();
  for (const phrase of ["RAREXT is", "the protocol", "verifiable builds\n"]) {
    const ids = engine.encode!(handle, phrase);
    assert.ok(ids.every((id) => id >= 0 && id <= 255), "token ids are byte values");
    const back = engine.decode!(handle, engine.encode!(handle, phrase + " ").slice(0, ids.length));
    assert.equal(back, phrase);
  }
});

test("the native model decodes deterministically and replays a sampled run from its seed", () => {
  const { engine, handle } = model();
  const prompt = "RAREXT is ";
  const a = engine.run(handle, { prompt, steps: 48 });
  const b = engine.run(handle, { prompt, steps: 48 });
  assert.deepEqual(a.tokens, b.tokens, "greedy is token-for-token deterministic");

  const cfg = { prompt: "The protocol ", steps: 40, seed: 42, temperature: 0.9, topK: 40, topP: 0.95 };
  const s1 = engine.run(handle, cfg);
  const s2 = engine.run(handle, cfg);
  const s3 = engine.run(handle, { ...cfg, seed: 7 });
  assert.deepEqual(s1.tokens, s2.tokens, "a sampled run replays byte for byte from its seed");
  assert.notDeepEqual(s1.tokens, s3.tokens, "a different seed changes the run");
});

test("the native model honours the decoding controls the protocol promises", () => {
  const { engine, handle } = model();
  const scored = engine.run(handle, { prompt: "RAREXT is ", steps: 24, logprobs: true, topLogprobs: 3 });
  assert.equal(scored.logprobs?.length, scored.tokens.length, "logprobs align with the trace");
  assert.ok((scored.logprobs ?? []).every((e) => e.top.length === 3 && Number.isFinite(e.logprob)));

  const target = "RAREXT";
  const pinned = engine.run(handle, { prompt: "RAREXT is ", steps: 6, pinnedTokens: engine.encode!(handle, target) });
  assert.equal(engine.decode!(handle, pinned.tokens), target, "pinnedTokens fix the emitted bytes");

  const stopped = engine.run(handle, { prompt: "RAREXT is ", steps: 96, stop: ["the "] });
  assert.equal(stopped.finishReason, "stop");
  assert.equal(stopped.text.includes("the "), false);

  const embA = engine.embed!(handle, { text: "verifiable builds" });
  const embB = engine.embed!(handle, { text: "verifiable builds" });
  assert.deepEqual(embA.embedding, embB.embedding, "embeddings are reproducible");
  assert.equal(embA.dimensions, engine.describe!(handle).dim);
});

test("tampering with one weight byte changes what the native model says", () => {
  const engine = loadEngine(ENGINE);
  const original = new Uint8Array(readFileSync(CONTAINER));
  const tampered = original.slice();
  // Flip a byte inside the embedding vector for "R", the first prompt byte, so
  // the very first forward pass reads the tampered weight.
  const buf = Buffer.from(original);
  const headerLen = buf.readUInt32LE(8);
  const header = JSON.parse(buf.subarray(12, 12 + headerLen).toString("utf8")) as { bytes: number[]; dim: number };
  const rowOf = (byte: number): number => {
    const idx = header.bytes.indexOf(byte);
    return 12 + headerLen + Math.max(0, idx) * header.dim * 4;
  };
  const at = rowOf(0x52); // "R"
  tampered[at] = tampered[at]! ^ 0xff;
  tampered[at + 1] = tampered[at + 1]! ^ 0xff;
  const before = engine.run({ kind: "gguf", bytes: original }, { prompt: "RAREXT is ", steps: 40 });
  const after = engine.run({ kind: "gguf", bytes: tampered }, { prompt: "RAREXT is ", steps: 40 });
  assert.notDeepEqual(before.tokens, after.tokens, "the output is driven by the committed weights, not a constant");
  assert.notEqual(
    createHash("sha256").update(tampered).digest("hex"),
    createHash("sha256").update(original).digest("hex"),
  );
});

test("training the native model is reproducible: two runs are byte-identical", () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-native-repro-"));
  try {
    const args = [
      "scripts/train-native-lm.mjs",
      "--steps", "150",
      "--hidden", "48",
      "--dim", "8",
      "--context", "12",
      "--label", "repro",
      "--eval-every", "1000",
    ];
    const run = (out: string): string => {
      execFileSync(process.execPath, [...args, "--out", out], { cwd: REPO, stdio: "ignore" });
      return createHash("sha256").update(readFileSync(join(out, "repro.rnlm"))).digest("hex");
    };
    const a = run(join(dir, "a"));
    const b = run(join(dir, "b"));
    assert.equal(a, b, "same corpus + same seed => byte-identical container");
    assert.ok(existsSync(join(dir, "a", "repro.json")), "the training report is written too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
