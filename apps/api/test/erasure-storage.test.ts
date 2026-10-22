import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeBytes, encodeBytes, verifyShard } from "../src/erasure.ts";
import { BlobStore } from "../src/storage.ts";

/**
 * The shards are just bytes, so they live in the same content-addressed store as
 * everything else. That is the point: durability is a property of the shard set,
 * not of a special storage service.
 */

test("shards stored as blobs reconstruct the payload after one is lost", () => {
  const directory = mkdtempSync(join(tmpdir(), "rarext-erasure-"));

  try {
    const store = new BlobStore(directory);
    const payload = randomBytes(4096);
    const shards = encodeBytes(payload, 4, 2);

    const hashes = shards.map(
      (shard) => store.put(shard.bytes, { mediaType: "application/octet-stream" }).hash,
    );

    // Lose shard 0 and read the rest back by their content hash.
    const survivors = shards.slice(1).map((shard) => {
      const found = store.get(hashes[shard.index]!);
      assert.ok(found, `shard ${shard.index} should be in the store`);
      return { ...shard, bytes: Uint8Array.from(found.bytes) };
    });

    assert.equal(survivors.length, 5);
    assert.deepEqual(Buffer.from(decodeBytes(survivors)), payload);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupted stored shard is refused and the rest still reconstruct", () => {
  const directory = mkdtempSync(join(tmpdir(), "rarext-erasure-"));

  try {
    const store = new BlobStore(directory);
    const payload = randomBytes(1024);
    const shards = encodeBytes(payload, 3, 2);

    const hashes = shards.map((shard) => store.put(shard.bytes).hash);
    const found = store.get(hashes[0]!);
    assert.ok(found);

    // Flip a byte in a copy of the stored shard. Its digest no longer matches.
    const corrupted = Uint8Array.from(found.bytes);
    corrupted[0] ^= 0xff;
    assert.equal(verifyShard({ ...shards[0]!, bytes: corrupted }), false);
    assert.throws(
      () => decodeBytes([{ ...shards[0]!, bytes: corrupted }, ...shards.slice(1)]),
      /digest/,
    );

    const recovered = shards.slice(1).map((shard) => ({
      ...shard,
      bytes: Uint8Array.from(store.get(hashes[shard.index]!)!.bytes),
    }));

    assert.deepEqual(Buffer.from(decodeBytes(recovered)), payload);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
