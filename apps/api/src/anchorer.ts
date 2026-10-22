import { randomUUID } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { Anchor, Publication } from "../../../packages/core/src/index.ts";

import { sha256 } from "./attest.ts";
import { merkleRoot } from "./merkle.ts";
import { createDefaultRegistry } from "./adapters/registry.ts";
import type { AdapterRegistry } from "./adapters/registry.ts";
import type { RarextStore } from "./store.ts";

export const PUBLICATION_LEAF_VERSION = 3;

/**
 * The leaf a publication contributes to a Merkle root.
 *
 * It has to cover the whole publication, not a summary: if the root only committed
 * to a score and a hash, a mirror could serve different titles, different bodies, or
 * a different artifact and still match the root, and "the anchor proves the content"
 * would be false. So the leaf covers the signed envelope and the stable part of the
 * attestation.
 *
 * The per-verification fields (the attestation id and its timestamp) are excluded on
 * purpose: re-verifying the same artifact produces a different id, and the leaf has
 * to stay reproducible for anyone serving a mirror.
 *
 * Version 1 committed to a summary only. It is kept so anchors created before
 * version 2 still produce proofs that verify against the root they were anchored
 * with.
 */
export function publicationLeaf(
  publication: Publication,
  version: number = PUBLICATION_LEAF_VERSION,
): string {
  if (version < 2) {
    return sha256(
      canonicalize({
        id: publication.id,
        author: publication.author,
        authorKey: publication.authorKey,
        taskId: publication.taskId,
        circuitHash: publication.attestation.circuitHash,
        traceHash: publication.attestation.traceHash,
        score: publication.attestation.score,
        gateCount: publication.attestation.gateCount,
        createdAt: publication.createdAt,
      }),
    );
  }

  const base = {
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
    return sha256(canonicalize({ leafVersion: 2, ...base }));
  }

  // Version 3 also commits to the cryptographic profile of the claim, so the
  // anchor records whether the signature behind it was post-quantum.
  return sha256(
    canonicalize({
      leafVersion: 3,
      ...base,
      signatureAlgorithm: publication.signatureAlgorithm,
      cryptoProfile: publication.attestation.cryptoProfile,
    }),
  );
}

export async function anchorPending(
  store: RarextStore,
  registry: AdapterRegistry = createDefaultRegistry(),
): Promise<Anchor | null> {
  const pending = store.pendingPublications();

  if (pending.length === 0) return null;

  const leaves = pending.map((publication) => publicationLeaf(publication));
  const root = merkleRoot(leaves);
  const publicationIds = pending.map((publication) => publication.id);
  const receipts = await registry.anchor(root, publicationIds);
  const primary =
    receipts.find((receipt) => receipt.adapter === "trac" && receipt.status === "ok") ??
    receipts.find((receipt) => receipt.status === "ok");

  const anchor: Anchor = {
    id: randomUUID(),
    root,
    publicationIds,
    leafCount: leaves.length,
    leafVersion: PUBLICATION_LEAF_VERSION,
    createdAt: new Date().toISOString(),
    adapter: primary?.adapter ?? "local",
    reference: primary?.reference ?? null,
    receipts,
  };

  store.addAnchor(anchor);
  return anchor;
}

export function anchorThreshold(): number {
  const parsed = Number(process.env.RAREXT_ANCHOR_EVERY ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}
