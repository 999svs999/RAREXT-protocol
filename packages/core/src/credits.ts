import { canonicalize } from "./canonical.ts";
import { sha256Hex, type Sha256 } from "./digest.ts";
import { merkleProof, merkleRoot } from "./merkle.ts";
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

/**
 * One leaf of the credit ledger: the record's identity, domain-separated again so a leaf can never
 * be mistaken for a root or for another rule's digest. The ledger commits to IDENTITIES rather than
 * to raw records, which is what lets a proof be checked by a client holding only the receipt.
 */
export function creditLeaf(record: CreditRecordFields, hash: HashFn): string {
  return hash(`rarext.credit.leaf.v1\n${creditRoot(record, hash)}`);
}

/**
 * The commitment over the WHOLE ledger, recomputable from the records alone.
 *
 * This is what turns "the accounting is a node's word" false: a node publishes this root, and any
 * client holding records can recompute it — a record dropped from the ledger, edited, or quietly
 * added produces a different root and is caught.
 *
 * The leaves are sorted by the records' own identities rather than taken in arrival order, so the
 * commitment is a fact about the SET of payments and not about the order a particular node happened
 * to write them down: the same ledger in a different order recomputes to the same root, which is
 * the same determinism the tally depends on. A partial copy is honestly a different ledger — the
 * count is bound by the tree — and an empty ledger has a defined root, because "nobody has been
 * paid yet" is a state worth committing to, not an error.
 */
export function creditLedgerRoot(records: CreditRecordFields[], hash: HashFn): string {
  const leaves = records
    .map((record) => creditLeaf(record, hash))
    .sort();
  return merkleRoot(leaves, bytesHashOf(hash));
}

/**
 * A Merkle inclusion proof for ONE receipt: the worker's answer to "is my payment in the ledger the
 * node committed to". The index travels with the siblings because verifying needs both
 * (`verifyProof(leaf, proof, root, index, sha256)`), and a worker holding only its own receipt
 * cannot recompute where it sits. `null` when the record is not in the ledger — which is the honest
 * answer to the question, not an error.
 */
export function creditLedgerProof(
  records: CreditRecordFields[],
  record: CreditRecordFields,
  hash: HashFn,
): { index: number; proof: string[] } | null {
  const leaves = records.map((entry) => creditLeaf(entry, hash)).sort();
  const leaf = creditLeaf(record, hash);
  const index = leaves.indexOf(leaf);

  if (index === -1) {
    return null;
  }

  return { index, proof: merkleProof(leaves, index, bytesHashOf(hash)) };
}

/**
 * The ledger's rules are Merkle rules, which take a BYTE hasher; the credit rules take a HashFn.
 * This adapts without a second implementation of either: a HashFn that receives a string hashes its
 * bytes, and one that receives bytes passes them through.
 */
function bytesHashOf(hash: HashFn): Sha256 {
  return (bytes: Uint8Array) => {
    const digest = hash(bytes);
    if (!/^[0-9a-f]{64}$/i.test(digest)) {
      throw new Error("the injected hash must return a 64-hex digest");
    }
    // Pure JS, no Node-only helpers: core runs in a browser too.
    const out = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      out[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
  };
}
