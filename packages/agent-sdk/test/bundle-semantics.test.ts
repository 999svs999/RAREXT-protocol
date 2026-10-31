import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_SEMANTICS,
  LOGIC_SEMANTICS,
  semanticsCommitmentArtifact,
  semanticsDigests,
  semanticsKey,
  semanticsRecordDigest,
} from "../../core/src/index.ts";
import { createHash } from "node:crypto";

import { verifyBundleSemantics } from "../src/index.ts";

/**
 * An agent holding a bundle, with no server and no key, answering RFC 0003's question 1:
 * is the MEANING I resolved the one the registry anchored? The comparison is core's, so the
 * page a human opens and the agent that reads the same bundle apply one rule.
 */
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const records = [LOGIC_SEMANTICS[0]!, AI_SEMANTICS[0]!];
const commitment = semanticsCommitmentArtifact(semanticsDigests(records, sha));

const bundleWith = (semantics: unknown[]) =>
  ({ publications: [{ artifact: commitment }], semantics }) as never;

test("an agent verifies a bundle's anchored meanings offline", () => {
  const status = verifyBundleSemantics(bundleWith(records));
  assert.ok(status);
  assert.equal(status!.committed, records.length);
  assert.equal(status!.matched, records.length);
  assert.deepEqual(status!.missing, []);
});

test("a record the commitment does not cover is named, and a bundle with none answers null", () => {
  const edited = { ...records[0]!, summary: "edited after the commitment was written" };
  const drifted = verifyBundleSemantics(bundleWith([edited, records[1]!]));
  assert.deepEqual(drifted!.missing, [semanticsKey(edited)]);

  // Null is not false: no commitment means the artifact never made the claim.
  assert.equal(verifyBundleSemantics({ publications: [{ artifact: { app: "x", kind: "y" } }] } as never), null);

  // And the digest the agent compares against is the record's canonical form, not its JSON text.
  assert.equal(semanticsRecordDigest(records[0]!, sha), semanticsDigests([records[0]!], sha)[semanticsKey(records[0]!)]);
});
