import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chunkLeaves } from "../src/durability.ts";
import { decodeShardsToFile, encodeFileToShards, reencodeStreamedShard } from "../src/erasure-stream.ts";
import { merkleRoot } from "../src/merkle.ts";

function workspace(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "rarext-erasure-stream-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeInput(root: string, bytes: Uint8Array): string {
  const path = join(root, "payload.bin");
  writeFileSync(path, bytes);
  return path;
}

function read(path: string): Buffer {
  return readFileSync(path);
}

test("streaming erasure round-trips across chunk boundaries and any k shards", () => {
  const { root, cleanup } = workspace();

  try {
    const payload = randomBytes(1024 * 1024 + 123);
    const inputPath = writeInput(root, payload);
    const placement = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 3,
      parityShards: 2,
      chunkBytes: 3 * 4096 * 4,
    });

    assert.equal(placement.length, payload.length);
    assert.equal(placement.payloadDigest, createHash("sha256").update(payload).digest("hex"));
    assert.equal(placement.shards.length, 5);

    const output = join(root, "output-all.bin");
    const all = decodeShardsToFile({ placement, outputPath: output });
    assert.equal(all.bytes, payload.length);
    assert.deepEqual(read(output), payload);

    const available = [0, 2, 3].map((index) => ({
      index,
      path: placement.shards[index]!.path,
    }));
    const partial = join(root, "output-k.bin");
    decodeShardsToFile({ placement, outputPath: partial, available });
    assert.deepEqual(read(partial), payload);
  } finally {
    cleanup();
  }
});

test("streamed shard roots and hashes commit to the shard files", () => {
  const { root, cleanup } = workspace();

  try {
    const payload = randomBytes(200_000);
    const inputPath = writeInput(root, payload);
    const placement = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 3,
    });

    for (const shard of placement.shards) {
      const bytes = read(shard.path);
      assert.equal(shard.bytes, bytes.length);
      assert.equal(shard.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(merkleRoot(chunkLeaves(bytes)), shard.root);
      assert.equal(shard.leaves, chunkLeaves(bytes).length);
    }
  } finally {
    cleanup();
  }
});

test("empty and chunk-aligned payloads round-trip", () => {
  const { root, cleanup } = workspace();
  const chunkBytes = 2 * 4096 * 2;

  try {
    for (const [name, payload] of [
      ["empty", Buffer.alloc(0)],
      ["short", Buffer.from("a")],
      ["aligned", randomBytes(chunkBytes)],
    ] as const) {
      const inputPath = writeInput(join(root), payload);
      const placement = encodeFileToShards({
        inputPath,
        outputDir: join(root, `shards-${name}`),
        dataShards: 2,
        parityShards: 1,
        chunkBytes,
      });
      const output = join(root, `out-${name}.bin`);

      decodeShardsToFile({ placement, outputPath: output });
      assert.deepEqual(read(output), Buffer.from(payload), name);
    }
  } finally {
    cleanup();
  }
});

test("a tampered or missing shard is refused", () => {
  const { root, cleanup } = workspace();

  try {
    const payload = randomBytes(300_000);
    const inputPath = writeInput(root, payload);
    const placement = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });

    const tampered = read(placement.shards[1]!.path);
    tampered[Math.floor(tampered.length / 2)]! ^= 0xff;
    writeFileSync(placement.shards[1]!.path, tampered);

    const withTampered = [0, 1].map((index) => ({
      index,
      path: placement.shards[index]!.path,
    }));

    assert.throws(
      () => decodeShardsToFile({ placement, outputPath: join(root, "bad.bin"), available: withTampered }),
      /recorded digest/,
    );
    assert.equal(existsSync(join(root, "bad.bin")), false);

    const unaffected = [0, 2].map((index) => ({
      index,
      path: placement.shards[index]!.path,
    }));

    decodeShardsToFile({ placement, outputPath: join(root, "good.bin"), available: unaffected });
    assert.deepEqual(read(join(root, "good.bin")), payload);

    assert.throws(
      () => decodeShardsToFile({
        placement,
        outputPath: join(root, "short.bin"),
        available: [{ index: 0, path: placement.shards[0]!.path }],
      }),
      /need 2 shard files/,
    );
    assert.equal(existsSync(join(root, "short.bin")), false);
  } finally {
    cleanup();
  }
});

test("a truncated shard is refused before any output is written", () => {
  const { root, cleanup } = workspace();

  try {
    const payload = randomBytes(200_000);
    const inputPath = writeInput(root, payload);
    const placement = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });
    const shardPath = placement.shards[1]!.path;
    const bytes = read(shardPath);
    writeFileSync(shardPath, bytes.subarray(0, bytes.length - 1));

    const output = join(root, "truncated.bin");

    assert.throws(
      () => decodeShardsToFile({ placement, outputPath: output }),
      /file is .* expected/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    cleanup();
  }
});


test("reencoding a shard refuses a corrupt survivor and leaves no output", () => {
  const { root, cleanup } = workspace();

  try {
    const payload = randomBytes(200_000);
    const inputPath = writeInput(root, payload);
    const placement = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });
    const survivorPath = placement.shards[1]!.path;
    const bytes = read(survivorPath);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    writeFileSync(survivorPath, bytes);

    const output = join(root, "rebuilt-shard.bin");

    assert.throws(
      () => reencodeStreamedShard({
        placement,
        targetIndex: 2,
        available: [0, 1].map((index) => ({
          index,
          path: placement.shards[index]!.path,
        })),
        outputPath: output,
      }),
      /digest/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    cleanup();
  }
});
