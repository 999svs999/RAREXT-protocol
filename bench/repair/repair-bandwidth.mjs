#!/usr/bin/env node
// Measures what it actually costs to rebuild one lost erasure shard.
//
// The storage contract asks for repair traffic below 1/k of the blob for a
// single loss. For an MDS code that is arithmetically impossible: rebuilding
// one shard needs k shards, so the read alone is the whole payload. This
// harness records the measurement instead of assuming the answer, and keeps
// the negative result in view.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { decodeBytes, encodeBytes, verifyShard } from "../../apps/api/src/erasure.ts";

const GiB = 1024 ** 3;

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pattern(length) {
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x9e3779b9;

  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }

  return bytes;
}

export function measureRepair({ bytes = GiB, dataShards = 4, parityShards = 2, write = true } = {}) {
  const payload = pattern(bytes);
  const payloadDigest = digest(payload);

  const encoded = encodeBytes(payload, dataShards, parityShards);
  for (const shard of encoded) {
    if (!verifyShard(shard)) throw new Error(`shard ${shard.index} failed verification`);
  }

  const lost = encoded[0];
  const survivors = encoded.slice(1);

  if (survivors.length < dataShards) throw new Error("not enough survivors");

  const started = performance.now();
  const keep = survivors.slice(0, dataShards);
  const readBytes = keep.reduce((total, shard) => total + shard.bytes.byteLength, 0);
  const rebuiltPayload = decodeBytes(keep);
  const rebuilt = encodeBytes(rebuiltPayload, dataShards, parityShards)[lost.index];
  const writeBytes = rebuilt.bytes.byteLength;
  const elapsedMs = performance.now() - started;

  if (!verifyShard(rebuilt)) throw new Error("rebuilt shard failed verification");
  if (rebuilt.digest !== lost.digest) throw new Error("rebuilt shard digest differs");
  if (digest(rebuiltPayload) !== payloadDigest) throw new Error("rebuilt payload digest differs");

  const shardBytes = lost.bytes.byteLength;
  const totalBytes = readBytes + writeBytes;
  const result = {
    payloadBytes: bytes,
    dataShards,
    parityShards,
    shardBytes,
    readBytes,
    writeBytes,
    totalBytes,
    readRatio: readBytes / bytes,
    writeRatio: writeBytes / bytes,
    totalRatio: totalBytes / bytes,
    idealRatio: 1 / dataShards,
    exact: true,
    elapsedMs,
  };

  if (write) {
    const out = new URL("./RESULTS.json", import.meta.url);
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

function human(bytes) {
  return `${(bytes / GiB).toFixed(3)} GiB`;
}

function main() {
  const bytes = Number(argument("bytes", String(GiB)));
  const dataShards = Number(argument("data", "4"));
  const parityShards = Number(argument("parity", "2"));
  const write = !flag("no-write");
  const result = measureRepair({ bytes, dataShards, parityShards, write });

  console.log(`payload        ${bytes.toLocaleString()} bytes (${human(bytes)})`);
  console.log(`code           ${dataShards} data + ${parityShards} parity`);
  console.log(`read           ${human(result.readBytes)} (${result.readRatio.toFixed(3)}x blob)`);
  console.log(`write          ${human(result.writeBytes)} (${result.writeRatio.toFixed(3)}x blob)`);
  console.log(`total          ${human(result.totalBytes)} (${result.totalRatio.toFixed(3)}x blob)`);
  console.log(`target < 1/k   ${result.idealRatio.toFixed(3)}x blob — not reachable for one MDS shard`);
  console.log(`verified       payload and rebuilt shard digests match`);
  console.log(`elapsed        ${(result.elapsedMs / 1000).toFixed(1)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
