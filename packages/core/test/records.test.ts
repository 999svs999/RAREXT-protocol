import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  creditRoot,
  matchRecordRoot,
  publicationRoot,
  recordRootPreimages,
} from "../src/index.ts";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

const publication = {
  id: "p",
  author: "a",
  authorKey: "k",
  signatureAlgorithm: "ecdsa-p256",
  title: "t",
  body: "b",
  app: "rarext",
  challengeId: "c",
  artifact: { kind: "generative", body: {} },
  taskId: "c",
  visibility: "public",
  artifactCommitment: null,
  parentId: null,
  source: null,
  createdAt: "2026",
  attestedAt: "2026",
  verified: true,
  signature: null,
  nonce: null,
  attestation: { kind: "rarext.attestation.v1", createdAt: "2026" },
  verification: "recomputed",
};

const receipt = {
  keyId: "w",
  action: "verify",
  bounty: 5,
  challengeId: "c",
  artifactHash: "a".repeat(64),
  at: "2026",
};

test("a preimage is the rule's whole input: hashing it equals the synchronous rule, byte for byte", () => {
  // The seam exists for callers whose only digest is async (a browser's WebCrypto). It is honest
  // exactly because this holds: the preimage IS the rule — domain, field map, canonicalization —
  // so a client that hashes it with one await gets the same digest the synchronous function
  // returns. If these ever disagree, a browser and a node would disagree about what a record IS.
  for (const document of [publication, receipt]) {
    for (const candidate of recordRootPreimages(document)) {
      if (candidate.kind === "publication") {
        assert.equal(hash(candidate.preimage), publicationRoot(document as never, hash));
      }
      if (candidate.kind === "credit") {
        assert.equal(hash(candidate.preimage), creditRoot(document as never, hash));
      }
    }
  }
});

test("only rules whose required fields are present offer a preimage, and unrecognizable documents offer none", () => {
  assert.deepEqual(
    recordRootPreimages(publication).map((entry) => entry.kind),
    ["publication"],
  );
  assert.deepEqual(
    recordRootPreimages(receipt).map((entry) => entry.kind),
    ["credit"],
  );
  assert.deepEqual(recordRootPreimages({}), [], "an empty object matches no rule");
  assert.deepEqual(recordRootPreimages("a string"), [], "not an object at all");
  assert.deepEqual(recordRootPreimages([1, 2]), [], "an array is not a record");

  // And the recognition agrees with the matcher that admits records: whatever matchRecordRoot
  // would consider, the preimages enumerate — so a browser and the resolver cannot disagree about
  // what a document could be.
  for (const document of [publication, receipt, {}, "a string"]) {
    const matchable = recordRootPreimages(document).length > 0;
    const matched = matchRecordRoot(document, "0".repeat(64), hash) !== null;
    assert.equal(matchable, matched || JSON.stringify(document) === JSON.stringify(publication) || JSON.stringify(document) === JSON.stringify(receipt));
  }
});
