#!/usr/bin/env node
// npm run bench:throughput -- [--mb 1024] [--k 4] [--m 2]
//
// Measures the shipped erasure path at 1 GiB: encode (the put path) and decode
// (the get path), plus peak resident memory. HTTP framing is excluded; this is
// the compute cost inside a put and a get, not a network measurement.

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";

import { decodeBytes, encodeBytes } from "../../apps/api/src/erasure.ts";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`);
  return value;
}

const sizeMb = option("mb", 1024);
const dataShards = option("k", 4);
const parityShards = option("m", 2);
const size = Math.round(sizeMb * 1024 * 1024);
const mib = (bytes) => bytes / (1024 * 1024);
const mbps = (bytes, ms) => (bytes / (1024 * 1024)) / (ms / 1000);

const peakBefore = process.resourceUsage().maxRSS;
const baseline = process.memoryUsage();

const payload = randomBytes(size);
const payloadDigest = createHash("sha256").update(payload).digest("hex");

const encodeStart = performance.now();
const shards = encodeBytes(payload, dataShards, parityShards);
const encodeMs = performance.now() - encodeStart;

const afterEncode = process.memoryUsage();

if (typeof globalThis.gc === "function") globalThis.gc();

const decodeStart = performance.now();
const decoded = decodeBytes(shards.slice(0, dataShards));
const decodeMs = performance.now() - decodeStart;

const decodedDigest = createHash("sha256").update(decoded).digest("hex");
const exact = decodedDigest === payloadDigest;
const afterDecode = process.memoryUsage();

const maxRssMiB = process.resourceUsage().maxRSS / 1024;
const beforeRssMiB = baseline.rss / (1024 * 1024);
const afterEncodeRssMiB = afterEncode.rss / (1024 * 1024);
const afterDecodeRssMiB = afterDecode.rss / (1024 * 1024);

const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  payloadBytes: size,
  dataShards,
  parityShards,
  shards: shards.length,
  storedBytes: shards.reduce((total, shard) => total + shard.bytes.length, 0),
  payloadDigest,
  decodedDigest,
  exact,
  encodeMs,
  encodeMiBs: mbps(size, encodeMs),
  decodeMs,
  decodeMiBs: mbps(size, decodeMs),
  rssBeforeMiB: beforeRssMiB,
  rssAfterEncodeMiB: afterEncodeRssMiB,
  rssAfterDecodeMiB: afterDecodeRssMiB,
  peakRssMiB: maxRssMiB,
  peakRssBeforeMiB: peakBefore / 1024,
  gcAvailable: typeof globalThis.gc === "function",
};

const fmt = (value, digits = 2) => value.toFixed(digits);

const markdown = `## 1 GiB throughput and memory

Measured by \`npm run bench:throughput\` on ${report.measuredAt} with Node
\`${report.node}\` on ${report.cpu}. Scope: the shipped erasure path
(\`encodeBytes\`/\`decodeBytes\`, ${dataShards}+${parityShards}), not HTTP or JSON
framing. That is the compute cost inside a put and a get.

| Payload | Shards | Stored | Encode | Encode throughput | Decode | Decode throughput | Peak RSS | Exact |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ${fmt(sizeMb, 0)} MiB | ${report.shards} | ${fmt(mib(report.storedBytes), 1)} MiB | ${fmt(encodeMs / 1000)} s | ${fmt(report.encodeMiBs, 1)} MiB/s | ${fmt(decodeMs / 1000)} s | ${fmt(report.decodeMiBs, 1)} MiB/s | ${fmt(maxRssMiB, 1)} MiB | ${exact ? "yes" : "no"} |

Peak RSS comes from \`process.resourceUsage().maxRSS\` and includes the 1 GiB
payload, all shards, and the decoder working set held in memory at once. It is an
upper bound for one in-memory blob, not a steady-state daemon footprint.
`;

console.log(markdown);
writeFileSync("bench/storage/THROUGHPUT.md", markdown);
writeFileSync("bench/storage/THROUGHPUT.json", `${JSON.stringify(report, null, 2)}\n`);
console.error(`wrote bench/storage/THROUGHPUT.md and THROUGHPUT.json`);

if (!exact) process.exitCode = 1;
