#!/usr/bin/env node
// Measures what it actually costs to rebuild lost erasure shards.
//
// For an MDS code the repair floor is read = the payload and write = losses/k,
// so total >= 1 + losses/k. This harness records both sides and checks the
// rebuilt shard digests instead of assuming the answer.

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

export function measureRepair({
  bytes = GiB,
  dataShards = 4,
  parityShards = 2,
  losses = 1,
  write = true,
} = {}) {
  if (!Number.isInteger(losses) || losses < 1) throw new Error("losses must be a positive integer");
  if (losses > parityShards) throw new Error("cannot lose more shards than the parity count");

  const payload = pattern(bytes);
  const payloadDigest = digest(payload);

  const encoded = encodeBytes(payload, dataShards, parityShards);
  for (const shard of encoded) {
    if (!verifyShard(shard)) throw new Error(`shard ${shard.index} failed verification`);
  }

  const lost = encoded.slice(0, losses);
  const survivors = encoded.slice(losses);

  if (survivors.length < dataShards) throw new Error("not enough survivors");

  const started = performance.now();
  const keep = survivors.slice(0, dataShards);
  const readBytes = keep.reduce((total, shard) => total + shard.bytes.byteLength, 0);
  const rebuiltPayload = decodeBytes(keep);
  const reencoded = encodeBytes(rebuiltPayload, dataShards, parityShards);
  const rebuilt = lost.map((shard) => reencoded[shard.index]);
  const writeBytes = rebuilt.reduce((total, shard) => total + shard.bytes.byteLength, 0);
  const elapsedMs = performance.now() - started;

  if (digest(rebuiltPayload) !== payloadDigest) throw new Error("rebuilt payload digest differs");

  for (const [index, shard] of rebuilt.entries()) {
    if (!verifyShard(shard)) throw new Error(`rebuilt shard ${shard.index} failed verification`);
    if (shard.digest !== lost[index].digest) throw new Error(`rebuilt shard ${shard.index} digest differs`);
  }

  const shardBytes = lost[0].bytes.byteLength;
  const totalBytes = readBytes + writeBytes;
  const result = {
    payloadBytes: bytes,
    dataShards,
    parityShards,
    losses,
    shardBytes,
    readBytes,
    writeBytes,
    totalBytes,
    readRatio: readBytes / bytes,
    writeRatio: writeBytes / bytes,
    totalRatio: totalBytes / bytes,
    floorRatio: 1 + losses / dataShards,
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
  const losses = Number(argument("losses", "1"));
  const write = !flag("no-write");
  const result = measureRepair({ bytes, dataShards, parityShards, losses, write });

  console.log(`payload        ${bytes.toLocaleString()} bytes (${human(bytes)})`);
  console.log(`code           ${dataShards} data + ${parityShards} parity, ${result.losses} loss(es)`);
  console.log(`read           ${human(result.readBytes)} (${result.readRatio.toFixed(3)}x blob)`);
  console.log(`write          ${human(result.writeBytes)} (${result.writeRatio.toFixed(3)}x blob)`);
  console.log(`total          ${human(result.totalBytes)} (${result.totalRatio.toFixed(3)}x blob)`);
  console.log(`MDS floor      ${result.floorRatio.toFixed(3)}x blob (read 1.0x + write ${losses}/${dataShards})`);
  console.log(`verified       payload and ${result.losses} rebuilt shard digest(s) match`);
  console.log(`elapsed        ${(result.elapsedMs / 1000).toFixed(1)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
