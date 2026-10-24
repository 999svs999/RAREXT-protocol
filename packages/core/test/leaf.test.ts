import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalize } from "../src/canonical.ts";
import { leafPayload, PUBLICATION_LEAF_VERSION } from "../src/leaf.ts";
import type { Attestation, Publication } from "../src/types.ts";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

const legacyAttestation: Attestation = {
  id: "att-1",
  verifier: "rarext-v0",
  taskId: "half-adder",
  circuitHash: "c".repeat(64),
  traceHash: "t".repeat(64),
  correct: true,
  score: 100,
  gateCount: 5,
  semanticsId: "logic/half-adder",
  semanticsVersion: 1,
  semanticsHash: "s".repeat(64),
  claimKind: "satisfies",
  scope: null,
  verifierHash: "v".repeat(64),
  proofKind: "recomputable",
  signatureAlgorithm: "ecdsa-p256",
  cryptoProfile: "classical",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const aiAttestation: Attestation = {
  ...legacyAttestation,
  id: "att-ai",
  representation: "bounded",
  metricName: "maxAbsError",
  metricValue: 2,
};

function publication(attestation: Attestation): Publication {
  return {
    id: "pub-1",
    author: "alice",
    authorKey: "a".repeat(64),
    signatureAlgorithm: "ecdsa-p256",
    title: "An AI build",
    body: "A claim.",
    app: "ai-bounded",
    challengeId: "bounded-1",
    taskId: "bounded-1",
    artifact: {
      app: "ai-bounded",
      kind: "ai.bounded",
      version: 1,
      mediaType: "application/json",
      body: { values: [1, 2, 3] },
    },
    parentId: null,
    source: null,
    visibility: "public",
    artifactCommitment: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    attestedAt: "2026-01-01T00:00:00.000Z",
    verified: true,
    nonce: "n".repeat(16),
    signature: "sig",
    attestation,
  };
}

test("current leaf version is 4", () => {
  assert.equal(PUBLICATION_LEAF_VERSION, 4);
});

test("v4 leaf commits the representation and bounded-metric evidence", () => {
  const leaf = leafPayload(publication(aiAttestation)) as {
    leafVersion: number;
    attestation: Record<string, unknown>;
  };

  assert.equal(leaf.leafVersion, 4);
  assert.equal(leaf.attestation.representation, "bounded");
  assert.equal(leaf.attestation.metricName, "maxAbsError");
  assert.equal(leaf.attestation.metricValue, 2);

  const tampered = publication({ ...aiAttestation, representation: "exact" });
  assert.notEqual(
    sha256(leafPayload(publication(aiAttestation))),
    sha256(leafPayload(tampered)),
  );
});

test("a legacy publication's v3 leaf is byte-identical to the pre-v4 implementation", () => {
  const legacy = publication(legacyAttestation);

  const v3 = leafPayload(legacy, 3) as { leafVersion: number; attestation: Record<string, unknown> };
  const v4 = leafPayload(legacy, 4) as { leafVersion: number; attestation: Record<string, unknown> };

  assert.equal(v3.leafVersion, 3);
  assert.equal(v4.leafVersion, 4);
  assert.equal("representation" in v4.attestation, false);
  assert.equal("metricName" in v4.attestation, false);

  // The exact object the v3 implementation produced — old bundles anchored at
  // leafVersion 3 must keep verifying against it.
  const oldV3 = {
    leafVersion: 3,
    id: legacy.id,
    author: legacy.author,
    authorKey: legacy.authorKey,
    title: legacy.title,
    body: legacy.body,
    app: legacy.app,
    challengeId: legacy.challengeId,
    taskId: legacy.taskId,
    artifact: legacy.artifact,
    circuit: legacy.circuit ?? null,
    parentId: legacy.parentId,
    source: legacy.source,
    createdAt: legacy.createdAt,
    nonce: legacy.nonce,
    signature: legacy.signature,
    attestation: {
      circuitHash: legacy.attestation.circuitHash,
      traceHash: legacy.attestation.traceHash,
      correct: legacy.attestation.correct,
      score: legacy.attestation.score,
      gateCount: legacy.attestation.gateCount,
      semanticsId: legacy.attestation.semanticsId,
      semanticsVersion: legacy.attestation.semanticsVersion,
      semanticsHash: legacy.attestation.semanticsHash,
      claimKind: legacy.attestation.claimKind,
      scope: legacy.attestation.scope,
      verifierHash: legacy.attestation.verifierHash,
    },
    signatureAlgorithm: legacy.signatureAlgorithm,
    cryptoProfile: legacy.attestation.cryptoProfile,
  };

  assert.equal(sha256(v3), sha256(oldV3));
});

test("v3 shape stays version-faithful even for AI attestations", () => {
  const v3 = leafPayload(publication(aiAttestation), 3) as {
    attestation: Record<string, unknown>;
  };

  assert.equal("representation" in v3.attestation, false);
  assert.equal("metricName" in v3.attestation, false);
  assert.equal("metricValue" in v3.attestation, false);
});

test("v1/v2 legacy shapes are unchanged", () => {
  const pub = publication(legacyAttestation);
  const v1 = leafPayload(pub, 1) as Record<string, unknown>;
  const v2 = leafPayload(pub, 2) as Record<string, unknown>;

  assert.equal("leafVersion" in v1, false);
  assert.equal(v2.leafVersion, 2);
  assert.equal("title" in v1, false);
  assert.equal("title" in v2, true);
});
