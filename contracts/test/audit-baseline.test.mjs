import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUDIT_PATH,
  compareBaseline,
  computeBaseline,
  recordedBaseline,
} from "../scripts/audit-baseline.mjs";

test("the audit baseline in AUDIT.md matches the compiled contract", () => {
  const actual = computeBaseline();
  const recorded = recordedBaseline(readFileSync(AUDIT_PATH, "utf8"));

  assert.deepEqual(compareBaseline(actual, recorded), []);
  assert.deepEqual(recorded, {
    sourceSha256: actual.sourceSha256,
    gitBlob: actual.gitBlob,
    creationBytecodeSha256: actual.creationBytecodeSha256,
    runtimeBytecodeSha256: actual.runtimeBytecodeSha256,
    abiSha256: actual.abiSha256,
  });
});

test("the baseline is reproducible and covers the relay interface", () => {
  const first = computeBaseline();
  const recorded = recordedBaseline(readFileSync(AUDIT_PATH, "utf8"));

  assert.equal(first.creationBytecodeSha256, recorded.creationBytecodeSha256);
  assert.equal(first.runtimeBytecodeSha256, recorded.runtimeBytecodeSha256);
  assert.equal(first.abiSha256, recorded.abiSha256);
  assert.equal(first.toolchain.solc, "0.8.38");
  assert.equal(first.toolchain.evmVersion, "cancun");

  assert.match(first.creationBytecodeSha256, /^[0-9a-f]{64}$/);
  assert.match(first.runtimeBytecodeSha256, /^[0-9a-f]{64}$/);
  assert.match(first.abiSha256, /^[0-9a-f]{64}$/);
});

test("a changed or missing recorded value is reported", () => {
  const actual = computeBaseline();
  const changed = compareBaseline(actual, {
    ...actual,
    runtimeBytecodeSha256: "0".repeat(64),
  });

  assert.equal(changed.length, 1);
  assert.match(changed[0], /Runtime bytecode SHA-256/);

  const missing = compareBaseline(actual, { ...actual, abiSha256: undefined });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /ABI SHA-256 is missing/);
});
