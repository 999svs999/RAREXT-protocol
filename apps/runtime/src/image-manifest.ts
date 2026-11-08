import { publicKeyId, verifyPayload } from "../../../packages/agent-sdk/src/index.ts";

export const IMAGE_MANIFEST_KIND = "rarext.image-manifest.v1";

/**
 * A signed statement by a vendor that an enclave IMAGE has a given measurement.
 *
 * A self-computed code digest proves only what the running process says it is. A
 * manifest signed by a vendor key the deployment pins proves the digest is the
 * one the vendor certified for that image — the code identity is bound to a
 * signature, not taken on the running source's word. An enclave whose measured
 * image is not a signed one, or is signed by another vendor, is refused.
 */
export interface ImageManifest {
  kind: typeof IMAGE_MANIFEST_KIND;
  /** The code measurement this manifest vouches for. */
  image: string;
  /** What the image is, for a reader. */
  runtime: string;
  publishedAt: string;
  signature: string;
  publicKey: unknown;
  suite: string;
}

/** The exact fields the manifest signature covers. */
export function imageManifestPayload(manifest: ImageManifest): {
  kind: string;
  image: string;
  runtime: string;
  publishedAt: string;
} {
  return {
    kind: manifest.kind,
    image: manifest.image,
    runtime: manifest.runtime,
    publishedAt: manifest.publishedAt,
  };
}

/** Sign an image manifest with a vendor key. */
export function signImageManifest(
  input: { image: string; runtime: string; publishedAt?: string },
  signer: { sign(payload: unknown): string; publicKey: unknown; suite: string },
): ImageManifest {
  const body = {
    kind: IMAGE_MANIFEST_KIND,
    image: input.image,
    runtime: input.runtime,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
  } as const;
  return {
    ...body,
    signature: signer.sign(body),
    publicKey: signer.publicKey,
    suite: signer.suite,
  };
}

/**
 * Verify an image manifest under its own vendor key, returning the image it names
 * and the vendor key id. `null` when the manifest is malformed or the signature
 * does not hold. Checking the vendor id against the deployment's pin is a further
 * step the gateway and verifier perform.
 */
export function verifyImageManifest(value: unknown): { image: string; vendorKeyId: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.kind !== IMAGE_MANIFEST_KIND) return null;
  if (typeof manifest.image !== "string" || !/^[0-9a-f]{64}$/.test(manifest.image)) return null;
  if (typeof manifest.signature !== "string") return null;
  if (typeof manifest.publicKey !== "object" || manifest.publicKey === null) return null;
  try {
    const ok = verifyPayload(
      manifest.publicKey as never,
      imageManifestPayload(manifest as unknown as ImageManifest),
      manifest.signature,
      typeof manifest.suite === "string" ? (manifest.suite as never) : undefined,
    );
    if (!ok) return null;
    return { image: manifest.image, vendorKeyId: publicKeyId(manifest.publicKey as never) };
  } catch {
    return null;
  }
}
