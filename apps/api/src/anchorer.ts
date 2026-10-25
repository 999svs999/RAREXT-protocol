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

/**
 * One anchor at a time per store.
 *
 * `anchorPending` reads the pending set, awaits the adapter (a network hop for
 * a real chain rail) and only then commits the anchor. Two overlapping calls
 * therefore both read the same batch and both commit — measured: two anchors,
 * same root, the same three publications in each. The HTTP route happens to
 * serialize on one keep-alive connection, which is why this stayed invisible,
 * but the function has two call sites (the automatic anchor-on-publish path and
 * an explicit POST), and their interleaving is reachable.
 *
 * A second caller while one is in flight now shares the same result instead of
 * anchoring the batch again: same anchor id, same root, one adapter submission.
 */
const inflight = new WeakMap<RarextStore, Promise<Anchor | null>>();

export function anchorPending(
  store: RarextStore,
  registry: AdapterRegistry = createDefaultRegistry(),
): Promise<Anchor | null> {
  const running = inflight.get(store);
  if (running) return running;

  const attempt = commitAnchor(store, registry).finally(() => {
    inflight.delete(store);
  });
  inflight.set(store, attempt);
  return attempt;
}

async function commitAnchor(
  store: RarextStore,
  registry: AdapterRegistry,
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
