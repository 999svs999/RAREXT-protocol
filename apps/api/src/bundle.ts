import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Anchor,
  Challenge,
  Publication,
  Semantics,
} from "../../../packages/core/src/index.ts";

import { PUBLICATION_LEAF_VERSION, publicationLeaf } from "./anchorer.ts";
import { merkleRoot } from "./merkle.ts";
import type { RarextStore } from "./store.ts";

export const BUNDLE_VERSION = 1;

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
  const leaves = bundle.publications.map((publication) =>
    publicationLeaf(publication, bundle.manifest.leafVersion),
  );

  const computedRoot = merkleRoot(leaves);

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

export function bundleSummary(bundle: Bundle): string {
  return (
    `bundle v${bundle.manifest.version} · ${bundle.manifest.publications.length} publications · ` +
    `root ${bundle.manifest.root.slice(0, 12)}`
  );
}
