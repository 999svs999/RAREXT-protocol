import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Anchor, Bundle } from "../../../packages/core/src/index.ts";
import { merkleRoot, publicationLeaf } from "@rarext/core";
import { buildBundle, replayBundleAi, verifyBundle } from "../src/index.ts";

/**
 * Building a bundle offline — the publishing half of the rule the SDK already
 * verifies.
 *
 * An agent with no server could verify a bundle and replay its AI claims, and
 * could not MAKE one, which is half a protocol: "AI lives on RAREXT" includes
 * producing the artifact, not only checking it. The assembly comes from core, the
 * same function the registry's own builder calls, so the two cannot drift.
 */

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as Bundle;
const nodeSha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

test("a bundle built offline verifies, and its root is the root over its own leaves", () => {
  const publications = committed.publications;
  const bundle = buildBundle(publications, {
    challenges: committed.challenges,
    semantics: committed.semantics,
    leafVersion: committed.manifest.leafVersion,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  const verification = verifyBundle(bundle);
  assert.equal(verification.valid, true, verification.reason ?? undefined);

  // The root recomputed here, from the leaves, with no help from the builder.
  const leaves = publications.map((publication) =>
    publicationLeaf(publication, nodeSha256, committed.manifest.leafVersion),
  );
  assert.equal(
    bundle.manifest.root,
    merkleRoot(leaves, nodeSha256),
    "the builder's root is the Merkle root over the publications it was given",
  );
  assert.deepEqual(
    bundle.manifest.publications.map((entry) => entry.id),
    publications.map((publication) => publication.id),
    "and the manifest lists exactly those publications, in order",
  );
  assert.equal(bundle.manifest.leafVersion, committed.manifest.leafVersion);
  assert.equal(bundle.manifest.anchorId, null, "a bundle built offline names no anchor it does not have");
});

test("a bundle built offline replays the AI claims inside it", () => {
  const bundle = buildBundle(committed.publications, {
    challenges: committed.challenges,
    semantics: committed.semantics,
    leafVersion: committed.manifest.leafVersion,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  const replay = replayBundleAi(bundle);
  assert.equal(replay.root, bundle.manifest.root, "the replay ties its verdicts to the bundle's root");
  assert.equal(replay.claims.length, 2, `the two AI representations replay: ${JSON.stringify(replay.claims.map((c) => c.title))}`);
  assert.ok(
    replay.claims.every((claim) => claim.correct === true),
    "and every claim is correct by recomputation, not by assertion",
  );
});

test("a tampered publication does not rebuild the root the bundle declares", () => {
  const tampered = committed.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: `${publication.title} (altered)` } : publication,
  );

  const bundle = buildBundle(tampered, {
    challenges: committed.challenges,
    semantics: committed.semantics,
    leafVersion: committed.manifest.leafVersion,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  // The builder is honest — it declared the root of what it was GIVEN — so the
  // tampering shows up as a bundle that no longer matches the pinned root the
  // world knows.
  assert.notEqual(bundle.manifest.root, committed.manifest.root, "a changed publication is a changed root");
  const verification = verifyBundle({ ...bundle, manifest: { ...bundle.manifest, root: committed.manifest.root } });
  assert.equal(verification.valid, false);
  assert.match(String(verification.reason), /do not rebuild the anchored root/);
});

test("an anchor that covers different publications is refused AT ASSEMBLY, naming both roots", () => {
  const anchor: Anchor = {
    id: "anchor-elsewhere",
    root: "0".repeat(64),
    publicationIds: [],
    leafCount: 0,
    createdAt: "2026-10-28T00:00:00.000Z",
    adapter: "local",
    reference: null,
    receipts: [],
  };

  assert.throws(
    () =>
      buildBundle(committed.publications, {
        anchors: [anchor],
        anchor,
        leafVersion: committed.manifest.leafVersion,
        createdAt: "2026-10-28T00:00:00.000Z",
      }),
    (error: Error) => {
      assert.match(error.message, new RegExp(anchor.root));
      assert.match(error.message, /rebuild/);
      return true;
    },
    "an anchor over other publications is a bundle that cannot verify, and it says so while both numbers are in hand",
  );
});
