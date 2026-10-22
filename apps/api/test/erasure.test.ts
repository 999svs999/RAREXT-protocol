import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  decodeBytes,
  encodeBytes,
  shardDigest,
  verifyShard,
  type ErasureShard,
} from "../src/erasure.ts";

/**
 * Erasure coding is the difference between "we replicated it" and "we can
 * rebuild it from any k of n holders". The tests below are the contract:
 * every k-subset reconstructs, k-1 cannot, and a shard that lies about itself
 * is rejected before it is used.
 */

function combinations(count: number, choose: number): number[][] {
  const result: number[][] = [];

  function walk(start: number, chosen: number[]): void {
    if (chosen.length === choose) {
      result.push([...chosen]);
      return;
    }

    for (let index = start; index < count; index += 1) {
      walk(index + 1, [...chosen, index]);
    }
  }

  walk(0, []);
  return result;
}

test("a payload round-trips through every shard", () => {
  const payload = randomBytes(1000);
  const shards = encodeBytes(payload, 4, 2);

  assert.equal(shards.length, 6);
  assert.deepEqual(Buffer.from(decodeBytes(shards)), payload);
});

test("any k of the n shards reconstruct the payload", () => {
  const payload = randomBytes(257);
  const shards = encodeBytes(payload, 3, 2);

  for (const subset of combinations(shards.length, 3)) {
    const chosen = subset.map((index) => shards[index]!);
    assert.deepEqual(
      Buffer.from(decodeBytes(chosen)),
      payload,
      `the subset ${subset.join(",")} did not reconstruct`,
    );
  }
});

test("fewer than k shards cannot reconstruct", () => {
  const payload = randomBytes(64);
  const shards = encodeBytes(payload, 4, 2);

  assert.throws(() => decodeBytes(shards.slice(0, 3)), /at least 4 shards/);
});

test("one data shard means plain replication", () => {
  const payload = randomBytes(33);
  const shards = encodeBytes(payload, 1, 2);

  assert.equal(shards.length, 3);

  for (const shard of shards) {
    assert.deepEqual(Buffer.from(decodeBytes([shard])), payload);
  }
});

test("a corrupted shard fails its own digest and is refused", () => {
  const payload = randomBytes(120);
  const shards = encodeBytes(payload, 2, 2);
  const corrupted = { ...shards[1]!, bytes: Uint8Array.from(shards[1]!.bytes) };
  corrupted.bytes[0] ^= 0xff;

  assert.equal(verifyShard(corrupted), false);
  assert.throws(() => decodeBytes([shards[0]!, corrupted]), /digest/);
});

test("a shard relabelled with another index is refused", () => {
  const payload = randomBytes(120);
  const shards = encodeBytes(payload, 2, 2);
  const relabelled: ErasureShard = { ...shards[2]!, index: 3 };

  assert.equal(verifyShard(relabelled), false);
  assert.throws(() => decodeBytes([shards[0]!, shards[1]!, relabelled]), /digest/);
});

test("a shard from a different set is refused", () => {
  const first = encodeBytes(randomBytes(100), 2, 2);
  const second = encodeBytes(randomBytes(100), 2, 2);

  assert.throws(
    () => decodeBytes([first[0]!, first[1]!, second[2]!]),
    /same set|digest/,
  );
});

test("empty and unaligned payloads round-trip", () => {
  for (const size of [0, 1, 2, 5, 7, 64, 65, 999]) {
    const payload = randomBytes(size);
    const shards = encodeBytes(payload, 3, 3);
    assert.deepEqual(Buffer.from(decodeBytes(shards)), payload, `size ${size}`);
  }
});

test("the encoding is deterministic", () => {
  const payload = randomBytes(300);
  const first = encodeBytes(payload, 5, 3);
  const second = encodeBytes(payload, 5, 3);

  assert.deepEqual(
    first.map((shard) => shardDigest(shard)),
    second.map((shard) => shardDigest(shard)),
  );
});

test("a digest covers the shard's identity, not only its bytes", () => {
  const shard = encodeBytes(randomBytes(50), 2, 2)[0]!;

  assert.notEqual(
    shardDigest(shard),
    shardDigest({ ...shard, index: shard.index + 1 }),
  );
  assert.notEqual(
    shardDigest(shard),
    shardDigest({ ...shard, length: shard.length + 1 }),
  );
});

test("shards of a set agree on their parameters and size", () => {
  const shards = encodeBytes(randomBytes(500), 4, 4);

  for (const shard of shards) {
    assert.equal(shard.dataShards, 4);
    assert.equal(shard.parityShards, 4);
    assert.equal(shard.length, 500);
    assert.equal(shard.bytes.length, shards[0]!.bytes.length);
  }
});

test("impossible parameters are rejected", () => {
  assert.throws(() => encodeBytes(new Uint8Array([1]), 0, 3), /data shards/);
  assert.throws(() => encodeBytes(new Uint8Array([1]), 5, -1), /parity/);
  assert.throws(() => encodeBytes(new Uint8Array([1]), 3, 300), /255/);
});
