import { canonicalize } from "./canonical.ts";
import { sha256Hex, type Sha256 } from "./digest.ts";
import type { Publication } from "./types.ts";

export const PUBLICATION_LEAF_VERSION = 4;

/**
 * The exact object a publication contributes to a Merkle root.
 *
 * This lives in one place on purpose. The registry hashes it, the browser verifier
 * hashes it, and the tests hash it, and a version that drifted between them would
 * make every mirror look broken — or, worse, make a tampered mirror look fine.
 * The shape is shared; only the hashing primitive is local, because the browser
 * has WebCrypto and the server has node:crypto.
 *
 * Version 3 adds the cryptographic profile of the claim, so the anchor records
 * whether the signature behind it was post-quantum.
 *
 * Version 4 adds the representation kind and the bounded-metric evidence
 * (metricName, metricValue) to the embedded attestation, so an AI claim is
 * committed by the anchor too: a mirror cannot strip the representation or
 * inflate a metric without breaking the Merkle root. Bundles verify at the
 * leafVersion their anchor recorded, so pre-v4 anchors keep their exact old
 * shape; for pre-AI attestations the added fields are absent anyway, and
 * canonicalize drops absent keys.
 */
export function leafPayload(
  publication: Publication,
  version: number = PUBLICATION_LEAF_VERSION,
): Record<string, unknown> {
  if (version < 2) {
    return {
      id: publication.id,
      author: publication.author,
      authorKey: publication.authorKey,
      taskId: publication.taskId,
      circuitHash: publication.attestation.circuitHash,
      traceHash: publication.attestation.traceHash,
      score: publication.attestation.score,
      gateCount: publication.attestation.gateCount,
      createdAt: publication.createdAt,
    };
  }

  const attestation = {
    circuitHash: publication.attestation.circuitHash,
    traceHash: publication.attestation.traceHash,
    correct: publication.attestation.correct,
    score: publication.attestation.score,
    gateCount: publication.attestation.gateCount,
    semanticsId: publication.attestation.semanticsId,
    semanticsVersion: publication.attestation.semanticsVersion,
    semanticsHash: publication.attestation.semanticsHash,
    claimKind: publication.attestation.claimKind,
    scope: publication.attestation.scope,
    verifierHash: publication.attestation.verifierHash,
  };

  const base: Record<string, unknown> = {
    id: publication.id,
    author: publication.author,
    authorKey: publication.authorKey,
    title: publication.title,
    body: publication.body,
    app: publication.app,
    challengeId: publication.challengeId,
    taskId: publication.taskId,
    artifact: publication.artifact,
    circuit: publication.circuit ?? null,
    parentId: publication.parentId,
    source: publication.source,
    createdAt: publication.createdAt,
    nonce: publication.nonce,
    signature: publication.signature,
    attestation,
  };

  if (version < 3) {
    return { leafVersion: 2, ...base };
  }

  const extended = {
    ...base,
    signatureAlgorithm: publication.signatureAlgorithm,
    cryptoProfile: publication.attestation.cryptoProfile,
  };

  if (version === 3) {
    return { leafVersion: 3, ...extended };
  }

  // Only the fields the attestation actually carries enter the leaf: absent
  // stays absent, in memory and in the canonical JSON alike.
  const evidence: Record<string, unknown> = {};
  if (publication.attestation.representation !== undefined) {
    evidence.representation = publication.attestation.representation;
  }
  if (publication.attestation.metricName !== undefined) {
    evidence.metricName = publication.attestation.metricName;
  }
  if (publication.attestation.metricValue !== undefined) {
    evidence.metricValue = publication.attestation.metricValue;
  }

  return {
    leafVersion: 4,
    ...extended,
    attestation: { ...attestation, ...evidence },
  };
}

/**
 * A publication's leaf: the canonical payload hashed with the injected digest.
 * The registry, a mirror, and an agent client all call this one function, so a
 * version or shape change cannot drift between them.
 */
export function publicationLeaf(
  publication: Publication,
  sha256: Sha256,
  version: number = PUBLICATION_LEAF_VERSION,
): string {
  return sha256Hex(sha256, canonicalize(leafPayload(publication, version)));
}
