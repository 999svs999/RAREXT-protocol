import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { bundleShapeProblem, verifyBundleShape } from "../src/index.ts";
import {
  PUBLICATION_ROOT_DOMAIN,
  PUBLICATION_ROOT_EXCLUDED_FIELDS,
  PUBLICATION_ROOT_FIELDS,
  publicationRoot,
} from "../src/index.ts";
import type { Publication } from "../src/index.ts";

/** The BYTE hasher core's sha256-shaped ports take, next to the HashFn above: two contracts, and a
 *  test that mixes them up gets a type error rather than a wrong answer. */
const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

const nodeSha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

/** A record of the shape a node stores, with every optional field PRESENT. */
function record(): Publication {
  return {
    id: "reg-1",
    author: "alice",
    authorKey: "alice-key",
    delegatedBy: null,
    signatureAlgorithm: "ecdsa-p256",
    title: "a site that verifies itself",
    body: "the bytes are the argument",
    app: "rarext",
    challengeId: "gen-starter",
    artifact: { kind: "generative", body: { seed: 7, steps: 32 } } as never,
    taskId: "gen-starter",
    circuit: null as never,
    visibility: "public",
    artifactCommitment: null,
    parentId: null,
    source: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    attestedAt: "2026-11-01T00:00:01.000Z",
    verified: true,
    signature: "c2lnbmF0dXJl",
    nonce: "nonce-1",
    attestation: { kind: "rarext.attestation.v1", createdAt: "2026-11-01T00:00:00.500Z" } as never,
    verification: "recomputed",
    attestationKeyId: "registry-key",
    attestationSignature: "YXR0ZXN0",
    // A reader's OBSERVATION of storage, which core's own type says is "not part of the
    // publication" — bookkeeping, and therefore excluded from the root for the same reason an `id`
    // is: it says something ABOUT the record rather than being what the author published.
    durability: {
      policy: "durability-v1",
      source: "registry-observation",
      tier: "durable",
      required: 2,
      live: 2,
      status: "ok",
      observedAt: "2026-11-01T00:00:02.000Z",
      windowMs: 86_400_000,
      blobs: [],
    },
  };
}

/**
 * One mutator per field of `Publication`, typed as a mapped record over the interface.
 *
 * This is the compile-time half of the guard: add a field to `Publication` and this object stops
 * satisfying its type, so the gate fails until somebody decides whether the root covers the new
 * field or excludes it deliberately. A root that silently ignores a field nobody thought about is
 * the failure this exists to prevent.
 */
const mutators: Record<keyof Publication, (entry: Publication) => void> = {
  id: (entry) => { entry.id = "reg-2"; },
  author: (entry) => { entry.author = "mallory"; },
  authorKey: (entry) => { entry.authorKey = "other-key"; },
  delegatedBy: (entry) => { entry.delegatedBy = "alice-key"; },
  signatureAlgorithm: (entry) => { entry.signatureAlgorithm = "ml-dsa-65"; },
  title: (entry) => { entry.title = "another title"; },
  body: (entry) => { entry.body = "another body"; },
  app: (entry) => { entry.app = "another-app"; },
  challengeId: (entry) => { entry.challengeId = "other-challenge"; },
  artifact: (entry) => { entry.artifact = { kind: "bounded", body: {} } as never; },
  taskId: (entry) => { entry.taskId = "other-task"; },
  circuit: (entry) => { entry.circuit = { gates: 1 } as never; },
  visibility: (entry) => { entry.visibility = "sealed"; },
  artifactCommitment: (entry) => { entry.artifactCommitment = "a".repeat(64); },
  parentId: (entry) => { entry.parentId = "parent-1"; },
  source: (entry) => { entry.source = { kind: "url", repo: null, url: "https://example.com", ref: null, path: null, commit: null, license: null }; },
  createdAt: (entry) => { entry.createdAt = "2026-11-01T01:00:00.000Z"; },
  attestedAt: (entry) => { entry.attestedAt = "2026-11-01T02:00:00.000Z"; },
  verified: (entry) => { entry.verified = false; },
  signature: (entry) => { entry.signature = "b3RoZXI="; },
  nonce: (entry) => { entry.nonce = "nonce-2"; },
  attestation: (entry) => { entry.attestation = { kind: "rarext.attestation.v1", createdAt: "2026-11-01T03:00:00.000Z" } as never; },
  verification: (entry) => { entry.verification = "operator"; },
  attestationKeyId: (entry) => { entry.attestationKeyId = "other-registry-key"; },
  attestationSignature: (entry) => { entry.attestationSignature = "b3RoZXI="; },
  durability: (entry) => {
    entry.durability = { ...(entry.durability as NonNullable<Publication["durability"]>), tier: "pinned", live: 1, status: "under-replicated" };
  },
};

test("the root is recomputed from the record: canonical, and blind to the fields that are bookkeeping", () => {
  const first = publicationRoot(record(), nodeSha256);
  assert.match(first, /^[0-9a-f]{64}$/);

  // Field ORDER is not content: the same record written in another key order is the same object.
  const reordered = record();
  const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as Publication;
  assert.equal(publicationRoot(shuffled, nodeSha256), first, "canonicalization does the ordering work");

  // And the same content from two publishers is ONE object: a minted id is a label, not identity.
  const otherPublisher = record();
  otherPublisher.id = "a-completely-different-id";
  assert.equal(publicationRoot(otherPublisher, nodeSha256), first);
});

test("EVERY field is either covered or excluded on purpose — and the excluded ones provably do not move the root", () => {
  const base = record();
  const baseRoot = publicationRoot(base, nodeSha256);
  const tried: string[] = [];

  for (const [field, mutate] of Object.entries(mutators)) {
    const entry = record();
    mutate(entry);
    const mutated = publicationRoot(entry, nodeSha256);
    tried.push(field);

    if ((PUBLICATION_ROOT_EXCLUDED_FIELDS as readonly string[]).includes(field)) {
      assert.equal(mutated, baseRoot, `${field} is bookkeeping and must not move the root`);
    } else {
      assert.notEqual(mutated, baseRoot, `${field} is content and must move the root`);
    }
  }

  assert.deepEqual(tried.sort(), Object.keys(base).sort(), "every field of the record was decided on");
  assert.deepEqual(
    Object.keys(PUBLICATION_ROOT_FIELDS).sort(),
    Object.keys(base).sort(),
    "the field map is exactly the record's fields, so the compile-time guard is the whole guard",
  );
  // The exclusion list is exactly the bookkeeping half — no more, no less.
  assert.deepEqual([...PUBLICATION_ROOT_EXCLUDED_FIELDS].sort(), ["attestationKeyId", "attestationSignature", "attestedAt", "durability", "id"].sort());
});

test("the root is domain-separated, and what it hashes is the record minus its labels", () => {
  // A HashFn is a PORT, so a test can bring one that LOOKS at what is being hashed: the domain
  // prefix is real, and the excluded labels are really absent from the preimage.
  const seen: string[] = [];
  const spying = (value: string | Uint8Array) => {
    seen.push(typeof value === "string" ? value : new TextDecoder().decode(value));
    return nodeSha256(value);
  };

  const entry = record();
  publicationRoot(entry, spying);

  assert.equal(seen.length, 1, "one hash, over one canonical string");
  const preimage = seen[0]!;
  assert.ok(preimage.startsWith(`${PUBLICATION_ROOT_DOMAIN}\n`), "the domain prefix is the first thing hashed");
  assert.ok(preimage.includes("the bytes are the argument"), "the body is covered");
  assert.ok(!preimage.includes("reg-1"), "a minted id is not");
  assert.ok(!preimage.includes("2026-11-01T00:00:01.000Z"), "nor when a node wrote it down");
  assert.ok(!preimage.includes("registry-key"), "nor which key attested it");
});

test("a record is served with things attached that are NOT part of it, and the root ignores them", () => {
  // The API hands a publication out with its `root` and its durability observation on board, and a
  // client must be able to recompute the digest it was given from exactly what it received — no
  // stripping, no ceremony. This was broken in the first version, which walked the record's own
  // keys: the served copy hashed differently from the stored one, and a naive client could not
  // check the node's claim at all. The field map is why it is now ignored by construction.
  const stored = record();
  const root = publicationRoot(stored, nodeSha256);

  const asServed = { ...stored, root, durability: null, links: { self: "/v1/publications/x" } } as Publication;
  assert.equal(publicationRoot(asServed, nodeSha256), root, "presentation keys do not move the root");

  // And an UNKNOWN key is ignored even when it looks like content — the map is the list, so a
  // client adding a field of its own cannot invent a different object.
  const withExtra = { ...stored, myNotes: "scribbled in the margin" } as Publication;
  assert.equal(publicationRoot(withExtra, nodeSha256), root);

  // Content still counts, whichever way it arrives.
  const withRealChange = { ...stored, title: "changed" } as Publication;
  assert.notEqual(publicationRoot(withRealChange, nodeSha256), root);
});

test("a document that is not a bundle is refused BY NAME, not with a TypeError", () => {
  // The resolver reaches this with whatever a candidate served: a publication record, a search
  // result, an error envelope. Walking into `bundle.publications.map` threw
  // "Cannot read properties of undefined (reading 'map')" — and that string reached the command
  // line as the REASON a reference failed, which explains nothing to the person reading it.
  assert.match(bundleShapeProblem({})!, /no manifest/);
  assert.match(bundleShapeProblem({ manifest: {} })!, /states no root/);
  assert.match(bundleShapeProblem({ manifest: { root: "a".repeat(64) } })!, /lists no publications/);
  assert.match(bundleShapeProblem({ manifest: { root: "a".repeat(64), publications: [] } })!, /carries no publications/);
  assert.match(bundleShapeProblem([])!, /not a JSON object/);
  assert.match(bundleShapeProblem(record())!, /carries no manifest/, "a publication is not a bundle and is refused as such");
  assert.equal(bundleShapeProblem({ manifest: { root: "a".repeat(64), publications: [] }, publications: [] }), null);

  // The verifier says the same thing rather than throwing, with no invented root.
  const refused = verifyBundleShape(record() as never, bytesSha256);
  assert.equal(refused.valid, false);
  assert.match(refused.reason!, /not a bundle/);
  assert.equal(refused.root, "");
  assert.equal(refused.computedRoot, "");
  assert.equal(refused.publications, 0);
});
