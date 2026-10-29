import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalize } from "@rarext/core";
import {
  STARTER_MODEL,
  STARTER_SEED,
  STARTER_STEPS,
  checkBoundedClaim,
  checkClaim,
  runBoundedProof,
  runCommittedModel,
  sha256Hex,
  renderBoundedPicture,
  renderProofPicture,
} from "../src/ai.ts";

/**
 * The proof, made in the browser's runtime. These run under node, which has the
 * same WebCrypto — so this file is also the cross-runtime test: if WebCrypto and
 * node's createHash disagreed about any part of the evidence, "anyone can
 * recompute this" would be a slogan rather than a property.
 */

interface CommittedBundle {
  publications: Array<{
    app?: string;
    artifact: { body: { model?: unknown; seed?: number; output?: string; values?: number[] } };
    attestation?: { metricValue?: number };
    challengeId?: string;
  }>;
  challenges: Array<{ id: string; spec: { metric?: string; bound?: number; reference?: number[] } }>;
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

  assert.equal(run.output, published.artifact.body.output!, "the published output, byte for byte");
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
  const forged = `${published.artifact.body.output!.slice(0, -4)}zzzz`;
  const verdict = checkClaim(STARTER_MODEL, STARTER_SEED, forged, STARTER_STEPS);
  assert.equal(verdict.correct, false);
  assert.notEqual(verdict.expected, forged, "and the verdict carries what the model actually produces");
  assert.equal(verdict.expected, published.artifact.body.output!);
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

const boundedPublished = committed.publications.find((entry) => entry.app === "ai-bounded")!;
const boundedChallenge = committed.challenges.find((entry) => entry.id === boundedPublished.challengeId)!;
const boundedSpec = boundedChallenge.spec as { metric: "maxAbsError" | "meanAbsError"; bound: number; reference: number[] };

test("the lossy proof, computed here, matches the COMMITTED metric and node's hashes", async () => {
  const proof = await runBoundedProof(
    boundedSpec.reference,
    boundedPublished.artifact.body.values!,
    boundedSpec.metric,
    boundedSpec.bound,
  );

  // The published attestation says what the registry measured; this says what a
  // browser measures for the same bytes. They must be the same number.
  assert.equal(proof.metricValue, boundedPublished.attestation?.metricValue, "the committed metric, recomputed here");
  assert.equal(proof.correct, true, "and it is within the bound the challenge declares");
  assert.equal(proof.metric, boundedSpec.metric);
  assert.equal(proof.bound, boundedSpec.bound);

  // The evidence hashes are node's, from the same fields the registry uses.
  const referenceDigest = createHash("sha256").update(canonicalize(boundedSpec.reference)).digest("hex");
  const reconstructionDigest = createHash("sha256").update(canonicalize(boundedPublished.artifact.body.values!)).digest("hex");
  assert.equal(proof.referenceDigest, referenceDigest);
  assert.equal(proof.reconstructionDigest, reconstructionDigest);
  const trace = {
    metric: boundedSpec.metric,
    metricValue: proof.metricValue,
    bound: boundedSpec.bound,
    referenceDigest,
    reconstructionDigest,
  };
  assert.equal(proof.traceHash, createHash("sha256").update(canonicalize(trace)).digest("hex"));
});

test("a reconstruction outside the bound is refused here too", () => {
  const beyond = boundedPublished.artifact.body.values!.map((value) => value + boundedSpec.bound + 4);
  const claim = checkBoundedClaim(boundedSpec.reference, beyond, boundedSpec.metric, boundedSpec.bound);
  assert.equal(claim.correct, false);
  assert.ok((claim.metricValue ?? 0) > boundedSpec.bound, `the distance is reported: ${claim.metricValue} > ${boundedSpec.bound}`);
});

test("the lossy path refuses what it cannot mean, by name", async () => {
  const values = boundedPublished.artifact.body.values!;
  await assert.rejects(
    () => runBoundedProof(boundedSpec.reference, values.slice(0, 3), boundedSpec.metric, boundedSpec.bound),
    /does not match reference length/,
    "a reconstruction of the wrong length is not a reconstruction of this reference",
  );
  await assert.rejects(
    () => runBoundedProof(boundedSpec.reference, [...values.slice(0, -1), Number.NaN], boundedSpec.metric, boundedSpec.bound),
    /finite numbers/,
  );
  await assert.rejects(() => runBoundedProof(boundedSpec.reference, values, boundedSpec.metric, Number.NaN), /bound must be a finite number/);
});

test("the picture the page draws is the published one, both representations", () => {
  // The same file the page fetches beside itself: `./bundle.json` is the mirror's
  // bundle, and the lossy reference lives in the CHALLENGE spec — exactly where
  // `loadBoundedFixture` reads it. Rendering here in the browser runtime and
  // matching the published raster digests is what makes the page's picture the
  // artifact's picture rather than a picture that happens to look right.
  const bundle = JSON.parse(
    readFileSync(new URL("../../../site/registry/mirror/bundle.json", import.meta.url), "utf8"),
  ) as {
    publications: Array<{ app?: string; challengeId?: string; artifact: { body: any } }>;
    challenges: Array<{ id?: string; spec?: { reference?: number[] } }>;
  };

  const generative = bundle.publications.find((entry) => entry.app === "ai-generative")!;
  const genBody = generative.artifact.body;
  const genBytes = renderProofPicture(genBody, genBody.media.size);
  assert.equal(createHash("sha256").update(genBytes).digest("hex"), genBody.media.raster);
  assert.equal(genBytes.length, genBody.media.size * genBody.media.size * 3);

  const bounded = bundle.publications.find((entry) => entry.app === "ai-bounded")!;
  const boundedBody = bounded.artifact.body;
  const challenge = bundle.challenges.find((entry) => entry.id === bounded.challengeId)!;
  const media = boundedBody.media;
  const strip = renderBoundedPicture(challenge.spec!.reference!, boundedBody.values, {
    width: media.width,
    height: media.height,
    rule: media.rule,
  });
  assert.equal(createHash("sha256").update(strip).digest("hex"), media.raster);

  // And a rule this page does not implement is refused, not drawn.
  assert.throws(() => renderProofPicture({ ...genBody, media: { rule: "someone-elses-v9" } }, 64));
  assert.throws(() => renderBoundedPicture(challenge.spec!.reference!, boundedBody.values, { rule: "someone-elses-v9" }));
});
