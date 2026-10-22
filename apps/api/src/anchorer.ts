import { randomUUID } from "node:crypto";

import {
  canonicalize,
  leafPayload,
  PUBLICATION_LEAF_VERSION as LEAF_VERSION,
} from "../../../packages/core/src/index.ts";
import type { Anchor, Publication } from "../../../packages/core/src/index.ts";

import { sha256 } from "./attest.ts";
import { merkleRoot } from "./merkle.ts";
import { createDefaultRegistry } from "./adapters/registry.ts";
import type { AdapterRegistry } from "./adapters/registry.ts";
import type { RarextStore } from "./store.ts";

export const PUBLICATION_LEAF_VERSION = LEAF_VERSION;

export function publicationLeaf(
  publication: Publication,
  version: number = PUBLICATION_LEAF_VERSION,
): string {
  return sha256(canonicalize(leafPayload(publication, version)));
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
