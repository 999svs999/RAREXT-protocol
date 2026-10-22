import test from "node:test";
import assert from "node:assert/strict";

import { measureRepair } from "../repair-bandwidth.mjs";

test("a lost shard is rebuilt from k survivors with the expected accounting", () => {
  const result = measureRepair({ bytes: 64 * 1024, dataShards: 4, parityShards: 2, write: false });

  assert.equal(result.exact, true);
  assert.equal(result.readBytes, result.payloadBytes);
  assert.equal(result.writeBytes, result.payloadBytes / 4);
  assert.equal(result.totalRatio, 1.25);
});
