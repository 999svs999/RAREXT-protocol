import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  CREDIT_ROOT_DOMAIN,
  creditLedgerProof,
  creditLedgerRoot,
  creditLeaf,
  CREDIT_ROOT_EXCLUDED_FIELDS,
  CREDIT_ROOT_FIELDS,
  creditRoot,
  matchRecordRoot,
  merkleRoot,
  verifyProof,
  publicationRoot,
} from "../src/index.ts";
import type { CreditRecordFields } from "../src/index.ts";

/** The byte hasher the Merkle rules take — a different contract from the HashFn above, and mixing
 *  them up is a type error rather than a wrong answer. */
const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

const nodeSha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

function receipt(): CreditRecordFields {
  return {
    keyId: "worker-key",
    action: "verify",
    bounty: 12,
    challengeId: "gen-starter",
    artifactHash: "c".repeat(64),
    at: "2026-11-01T00:00:00.000Z",
  };
}

/** One mutator per field: a credit record carries no minted label, so every field is content — and
 *  this is the decision, asserted rather than assumed. */
const mutators: Record<keyof CreditRecordFields, (entry: CreditRecordFields) => void> = {
  keyId: (entry) => { entry.keyId = "other-key"; },
  action: (entry) => { entry.action = "store"; },
  bounty: (entry) => { entry.bounty = 13; },
  challengeId: (entry) => { entry.challengeId = "other-challenge"; },
  artifactHash: (entry) => { entry.artifactHash = "d".repeat(64); },
  at: (entry) => { entry.at = "2026-11-01T00:00:01.000Z"; },
};

test("a credit's identity is the receipt itself: canonical, and every field counts", () => {
  const base = receipt();
  const baseRoot = creditRoot(base, nodeSha256);
  assert.match(baseRoot, /^[0-9a-f]{64}$/);

  const reordered = Object.fromEntries(Object.entries(base).reverse()) as CreditRecordFields;
  assert.equal(creditRoot(reordered, nodeSha256), baseRoot, "key order is not content");

  const tried: string[] = [];
  for (const [field, mutate] of Object.entries(mutators)) {
    const entry = receipt();
    mutate(entry);
    const mutated = creditRoot(entry, nodeSha256);
    tried.push(field);
    assert.notEqual(mutated, baseRoot, `${field} is part of the payment and must move the root`);
  }
  assert.deepEqual(tried.sort(), Object.keys(base).sort(), "every field was decided on");
  assert.deepEqual(Object.keys(CREDIT_ROOT_FIELDS).sort(), Object.keys(base).sort());

  // THE decision, stated: a credit record carries no minted label, so nothing is excluded —
  // an empty exclusion list is the claim that identity is entirely recomputable.
  assert.deepEqual([...CREDIT_ROOT_EXCLUDED_FIELDS], []);
  // WHEN it was earned is part of the payment, not bookkeeping about it.
  assert.equal(CREDIT_ROOT_FIELDS.at, true);
});

test("matchRecordRoot names the credit rule, and the rules do not answer for each other", () => {
  const base = receipt();
  const root = creditRoot(base, nodeSha256);

  const matched = matchRecordRoot(base, root, nodeSha256);
  assert.equal(matched?.kind, "credit");
  assert.equal(matched?.root, root);

  // Domain separation: the receipt does not answer as a publication under the same digest, and a
  // publication does not answer as a credit — trying the rules in any order is safe because at most
  // one can match.
  assert.notEqual(publicationRoot(base as never, nodeSha256), root);
  assert.equal(matchRecordRoot(base, publicationRoot(base as never, nodeSha256), nodeSha256), null);

  // Presentation keys are ignored by construction, so a served receipt (with its root attached)
  // still recomputes to the root it was served with.
  const asServed = { ...base, root } as never;
  assert.equal(creditRoot(asServed, nodeSha256), root);
  assert.equal(matchRecordRoot(asServed, root, nodeSha256)?.kind, "credit");
});

test("the ledger commitment is a fact about the SET of payments, not the order a node wrote them down", () => {
  const paid = [receipt(), { ...receipt(), keyId: "k2", artifactHash: "d".repeat(64) }, { ...receipt(), keyId: "k3", artifactHash: "e".repeat(64) }];
  const root = creditLedgerRoot(paid, nodeSha256);
  assert.match(root, /^[0-9a-f]{64}$/);

  // THE determinism property, regression-tested because an order-dependent commitment would change
  // for no reason — the same lesson the tally's result root taught.
  const shuffled = [paid[2]!, paid[0]!, paid[1]!];
  assert.equal(creditLedgerRoot(shuffled, nodeSha256), root);

  // A payment dropped, edited, or added is a DIFFERENT ledger, and the count is bound by the tree.
  assert.notEqual(creditLedgerRoot(paid.slice(0, 2), nodeSha256), root);
  assert.notEqual(creditLedgerRoot([...paid, { ...receipt(), keyId: "k4", artifactHash: "f".repeat(64) }], nodeSha256), root);

  // An empty ledger has a defined root: "nobody has been paid yet" is a state worth committing to.
  assert.match(creditLedgerRoot([], nodeSha256), /^[0-9a-f]{64}$/);
});

test("a receipt proves its own inclusion, and a tampered one proves nothing", () => {
  const paid = [receipt(), { ...receipt(), keyId: "k2", artifactHash: "d".repeat(64) }, { ...receipt(), keyId: "k3", artifactHash: "e".repeat(64) }];
  const root = creditLedgerRoot(paid, nodeSha256);

  const inclusion = creditLedgerProof(paid, paid[1]!, nodeSha256);
  assert.ok(inclusion !== null);
  assert.ok(inclusion.proof.length >= 1, "the siblings travel with the index");
  assert.equal(
    verifyProof(creditLeaf(paid[1]!, nodeSha256), inclusion.proof, root, inclusion.index, bytesSha256),
    true,
    "the worker verifies its payment against the published root",
  );

  // The same receipt edited after the fact is not in the ledger, and the proof says so honestly.
  const edited = { ...paid[1]!, bounty: 999 };
  assert.equal(creditLedgerProof(paid, edited, nodeSha256), null);

  // And a proof from a DIFFERENT ledger does not verify against this root.
  const other = creditLedgerProof([paid[0]!], paid[0]!, nodeSha256);
  assert.equal(
    verifyProof(creditLeaf(paid[0]!, nodeSha256), other!.proof, root, other!.index, bytesSha256),
    false,
    "a partial ledger's proof does not pass for the whole one",
  );

  // The leaf is domain-separated from the record's own root, so the two digest shapes cannot be
  // substituted for each other.
  assert.notEqual(creditLeaf(paid[0]!, nodeSha256), creditRoot(paid[0]!, nodeSha256));
  assert.equal(merkleRoot([creditLeaf(paid[0]!, nodeSha256)], bytesSha256), creditLedgerRoot([paid[0]!], nodeSha256));
});
