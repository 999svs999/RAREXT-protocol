import { createHash, randomBytes, randomInt } from "node:crypto";

import {
  canonicalize,
  type JsonWebKey,
  type SignatureSuite,
} from "../../../packages/core/src/index.ts";
import {
  MAX_CHALLENGE_NONCE,
  verifyChallengeResponse,
  type ChallengeResponse,
  type HolderChallenge,
  type Placement,
  type ShardPlacement,
} from "./durability.ts";
import { keyId, suiteFor, verifyPayload } from "./identity.ts";

export const AUDIT_WINDOW_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

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

export interface AuditChallenge extends HolderChallenge {
  timestamp: string;
}

export interface AuditChallengeOptions {
  now?: number;
  leafIndex?: number;
  nonce?: string;
  random?: (upper: number) => number;
}

export interface AuditVerificationOptions {
  now?: number;
  windowMs?: number;
  expectedVerifierKeyId?: string;
  expectedVerifierPublicKey?: unknown;
}

export function auditPlacementDigest(placement: Placement): string {
  return createHash("sha256").update(canonicalize(placement)).digest("hex");
}

export function newAuditChallenge(
  shard: ShardPlacement,
  options: AuditChallengeOptions = {},
): AuditChallenge {
  const now = options.now ?? Date.now();
  const random = options.random ?? randomInt;
  const leafIndex = options.leafIndex ?? random(shard.leaves);
  const nonce = options.nonce ?? randomBytes(16).toString("hex");

  return {
    storedAs: shard.storedAs,
    leafIndex,
    nonce,
    timestamp: new Date(now).toISOString(),
  };
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

function entryKey(holderId: string, storedAs: string): string {
  return `${holderId}\u0000${storedAs}`;
}

export function verifyAuditAttestation(
  attestation: AuditAttestation,
  placement: Placement,
  options: AuditVerificationOptions = {},
): { ok: boolean; reason: string | null } {
  const invalid = (reason: string) => ({ ok: false, reason });

  if (!attestation || typeof attestation !== "object") {
    return invalid("attestation must be an object");
  }
  if (typeof attestation.signature !== "string") {
    return invalid("signature must be a string");
  }
  if (!attestation.verifierPublicKey || typeof attestation.verifierPublicKey !== "object") {
    return invalid("verifierPublicKey is required");
  }
  if (typeof attestation.verifierKeyId !== "string" || !attestation.verifierKeyId) {
    return invalid("verifierKeyId is required");
  }
  if (typeof attestation.timestamp !== "string") {
    return invalid("timestamp is required");
  }
  if (!Array.isArray(attestation.entries)) {
    return invalid("entries must be a list");
  }

  const suite = suiteFor(attestation.verifierPublicKey);
  if (!suite || (attestation.algorithm !== undefined && attestation.algorithm !== suite)) {
    return invalid("verifier algorithm is not supported");
  }
  if (attestation.verifierKeyId !== keyId(attestation.verifierPublicKey)) {
    return invalid("verifierKeyId does not match the public key");
  }

  let expectedKeyId = options.expectedVerifierKeyId ?? null;

  if (options.expectedVerifierPublicKey !== undefined) {
    if (
      !options.expectedVerifierPublicKey ||
      typeof options.expectedVerifierPublicKey !== "object"
    ) {
      return invalid("expectedVerifierPublicKey must be an object");
    }

    const expectedPublicKeyId = keyId(
      options.expectedVerifierPublicKey as JsonWebKey,
    );

    if (expectedKeyId !== null && expectedKeyId !== expectedPublicKeyId) {
      return invalid("expected verifier key id does not match the public key");
    }
    expectedKeyId = expectedPublicKeyId;
  }

  if (expectedKeyId !== null && attestation.verifierKeyId !== expectedKeyId) {
    return invalid("audit is not signed by the expected verifier");
  }

  const { signature, ...rest } = attestation;
  if (!verifyPayload(attestation.verifierPublicKey, canonicalizeAudit(rest), signature, suite)) {
    return invalid("audit signature is not valid");
  }

  if (attestation.blobHash !== placement.blobHash) {
    return invalid("audit is for another blob");
  }
  if (attestation.placementDigest !== auditPlacementDigest(placement)) {
    return invalid("placement digest does not match");
  }

  const attestationTime = Date.parse(attestation.timestamp);
  if (Number.isNaN(attestationTime)) {
    return invalid("timestamp must be an ISO timestamp");
  }

  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? AUDIT_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return invalid("verification window must be positive");
  }
  // The clock is validated for the same reason the window is: every freshness
  // comparison below is a numeric comparison, and NaN fails all of them. An
  // unusable clock would therefore not narrow the window — it would remove it,
  // and an expired audit would verify. Measured before the fix: `now: NaN`
  // accepted an attestation a millisecond past its window.
  if (!Number.isFinite(now)) {
    return invalid("verification clock must be a finite timestamp");
  }
  if (now - attestationTime > windowMs) {
    return invalid("audit attestation has expired");
  }
  if (attestationTime - now > CLOCK_SKEW_MS) {
    return invalid("audit attestation timestamp is in the future");
  }

  const shards = new Map<string, ShardPlacement>();
  for (const shard of placement.shards) {
    const key = entryKey(shard.holder, shard.storedAs);
    if (shards.has(key)) {
      return invalid(`placement repeats holder ${shard.holder}`);
    }
    shards.set(key, shard);
  }

  if (attestation.entries.length === 0) {
    return invalid("audit has no challenge entries");
  }
  if (attestation.entries.length !== shards.size) {
    return invalid("audit transcript does not cover every placement shard");
  }

  const seenEntries = new Set<string>();
  const seenNonces = new Set<string>();

  for (const entry of attestation.entries) {
    if (!entry || typeof entry !== "object") {
      return invalid("every transcript entry must be an object");
    }
    if (typeof entry.holderId !== "string" || typeof entry.storedAs !== "string") {
      return invalid("transcript holder and storedAs must be strings");
    }

    const key = entryKey(entry.holderId, entry.storedAs);
    const shard = shards.get(key);

    if (!shard) {
      return invalid(`transcript names unknown holder ${entry.holderId}`);
    }
    if (seenEntries.has(key)) {
      return invalid(`transcript names holder ${entry.holderId} more than once`);
    }
    seenEntries.add(key);

    if (typeof entry.nonce !== "string" || entry.nonce.length === 0) {
      return invalid(`challenge nonce is missing for holder ${entry.holderId}`);
    }
    if (entry.nonce.length > MAX_CHALLENGE_NONCE) {
      return invalid(`challenge nonce is too long for holder ${entry.holderId}`);
    }
    if (seenNonces.has(entry.nonce)) {
      return invalid(`challenge nonce is reused for holder ${entry.holderId}`);
    }
    seenNonces.add(entry.nonce);

    const entryTime = Date.parse(entry.timestamp);
    if (Number.isNaN(entryTime)) {
      return invalid(`challenge timestamp is invalid for holder ${entry.holderId}`);
    }
    if (entryTime - attestationTime > CLOCK_SKEW_MS) {
      return invalid(`challenge timestamp is after the attestation for holder ${entry.holderId}`);
    }
    if (entryTime - now > CLOCK_SKEW_MS) {
      return invalid(`challenge timestamp is in the future for holder ${entry.holderId}`);
    }
    if (now - entryTime > windowMs) {
      return invalid(`challenge response window has closed for holder ${entry.holderId}`);
    }
    if (attestationTime - entryTime > windowMs) {
      return invalid(`challenge transcript is outside the attestation window for holder ${entry.holderId}`);
    }

    const recomputed = verifyChallengeResponse(shard, entry.response, {
      storedAs: entry.storedAs,
      leafIndex: entry.leafIndex,
      nonce: entry.nonce,
    });

    if (!recomputed || entry.verified !== true) {
      return invalid(`challenge response failed verification for holder ${entry.holderId}`);
    }
  }

  if (seenEntries.size !== shards.size) {
    return invalid("audit transcript does not cover every placement shard");
  }

  return { ok: true, reason: null };
}
