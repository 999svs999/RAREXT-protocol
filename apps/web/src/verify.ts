import { canonicalize, leafPayload } from "@rarext/core";
import type { Publication } from "@rarext/core";

/**
 * The browser-side mirror verifier.
 *
 * A mirror is a copy, and a copy is worth nothing unless you can check it. This
 * recomputes the Merkle root of a bundle from the publications it contains and
 * compares it with the root the chain holds. The leaf shape comes from the same
 * module the registry uses, so the two cannot drift.
 */

export interface Bundle {
  manifest: {
    root: string;
    leafVersion: number;
    publications: { id: string; leaf: string }[];
  };
  publications: Publication[];
}

export interface BundleVerification {
  valid: boolean;
  root: string;
  computedRoot: string;
  publications: number;
  reason: string | null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hashPair(left: string, right: string): string {
  return left + right;
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return "";
  if (leaves.length === 1) return leaves[0]!;

  let level = [...leaves];

  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(hashPair(level[index]!, level[index + 1] ?? level[index]!));
    }
    level = next;
  }

  return level[0]!;
}

export async function verifyBundle(bundle: Bundle): Promise<BundleVerification> {
  const leaves: string[] = [];

  for (const publication of bundle.publications) {
    leaves.push(
      await sha256Hex(
        canonicalize(leafPayload(publication, bundle.manifest.leafVersion)),
      ),
    );
  }

  const computedRoot = merkleRoot(leaves);
  const listed = bundle.manifest.publications.map((entry) => entry.leaf);
  const listMatches = JSON.stringify(listed) === JSON.stringify(leaves);

  if (computedRoot !== bundle.manifest.root) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the publications in this bundle do not rebuild the anchored root",
    };
  }

  if (!listMatches) {
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
