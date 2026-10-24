import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeBytes, encodeBytes, shardDigest, verifyShard } from "../src/erasure.ts";
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

test("exactly k shards reconstruct and k - 1 fails loudly", () => {
  const payload = randomBytes(4096);
  const shards = encodeBytes(payload, 3, 2);

  assert.deepEqual(Buffer.from(decodeBytes(shards.slice(0, 3))), payload);
  assert.throws(() => decodeBytes(shards.slice(0, 2)), /at least 3 shards are needed/);
});

test("a shard relabelled under another index is refused even with a valid self-digest", () => {
  const payload = randomBytes(4096);
  const shards = encodeBytes(payload, 2, 2);
  const copied = {
    ...shards[1]!,
    bytes: Uint8Array.from(shards[0]!.bytes),
    digest: "",
  };

  copied.digest = shardDigest(copied);

  assert.throws(
    () => decodeBytes([shards[0]!, copied]),
    /reconstructed payload does not match its digest/,
  );
});

test("shards with mismatched byte lengths are refused before reconstruction", () => {
  const shards = encodeBytes(randomBytes(4096), 2, 2);
  const short = {
    ...shards[1]!,
    bytes: shards[1]!.bytes.subarray(0, shards[1]!.bytes.length - 1),
  };

  assert.throws(() => decodeBytes([shards[0]!, short]), /same size/);
});
