import assert from "node:assert/strict";
import test from "node:test";

import { creditStatement } from "../src/index.ts";


test("creditStatement: the derivation is pure, and the same everywhere it runs", () => {
  const records = [
    { keyId: "alice", action: "anchor", bounty: 0, challengeId: "anchor", artifactHash: "a".repeat(64), at: "2026-01-01T00:00:00.000Z" },
    { keyId: "alice", action: "anchor", bounty: 0, challengeId: "anchor", artifactHash: "b".repeat(64), at: "2026-01-02T00:00:00.000Z" },
    { keyId: "alice", action: "participate", bounty: 0, challengeId: "mirror-verify", artifactHash: "a".repeat(64), at: "2026-01-03T00:00:00.000Z" },
    { keyId: "alice", action: "governance", bounty: 300, challengeId: "prop-1", artifactHash: "c".repeat(64), at: "2026-01-04T00:00:00.000Z" },
    { keyId: "alice", action: "governance", bounty: -100, challengeId: "prop-2", artifactHash: "d".repeat(64), at: "2026-01-05T00:00:00.000Z" },
    { keyId: "bob", action: "anchor", bounty: 0, challengeId: "anchor", artifactHash: "a".repeat(64), at: "2026-01-06T00:00:00.000Z" },
  ];

  const statement = creditStatement("alice", records);
  assert.equal(statement.keyId, "alice");
  assert.deepEqual(statement.credits, { earned: 300, spent: 100, net: 200 }, "earned and spent are separate, net is theirs");
  assert.equal(statement.weight, 200, "weight is the ledger total a work-weighted ballot reads");
  // Holds names the CLASSES (receipt acts) the key is in, with its roots — and nothing else.
  assert.deepEqual(statement.holds.map((held) => held.act), ["participate", "anchor"], "RECEIPT_ACTS order");
  const anchorHold = statement.holds.find((held) => held.act === "anchor");
  assert.equal(anchorHold?.receipts, 2);
  assert.deepEqual(anchorHold?.roots, ["a".repeat(64), "b".repeat(64)], "roots are sorted and deduped");
  assert.equal(statement.holds.find((held) => held.act === "participate")?.receipts, 1);

  // A key with nothing, and a key that only anchors: empty holds, zero credits — never an error.
  assert.deepEqual(creditStatement("carol", records), { keyId: "carol", credits: { earned: 0, spent: 0, net: 0 }, holds: [], weight: 0 });
  assert.deepEqual(creditStatement("bob", records).holds, [{ act: "anchor", receipts: 1, roots: ["a".repeat(64)] }]);

  // PURE: the same records give byte-identical results, and the input is not mutated.
  const before = JSON.stringify(records);
  assert.deepEqual(creditStatement("alice", records), statement);
  assert.equal(JSON.stringify(records), before, "the derivation reads, never writes");
});
