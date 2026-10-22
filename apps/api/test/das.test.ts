import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  availabilityCommitment,
  detectableFraction,
  httpLeafReader,
  missProbability,
  missProbabilityFraction,
  sampleAvailability,
  samplesForMissingFraction,
  type AvailabilitySample,
  type LeafReader,
} from "../src/das.ts";
import { chunkLeaves } from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import { createHolderServer } from "../src/holder-server.ts";
import { merkleProof } from "../src/merkle.ts";

function memoryReader(shards: Uint8Array[], missing = new Set<number>()): LeafReader {
  return {
    async read({ shard, leaf }) {
      if (missing.has(shard)) return null;
      const bytes = shards[shard]!;
      const leaves = chunkLeaves(bytes);
      const start = leaf * 4096;

      return {
        shard,
        leaf,
        bytes: bytes.subarray(start, start + 4096),
        proof: merkleProof(leaves, leaf),
      };
    },
  };
}

test("availability sampling verifies random chunks and reports its bound", async () => {
  const shards = encodeBytes(Buffer.alloc(64 * 1024, 7), 4, 2);
  const commitment = availabilityCommitment(
    shards,
    shards.map((_, index) => `shard-${index}`),
  );
  const report = await sampleAvailability(
    commitment,
    memoryReader(shards.map((shard) => shard.bytes)),
    { samples: 24, random: seeded(1) },
  );

  assert.equal(report.ok, true);
  assert.equal(report.sampled, 24);
  assert.equal(report.failures.length, 0);
  assert.ok(report.bytesRead > 0 && report.bytesRead <= 24 * 4096);
  assert.ok(report.falseNegativeAt10Percent < 0.1);
  assert.ok(report.detectableFractionAt99Percent > 0);
  assert.equal(commitment.blobHash, shards[0]!.payloadDigest);
  assert.equal(
    commitment.shards.reduce((total, shard) => total + shard.leaves, 0),
    commitment.units,
  );
});

test("a withheld shard is a failed sample, never retried away", async () => {
  const shards = encodeBytes(Buffer.alloc(32 * 1024, 3), 3, 2);
  const commitment = availabilityCommitment(
    shards,
    shards.map((_, index) => `shard-${index}`),
  );
  const report = await sampleAvailability(
    commitment,
    memoryReader(
      shards.map((shard) => shard.bytes),
      new Set([0]),
    ),
    { samples: commitment.units, random: seeded(2) },
  );

  assert.equal(report.ok, false);
  assert.ok(report.failures.length >= shards[0]!.bytes.byteLength / 4096);
  assert.ok(report.failures.every((failure) => failure.shard === 0));
  assert.match(report.failures[0]!.reason, /missing/);
});

test("forged chunks and proofs fail against the committed root", async () => {
  const shards = encodeBytes(Buffer.alloc(16 * 1024, 9), 2, 1);
  const commitment = availabilityCommitment(
    shards,
    shards.map((_, index) => `shard-${index}`),
  );
  const honest = memoryReader(shards.map((shard) => shard.bytes));
  const forged: LeafReader = {
    async read(request): Promise<AvailabilitySample> {
      const sample = (await honest.read(request))!;
      return { ...sample, bytes: Buffer.alloc(sample.bytes.length, 1) };
    },
  };
  const report = await sampleAvailability(commitment, forged, {
    samples: 8,
    random: seeded(3),
  });

  assert.equal(report.ok, false);
  assert.match(report.failures[0]!.reason, /proof/);
});

test("the hypergeometric bound matches sampling without replacement", () => {
  assert.equal(missProbability(100, 10, 0), 1);
  assert.equal(missProbability(100, 10, 100), 0);
  assert.ok(missProbability(100, 10, 10) < missProbabilityFraction(0.1, 10));
  assert.ok(missProbability(1000, 100, 44) <= 0.01);
  assert.ok(missProbability(1000, 100, 44) < missProbabilityFraction(0.1, 44));
  assert.ok(samplesForMissingFraction(10000, 0.1, 0.01) <= 44);
  assert.ok(samplesForMissingFraction(10000, 0.05, 0.01) > 44);
  assert.ok(detectableFraction(10000, 44, 0.01) <= 0.1);
  assert.equal(missProbabilityFraction(0, 10), 1);
  assert.equal(missProbabilityFraction(1, 10), 0);
});

test("a real holder serves a leaf and its proof over HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-das-"));
  const server = createHolderServer({ id: "das", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const bytes = Buffer.alloc(12 * 1024, 5);
    const put = await fetch(`${base}/v1/holder/shards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: bytes.toString("base64") }),
    });
    const { storedAs } = (await put.json()) as { storedAs: string };
    const shards = encodeBytes(bytes, 1, 0).map((shard) => ({ ...shard, bytes }));
    const commitment = availabilityCommitment(shards, [storedAs]);
    const report = await sampleAvailability(commitment, httpLeafReader(base), {
      samples: 3,
      random: seeded(4),
    });

    assert.equal(report.ok, true);
    assert.equal(report.failures.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;

  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}
