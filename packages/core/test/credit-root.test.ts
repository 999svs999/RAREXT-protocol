import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  CREDIT_ROOT_DOMAIN,
  CREDIT_ROOT_EXCLUDED_FIELDS,
  CREDIT_ROOT_FIELDS,
  creditRoot,
  matchRecordRoot,
  publicationRoot,
} from "../src/index.ts";
import type { CreditRecordFields } from "../src/index.ts";

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
