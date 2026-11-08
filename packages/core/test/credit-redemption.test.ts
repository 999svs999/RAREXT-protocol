import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  REDEEM_ACTION,
  REDEMPTION_KIND,
  creditLedgerProblems,
  creditLedgerProof,
  creditLedgerRoot,
  creditLeaf,
  creditSupply,
  redemptionProblems,
  redemptionRecords,
  redemptionRoot,
  transferRecords,
  verifyProof,
} from "../src/index.ts";
import type { CreditRecordFields, RedemptionInstruction, TransferInstruction } from "../src/index.ts";

const nodeSha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

const earned = (keyId: string, bounty: number): CreditRecordFields => ({
  keyId,
  action: "infer",
  bounty,
  challengeId: "d".repeat(64),
  artifactHash: "a".repeat(64),
  at: "2026-11-09T00:00:00.000Z",
});

function instruction(overrides: Partial<RedemptionInstruction> = {}): RedemptionInstruction {
  return {
    kind: REDEMPTION_KIND,
    from: "key-alice",
    amount: 5,
    reference: "chain:tx:0xabc",
    nonce: "n1",
    at: "2026-11-09T01:00:00.000Z",
    ...overrides,
  };
}

test("a redemption's identity is the instruction, and the reference and nonce are part of it", () => {
  const base = redemptionRoot(instruction(), nodeSha256);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(redemptionRoot(instruction(), nodeSha256), base);
  assert.notEqual(redemptionRoot(instruction({ amount: 6 }), nodeSha256), base);
  assert.notEqual(redemptionRoot(instruction({ reference: "chain:tx:0xdef" }), nodeSha256), base);
  assert.notEqual(redemptionRoot(instruction({ nonce: "n2" }), nodeSha256), base);
});

test("a redemption is a debit with no matching credit, so it lowers the ledger total", () => {
  const ledger = [earned("key-alice", 12), earned("key-bob", 12)];
  const minted = creditSupply(ledger);
  assert.equal(minted, 24);

  // A transfer conserves: a zero-sum pair.
  const move: TransferInstruction = {
    kind: "rarext.credit-transfer.v1",
    from: "key-alice",
    to: "key-bob",
    amount: 5,
    nonce: "t1",
    at: "2026-11-09T01:00:00.000Z",
  };
  assert.equal(creditSupply([...ledger, ...transferRecords(move, nodeSha256)]), minted);

  // A redemption removes: one debit, no credit.
  const redeemed = [...ledger, ...redemptionRecords(instruction(), nodeSha256)];
  assert.equal(creditSupply(redeemed), minted - 5);

  const [record] = redemptionRecords(instruction(), nodeSha256) as [CreditRecordFields];
  assert.equal(record.action, REDEEM_ACTION);
  assert.equal(record.bounty, -5);
  assert.equal(record.challengeId, "chain:tx:0xabc", "the removal is bound to the external reference");
  assert.deepEqual(creditLedgerProblems(redeemed), [], "redeeming within a balance is not an overdraft");
});

test("redeeming more than you hold is an overdraft, which is the double-spend", () => {
  const ledger = [earned("key-alice", 12), ...redemptionRecords(instruction({ amount: 12 }), nodeSha256)];
  assert.deepEqual(creditLedgerProblems(ledger), []);

  // Spend the same credits again.
  const overspent = [...ledger, ...redemptionRecords(instruction({ amount: 1, nonce: "n2" }), nodeSha256)];
  const problems = creditLedgerProblems(overspent);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /key key-alice is overdrawn by 1/);
});

test("a redemption rejects a bad amount, a missing reference, and a missing nonce", () => {
  assert.deepEqual(redemptionProblems(instruction()), []);
  assert.ok(redemptionProblems(instruction({ amount: 0 })).some((p) => p.includes("positive integer")));
  assert.ok(redemptionProblems(instruction({ reference: "" })).some((p) => p.includes("external reference")));
  assert.ok(redemptionProblems(instruction({ nonce: "" })).some((p) => p.includes("nonce")));
});

test("a redeemed receipt proves against the whole-ledger root", () => {
  const all = [earned("key-alice", 12), ...redemptionRecords(instruction(), nodeSha256)];
  const root = creditLedgerRoot(all, nodeSha256);
  const receipt = redemptionRecords(instruction(), nodeSha256)[0]!;
  const inclusion = creditLedgerProof(all, receipt, nodeSha256);
  assert.ok(inclusion);
  assert.equal(
    verifyProof(creditLeaf(receipt, nodeSha256), inclusion.proof, root, inclusion.index, bytesSha256),
    true,
  );
});
