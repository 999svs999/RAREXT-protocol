import {
  readBundleResponseBytes,
  verifyBundleShape,
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
import { cidV1Raw } from "./adapters/content.ts";
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
export interface SeedDocument {
  bundle: string;
  bundleRoot: string;
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
  mirrors?: Array<{ bundle: string; root: string }>;
}

export interface VerifiedBundleSource {
  bundle: Bundle;
  root: string;
  source: string;
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
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const candidates = Array.from(
    new Set([seed.bundle, ...(seed.mirrors ?? []).map((mirror) => mirror.bundle)]),
  ).filter((url) => typeof url === "string" && url.length > 0);

  if (candidates.length === 0) {
    throw new Error("the seed names no bundle or mirror to try");
  }

  const refusals: string[] = [];

  for (const url of candidates) {
    let value: unknown;
    try {
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        refusals.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      // Read the bytes, not a parsed shape: when the seed pins a CID, the hash
      // is taken over exactly what the mirror served. A re-serialized copy of
      // the same bundle fails here, which is the point — the pointer is a
      // hash, and a hash cannot be re-serialized into being. The read is
      // capped: a mirror that declares a huge Content-Length, or streams
      // forever, is refused at the cap and skipped like any other bad copy.
      const bytes = await readBundleResponseBytes(response);
      if (seed.bundleCid) {
        const served = cidV1Raw(bytes);
        if (served !== seed.bundleCid) {
          refusals.push(
            `${url}: serves ${served}, the seed pins ${seed.bundleCid}`,
          );
          continue;
        }
      }
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      refusals.push(`${url}: ${error instanceof Error ? error.message : "fetch failed"}`);
      continue;
    }

    const verification = verifyBundle(value as Bundle);
    if (!verification.valid) {
      refusals.push(`${url}: ${verification.reason ?? "the bundle does not verify"}`);
      continue;
    }

    if (verification.computedRoot !== seed.bundleRoot) {
      refusals.push(
        `${url}: verifies internally but rebuilds ${verification.computedRoot}, not the pinned ${seed.bundleRoot}`,
      );
      continue;
    }

    return { bundle: value as Bundle, root: verification.computedRoot, source: url };
  }

  throw new Error(`no candidate rebuilt the pinned root:\n  ${refusals.join("\n  ")}`);
}
