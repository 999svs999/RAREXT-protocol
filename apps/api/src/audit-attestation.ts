import type { JsonWebKey, SignatureSuite } from "../../../packages/core/src/index.ts";
import { verifyPayload } from "./identity.ts";
import { verifyChallengeResponse, type ChallengeResponse, type Placement } from "./durability.ts";

export interface ChallengeTranscriptEntry {
  holderId: string;
  storedAs: string;
  leafIndex: number;
  nonce: string;
  timestamp: string;
  response: ChallengeResponse;
  verified: boolean;
}

export interface AuditAttestation {
  blobHash: string;
  placementDigest: string;
  verifierKeyId: string;
  verifierPublicKey: any;
  algorithm?: SignatureSuite;
  timestamp: string;
  entries: ChallengeTranscriptEntry[];
  signature?: string;
}

export interface AuditSigner {
  keyId: string;
  publicKey: any;
  suite: SignatureSuite;
  sign(payload: unknown): string;
}

export function canonicalizeAudit(attestation: Omit<AuditAttestation, "signature">): unknown {
  return {
    blobHash: attestation.blobHash,
    placementDigest: attestation.placementDigest,
    verifierKeyId: attestation.verifierKeyId,
    verifierPublicKey: attestation.verifierPublicKey,
    algorithm: attestation.algorithm,
    timestamp: attestation.timestamp,
    entries: attestation.entries.map((e) => ({
      holderId: e.holderId,
      storedAs: e.storedAs,
      leafIndex: e.leafIndex,
      nonce: e.nonce,
      timestamp: e.timestamp,
      response: e.response,
      verified: e.verified,
    })),
  };
}

export function signAuditAttestation(
  attestation: Omit<AuditAttestation, "signature">,
  signer: AuditSigner,
): AuditAttestation {
  const payload = canonicalizeAudit(attestation);
  const signature = signer.sign(payload);
  return {
    ...attestation,
    signature,
  };
}

export function verifyAuditAttestation(
  attestation: AuditAttestation,
  placement: Placement,
): { ok: boolean; reason: string | null } {
  if (!attestation || typeof attestation !== "object") {
    return { ok: false, reason: "attestation must be an object" };
  }
  if (typeof attestation.signature !== "string") {
    return { ok: false, reason: "signature must be a string" };
  }
  if (!attestation.verifierPublicKey) {
    return { ok: false, reason: "verifierPublicKey is required" };
  }

  const { signature, ...rest } = attestation;
  const validSig = verifyPayload(
    attestation.verifierPublicKey,
    canonicalizeAudit(rest),
    signature,
    attestation.algorithm,
  );
  if (!validSig) {
    return { ok: false, reason: "audit signature is not valid" };
  }

  const shardMap = new Map(placement.shards.map((s) => [s.holder, s]));

  for (const entry of attestation.entries) {
    const shard = shardMap.get(entry.holderId);
    if (!shard) {
      return { ok: false, reason: `transcript names unknown holder ${entry.holderId}` };
    }
    if (shard.storedAs !== entry.storedAs) {
      return { ok: false, reason: `storedAs mismatch for holder ${entry.holderId}` };
    }

    const recomputed = verifyChallengeResponse(shard, entry.response, {
      storedAs: entry.storedAs,
      leafIndex: entry.leafIndex,
      nonce: entry.nonce,
    });

    if (!recomputed || !entry.verified) {
      return { ok: false, reason: `challenge response failed verification for holder ${entry.holderId}` };
    }
  }

  return { ok: true, reason: null };
}
