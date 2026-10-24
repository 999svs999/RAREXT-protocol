import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import {
  boundedScore,
  boundedVerifierHash,
  computeBoundedMetric,
  isBoundedBody,
  isBoundedSpec,
  maxAbsError,
  meanAbsError,
  verifyBounded,
  verifyBoundedReconstruction,
} from "../src/bounded.ts";
import { createSemanticsRegistry } from "../src/semantics.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";

const reference = [10, 20, 30, 40, 200, 255, 0, 128];

const challenge: Challenge = {
  id: "bounded-1",
  app: "ai-bounded",
  title: "Reconstruct within a metric bound",
  description: "The lossy reconstruction must stay within the committed bound.",
  version: 1,
  spec: { metric: "maxAbsError", bound: 4, reference },
  semanticsId: "ai-bounded/bounded-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function artifactFor(values: number[]): Artifact {
  return {
    app: "ai-bounded",
    kind: "ai.bounded",
    version: 1,
    mediaType: "application/json",
    body: { values, codec: "int8-quantized" },
  };
}

test("metrics are computed exactly", () => {
  assert.equal(maxAbsError([11, 20, 28, 40, 200, 255, 0, 128], reference), 2);
  assert.equal(maxAbsError([10, 20, 30, 40, 200, 255, 0, 128], reference), 0);
  assert.equal(maxAbsError([14, 20, 30, 40, 200, 255, 0, 132], reference), 4);
  // mean of |1+1+2+0+0+0+0+0| / 8 = 0.5
  assert.equal(meanAbsError([11, 21, 32, 40, 200, 255, 0, 128], reference), 0.5);
  assert.equal(computeBoundedMetric("maxAbsError", [11, 20], reference.slice(0, 2)), 1);
});

test("score is graded: perfect 100, at-bound 1, over-bound 0", () => {
  assert.equal(boundedScore(0, 4), 100);
  assert.equal(boundedScore(2, 4), 50);
  assert.equal(boundedScore(4, 4), 1);
  assert.equal(boundedScore(4.5, 4), 0);
  assert.equal(boundedScore(0, 0), 100);
});

test("registry verifies a within-bound reconstruction as bounded", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const reconstruction = reference.map((v) => Math.min(255, Math.max(0, v + 2)));
  const attestation = await registry.verify(artifactFor(reconstruction), challenge);

  assert.equal(attestation.app, "ai-bounded");
  assert.equal(attestation.correct, true);
  assert.equal(attestation.representation, "bounded");
  assert.equal(attestation.metricName, "maxAbsError");
  assert.equal(attestation.metricValue, 2);
  assert.equal(attestation.score, 50);
  assert.equal(attestation.proofKind, "recomputable");
  assert.equal(attestation.gateCount, reference.length);
  assert.equal(attestation.verifierHash, boundedVerifierHash());
  assert.match(attestation.traceHash, /^[0-9a-f]{64}$/);
});

test("registry exposes the bounded app", () => {
  const registry = createVerifierRegistry(fetch, null);
  const app = registry.get("ai-bounded");

  if (!app) throw new Error("ai-bounded verifier not registered");
  assert.equal(app.name, "Bounded AI");
  assert.deepEqual(app.artifactKinds, ["ai.bounded"]);
});

test("an over-bound reconstruction fails with metric recorded", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const bad = reference.map((v) => v + 10);
  const attestation = await registry.verify(artifactFor(bad), challenge);

  assert.equal(attestation.correct, false);
  assert.equal(attestation.score, 0);
  assert.equal(attestation.metricValue, 10);
  assert.equal(attestation.representation, "bounded");
});

test("length mismatch is an error, not a silent failure", async () => {
  const registry = createVerifierRegistry(fetch, null);

  await assert.rejects(
    () => registry.verify(artifactFor(reference.slice(0, 3)), challenge),
    /does not match reference length/,
  );
});

test("meanAbsError bound path works end to end", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const meanChallenge: Challenge = {
    ...challenge,
    id: "bounded-mean",
    spec: { metric: "meanAbsError", bound: 1, reference },
  };
  const reconstruction = reference.map((v) => v + (v % 2 === 0 ? 1 : -1));
  const attestation = await registry.verify(artifactFor(reconstruction), meanChallenge);

  assert.equal(attestation.correct, true);
  assert.equal(attestation.metricName, "meanAbsError");
  assert.equal(attestation.metricValue, 1);
  assert.equal(attestation.score, 1);
});

test("verifyBounded binds the claim and preserves metric fields", async () => {
  const challenges = [challenge];
  const semantics = createSemanticsRegistry(() => challenges);
  const reconstruction = reference.map((v) => v + 1);
  const result = await verifyBounded(artifactFor(reconstruction), challenge, semantics);

  if ("error" in result) throw new Error(result.error);
  const attestation = result.attestation;
  assert.equal(attestation.correct, true);
  assert.equal(attestation.representation, "bounded");
  assert.equal(attestation.metricName, "maxAbsError");
  assert.equal(attestation.semanticsId, challenge.semanticsId);
  assert.ok(attestation.verifierHash.length > 0);
});

test("malformed bodies and specs are rejected", () => {
  assert.equal(isBoundedBody({ values: [] }), false);
  assert.equal(isBoundedBody({ values: [1, "x"] }), false);
  assert.equal(isBoundedBody({ values: [1, NaN] }), false);
  assert.equal(isBoundedBody({ values: [1, Infinity] }), false);
  assert.equal(isBoundedBody({ values: [1, 2] }), true);
  assert.equal(isBoundedSpec({ metric: "cosine", bound: 1, reference }), false);
  assert.equal(isBoundedSpec({ metric: "maxAbsError", bound: -1, reference }), false);
  assert.equal(isBoundedSpec({ metric: "maxAbsError", bound: 4, reference: [] }), false);
  assert.equal(isBoundedSpec({ metric: "meanAbsError", bound: 0.5, reference: [1] }), true);
});

test("wrong app or kind is not supported", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const wrong: Artifact = { ...artifactFor(reference), kind: "ai.generative" };

  await assert.rejects(
    () => registry.verify(wrong, challenge),
    /does not support artifact kind/,
  );
});

test("reconstruction quality is visible in the trace digest", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const good = await registry.verify(artifactFor(reference.map((v) => v + 1)), challenge);
  const better = await registry.verify(artifactFor(reference.map((v) => v + 0.5)), challenge);

  assert.notEqual(good.traceHash, better.traceHash);
  assert.ok((better.metricValue ?? 1) < (good.metricValue ?? 0));
});
