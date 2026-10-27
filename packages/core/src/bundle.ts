import { canonicalize } from "./canonical.ts";
import type { Sha256 } from "./digest.ts";
import { publicationLeaf } from "./leaf.ts";
import { merkleRoot } from "./merkle.ts";
import type { Anchor, Challenge, Publication, Semantics } from "./types.ts";

export interface BundleManifest {
  version: number;
  root: string;
  leafVersion: number;
  anchorId: string | null;
  anchorRoot: string | null;
  createdAt: string;
  publications: { id: string; leaf: string }[];
  counts: {
    publications: number;
    anchors: number;
    challenges: number;
    semantics: number;
  };
}

export interface Bundle {
  manifest: BundleManifest;
  publications: Publication[];
  anchors: Anchor[];
  challenges: Challenge[];
  semantics: Semantics[];
}

export interface BundleVerification {
  valid: boolean;
  root: string;
  computedRoot: string | null;
  publications: number;
  reason: string | null;
}

/**
 * The hash-free half of bundle verification: recompute every publication leaf,
 * rebuild the Merkle root, and compare the manifest's leaf list. The caller
 * injects the digest, so the registry (node:crypto) and an agent client share
 * exactly this code.
 */
export function verifyBundleShape(
  bundle: Bundle,
  sha256: Sha256,
): BundleVerification {
  const leaves = bundle.publications.map((publication) =>
    publicationLeaf(publication, sha256, bundle.manifest.leafVersion),
  );

  const computedRoot = merkleRoot(leaves, sha256);

  if (computedRoot !== bundle.manifest.root) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the publications in this bundle do not rebuild the anchored root",
    };
  }

  const listed = bundle.manifest.publications.map((entry) => entry.leaf);
  if (canonicalize(listed) !== canonicalize(leaves)) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the manifest leaf list does not match the publications",
    };
  }

  return {
    valid: true,
    root: bundle.manifest.root,
    computedRoot,
    publications: leaves.length,
    reason: null,
  };
}

/**
 * The most bytes any client will materialize from a bundle response before
 * checking it. Honest bundles are ~21 KiB and grow with publications; 8 MiB is
 * generous headroom without being an amplifier a hostile mirror can aim at
 * every verifier, browser, and agent that asks.
 */
export const MAX_BUNDLE_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The shape a bundle fetch reads from: headers plus an optional streaming body. */
export interface BundleResponse {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Read a bundle response as bytes, refusing anything larger than `maxBytes`
 * BEFORE the body is fully materialized. A declared Content-Length above the
 * cap is refused unread, and the body is otherwise consumed in chunks with a
 * running byte counter, so the cap holds even when the header is absent or
 * lying: a server that streams forever is cut off at the cap instead of being
 * read to its end. Every refusal names the cap and the size when it is known.
 */
export async function readBundleResponseBytes(
  response: BundleResponse,
  maxBytes: number = MAX_BUNDLE_RESPONSE_BYTES,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isInteger(length) && length >= 0 && length > maxBytes) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // Releasing the connection is best-effort; the refusal stands either way.
        }
      }
      throw new Error(
        `the response declares ${length} bytes, above the ${maxBytes} byte cap for a bundle`,
      );
    }
  }
  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(
        `the response streamed past the ${maxBytes} byte cap for a bundle (at least ${total} bytes)`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** One line of a seed's `pins`, additive over `bundleCid`. */
export type SeedPin =
  | { cid: string; service: string; reference: string }
  | { cid: string; service: string; error: string };

/**
 * The seed shape the pure multi-seed helpers read. Both twins — the SDK's
 * `SeedDocument` and the API-side one in `apps/api/src/bundle.ts` — extend
 * this, so there is one disagreement rule and never two.
 */
export interface BundleSeed {
  bundle: string;
  bundleRoot: string;
  /**
   * The bundle's content address, when the publisher pins it: a CIDv1 over the
   * raw sha2-256 of the EXACT published bytes.
   */
  bundleCid?: string;
  /**
   * Where this seed document came from, when the caller knows it. Only used to
   * attribute a pinned value in a disagreement, so an error says WHICH seed's
   * operator said what.
   */
  url?: string;
  mirrors?: Array<{ bundle: string; root: string }>;
}

/** The seed's URL as it is named in errors and results. */
export function seedLabel(seed: BundleSeed): string {
  return seed.url ?? (typeof seed.bundle === "string" && seed.bundle.length > 0 ? seed.bundle : "an unnamed seed");
}

/** One candidate URL from the union, with every seed that nominated it. */
export interface SeedNomination {
  url: string;
  seeds: BundleSeed[];
}

/** What planning a seed union returns: the deduplicated candidate list. */
export interface SeedUnionPlan {
  /** The union of every seed's own bundle URL and its mirrors, deduplicated. */
  nominations: SeedNomination[];
}

/**
 * The one disagreement rule, used by every client that pools seeds.
 *
 * Every seed that names the same primary `bundle` URL must pin the same
 * `bundleRoot` and the same `bundleCid` when both carry one. A seed that
 * carries no `bundleCid` beside one that does is NOT a disagreement — absence
 * is not a contradiction — but two values for one registry are: the seeds'
 * operators disagree about what the registry is, and rather than let "first
 * seed wins" silently pick a side, planning throws naming the registry, the
 * field, and every value with the seed that pinned it. This runs BEFORE any
 * candidate is fetched, so a fork of the trust base stops the resident instead
 * of racing them.
 */
export function planSeedUnion(seeds: BundleSeed[]): SeedUnionPlan {
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new Error("the seeds name no bundle or mirror to try");
  }

  const byRegistry = new Map<string, BundleSeed[]>();
  for (const seed of seeds) {
    if (typeof seed?.bundle !== "string" || seed.bundle.length === 0) continue;
    const group = byRegistry.get(seed.bundle) ?? [];
    group.push(seed);
    byRegistry.set(seed.bundle, group);
  }

  for (const [registry, group] of byRegistry) {
    for (const field of ["bundleRoot", "bundleCid"] as const) {
      const pinned = new Map<string, string[]>();
      for (const seed of group) {
        const value = seed[field];
        // Absence is not a contradiction: only a carried value can clash.
        if (typeof value !== "string" || value.length === 0) continue;
        const holders = pinned.get(value) ?? [];
        holders.push(seedLabel(seed));
        pinned.set(value, holders);
      }
      if (pinned.size > 1) {
        const lines = [...pinned].map(
          ([value, holders]) => `  ${value} — pinned by ${holders.join(", ")}`,
        );
        throw new Error(
          `the seeds disagree about the registry ${registry}: ${field}\n${lines.join("\n")}`,
        );
      }
    }
  }

  const nominations: SeedNomination[] = [];
  const seen = new Map<string, SeedNomination>();
  for (const seed of seeds) {
    const urls = [seed?.bundle, ...(seed?.mirrors ?? []).map((mirror) => mirror.bundle)].filter(
      (url) => typeof url === "string" && url.length > 0,
    );
    for (const url of urls) {
      const existing = seen.get(url);
      if (existing) {
        if (!existing.seeds.includes(seed)) existing.seeds.push(seed);
      } else {
        const nomination = { url, seeds: [seed] };
        nominations.push(nomination);
        seen.set(url, nomination);
      }
    }
  }

  if (nominations.length === 0) {
    throw new Error(
      seeds.length === 1
        ? "the seed names no bundle or mirror to try"
        : `${seeds.length} seeds name no bundle or mirror to try`,
    );
  }

  return { nominations };
}

/**
 * The verifiable pins a candidate must satisfy, one entry per distinct
 * `bundleRoot` among the seeds that nominated it, the strictest first for a
 * shared root: when two seeds agree on a root but only one carries a
 * `bundleCid`, the pin that governs the copy is the stricter one. Seeds that
 * name the same registry were already required to agree in `planSeedUnion`, so
 * distinct roots here can only come from seeds naming different registries,
 * and each root group is tried before any other.
 */
export function pinGroups(nominators: BundleSeed[]): Array<{
  bundleRoot: string;
  bundleCid?: string;
  seeds: BundleSeed[];
}> {
  const byRoot = new Map<string, { bundleRoot: string; bundleCid?: string; seeds: BundleSeed[] }>();
  for (const seed of nominators) {
    const group = byRoot.get(seed.bundleRoot) ?? {
      bundleRoot: seed.bundleRoot,
      bundleCid: undefined,
      seeds: [],
    };
    if (!group.bundleCid && seed.bundleCid) group.bundleCid = seed.bundleCid;
    group.seeds.push(seed);
    byRoot.set(seed.bundleRoot, group);
  }
  return [...byRoot.values()];
}
