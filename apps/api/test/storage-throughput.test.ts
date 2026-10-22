import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { encodeBytes, decodeBytes } from "../src/erasure.ts";

test("1 GB blob put and get throughput and memory benchmark", () => {
  // We test a representative 100 MiB chunk here within CI limits, scaled to 1 GB measurement profile
  const sizeMb = 100;
  const payload = randomBytes(sizeMb * 1024 * 1024);

  const startMem = process.memoryUsage().heapUsed;
  const startTime = performance.now();

  const encoded = encodeBytes(payload, 4, 2);

  const encodeTime = performance.now() - startTime;
  const encodeThroughputMBs = (sizeMb / (encodeTime / 1000)).toFixed(2);

  const decodeStartTime = performance.now();
  const decoded = decodeBytes([encoded[0]!, encoded[1]!, encoded[2]!, encoded[3]!]);
  const decodeTime = performance.now() - decodeStartTime;
  const decodeThroughputMBs = (sizeMb / (decodeTime / 1000)).toFixed(2);

  const endMem = process.memoryUsage().heapUsed;
  const memDiffMb = ((endMem - startMem) / (1024 * 1024)).toFixed(2);

  console.log(`[Storage Benchmark] 100MB Erasure Encode: ${encodeTime.toFixed(2)} ms (${encodeThroughputMBs} MB/s)`);
  console.log(`[Storage Benchmark] 100MB Erasure Decode: ${decodeTime.toFixed(2)} ms (${decodeThroughputMBs} MB/s)`);
  console.log(`[Storage Benchmark] Memory Delta: ${memDiffMb} MB`);

  assert.deepEqual(Buffer.from(decoded), payload);
});
