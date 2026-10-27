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
