import { canonicalize } from "./canonical.ts";
import type { HashFn } from "./ai.ts";

/** Domain separation: a credit's root can never be mistaken for another rule's output. */
export const CREDIT_ROOT_DOMAIN = "rarext.credit.root.v1";

/**
 * The fields of a credit receipt, and whether the root covers them.
 *
 * A credit record is the one protocol record that carries NO minted label at all — it is what was
 * earned, by which key, for which work, on which artifact, and when. So every field is content, the
 * excluded list is empty, and the identity is entirely recomputable: the receipt a worker carries is
 * checkable by whoever it is shown to, which is most of what "dependable money" can mean at this
 * layer.
 *
 * Declared as a structural type rather than the API's `CreditRecord`, because the board (which
 * actions exist and what they pay) is an operator's policy that lives in the app, while the identity
 * of what the board pays out is the protocol's. The API's own type is held against this map by a
 * test that enumerates its fields: adding a field to a credit record fails the gate until somebody
 * decides whether the root covers it.
 */
export interface CreditRecordFields {
  keyId: string;
  action: string;
  bounty: number;
  challengeId: string;
  artifactHash: string;
  at: string;
}

export const CREDIT_ROOT_FIELDS: Record<keyof CreditRecordFields, boolean> = {
  keyId: true,
  action: true,
  bounty: true,
  challengeId: true,
  artifactHash: true,
  at: true,
};

export const CREDIT_ROOT_EXCLUDED_FIELDS: readonly string[] = Object.entries(CREDIT_ROOT_FIELDS)
  .filter(([, isContent]) => !isContent)
  .map(([field]) => field)
  .sort();

/** A credit receipt has no optional fields and no labels: all six are required for recognition. */
export const CREDIT_ROOT_REQUIRED_FIELDS: readonly string[] = Object.keys(CREDIT_ROOT_FIELDS).sort();

/**
 * A credit's identity, recomputed from the receipt itself.
 *
 * `at` is covered, deliberately: WHEN a credit was earned is part of the payment, not bookkeeping
 * about it — two receipts that differ only in time are two payments, and a ledger that cannot tell
 * them apart cannot be audited.
 */
export function creditRoot(record: CreditRecordFields, hash: HashFn): string {
  const covered: Record<string, unknown> = {};
  const source = record as unknown as Record<string, unknown>;

  for (const [field, isContent] of Object.entries(CREDIT_ROOT_FIELDS)) {
    if (!isContent) continue;
    const value = source[field];
    if (value !== undefined) covered[field] = value;
  }

  return hash(`${CREDIT_ROOT_DOMAIN}\n${canonicalize(covered)}`);
}
