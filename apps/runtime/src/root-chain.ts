import { publicKeyId, verifyPayload } from "../../../packages/agent-sdk/src/index.ts";
import { canonicalDigest } from "./digest.ts";
import { verifyProviderChain } from "./model-bundle.ts";

type Suite = "ecdsa-p256" | "ml-dsa-44" | "ml-dsa-65";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ROOT_ROTATION_KIND = "rarext.root-rotation.v1";
export const ROOT_CHAIN_KIND = "rarext.root-chain.v1";

/**
 * One signed step of an append-only root rotation chain.
 *
 * A root is identified by its key id; a rotation names the root it retires
 * (`from`), the root that replaces it (`to`), and carries both public keys so a
 * verifier can check the key id AND the signature without holding a key store.
 * The step is signed by the OLD root, so authority flows from the pinned anchor
 * forward and cannot be claimed by an unrelated key.
 */
export interface RootRotation {
  kind: typeof ROOT_ROTATION_KIND;
  /** The retired root's key id. */
  from: string;
  /** The retired root's public key (must hash to `from`). */
  fromPublicKey: unknown;
  /** The new root's key id. */
  to: string;
  /** The new root's public key (must hash to `to`). */
  nextPublicKey: unknown;
  /** Monotonic epoch: the anchor is 0, the first rotation is 1, and so on. */
  epoch: number;
  /** Digest of the previous rotation, or null for the first. */
  previous: string | null;
  /** Root ids revoked by this step. A quote rooted at one is refused. */
  revoke?: string[];
  issuedAt: string;
  /** Base64 signature by the OLD root over the covered fields. */
  signature: string;
  suite: string;
}

/** The exact fields a rotation covers. */
export function rootRotationPayload(rotation: RootRotation): {
  kind: string;
  from: string;
  fromPublicKey: unknown;
  to: string;
  nextPublicKey: unknown;
  epoch: number;
  previous: string | null;
  revoke?: string[];
  issuedAt: string;
} {
  return {
    kind: rotation.kind,
    from: rotation.from,
    fromPublicKey: rotation.fromPublicKey,
    to: rotation.to,
    nextPublicKey: rotation.nextPublicKey,
    epoch: rotation.epoch,
    previous: rotation.previous,
    ...(rotation.revoke === undefined ? {} : { revoke: rotation.revoke }),
    issuedAt: rotation.issuedAt,
  };
}

/** The digest that links the next rotation to this one. */
export function rootRotationDigest(rotation: RootRotation): string {
  return canonicalDigest(rootRotationPayload(rotation));
}

/**
 * A root chain: the append-only rotations from a pinned anchor to the root in
 * force now. The anchor is a KEY ID the deployment pins; the chain supplies the
 * public keys, so a rotation to a key whose id does not match cannot be forged.
 */
export interface RootChain {
  kind: typeof ROOT_CHAIN_KIND;
  anchor: string;
  rotations: RootRotation[];
}

/** A commitment over the chain, for pinning a full history in one digest. */
export function rootChainDigest(chain: RootChain): string {
  return canonicalDigest({
    kind: chain.kind,
    anchor: chain.anchor,
    rotations: chain.rotations.map(rootRotationDigest),
  });
}

/**
 * Issue one rotation, signed by the root being retired. `previous` is the digest
 * of the prior rotation (null for the first); `epoch` must be one higher.
 */
export function issueRootRotation(input: {
  fromSigner: { sign(payload: unknown): string; publicKey: unknown; suite: string };
  nextSigner: { publicKey: unknown };
  epoch: number;
  previous: string | null;
  issuedAt?: string;
  revoke?: string[];
}): RootRotation {
  const from = publicKeyId(input.fromSigner.publicKey as never);
  const to = publicKeyId(input.nextSigner.publicKey as never);
  const rotation: RootRotation = {
    kind: ROOT_ROTATION_KIND,
    from,
    fromPublicKey: input.fromSigner.publicKey,
    to,
    nextPublicKey: input.nextSigner.publicKey,
    epoch: input.epoch,
    previous: input.previous,
    ...(input.revoke === undefined ? {} : { revoke: input.revoke }),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    signature: "",
    suite: input.fromSigner.suite,
  };
  rotation.signature = input.fromSigner.sign(rootRotationPayload(rotation));
  return rotation;
}

export interface VerifiedRootChain {
  anchor: string;
  /** The root in force after every rotation was applied. */
  current: string;
  /** The epoch reached (0 means the anchor is still current). */
  epoch: number;
  /** Every root id revoked anywhere along the chain. */
  revoked: Set<string>;
}

/**
 * Verify an append-only rotation chain from `anchor`.
 *
 * Every step must start at the root in force at that point, advance the epoch by
 * exactly one, link to the previous rotation's digest, carry public keys whose
 * ids match the named roots, and be signed by the retired root. There is no
 * "pick a later step": a gap, reorder, rollback, or re-sign breaks the chain and
 * the whole chain is refused.
 */
export function verifyRootChain(chain: unknown, anchor: string): VerifiedRootChain | null {
  if (!isRecord(chain) || chain.kind !== ROOT_CHAIN_KIND) return null;
  if (chain.anchor !== anchor) return null;
  if (!Array.isArray(chain.rotations)) return null;

  let current = anchor;
  let epoch = 0;
  let previous: string | null = null;
  const revoked = new Set<string>();
  for (const raw of chain.rotations) {
    if (!isRecord(raw)) return null;
    const rotation = raw as unknown as RootRotation;
    if (rotation.kind !== ROOT_ROTATION_KIND) return null;
    if (rotation.from !== current) return null;
    if (!Number.isSafeInteger(rotation.epoch) || rotation.epoch !== epoch + 1) return null;
    if (rotation.previous !== previous) return null;
    if (!isRecord(rotation.fromPublicKey) || !isRecord(rotation.nextPublicKey)) return null;
    if (rotation.fromPublicKey === null || rotation.nextPublicKey === null) return null;
    try {
      if (publicKeyId(rotation.fromPublicKey as never) !== rotation.from) return null;
      if (publicKeyId(rotation.nextPublicKey as never) !== rotation.to) return null;
      // The retreating root signs the handover; an unrelated key cannot.
      if (
        !verifyPayload(
          rotation.fromPublicKey as never,
          rootRotationPayload(rotation),
          rotation.signature,
          typeof rotation.suite === "string" ? (rotation.suite as Suite) : undefined,
        )
      ) {
        return null;
      }
    } catch {
      return null;
    }
    if (rotation.revoke !== undefined) {
      if (!Array.isArray(rotation.revoke)) return null;
      for (const id of rotation.revoke) {
        if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) return null;
        revoked.add(id);
      }
    }
    previous = rootRotationDigest(rotation);
    current = rotation.to;
    epoch += 1;
  }
  return { anchor, current, epoch, revoked };
}

export interface RootedQuote {
  /** The root the certificate chain terminates at. */
  root: string;
  /** The root in force after applying the supplied root chain. */
  current: string;
  /** The epoch the supplied chain reaches. */
  epoch: number;
}

/**
 * Verify that a provider's quote is rooted at the CURRENT root, as proven by a
 * root chain from the pinned anchor, and that the chain is at least `minEpoch`
 * fresh and that the root was never revoked.
 *
 * A quote with no root chain is accepted only when no rotation is required
 * (`minEpoch` 0) and the certificate chain terminates at the anchor itself.
 * With a rotation pinned, a bare anchor chain is STALE: the deployment has
 * learned the root moved, so a quote that never reaches the new root is refused.
 */
export function verifyProviderRootChain(
  independence: unknown,
  anchor: string,
  minEpoch: number,
): RootedQuote | null {
  // The certificate chain must verify on its own; its terminal root is what the
  // root chain must vouch for.
  const root = verifyProviderChain(independence);
  if (root === null) return null;

  const quote = isRecord(independence) && isRecord(independence.quote) ? independence.quote : null;
  const chain = quote !== null ? quote.rootChain : undefined;

  let info: VerifiedRootChain;
  if (chain === undefined || chain === null) {
    // Legacy: the quote is rooted directly at the pinned anchor. Only valid when
    // the deployment has not learned about a rotation.
    if (minEpoch > 0 || root !== anchor) return null;
    info = { anchor, current: anchor, epoch: 0, revoked: new Set<string>() };
  } else {
    const verified = verifyRootChain(chain, anchor);
    if (verified === null) return null;
    info = verified;
  }

  // Freshness/epoch: a chain older than the deployment's pinned epoch is stale.
  if (info.epoch < minEpoch) return null;
  // The quote must terminate at the root in force, not a retired one.
  if (info.current !== root) return null;
  // A revoked root cannot vouch for a quote, even if it is still "current".
  if (info.revoked.has(root)) return null;
  return { root, current: info.current, epoch: info.epoch };
}
