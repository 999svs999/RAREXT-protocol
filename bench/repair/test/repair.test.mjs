import test from "node:test";
import assert from "node:assert/strict";

import { measureRepair } from "../repair-bandwidth.mjs";

test("a lost shard is rebuilt from k survivors with the expected accounting", () => {
  const result = measureRepair({ bytes: 64 * 1024, dataShards: 4, parityShards: 2, write: false });

  assert.equal(result.exact, true);
  assert.equal(result.losses, 1);
  assert.equal(result.readBytes, result.payloadBytes);
  assert.equal(result.writeBytes, result.payloadBytes / 4);
  assert.equal(result.totalRatio, 1.25);
  assert.equal(result.floorRatio, 1.25);
});

test("two simultaneous losses rebuild both shards at the 1 + m/k floor", () => {
  const result = measureRepair({
    bytes: 64 * 1024,
    dataShards: 4,
    parityShards: 2,
    losses: 2,
    write: false,
  });

  assert.equal(result.exact, true);
  assert.equal(result.losses, 2);
  assert.equal(result.readBytes, result.payloadBytes);
  assert.equal(result.writeBytes, result.payloadBytes / 2);
  assert.equal(result.totalRatio, 1.5);
  assert.equal(result.floorRatio, 1.5);
});

test("losing more shards than the parity count is refused", () => {
  assert.throws(
    () => measureRepair({ bytes: 1024, dataShards: 4, parityShards: 2, losses: 3, write: false }),
    /parity/,
  );
});
