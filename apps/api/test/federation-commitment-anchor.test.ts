import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Bundle, Publication } from "../../../packages/core/src/index.ts";
import {
  FEDERATION_APP,
  REGISTRY_LIST_COMMITMENT_KIND,
  federationCommitmentArtifact,
  parseFederationCommitmentArtifact,
  parseRegistrySeedList,
  registryListDigest,
} from "../../../packages/core/src/index.ts";
import { PUBLICATION_LEAF_VERSION } from "../../../packages/core/src/index.ts";
import { anchorPending, publicationLeaf } from "../src/anchorer.ts";
import { merkleRoot } from "../src/merkle.ts";
import { nodeSha256 } from "../src/digest.ts";
import { RarextStore } from "../src/store.ts";

/**
 * RFC 0020's write half, proven with the REAL components: the anchorer, the
 * default adapter registry (which includes the `local` rail — no network), and
 * the committed publications.
 *
 * The claim to prove is not "a commitment can be attached to a bundle" but "a
 * commitment is ANCHORED with it": the anchor's root must be the root over the
 * publications INCLUDING the commitment, so tampering with the committed digest
 * makes the anchor point at a root the tampered publications cannot rebuild.
 */

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as Bundle;

// The leaf helper binds the version the committed bundle was built with, so the
// single-argument form and the manifest's leafVersion are the same commitment.
assert.equal(committed.manifest.leafVersion, PUBLICATION_LEAF_VERSION);

/** A publication shaped like the registry's own, carrying the commitment. */
function commitmentPublication(listUrl: string, digest: string): Publication {
  const sample = committed.publications[0];
  // Same shape the publisher produces, including the stripped AI attestation:
  // a commitment is not a rendition, and the fixture should not be able to hide
  // that by looking different from the real thing.
  const attestation = { ...(sample.attestation as unknown as Record<string, unknown>) };
  delete attestation.representation;
  return {
    ...sample,
    id: "pub-federation-commitment",
    title: "The federation list this bundle commits to",
    attestation: attestation as never,
    artifact: {
      ...sample.artifact,
      ...federationCommitmentArtifact({ listUrl, digest, generatedAt: "2026-10-28T00:00:00.000Z" }),
    },
  } as Publication;
}

/** The live bundle's publications WITHOUT any commitment, as the baseline. */
const withoutCommitment = committed.publications.filter(
  (publication) => publication.artifact?.kind !== REGISTRY_LIST_COMMITMENT_KIND,
);

test("a commitment publication is inside the ANCHOR, not merely beside it", async () => {
  const listUrl = "https://999svs999.github.io/RAREXT-protocol/registry/seed.json";
  const entries = parseRegistrySeedList(
    JSON.parse(readFileSync("site/registry/seed.json", "utf8")) as unknown,
  );
  assert.ok(entries.length > 0, "the published seed names at least one registry");
  const digest = registryListDigest(entries, nodeSha256);

  const store = new RarextStore();
  for (const publication of withoutCommitment) store.addPublication(publication);
  const before = await anchorPending(store);
  assert.ok(before, "the store's publications anchor");
  const rootWithoutCommitment = before.root;

  // Now the same publications, plus the commitment.
  const store2 = new RarextStore();
  for (const publication of withoutCommitment) store2.addPublication(publication);
  const commitment = commitmentPublication(listUrl, digest);
  store2.addPublication(commitment);

  const anchor = await anchorPending(store2);
  assert.ok(anchor, "a batch that includes the commitment anchors");
  assert.notEqual(
    anchor.root,
    rootWithoutCommitment,
    "the commitment must move the anchored root — otherwise it is not anchored, just attached",
  );

  // The anchor's root is the root over the publications INCLUDING the commitment,
  // recomputed here by the test rather than taken from the anchorer.
  const publications = [...withoutCommitment, commitment];
  const leaves = publications.map((publication) =>
    publicationLeaf(publication),
  );
  assert.equal(
    merkleRoot(leaves),
    anchor.root,
    "the anchored root covers the commitment's leaf",
  );
  assert.equal(anchor.leafCount, publications.length, "and the anchor says how many leaves it covers");

  // The commitment is readable from the publications, and its digest is the
  // digest of the published list.
  const found = publications
    .map((publication) => parseFederationCommitmentArtifact(publication.artifact as never))
    .find((body) => body !== null);
  assert.ok(found, "the commitment is found among the anchored publications");
  assert.equal(found.digest, digest);
  assert.equal(found.listUrl, listUrl);
  assert.equal(found.generatedAt, "2026-10-28T00:00:00.000Z");

  // And the anchor recorded a reference through the local rail: anchoring here
  // needs no network, which is what makes this flow reachable in this repo.
  assert.equal(anchor.adapter, "local", `the local rail anchored it: ${JSON.stringify(anchor.adapter)}`);
  assert.match(String(anchor.reference), /^local:[0-9a-f]{16}$/);
});

test("a tampered commitment cannot rebuild the anchored root", async () => {
  const listUrl = "https://999svs999.github.io/RAREXT-protocol/registry/seed.json";
  const entries = parseRegistrySeedList(
    JSON.parse(readFileSync("site/registry/seed.json", "utf8")) as unknown,
  );
  const digest = registryListDigest(entries, nodeSha256);

  const store = new RarextStore();
  for (const publication of withoutCommitment) store.addPublication(publication);
  store.addPublication(commitmentPublication(listUrl, digest));
  const anchor = await anchorPending(store);
  assert.ok(anchor);

  // Swap the committed digest for another list's. The anchored root no longer
  // matches, which is the ONLY reason to anchor it at all.
  const tampered = commitmentPublication(listUrl, "0".repeat(64));
  const leaves = [...withoutCommitment, tampered].map((publication) =>
    publicationLeaf(publication),
  );
  assert.notEqual(
    merkleRoot(leaves),
    anchor.root,
    "a different committed digest must not rebuild the anchored root",
  );
});

test("core's shape round-trips, and refuses anything else", () => {
  const artifact = federationCommitmentArtifact({
    listUrl: "https://l.example/registries",
    digest: "a".repeat(64),
    generatedAt: "2026-10-28T00:00:00.000Z",
  });
  assert.equal(artifact.app, FEDERATION_APP);
  assert.equal(artifact.kind, REGISTRY_LIST_COMMITMENT_KIND);
  assert.deepEqual(parseFederationCommitmentArtifact(artifact), {
    listUrl: "https://l.example/registries",
    digest: "a".repeat(64),
    generatedAt: "2026-10-28T00:00:00.000Z",
  });

  assert.equal(parseFederationCommitmentArtifact({ app: "logic", kind: "netlist", body: "{}" }), null);
  assert.equal(parseFederationCommitmentArtifact({ app: FEDERATION_APP, kind: "other", body: "{}" }), null);
  assert.equal(
    parseFederationCommitmentArtifact(
      federationCommitmentArtifact({ listUrl: "x", digest: "", generatedAt: "" }),
    ),
    null,
    "a body missing the fields is not a commitment",
  );
  assert.equal(
    parseFederationCommitmentArtifact({ app: FEDERATION_APP, kind: REGISTRY_LIST_COMMITMENT_KIND, body: "{not json" }),
    null,
    "a malformed body is refused, not guessed",
  );
});
