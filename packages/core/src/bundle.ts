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

/** One line of a seed's `pins`, additive over `bundleCid`. */
export type SeedPin =
  | { cid: string; service: string; reference: string }
  | { cid: string; service: string; error: string };
