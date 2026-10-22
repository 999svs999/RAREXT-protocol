import type { Publication } from "./types.ts";

export const PUBLICATION_LEAF_VERSION = 3;

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
    attestation: {
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
    },
  };

  if (version < 3) {
    return { leafVersion: 2, ...base };
  }

  return {
    leafVersion: 3,
    ...base,
    signatureAlgorithm: publication.signatureAlgorithm,
    cryptoProfile: publication.attestation.cryptoProfile,
  };
}
