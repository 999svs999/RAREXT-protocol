import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  AI_SEMANTICS,
  LOGIC_SEMANTICS,
  semanticsCommitmentArtifact,
  semanticsDigests,
  semanticsKey,
  type Bundle,
  type Semantics,
} from "../../../packages/core/src/index.ts";
import { verifyRegistrySemantics } from "../../mcp/src/verify-semantics.ts";

/**
 * `rarext_verify_semantics` from the outside: a registry port literal, no server and no stdio
 * loop, because the verb's whole claim is that the VERDICT is computed here rather than
 * accepted from the registry. If this test needed the registry's cooperation to be meaningful,
 * it would not be testing the thing the verb promises.
 */
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const records: Semantics[] = [LOGIC_SEMANTICS[0]!, AI_SEMANTICS[0]!];
const commitment = semanticsCommitmentArtifact(semanticsDigests(records, sha));
const ROOT = "0aa477f24e8e276c7a1743f5e0bf2376d45e78510a7557815f27e52eeef8c523";

/**
 * A COMPLETE bundle, not the three fields this check happens to read: the verb's port takes a
 * Bundle, and a fixture that only satisfies the reader would let a caller pass something the
 * route could never return. `tsc` is what enforces that — `node --experimental-strip-types`
 * strips the types without checking them, so a runtime-green suite says nothing about them.
 */
const registry = (
  semantics: Semantics[],
  manifest: Bundle["manifest"] = { root: ROOT } as Bundle["manifest"],
): { bundle(): Promise<Bundle> } => ({
  bundle: async () =>
    ({
      publications: [{ artifact: commitment }],
      semantics,
      manifest,
      anchors: [],
      challenges: [],
    }) as unknown as Bundle,
});

test("a registry whose commitment covers its records reports anchored, with the root it was checked against", async () => {
  const report = await verifyRegistrySemantics(registry(records));
  assert.ok(report);
  assert.equal(report!.committed, records.length);
  assert.equal(report!.matched, records.length);
  assert.deepEqual(report!.missing, []);
  assert.equal(report!.anchored, true);
  assert.equal(report!.root, ROOT);
  // The verdict says what it does not establish, so a caller cannot read more into it.
  assert.match(report!.limit, /does not prove the bundle rebuilds a root/);
});

test("a record edited after the commitment is named, and the verdict is not anchored", async () => {
  const edited = { ...records[0]!, summary: "edited after the commitment was written" };
  const report = await verifyRegistrySemantics(registry([edited, records[1]!]));
  assert.equal(report!.anchored, false);
  assert.deepEqual(report!.missing, [semanticsKey(edited)]);
  assert.equal(report!.matched, records.length - 1);
});

test("a registry that records no commitment answers null — never a failed claim", async () => {
  // null is not false: this bundle never anchored anything, which is a different fact from
  // having anchored meanings that no longer match, and the two must not be reported alike.
  assert.equal(
    await verifyRegistrySemantics({ bundle: async () => ({ publications: [], anchors: [], challenges: [] }) as unknown as Bundle }),
    null,
  );
  // And a bundle whose semantics happen to be present but uncommitted is the same case.
  const uncommitted = await verifyRegistrySemantics({
    bundle: async () =>
      ({
        publications: [{ artifact: { app: "x", kind: "y" } }],
        semantics: records,
        anchors: [],
        challenges: [],
      }) as unknown as Bundle,
  });
  assert.equal(uncommitted, null);
});

test("the root is reported only when the registry actually reports one", async () => {
  const report = await verifyRegistrySemantics(registry(records, {} as Bundle["manifest"]));
  assert.equal(report!.root, null);
});
