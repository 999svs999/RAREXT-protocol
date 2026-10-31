import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { publicationRoot } from "../src/index.ts";
import {
  ANCHOR_ROOT_DOMAIN,
  ANCHOR_ROOT_EXCLUDED_FIELDS,
  ANCHOR_ROOT_FIELDS,
  anchorRoot,
  matchRecordRoot,
} from "../src/index.ts";
import type { Anchor } from "../src/index.ts";

const nodeSha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

function anchor(): Anchor {
  return {
    id: "minted-label",
    root: "a".repeat(64),
    publicationIds: ["p1", "p2"],
    leafCount: 2,
    leafVersion: 2,
    createdAt: "2026-11-01T00:00:00.000Z",
    adapter: "eip-3009-anchor",
    reference: "0xabc",
    receipts: [{ adapter: "eip-3009-anchor", status: "ok", reference: "0xabc" }],
  };
}

/** One mutator per field, typed over the interface: adding a field stops the build until somebody
 *  decides whether the anchor's root covers it or excludes it. */
const mutators: Record<keyof Anchor, (entry: Anchor) => void> = {
  id: (entry) => { entry.id = "other-label"; },
  root: (entry) => { entry.root = "b".repeat(64); },
  publicationIds: (entry) => { entry.publicationIds = ["p1"]; },
  leafCount: (entry) => { entry.leafCount = 1; },
  leafVersion: (entry) => { entry.leafVersion = 3; },
  createdAt: (entry) => { entry.createdAt = "2026-11-02T00:00:00.000Z"; },
  adapter: (entry) => { entry.adapter = "other-adapter"; },
  reference: (entry) => { entry.reference = "0xdef"; },
  receipts: (entry) => { entry.receipts = []; },
};

test("an anchor's identity is recomputed from the record, blind to what a node minted", () => {
  const base = anchor();
  const baseRoot = anchorRoot(base, nodeSha256);
  assert.match(baseRoot, /^[0-9a-f]{64}$/);

  const reordered = Object.fromEntries(Object.entries(base).reverse()) as Anchor;
  assert.equal(anchorRoot(reordered, nodeSha256), baseRoot, "key order is not content");

  const tried: string[] = [];
  for (const [field, mutate] of Object.entries(mutators)) {
    const entry = anchor();
    mutate(entry);
    const mutated = anchorRoot(entry, nodeSha256);
    tried.push(field);
    if ((ANCHOR_ROOT_EXCLUDED_FIELDS as readonly string[]).includes(field)) {
      assert.equal(mutated, baseRoot, `${field} is bookkeeping and must not move the root`);
    } else {
      assert.notEqual(mutated, baseRoot, `${field} is the claim and must move the root`);
    }
  }
  assert.deepEqual(tried.sort(), Object.keys(base).sort(), "every field was decided on");
  assert.deepEqual(Object.keys(ANCHOR_ROOT_FIELDS).sort(), Object.keys(base).sort());
  // The excluded list is derived from the map, so the two cannot disagree.
  assert.deepEqual([...ANCHOR_ROOT_EXCLUDED_FIELDS].sort(), ["createdAt", "id"].sort());
});

test("matchRecordRoot is the ONE registry of record identities, and it names which rule answered", () => {
  const publication = {
    id: "pub-1",
    author: "alice",
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
    createdAt: "2026-11-01T00:00:00.000Z",
    attestedAt: "2026-11-01T00:00:01.000Z",
    verified: true,
    signature: null,
    nonce: null,
    attestation: { kind: "rarext.attestation.v1", createdAt: "2026-11-01T00:00:00.500Z" },
    verification: "recomputed",
  };
  const anchored = anchor();

  const asPublication = matchRecordRoot(publication, publicationRoot(publication as never, nodeSha256), nodeSha256);
  assert.equal(asPublication?.kind, "publication", "a publication is recognised as one");

  const asAnchor = matchRecordRoot(anchored, anchorRoot(anchored, nodeSha256), nodeSha256);
  assert.equal(asAnchor?.kind, "anchor", "an anchor is recognised as one");

  // Domain separation is what makes trying both safe: neither document matches under the other's
  // rule, so the kind that answers is the kind the caller named.
  // …and neither document answers for the other's root, under either rule.
  assert.equal(matchRecordRoot(publication, anchorRoot(anchored, nodeSha256), nodeSha256), null);
  assert.equal(matchRecordRoot(anchored, publicationRoot(publication as never, nodeSha256), nodeSha256), null);
  assert.equal(matchRecordRoot("not an object", "a".repeat(64), nodeSha256), null);
  assert.equal(matchRecordRoot([1, 2, 3], "a".repeat(64), nodeSha256), null);
});
