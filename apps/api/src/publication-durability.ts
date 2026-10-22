import {
  type DurabilityObservationStatus,
  type DurabilityTier,
  type Publication,
  type PublicationBlobDurability,
  type PublicationDurability,
} from "../../../packages/core/src/index.ts";
import type { DurabilityLedger } from "./durability.ts";
import { recordDigest, type PlacementRegistry } from "./placements.ts";

const HASH = /^[0-9a-f]{64}$/;
const WEAKNESS: Record<DurabilityTier, number> = {
  ephemeral: 0,
  pinned: 1,
  durable: 2,
};

export function blobHashes(
  publication: Pick<Publication, "artifact">,
): string[] {
  const body = publication.artifact?.body;

  if (!body || typeof body !== "object") return [];

  const list = (body as { blobs?: unknown }).blobs;

  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;

    const hash = (entry as { hash?: unknown }).hash;

    if (typeof hash === "string" && HASH.test(hash)) seen.add(hash);
  }

  return [...seen];
}

/**
 * Reads the durability a publication's blobs actually have right now: the latest
 * signed placement record for each blob, and the live count from the ledger's
 * last challenge. This is an observation, not part of the author's signature.
 */
export function publicationDurability(
  publication: Pick<Publication, "artifact">,
  registry: PlacementRegistry,
  ledger: DurabilityLedger,
  options: { now?: () => number } = {},
): PublicationDurability | null {
  const hashes = blobHashes(publication);

  if (hashes.length === 0) return null;

  const blobs = hashes.map((hash): PublicationBlobDurability => {
    const signed = registry.get(hash);

    if (!signed) {
      return {
        hash,
        tier: null,
        required: 0,
        live: 0,
        status: "unplaced",
        sequence: null,
        placementDigest: null,
      };
    }

    const placement = signed.record.placement;
    const audit = ledger.get(hash) ? ledger.audit(hash) : null;
    const status: DurabilityObservationStatus =
      !audit || !audit.challenged ? "unverified" : audit.status;

    return {
      hash,
      tier: placement.tier,
      required: placement.required,
      live: audit && audit.challenged ? audit.live : 0,
      status,
      sequence: signed.record.sequence,
      placementDigest: recordDigest(signed.record),
    };
  });

  const tiers = blobs
    .map((blob) => blob.tier)
    .filter((tier): tier is DurabilityTier => tier !== null);
  const tier =
    tiers.length === 0
      ? null
      : tiers.reduce((weakest, candidate) =>
          WEAKNESS[candidate] < WEAKNESS[weakest] ? candidate : weakest,
        );
  const status: DurabilityObservationStatus = blobs.some(
    (blob) => blob.status === "unplaced",
  )
    ? "unplaced"
    : blobs.some((blob) => blob.status === "unverified")
      ? "unverified"
      : blobs.some((blob) => blob.status === "under-replicated")
        ? "under-replicated"
        : "ok";

  return {
    policy: "durability-v1",
    source: "registry-observation",
    tier,
    required: blobs.reduce((sum, blob) => sum + blob.required, 0),
    live: blobs.reduce((sum, blob) => sum + blob.live, 0),
    status,
    observedAt: new Date((options.now ?? Date.now)()).toISOString(),
    windowMs: ledger.windowMs,
    blobs,
  };
}
