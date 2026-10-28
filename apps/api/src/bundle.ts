import {
  foldAnnouncements,
  unresolvedIdentity,
  planSeedUnion,
  readBundleResponseBytes,
  verifyBundleShape,
  verifyCandidates,
  type AnnouncementEvent,
  type AnnouncementIdentity,
  type AnnouncementVerifier,
  type BundleSeed,
  assembleBundle,
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
import { keyId, suiteFor, verifyPayload } from "./identity.ts";
import type { RarextStore } from "./store.ts";
import { announcementIdentityForStore } from "./announcement-identity.ts";

export const BUNDLE_VERSION = 1;

export type { Bundle, BundleManifest, BundleVerification } from "../../../packages/core/src/index.ts";
export type { AnnouncementEvent } from "../../../packages/core/src/index.ts";

/**
 * The signature machinery core's `foldAnnouncements` runs behind on the API
 * path: the key id and the suite are derived from the carried key (by
 * `keyId` and `suiteFor`, never claimed by the record), and the signature is
 * checked by this server's own `verifyPayload` — the same primitives every
 * signed publication this API accepts is verified with, so an announcement
 * gets no bespoke crypto of its own. The sequence that applies them lives in
 * core; this file only names where the primitives come from.
 */
const announcementPrimitives = {
  keyIdOf: keyId,
  suiteOf: suiteFor,
  verify: verifyPayload,
};
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

  // The assembly — leaves, root, manifest — lives in core, because the VERIFIER
  // lives there and the two are one rule read in two directions. This function
  // keeps only what is the registry's business: choosing which anchored batch to
  // serve.
  return assembleBundle({
    publications,
    anchors,
    challenges,
    semantics,
    anchor,
    leafVersion: anchor.leafVersion ?? 1,
    createdAt: anchor.createdAt,
    sha256: nodeSha256,
    bundleVersion: BUNDLE_VERSION,
  });
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
  /**
   * RFC 0019 step 1: announcement document URLs, inherited from core's
   * `BundleSeed` because the fold that reads them is core's too — this path
   * adds no rule of its own, only a caller for `foldAnnouncements`.
   */
  announcements?: string[];
}

/** What both discovery entry points accept: the caller's fetch and observers. */
export interface BundleDiscoveryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Observe each announcement record as it is accepted or reported and skipped. */
  onAnnouncement?: (event: AnnouncementEvent) => void;
  /**
   * Where a named handle's key history is resolved from. This server stores
   * identities, but a module-level reader has no store in hand, so the default
   * is core's `unresolvedIdentity`: a record carrying its own key is checked
   * against that key and a keyless record is refused. Supplying the store (or
   * any other history) is the caller's choice.
   */
  identity?: AnnouncementIdentity;
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
 *
 * RFC 0019 step 1: a seed may carry `announcements`, folded in below exactly as
 * the SDK path folds them — same core function, same semantics.
 */
/**
 * Announcement-aware discovery, wired to this server's OWN identity store.
 *
 * The API has no route that calls bundle discovery today, so this helper is the
 * one-line wiring for whichever caller arrives first — and the test that drives
 * it is the proof the adapter works end to end, rather than an assurance that it
 * would. `bundleFromSeed` itself keeps `unresolvedIdentity` as its default: a
 * module-level reader has no store in hand, and refusing an unresolvable record
 * is the honest default, not a gap to paper over.
 */
export async function bundleFromSeedForStore(
  seed: SeedDocument,
  store: RarextStore,
  options: Omit<BundleDiscoveryOptions, "identity"> = {},
): Promise<VerifiedBundleSource> {
  return bundleFromSeed(seed, { ...options, identity: announcementIdentityForStore(store) });
}

export async function bundleFromSeed(
  seed: SeedDocument,
  options: BundleDiscoveryOptions = {},
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
 *
 * RFC 0019 step 1: when seeds carry `announcements`, each document is fetched
 * and every record verified by THE fold, core's `foldAnnouncements`, called
 * here with this server's own identity primitives — the same function the SDK
 * path calls, so both paths pool announcements identically and neither one
 * holds a second copy of the sequence. The survivors are pooled with the seeds
 * BEFORE `planSeedUnion` runs, so the disagreement rule covers announcements
 * with no new rule of its own: a verified record that pins a different root
 * for a registry the seed names throws the same loud error, naming both
 * values and both sources, before anything is fetched. A record or a document
 * that cannot be fetched, parsed, or verified is reported through
 * `onAnnouncement` with its reason and skipped, never fatal while another
 * location verifies. A seed with no `announcements` performs no announcement
 * fetch and behaves exactly as before.
 */
export async function bundleFromSeeds(
  seeds: SeedDocument[],
  options: BundleDiscoveryOptions = {},
): Promise<VerifiedBundleFromSeeds> {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  // RFC 0019 step 1: core's fold fetches each announcement document the seeds
  // name, verifies every record with this server's identity primitives, and
  // pools the survivors with the trusted seeds BEFORE the union is planned. A
  // seed without `announcements` contributes nothing here: the pool is exactly
  // the seeds, so the plan, the fetches, and the error wording are byte for
  // byte today's.
  const verifier: AnnouncementVerifier = {
    ...(options.identity ?? unresolvedIdentity),
    ...announcementPrimitives,
  };
  const pool = await foldAnnouncements(seeds, {
    verifier,
    fetch: request,
    timeoutMs,
    onAnnouncement: options.onAnnouncement,
  });

  const plan = planSeedUnion(pool);

  // The per-candidate sequence — fetch the bytes (capped, exactly as the seed
  // docs publish), the CID pin over the bytes, the shape, the recomputed root
  // against the pin, every refusal recorded — is core's `verifyCandidates`.
  // This file injects node fetch and node:crypto; the sequence itself lives in
  // one place, so a fix lands in every client at once.
  const outcome = await verifyCandidates({
    plan,
    attribute: pool.length > 1,
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
