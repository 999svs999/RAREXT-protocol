/**
 * Runnable erasure-coding example: 1 MiB -> 4+2 shards -> lose one -> rebuild.
 *
 *   node --experimental-strip-types examples/erasure/main.ts
 *
 * The example imports the shipped primitive and store directly, so it exercises
 * the same code the API uses. It creates its own temporary directory and removes
 * it on exit; no files outside the temp directory are written.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeBytes, encodeBytes } from "../../apps/api/src/erasure.ts";
import { BlobStore } from "../../apps/api/src/storage.ts";

const K = 4;
const M = 2;
const PAYLOAD_BYTES = 1024 * 1024;
const LOST_SHARD = 2;

const directory = mkdtempSync(join(tmpdir(), "rarext-erasure-example-"));

try {
  const store = new BlobStore(join(directory, "blobs"));
  const payload = randomBytes(PAYLOAD_BYTES);

  console.log(`payload: ${payload.length.toLocaleString()} bytes`);

  const shards = encodeBytes(payload, K, M);
  const stored = shards.map((shard) => ({
    shard,
    record: store.put(shard.bytes, { mediaType: "application/octet-stream" }),
  }));

  console.log(`\nencoded with k=${K}, m=${M}: ${stored.length} shards`);
  for (const { shard, record } of stored) {
    console.log(
      `  shard ${shard.index}: ${shard.bytes.length.toLocaleString()} bytes  sha256=${record.hash}`,
    );
  }

  console.log(`\npayload digest: ${shards[0]!.payloadDigest}`);
  console.log(`shard digests: ${shards.map((shard) => shard.digest).join(" ")}`);

  const totalShardBytes = stored.reduce((sum, { shard }) => sum + shard.bytes.length, 0);
  const overhead = totalShardBytes / payload.length;
  console.log(
    `\nstored shard bytes: ${totalShardBytes.toLocaleString()} (${overhead.toFixed(2)}x the payload, ${(
      (overhead - 1) *
      100
    ).toFixed(0)}% overhead)`,
  );

  const lost = stored[LOST_SHARD]!;
  assert.equal(store.remove(lost.record.hash), true);
  assert.equal(store.get(lost.record.hash), null);
  console.log(`\ndeleted shard ${lost.shard.index} (${lost.record.hash}); ${stored.length - 1} remain in the store`);

  const survivors = stored
    .filter(({ shard }) => shard.index !== LOST_SHARD)
    .map(({ shard, record }) => {
      const found = store.get(record.hash);
      assert.ok(found, `shard ${shard.index} must still be readable from the blob store`);
      return { ...shard, bytes: Uint8Array.from(found.bytes) };
    });

  console.log(`reading ${survivors.length} shards back from the store...`);
  const rebuilt = decodeBytes(survivors);

  assert.equal(Buffer.from(rebuilt).equals(payload), true, "rebuilt bytes must equal the payload");
  console.log(`rebuilt ${rebuilt.length.toLocaleString()} bytes; digest matches ${shards[0]!.payloadDigest}`);
  console.log("\nOK: any k of n shards reconstructed the payload after one was deleted.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
