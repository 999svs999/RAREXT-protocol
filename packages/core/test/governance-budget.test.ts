import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  GOVERNANCE_BUDGET_KIND,
  GOVERNANCE_PROPOSAL_KIND,
  budgetPaymentRecords,
  creditLedgerRoot,
  governanceBudgetProblems,
  proposalProblems,
  proposalRoot,
} from "../src/index.ts";
import type { GovernanceBudget, GovernanceProposal } from "../src/index.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const byteHash = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

function proposal(): GovernanceProposal {
  return {
    kind: GOVERNANCE_PROPOSAL_KIND,
    id: "prop-mirror-fund",
    title: "Fund the mirror operators",
    question: "Should the treasury pledge 500 credits to the mirror operators?",
    choices: ["yes", "no"],
    closesAt: "2026-12-01T00:00:00.000Z",
    quorum: { kind: "keys", value: 1 },
    policy: { kind: "key" },
  };
}

function budget(): GovernanceBudget {
  return {
    kind: GOVERNANCE_BUDGET_KIND,
    version: 1,
    from: "treasury-key",
    to: "mirror-operator-key",
    amount: 500,
    reason: "the operators kept every mirror current through the migration",
    payOn: "yes",
    createdAt: "2026-11-01T00:00:00.000Z",
    proposal: proposal(),
  };
}

test("a budget is refused by name for what it gets wrong, and the carried proposal must be sound", () => {
  assert.deepEqual(governanceBudgetProblems(budget()), [], "a sound budget has no problems");

  const cases: Array<[string, (entry: GovernanceBudget) => void, RegExp]> = [
    ["kind", (entry) => { entry.kind = "other" as never; }, /governance-budget/],
    ["version", (entry) => { entry.version = 2 as never; }, /version 1/],
    ["from", (entry) => { entry.from = ""; }, /debited/],
    ["to", (entry) => { entry.to = ""; }, /credited/],
    ["same key both sides", (entry) => { entry.to = entry.from; }, /pledge to yourself/],
    ["amount", (entry) => { entry.amount = 0; }, /positive integer/],
    ["fractional amount", (entry) => { entry.amount = 10.5; }, /positive integer/],
    ["reason", (entry) => { entry.reason = ""; }, /reason a voter reads/],
    ["payOn", (entry) => { entry.payOn = ""; }, /choice whose decision/],
    ["payOn not offered", (entry) => { entry.payOn = "maybe"; }, /must be a choice the proposal offers/],
    ["createdAt", (entry) => { entry.createdAt = ""; }, /creation time/],
  ];
  for (const [what, mutate, expected] of cases) {
    const entry = budget();
    mutate(entry);
    const problems = governanceBudgetProblems(entry);
    assert.ok(problems.length > 0, `${what} should be refused`);
    assert.match(problems[0]!, expected, `${what}: the refusal names the problem`);
  }

  // An unsound CARRIED proposal is refused, and the refusal says which half is broken.
  const unsound = budget();
  (unsound.proposal as { choices: string[] }).choices = [];
  const problems = governanceBudgetProblems(unsound);
  assert.match(problems[0]!, /unsound proposal/);
});

test("a decided budget becomes exactly TWO ledger entries — a debit and a credit that mirror each other", () => {
  const entry = budget();
  const records = budgetPaymentRecords(entry, "2026-12-01T12:00:00.000Z", sha256);

  assert.equal(records.length, 2);
  const debit = records[0]!;
  const credit = records[1]!;
  assert.equal(debit.keyId, "treasury-key");
  assert.equal(debit.bounty, -500, "the pledger is DEBITED: the protocol never mints");
  assert.equal(credit.keyId, "mirror-operator-key");
  assert.equal(credit.bounty, 500);
  assert.equal(debit.bounty + credit.bounty, 0, "the payment moves credits; it does not create them");

  // Both sides reference the DECISION and carry the same artifact reference — the proposal's ROOT, a
  // real digest — which is what makes the payment once-only under the board's existing rule.
  assert.equal(debit.artifactHash, credit.artifactHash);
  assert.equal(debit.artifactHash, proposalRoot(entry.proposal, sha256));
  assert.match(debit.artifactHash, /^[0-9a-f]{64}$/);
  assert.equal(debit.action, "governance", "a governance payment is not board work");
  assert.equal(debit.challengeId, entry.proposal.id);
  assert.equal(debit.at, credit.at);

  // And the ledger commitment covers both sides with no new machinery — while a ledger holding only
  // the credit (a node that recorded the payout and "forgot" the debit) is a DIFFERENT ledger.
  const withBoth = creditLedgerRoot(records, byteHash);
  assert.match(withBoth, /^[0-9a-f]{64}$/);
  assert.notEqual(
    withBoth,
    creditLedgerRoot([credit], byteHash),
    "a ledger with only the credit is not the ledger with both sides",
  );

  // The proposal itself is still sound, and its root is what a reference names.
  assert.deepEqual(proposalProblems(entry.proposal), []);
  assert.match(proposalRoot(entry.proposal, sha256), /^[0-9a-f]{64}$/);
});
