import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalize } from "@rarext/core";
import {
  STARTER_MODEL,
  STARTER_SEED,
  STARTER_STEPS,
  checkClaim,
  runCommittedModel,
  sha256Hex,
} from "../src/ai.ts";

/**
 * The proof, made in the browser's runtime. These run under node, which has the
 * same WebCrypto — so this file is also the cross-runtime test: if WebCrypto and
 * node's createHash disagreed about any part of the evidence, "anyone can
 * recompute this" would be a slogan rather than a property.
 */

interface CommittedBundle {
  publications: Array<{ app?: string; artifact: { body: { model: unknown; seed: number; output: string } } }>;
}

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as CommittedBundle;
const published = committed.publications.find((entry) => entry.app === "ai-generative")!;

test("the browser's digest is node's digest, byte for byte", async () => {
  const sample = canonicalize({ b: 1, a: [1, 2, 3] });
  const node = createHash("sha256").update(sample).digest("hex");
  assert.equal(await sha256Hex(sample), node, "the hash the browser injects into core is the hash the server injects");
});

test("the committed model, run here, reproduces the PUBLISHED output", async () => {
  const run = await runCommittedModel(STARTER_MODEL, STARTER_SEED, STARTER_STEPS);

  assert.equal(run.output, published.artifact.body.output, "the published output, byte for byte");
  assert.equal(run.proof.correct, true, "and the replay agrees, computed here rather than taken on trust");

  // The evidence matches what node computes for the same inputs — the model
  // digest, and the trace hash built exactly as attestRun builds it.
  const modelDigest = createHash("sha256").update(canonicalize(STARTER_MODEL)).digest("hex");
  assert.equal(run.proof.modelDigest, modelDigest);
  const trace = { modelDigest, seed: STARTER_SEED, steps: STARTER_STEPS, expected: run.output };
  assert.equal(run.proof.traceHash, createHash("sha256").update(canonicalize(trace)).digest("hex"));

  // The committed publication's own seed and model are the ones this page runs.
  assert.equal(published.artifact.body.seed, STARTER_SEED);
  assert.deepEqual(published.artifact.body.model, STARTER_MODEL, "the page runs the committed model, not a copy of its shape");
});

test("a claimed output that is not the model's is refused here too", () => {
  const forged = `${published.artifact.body.output.slice(0, -4)}zzzz`;
  const verdict = checkClaim(STARTER_MODEL, STARTER_SEED, forged, STARTER_STEPS);
  assert.equal(verdict.correct, false);
  assert.notEqual(verdict.expected, forged, "and the verdict carries what the model actually produces");
  assert.equal(verdict.expected, published.artifact.body.output);
});

test("the page refuses what it cannot mean, by name rather than by clamping", async () => {
  await assert.rejects(() => runCommittedModel(STARTER_MODEL, STARTER_SEED, -1), /non-negative integer/);
  await assert.rejects(() => runCommittedModel(STARTER_MODEL, STARTER_SEED, 2.5), /non-negative integer/);
  await assert.rejects(() => runCommittedModel(STARTER_MODEL, Number.NaN, 8), /finite number/);
  await assert.rejects(
    () => runCommittedModel(STARTER_MODEL, STARTER_SEED, 1_000_000_000),
    /must not exceed/,
    "a page that generated a billion tokens would be a browser tab as a denial of service",
  );
});
