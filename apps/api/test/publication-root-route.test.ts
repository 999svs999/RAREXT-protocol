import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { publicationRoot } from "../../../packages/core/src/index.ts";
import type { Publication } from "../../../packages/core/src/index.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop } from "./helpers.ts";

/** The same rule the node uses, brought by the client — which is the whole point of a root. */
const clientHash = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

function record(id: string): Publication {
  return {
    id,
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
    circuit: undefined,
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
  };
}

test("a publication is addressable by its ROOT: the client recomputes what the node claims", async () => {
  const stored = record("reg-minted-label");
  const expected = publicationRoot(stored, clientHash);
  const store = new RarextStore();
  store.addPublication(stored);
  const { server, base } = await start(store);

  try {
    // 1. By id, as before — a label still works.
    const byId = await fetch(`${base}/v1/publications/reg-minted-label`);
    assert.equal(byId.status, 200);
    const served = (await byId.json()) as Publication & { root: string };
    assert.equal(served.id, stored.id);
    assert.equal(served.root, expected, "the node's answer is the client's own recomputation");

    // 2. The claim is not a field to trust: recompute it from exactly what was SERVED, with the
    //    node's own mapping and hasher out of the picture entirely. No stripping the `root` field
    //    off first — a client that had to know to do that would not really be able to check
    //    anything, and the first version of this rule secretly required it.
    assert.equal(
      publicationRoot(served as Publication, clientHash),
      served.root,
      "the served record rebuilds to the served root, using the response as it arrived",
    );

    // 3. And the root addresses it, which is what a client that holds only a reference has.
    assert.notEqual(expected, stored.id, "the root is not the minted label");
    const byRoot = await fetch(`${base}/v1/publications/${expected}`);
    assert.equal(byRoot.status, 200);
    assert.equal(((await byRoot.json()) as Publication).id, stored.id);

    // 4. A root that no record rebuilds to is a 404, not a guess.
    const unknown = await fetch(`${base}/v1/publications/${"c".repeat(64)}`);
    assert.equal(unknown.status, 404);

    // 5. IDENTITY, not labels: the same published content under two minted ids is ONE object, and
    //    the node answers a root lookup with either copy — because they are the same thing.
    store.addPublication(record("another-minted-label"));
    const viaRoot = await fetch(`${base}/v1/publications/${expected}`);
    assert.equal(viaRoot.status, 200);
    const answer = (await viaRoot.json()) as Publication & { root: string };
    assert.equal(answer.root, expected);
    assert.ok(["reg-minted-label", "another-minted-label"].includes(answer.id));
  } finally {
    await stop(server);
  }
});

test("a record that differs in one covered field is a DIFFERENT object, and its digest does not answer for the other", async () => {
  const honest = record("reg-1");
  const tampered: Publication = { ...honest, id: "reg-2", title: "a site that verifies itself " };
  const store = new RarextStore();
  store.addPublication(honest);
  store.addPublication(tampered);
  const { server, base } = await start(store);

  try {
    const honestRoot = publicationRoot(honest, clientHash);
    const tamperedRoot = publicationRoot(tampered, clientHash);
    assert.notEqual(honestRoot, tamperedRoot, "a whitespace edit is a different record");

    const found = (await (await fetch(`${base}/v1/publications/${honestRoot}`)).json()) as Publication;
    assert.equal(found.title, honest.title, "the root answers with the record it names, not the near-copy");
    const other = (await (await fetch(`${base}/v1/publications/${tamperedRoot}`)).json()) as Publication;
    assert.equal(other.title, tampered.title);
  } finally {
    await stop(server);
  }
});
