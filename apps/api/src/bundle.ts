import {
  planSeedUnion,
  readBundleResponseBytes,
  verifyBundleShape,
  verifyCandidates,
  type BundleSeed,
} from "../../../packages/core/src/index.ts";
import type {
  Bundle,
  BundleVerification,
  Challenge,
  Publication,
  SeedPin,
  Semantics,
} from "../../../packages/core/src/index.ts";

import { PUBLICATION_LEAF_VERSION, publicationLeaf } from "./anchorer.ts";
import { nodeSha256 } from "./digest.ts";
import type { RarextStore } from "./store.ts";

export const BUNDLE_VERSION = 1;

export type { Bundle, BundleManifest, BundleVerification } from "../../../packages/core/src/index.ts";

/**
 * A bundle is the registry in a form anyone can hold: the publications that
 * were anchored, the anchors themselves, the challenges, and the semantics.
 *
 * It is self-verifying. Recomputing the leaves from the publications and
 * rebuilding the Merkle root must land on the root the chain holds, so a mirror
 * can be checked without trusting whoever served it.
 */
export function buildBundle(
  store: RarextStore,
  challenges: Challenge[],
  semantics: Semantics[],
  root?: string,
): Bundle | null {
  const anchors = store.listAnchors();
  const anchor = root
    ? anchors.find((candidate) => candidate.root === root) ?? null
    : anchors[0] ?? null;

  if (!anchor) return null;

  const publications = anchor.publicationIds
    .map((id) => store.getPublication(id))
    .filter((publication): publication is Publication => publication !== null);

  const leafVersion = anchor.leafVersion ?? 1;
  const leaves = publications.map((publication) =>
    publicationLeaf(publication, leafVersion),
  );

  return {
    manifest: {
      version: BUNDLE_VERSION,
      root: anchor.root,
      leafVersion,
      anchorId: anchor.id,
      anchorRoot: anchor.root,
      createdAt: anchor.createdAt,
      publications: publications.map((publication, index) => ({
        id: publication.id,
        leaf: leaves[index]!,
      })),
      counts: {
        publications: publications.length,
        anchors: anchors.length,
        challenges: challenges.length,
        semantics: semantics.length,
      },
    },
    publications,
    anchors,
    challenges,
    semantics,
  };
}

export function verifyBundle(bundle: Bundle): BundleVerification {
  return verifyBundleShape(bundle, nodeSha256);
}

export function bundleSummary(bundle: Bundle): string {
  return (
    `bundle v${bundle.manifest.version} · ${bundle.manifest.publications.length} publications · ` +
    `root ${bundle.manifest.root.slice(0, 12)}`
  );
}

/** The seed list a client discovers mirrors from (docs/MIRRORS.md). */
export interface SeedDocument extends BundleSeed {
  /**
   * The bundle's content address, when the publisher pins it: a CIDv1 over the
   * raw sha2-256 of the EXACT published bytes. When present it is authoritative
   * — a mirror that re-serializes the same bundle with different whitespace
   * serves different bytes, and different bytes are a different artifact.
   */
  bundleCid?: string;
  /**
   * What the publisher handed to a pinning service, additive over `bundleCid`:
   * one entry per configured service — `{ cid, service, reference }` when the
   * service accepted the pin, `{ cid, service, error }` when it did not. Empty
   * or absent when no service was configured, because a pin nobody accepted is
   * not recorded as one. `verify-seed-mirrors.mjs` resolves each entry.
   */
  pins?: SeedPin[];
}

export interface VerifiedBundleSource {
  bundle: Bundle;
  root: string;
  source: string;
}

/** What multi-seed discovery adds to a single verified copy: its provenance. */
export interface VerifiedBundleFromSeeds extends VerifiedBundleSource {
  /** How many distinct candidate URLs the union held. */
  candidates: number;
  /** The seeds (their URLs) that nominated the winning copy. */
  seeds: string[];
}

/**
 * Federation's first step: find a bundle by trying the seed's own URL and then
 * each mirror, accepting the first copy that REBUILDS THE ROOT THE SEED PINS.
 *
 * Internal validity is not enough — a mirror can rewrite both its bundle and
 * the root inside it — so the pin is what makes the copy trustworthy. A
 * candidate that fails anywhere (a 404, malformed JSON, a root that does not
 * rebuild, a valid bundle whose root is not the pinned one) is skipped with its
 * reason recorded; if none verifies, the error names every candidate and why,
 * so an outage reads as evidence rather than as an opaque failure.
 */
export async function bundleFromSeed(
  seed: SeedDocument,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<VerifiedBundleSource> {
  const found = await bundleFromSeeds([seed], options);
  return { bundle: found.bundle, root: found.root, source: found.source };
}

/**
 * The same search across SEEDS, the API-side twin of the SDK's
 * `findVerifiedBundleFromSeeds`: the union of every seed's own bundle URL and
 * its mirrors, deduplicated, verified against the pins of the seeds that
 * nominated each copy, and — planning it before anything is fetched — one
 * disagreement rule, core's `planSeedUnion`, the exact one the SDK applies:
 * every seed naming the same primary `bundle` URL must pin the same
 * `bundleRoot` and the same `bundleCid` when both carry one, and any
 * disagreement throws naming the registry, the field, and every value with the
 * seed URL that pinned it. A seed without a `bundleCid` beside one that has it
 * is not a disagreement, and the stricter pin governs the shared candidates.
 */
export async function bundleFromSeeds(
  seeds: SeedDocument[],
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<VerifiedBundleFromSeeds> {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const plan = planSeedUnion(seeds);

  // The per-candidate sequence — fetch the bytes (capped, exactly as the seed
  // docs publish), the CID pin over the bytes, the shape, the recomputed root
  // against the pin, every refusal recorded — is core's `verifyCandidates`.
  // This file injects node fetch and node:crypto; the sequence itself lives in
  // one place, so a fix lands in every client at once.
  const outcome = await verifyCandidates({
    plan,
    attribute: seeds.length > 1,
    sha256: nodeSha256,
    fetchBytes: async (url) => {
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return readBundleResponseBytes(response);
    },
  });

  if (outcome.status !== "verified") throw new Error(outcome.message);
  return outcome;
}
