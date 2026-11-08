import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  INFER_ACTION,
  creditLedgerProof,
  creditLeaf,
  inferenceCreditLedgerRoot,
  inferenceCreditRecords,
  verifyProof,
} from "../src/index.ts";

const nodeSha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

const AGREED = "a".repeat(64);
const DISSENT = "b".repeat(64);

function input(overrides: Partial<Parameters<typeof inferenceCreditRecords>[0]> = {}) {
  return {
    providers: [
      { endpoint: "https://alice.example", responseDigest: AGREED, operator: "key-alice" },
      { endpoint: "https://bob.example", responseDigest: AGREED, operator: "key-bob" },
      { endpoint: "https://carol.example", responseDigest: DISSENT, operator: "key-carol" },
    ],
    responseDigest: AGREED,
    deploymentDigest: "d".repeat(64),
    completedAt: "2026-11-08T00:00:00.000Z",
    bounty: 7,
    ...overrides,
  };
}

test("only the distinct operators that agreed are paid", () => {
  const records = inferenceCreditRecords(input());

  assert.deepEqual(
    records.map((record) => record.keyId),
    ["key-alice", "key-bob"],
    "the dissenter is evidence, not a payee",
  );
  assert.ok(records.every((record) => record.action === INFER_ACTION));
  assert.ok(records.every((record) => record.bounty === 7));
  assert.ok(records.every((record) => record.artifactHash === AGREED));
  assert.equal(records[0]!.challengeId, "d".repeat(64));
});

test("one operator behind two endpoints is paid once", () => {
  const records = inferenceCreditRecords(
    input({
      providers: [
        { endpoint: "https://a1.example", responseDigest: AGREED, operator: "key-alice" },
        { endpoint: "https://a2.example", responseDigest: AGREED, operator: "key-alice" },
      ],
    }),
  );

  assert.equal(records.length, 1);
  assert.equal(records[0]!.keyId, "key-alice");
});

test("a provider with no operator key cannot be paid", () => {
  const records = inferenceCreditRecords(
    input({
      providers: [
        { endpoint: "https://anon.example", responseDigest: AGREED, operator: null },
        { endpoint: "https://bob.example", responseDigest: AGREED, operator: "key-bob" },
      ],
    }),
  );

  assert.deepEqual(records.map((record) => record.keyId), ["key-bob"]);
});

test("the ledger root is a fact about the payments, and every field counts", () => {
  const base = inferenceCreditRecords(input());
  const root = inferenceCreditLedgerRoot(input(), nodeSha256);

  assert.match(root, /^[0-9a-f]{64}$/);
  assert.equal(inferenceCreditLedgerRoot(input(), nodeSha256), root, "deterministic");

  // Reordering providers does not change who is paid.
  const reordered = input({
    providers: [
      { endpoint: "https://bob.example", responseDigest: AGREED, operator: "key-bob" },
      { endpoint: "https://alice.example", responseDigest: AGREED, operator: "key-alice" },
      { endpoint: "https://carol.example", responseDigest: DISSENT, operator: "key-carol" },
    ],
  });
  assert.equal(inferenceCreditLedgerRoot(reordered, nodeSha256), root);

  // A changed bounty, a changed answer, or a paid dissenter is a different ledger.
  assert.notEqual(inferenceCreditLedgerRoot(input({ bounty: 8 }), nodeSha256), root);
  assert.notEqual(inferenceCreditLedgerRoot(input({ responseDigest: DISSENT }), nodeSha256), root);
});

test("an operator can prove its own payment against the published root", () => {
  const records = inferenceCreditRecords(input());
  const root = inferenceCreditLedgerRoot(input(), nodeSha256);

  const receipt = records[0]!;
  const inclusion = creditLedgerProof(records, receipt, nodeSha256);
  assert.ok(inclusion, "the payment is in the ledger");
  assert.equal(
    verifyProof(creditLeaf(receipt, nodeSha256), inclusion.proof, root, inclusion.index, bytesSha256),
    true,
  );

  // An edited receipt no longer proves against the root.
  const edited = { ...receipt, bounty: receipt.bounty + 1 };
  const editedInclusion = creditLedgerProof(records, edited, nodeSha256);
  assert.equal(editedInclusion, null);
});
