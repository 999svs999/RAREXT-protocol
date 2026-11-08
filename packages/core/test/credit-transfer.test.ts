import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  TRANSFER_ACTION,
  TRANSFER_KIND,
  creditBalances,
  creditLedgerProblems,
  creditLedgerProof,
  creditLedgerRoot,
  creditLeaf,
  transferProblems,
  transferRecords,
  transferRoot,
  verifyProof,
} from "../src/index.ts";
import type { CreditRecordFields, TransferInstruction } from "../src/index.ts";

const nodeSha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

function instruction(overrides: Partial<TransferInstruction> = {}): TransferInstruction {
  return {
    kind: TRANSFER_KIND,
    from: "key-alice",
    to: "key-bob",
    amount: 5,
    nonce: "nonce-1",
    at: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

const earned = (keyId: string, bounty: number): CreditRecordFields => ({
  keyId,
  action: "infer",
  bounty,
  challengeId: "d".repeat(64),
  artifactHash: "a".repeat(64),
  at: "2026-11-08T00:00:00.000Z",
});

test("a transfer's identity is the signed instruction, and the nonce is part of it", () => {
  const base = transferRoot(instruction(), nodeSha256);
  assert.match(base, /^[0-9a-f]{64}$/);

  assert.equal(transferRoot(instruction(), nodeSha256), base, "deterministic");
  assert.notEqual(transferRoot(instruction({ amount: 6 }), nodeSha256), base);
  assert.notEqual(transferRoot(instruction({ to: "key-carol" }), nodeSha256), base);
  assert.notEqual(transferRoot(instruction({ nonce: "nonce-2" }), nodeSha256), base, "a fresh nonce is a new movement");
});

test("a transfer is a debit and a credit that sum to zero", () => {
  const records = transferRecords(instruction(), nodeSha256);
  assert.equal(records.length, 2);

  const [debit, credit] = records as [CreditRecordFields, CreditRecordFields];
  assert.equal(debit.keyId, "key-alice");
  assert.equal(debit.bounty, -5);
  assert.equal(debit.action, TRANSFER_ACTION);
  assert.equal(credit.keyId, "key-bob");
  assert.equal(credit.bounty, 5);
  assert.equal(debit.artifactHash, credit.artifactHash, "one movement, one identity");
  assert.equal(debit.artifactHash, transferRoot(instruction(), nodeSha256));
  assert.equal(debit.bounty + credit.bounty, 0, "value is conserved");
});

test("balances read out of the ledger, and an overdraft is the double-spend", () => {
  const paid = [earned("key-alice", 12), earned("key-bob", 12)];
  const moved = transferRecords(instruction({ amount: 5 }), nodeSha256);
  const ledger = [...paid, ...moved];

  const balances = creditBalances(ledger);
  assert.equal(balances["key-alice"], 7);
  assert.equal(balances["key-bob"], 17);
  assert.deepEqual(creditLedgerProblems(ledger), [], "a conserved ledger is not overdrawn");

  // Spending credits twice: a second 12 from a key that only has 7 left.
  const overspent = [
    ...ledger,
    ...transferRecords(instruction({ amount: 12, nonce: "nonce-2" }), nodeSha256),
  ];
  const problems = creditLedgerProblems(overspent);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /key key-alice is overdrawn by 5/);
});

test("a transfer rejects a self-move, a bad amount, and a missing nonce", () => {
  assert.deepEqual(transferProblems(instruction()), []);
  assert.ok(transferProblems(instruction({ to: "key-alice" })).some((p) => p.includes("two different keys")));
  assert.ok(transferProblems(instruction({ amount: 0 })).some((p) => p.includes("positive integer")));
  assert.ok(transferProblems(instruction({ nonce: "" })).some((p) => p.includes("nonce")));
});

test("a transferred credit proves against the whole-ledger root", () => {
  const ledger = [earned("key-alice", 12), earned("key-bob", 12)];
  const moved = transferRecords(instruction({ amount: 5 }), nodeSha256);
  const all = [...ledger, ...moved];
  const root = creditLedgerRoot(all, nodeSha256);

  const receipt = moved[1]!;
  const inclusion = creditLedgerProof(all, receipt, nodeSha256);
  assert.ok(inclusion);
  assert.equal(
    verifyProof(creditLeaf(receipt, nodeSha256), inclusion.proof, root, inclusion.index, bytesSha256),
    true,
  );
});
