import { publicKeyId } from "../../../packages/agent-sdk/src/index.ts";
import { verifyCertificateChain } from "./certificates.ts";
import type { ProviderCertificate } from "./certificates.ts";

export const IMAGE_MANIFEST_KIND = "rarext.image-manifest.v1";

/**
 * A signed statement by a vendor that an enclave IMAGE has a given measurement.
 *
 * A self-computed code digest proves only what the running process says it is. A
 * manifest signed by a vendor key the deployment pins proves the digest is the
 * one the vendor certified for that image — the code identity is bound to a
 * signature, not taken on the running source's word. And when the manifest
 * carries a certificate CHAIN, the signer is bound to a trust ANCHOR: a
 * deployment pins the root, so an operator cannot mint a manifest under its own
 * key and have it accepted — the chain must terminate at the pinned root.
 */
/**
 * The memory-isolation capability an image is certified to provide. A
 * software-only process cannot claim `host-root-excluded`: its memory is the
 * host's to read. A vendor that certifies an image as `host-root-excluded` is
 * asserting the image runs in a mode (an enclave, a confidential VM) whose
 * memory the host root cannot read — the claim the protocol checks, but cannot
 * itself create.
 */
export type IsolationClass = "host-root-excluded";

export function isIsolationClass(value: unknown): value is IsolationClass {
  return value === "host-root-excluded";
}

export interface ImageManifest {
  kind: typeof IMAGE_MANIFEST_KIND;
  /** The code measurement this manifest vouches for. */
  image: string;
  /** What the image is, for a reader. */
  runtime: string;
  /**
   * The memory-isolation capability the vendor certifies for this image, when
   * any. `host-root-excluded` is the strong claim: the host root cannot read the
   * running image's memory. Absent/`software-image` means host-readable.
   */
  isolation?: IsolationClass;
  publishedAt: string;
  signature: string;
  publicKey: unknown;
  suite: string;
  /**
   * Certificates from the manifest signer up to (but not including) the trust
   * anchor. The last certificate's issuer is the root; a deployment pins the
   * root's key id. Absent means the signer is its own root.
   */
  chain?: ProviderCertificate[];
}

/** The exact fields the manifest signature covers (not the chain). */
export function imageManifestPayload(manifest: ImageManifest): {
  kind: string;
  image: string;
  runtime: string;
  isolation?: IsolationClass;
  publishedAt: string;
} {
  return {
    kind: manifest.kind,
    image: manifest.image,
    runtime: manifest.runtime,
    ...(manifest.isolation === undefined ? {} : { isolation: manifest.isolation }),
    publishedAt: manifest.publishedAt,
  };
}

/** Sign an image manifest with a vendor key, optionally chained to an anchor. */
export function signImageManifest(
  input: { image: string; runtime: string; isolation?: IsolationClass; publishedAt?: string },
  signer: { sign(payload: unknown): string; publicKey: unknown; suite: string },
  chain?: ProviderCertificate[],
): ImageManifest {
  const body = {
    kind: IMAGE_MANIFEST_KIND,
    image: input.image,
    runtime: input.runtime,
    ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
    publishedAt: input.publishedAt ?? new Date().toISOString(),
  } as const;
  return {
    ...body,
    signature: signer.sign(body),
    publicKey: signer.publicKey,
    suite: signer.suite,
    ...(chain === undefined ? {} : { chain }),
  };
}

/**
 * Verify an image manifest: its own signature AND its chain of trust, returning
 * the image it names, the signer's key id, and the ROOT key id the chain
 * terminates at. `null` when the manifest is malformed, the signature does not
 * hold, or the chain is broken. Checking the root against the deployment's pin is
 * a further step the gateway and verifier perform.
 */
export function verifyImageManifest(
  value: unknown,
): {
  image: string;
  isolation: IsolationClass | null;
  vendorKeyId: string;
  rootKeyId: string;
  chainDepth: number;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.kind !== IMAGE_MANIFEST_KIND) return null;
  if (typeof manifest.image !== "string" || !/^[0-9a-f]{64}$/.test(manifest.image)) return null;
  if (manifest.isolation !== undefined && manifest.isolation !== "host-root-excluded") return null;
  if (typeof manifest.signature !== "string") return null;
  if (typeof manifest.publicKey !== "object" || manifest.publicKey === null) return null;

  const rootKeyId = verifyCertificateChain({
    leafPublicKey: manifest.publicKey,
    payload: imageManifestPayload(manifest as unknown as ImageManifest),
    signature: manifest.signature,
    suite: typeof manifest.suite === "string" ? manifest.suite : undefined,
    chain: manifest.chain,
  });
  if (rootKeyId === null) return null;
  return {
    image: manifest.image,
    isolation: manifest.isolation === "host-root-excluded" ? "host-root-excluded" : null,
    vendorKeyId: publicKeyId(manifest.publicKey as never),
    rootKeyId,
    chainDepth: Array.isArray(manifest.chain) ? manifest.chain.length : 0,
  };
}

/**
 * The length of a VALID manifest's certificate chain, or -1 if it does not verify.
 * Depth zero is a bare leaf (its own root); a deployment that requires a
 * minimum depth refuses a manifest signed directly by a key with no chain, so the
 * signer must be certified by the anchor rather than merely equal to it.
 */
export function imageManifestChainDepth(value: unknown): number {
  const info = verifyImageManifest(value);
  return info === null ? -1 : info.chainDepth;
}
