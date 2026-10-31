import { canonicalize } from "./canonical.ts";
import type { HashFn } from "./ai.ts";
import type { Anchor } from "./types.ts";

/** Domain separation: an anchor's root can never be mistaken for another rule's output. */
export const ANCHOR_ROOT_DOMAIN = "rarext.anchor.root.v1";

/**
 * Every field of an anchor, and whether the root covers it — `true` is content, `false` is
 * bookkeeping. The same discipline as a publication's: exhaustive BY THE TYPE, so adding a field
 * forces the decision here, in one visible place, rather than silently changing what an anchor is.
 *
 * `id` is a label the node mints; `createdAt` is when it wrote the record down. The EVIDENCE —
 * which root, over which publications, with which leaf version, attested by which adapter under
 * which reference and receipts — is the anchor, and that is what the root covers.
 */
export const ANCHOR_ROOT_FIELDS: Record<keyof Anchor, boolean> = {
  id: false,
  root: true,
  publicationIds: true,
  leafCount: true,
  leafVersion: true,
  createdAt: false,
  adapter: true,
  reference: true,
  receipts: true,
};

export const ANCHOR_ROOT_EXCLUDED_FIELDS: readonly string[] = Object.entries(ANCHOR_ROOT_FIELDS)
  .filter(([, isContent]) => !isContent)
  .map(([field]) => field)
  .sort();

/**
 * An anchor's identity, recomputed from the record itself.
 *
 * An anchor is the protocol's trust root: everything else defers to the root it committed. Its
 * authority comes from the receipts, but its IDENTITY should not depend on which node wrote the
 * record down — the same anchoring is the same object however many ids it was filed under, and a
 * copy that differs in one covered field is a different claim. A client that holds the reference
 * can recompute this and compare, exactly as it does for a publication.
 */
export function anchorRoot(anchor: Anchor, hash: HashFn): string {
  const covered: Record<string, unknown> = {};
  const record = anchor as unknown as Record<string, unknown>;

  for (const [field, isContent] of Object.entries(ANCHOR_ROOT_FIELDS)) {
    if (!isContent) continue;
    const value = record[field];
    if (value !== undefined) covered[field] = value;
  }

  return hash(`${ANCHOR_ROOT_DOMAIN}\n${canonicalize(covered)}`);
}
