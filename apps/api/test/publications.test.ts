import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Attestation } from "../../../packages/core/src/index.ts";
import { publicationFromSignedInput, type PublishInput } from "../src/publications.ts";

/**
 * The field mapping between what an agent submits and what the registry keeps —
 * extracted from the publish route so it exists in ONE place. These tests hold
 * the mapping's observable decisions; the route's own suite remains the
 * regression guard for the delegation.
 */

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as {
  publications: Array<{
    attestation: Record<string, unknown>;
    challengeId: string;
  }>;
};
const realAttestation = committed.publications[0]!.attestation as unknown as Attestation;

const baseInput: PublishInput = {
  author: "resident",
  title: "A record made offline",
  body: "made by an agent with no server",
  app: "rarext",
  challengeId: "gen-starter",
  artifact: { app: "rarext", kind: "text", mediaType: "text/plain", version: 1, body: "hello" },
  parentId: null,
  source: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  authorKey: "8f17318ea68df5775a8d1b04ac31337a8b2cce4a9be8e05b7f9c17802d088712",
  verified: true,
  signature: "sig-bytes",
  nonce: "nonce-1",
};

const extras = (challengeId = "gen-starter") => ({
  attestation: realAttestation,
  verification: "recomputed" as const,
  attestationKeyId: null,
  attestationSignature: null,
  challenge: { id: challengeId },
  suite: "ecdsa-p256" as const,
});

test("the mapping takes challengeId and taskId from the CHALLENGE, not the input", () => {
  const publication = publicationFromSignedInput(baseInput, extras("the-registry-decides"));
  assert.equal(publication.challengeId, "the-registry-decides");
  assert.equal(publication.taskId, "the-registry-decides");
  assert.notEqual(publication.challengeId, baseInput.challengeId);
});

test("a sealed publication keeps its commitment but not its body", () => {
  const publication = publicationFromSignedInput(
    { ...baseInput, visibility: "sealed", artifactCommitment: "commitment-1" },
    extras(),
  );
  assert.equal(publication.visibility, "sealed");
  assert.equal(publication.artifact.body, null, "the body is withheld");
  assert.equal(publication.artifactCommitment, "commitment-1", "the commitment is kept");
  assert.equal(publication.artifact.kind, baseInput.artifact.kind, "the rest of the artifact is untouched");
});

test("defaults and identity fields land where the route used to put them", () => {
  const publication = publicationFromSignedInput(baseInput, extras());
  assert.equal(publication.visibility, "public", "unspecified visibility is public");
  assert.equal(publication.delegatedBy, null);
  assert.equal(publication.artifactCommitment, null);
  assert.equal(publication.signatureAlgorithm, "ecdsa-p256", "the suite comes from the resolved key");
  assert.equal(publication.attestedAt, (realAttestation as { createdAt: string }).createdAt);
  assert.equal(publication.signature, "sig-bytes");
  assert.equal(publication.nonce, "nonce-1");
  assert.ok(publication.id, "the registry mints the id");
  assert.notEqual(
    publicationFromSignedInput(baseInput, extras()).id,
    publication.id,
    "two publications never share an id",
  );
});
