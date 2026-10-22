import assert from "node:assert/strict";
import test from "node:test";

import type { Publication } from "../../../packages/core/src/index.ts";
import { publicationLeaf } from "../src/anchorer.ts";
import { merkleProof, merkleRoot, verifyProof } from "../src/merkle.ts";

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: "pub-1",
    author: "alice",
    authorKey: "a".repeat(64),
    title: "Five-gate half adder",
    body: "Shares the first NAND for sum and carry.",
    app: "logic",
    challengeId: "half-adder",
    artifact: {
      app: "logic",
      kind: "logic.netlist",
      version: 1,
      mediaType: "application/json",
      body: { components: [] },
    },
    taskId: "half-adder",
    circuit: { components: [] },
    parentId: null,
    source: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    attestedAt: "2026-01-01T00:00:00.000Z",
    verified: true,
    signature: "c2lnbmF0dXJl",
    nonce: "nonce-1",
    attestation: {
      id: "att-1",
      verifier: "fabric-v0",
      app: "logic",
      challengeId: "half-adder",
      taskId: "half-adder",
      circuitHash: "circuit-hash",
      traceHash: "trace-hash",
      correct: true,
      score: 1000,
      gateCount: 5,
      semanticsId: "logic/half-adder",
      semanticsVersion: 1,
      semanticsHash: "semantics-hash",
      claimKind: "satisfies",
      scope: null,
      verifierHash: "verifier-hash",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("the leaf covers the content, not just a summary", () => {
  const base = publicationLeaf(publication());

  const changes: Partial<Publication>[] = [
    { title: "A different title" },
    { body: "A different body" },
    { app: "other" },
    { challengeId: "other" },
    { parentId: "parent-1" },
    { signature: "different-signature" },
    { nonce: "nonce-2" },
    { createdAt: "2026-01-02T00:00:00.000Z" },
    { source: { kind: "github", repo: "o/r", url: "https://x", ref: null, commit: null, path: null, license: null } },
  ];

  for (const change of changes) {
    assert.notEqual(
      publicationLeaf(publication(change)),
      base,
      `changing ${Object.keys(change)[0]} must change the leaf`,
    );
  }
});

test("the leaf covers the artifact and the claim binding", () => {
  const base = publicationLeaf(publication());

  const otherArtifact = publication({
    artifact: {
      app: "logic",
      kind: "logic.netlist",
      version: 1,
      mediaType: "application/json",
      body: { components: [{ id: "a", type: "INPUT" }] },
    },
  });

  assert.notEqual(publicationLeaf(otherArtifact), base);

  const otherClaim = publication({
    attestation: {
      ...publication().attestation,
      semanticsId: "logic/other",
    },
  });

  assert.notEqual(publicationLeaf(otherClaim), base);
});

test("the leaf is reproducible from the stored publication", () => {
  const stored = JSON.parse(JSON.stringify(publication())) as Publication;

  assert.equal(publicationLeaf(stored), publicationLeaf(publication()));
});

test("anchors made before the full leaf still verify", () => {
  const original = publication();
  const legacyLeaf = publicationLeaf(original, 1);
  const currentLeaf = publicationLeaf(original, 2);

  assert.notEqual(legacyLeaf, currentLeaf);

  const legacyRoot = merkleRoot([legacyLeaf]);
  const proof = merkleProof([legacyLeaf], 0);

  assert.equal(verifyProof(legacyLeaf, proof, legacyRoot, 0), true);
  assert.equal(verifyProof(currentLeaf, proof, legacyRoot, 0), false);
});

test("the leaf ignores per-verification fields", () => {
  const first = publication();
  const second = publication({
    attestation: {
      ...first.attestation,
      id: "att-2",
      createdAt: "2026-02-02T00:00:00.000Z",
    },
  });

  assert.equal(publicationLeaf(second), publicationLeaf(first));
});

test("a mirror serving altered content cannot match the anchor root", () => {
  const original = publication();
  const leaves = [publicationLeaf(original)];
  const root = merkleRoot(leaves);
  const proof = merkleProof(leaves, 0);

  assert.equal(verifyProof(leaves[0]!, proof, root, 0), true);

  const tampered = publicationLeaf(publication({ title: "A different title" }));

  assert.equal(verifyProof(tampered, proof, root, 0), false);
});

test("a mirror serving identical content matches the anchor root", () => {
  const leaves = [publicationLeaf(publication())];
  const root = merkleRoot(leaves);

  // A mirror receives the publication, recomputes the leaf the same way, and
  // lands on the same root the chain holds.
  const mirrorCopy = JSON.parse(JSON.stringify(publication())) as Publication;
  const mirrorLeaves = [publicationLeaf(mirrorCopy)];

  assert.equal(mirrorLeaves[0], leaves[0]);
  assert.equal(merkleRoot(mirrorLeaves), root);
});
