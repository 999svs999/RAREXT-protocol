#!/usr/bin/env node
// npm run bench:throughput -- [--mb 1024] [--k 4] [--m 2] [--chunk-mb 8]
//
// Measures the erasure path at 1 GiB in two separate processes so peak RSS is
// attributable:
//   memory   - encodeBytes/decodeBytes hold the payload, blocks, and shards.
//   stream   - encodeFileToShards/decodeShardsToFile work one chunk at a time
//              and write shard files to disk.
// HTTP/JSON framing is excluded; this is the compute cost inside a put and a get.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { decodeBytes, encodeBytes } from "../../apps/api/src/erasure.ts";
import { decodeShardsToFile, encodeFileToShards } from "../../apps/api/src/erasure-stream.ts";

function value(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be positive`);
  return parsed;
}

const sizeMb = value("mb", 1024);
const dataShards = value("k", 4);
const parityShards = value("m", 2);
const chunkMb = value("chunk-mb", 8);
const size = Math.round(sizeMb * 1024 * 1024);
const chunkBytes = Math.round(chunkMb * 1024 * 1024);
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex === -1 ? null : process.argv[modeIndex + 1];
const jsonIndex = process.argv.indexOf("--json");
const jsonPath = jsonIndex === -1 ? null : process.argv[jsonIndex + 1];
const mib = (bytes) => bytes / (1024 * 1024);
const mbps = (bytes, ms) => (bytes / (1024 * 1024)) / (ms / 1000);
const fmt = (number, digits = 2) => number.toFixed(digits);

function environment() {
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
  };
}

function mem() {
  const usage = process.memoryUsage();
  return {
    rssMiB: usage.rss / (1024 * 1024),
    arrayBuffersMiB: usage.arrayBuffers / (1024 * 1024),
  };
}

function measureMemory() {
  const before = mem();
  const payload = randomBytes(size);
  const payloadDigest = createHash("sha256").update(payload).digest("hex");

  const encodeStart = performance.now();
  const shards = encodeBytes(payload, dataShards, parityShards);
  const encodeMs = performance.now() - encodeStart;

  if (typeof globalThis.gc === "function") globalThis.gc();

  const decodeStart = performance.now();
  const decoded = decodeBytes(shards.slice(0, dataShards));
  const decodeMs = performance.now() - decodeStart;

  const decodedDigest = createHash("sha256").update(decoded).digest("hex");
  const after = mem();

  return {
    mode: "memory",
    label: "in-memory `encodeBytes`",
    payloadBytes: size,
    storedBytes: shards.reduce((total, shard) => total + shard.bytes.length, 0),
    shards: shards.length,
    payloadDigest,
    decodedDigest,
    exact: decodedDigest === payloadDigest,
    encodeMs,
    encodeMiBs: mbps(size, encodeMs),
    decodeMs,
    decodeMiBs: mbps(size, decodeMs),
    rssBeforeMiB: before.rssMiB,
    rssAfterMiB: after.rssMiB,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    gcAvailable: typeof globalThis.gc === "function",
  };
}

function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const block = Buffer.alloc(4 * 1024 * 1024);

  try {
    for (;;) {
      const read = readSync(fd, block, 0, block.length, null);
      if (read === 0) break;
      hash.update(block.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }

  return hash.digest("hex");
}

function writeRandomFile(path) {
  const fd = openSync(path, "w");
  const block = 4 * 1024 * 1024;

  try {
    for (let written = 0; written < size; written += block) {
      writeSync(fd, randomBytes(Math.min(block, size - written)));
    }
  } finally {
    closeSync(fd);
  }
}

function measureStream() {
  const work = mkdtempSync(join(tmpdir(), "rarext-throughput-stream-"));
  const inputPath = join(work, "payload.bin");
  const outputDir = join(work, "shards");
  const outputPath = join(work, "decoded.bin");
  const before = mem();

  try {
    writeRandomFile(inputPath);
    const payloadDigest = sha256File(inputPath);

    const encodeStart = performance.now();
    const placement = encodeFileToShards({
      inputPath,
      outputDir,
      dataShards,
      parityShards,
      chunkBytes,
    });
    const encodeMs = performance.now() - encodeStart;

    if (typeof globalThis.gc === "function") globalThis.gc();

    const available = placement.shards.slice(0, dataShards).map((shard) => ({
      index: shard.index,
      path: shard.path,
    }));

    const decodeStart = performance.now();
    const decoded = decodeShardsToFile({ placement, outputPath, available });
    const decodeMs = performance.now() - decodeStart;

    const after = mem();

    return {
      mode: "stream",
      label: "streaming `encodeFileToShards`",
      payloadBytes: size,
      storedBytes: placement.shards.reduce((total, shard) => total + shard.bytes, 0),
      shards: placement.shards.length,
      chunkBytes,
      chunks: placement.chunks,
      payloadDigest,
      decodedDigest: decoded.sha256,
      exact: decoded.sha256 === payloadDigest && placement.payloadDigest === payloadDigest,
      encodeMs,
      encodeMiBs: mbps(size, encodeMs),
      decodeMs,
      decodeMiBs: mbps(size, decodeMs),
      rssBeforeMiB: before.rssMiB,
      rssAfterMiB: after.rssMiB,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
      gcAvailable: typeof globalThis.gc === "function",
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (mode === "memory" || mode === "stream") {
  const report = {
    measuredAt: new Date().toISOString(),
    ...environment(),
    payloadBytes: size,
    dataShards,
    parityShards,
    ...(mode === "stream" ? { chunkBytes } : {}),
    ...(mode === "memory" ? measureMemory() : measureStream()),
  };

  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `${mode}: encode ${fmt(report.encodeMs / 1000)} s, decode ${fmt(report.decodeMs / 1000)} s, ` +
      `peak ${fmt(report.peakRssMiB, 1)} MiB, exact=${report.exact}`,
  );
} else {
  const work = mkdtempSync(join(tmpdir(), "rarext-throughput-"));
  const script = fileURLToPath(import.meta.url);
  const runs = [];

  try {
    for (const next of ["memory", "stream"]) {
      const path = join(work, `${next}.json`);
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          script,
          "--mode",
          next,
          "--mb",
          String(sizeMb),
          "--k",
          String(dataShards),
          "--m",
          String(parityShards),
          "--chunk-mb",
          String(chunkMb),
          "--json",
          path,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );

      if (child.status !== 0) throw new Error(`${next} measurement failed (${child.status})`);
      runs.push(JSON.parse(readFileSync(path, "utf8")));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const [memory, stream] = runs;
  const measuredAt = new Date().toISOString();
  const env = environment();
  const peakDrop = memory.peakRssMiB / stream.peakRssMiB;

  const markdown = `<!-- Generated by \`npm run bench:throughput\`; \`npm run bench:storage\` includes this section when it regenerates RESULTS.md. -->

## 1 GiB throughput and memory

Measured by \`npm run bench:throughput\` on ${measuredAt} with Node \`${env.node}\`
on ${env.cpu}. Both rows use the shipped erasure code at ${dataShards}+${parityShards}
and the same ${fmt(sizeMb, 0)} MiB payload. Each row runs in its own process, so peak
RSS is attributable to that path. Scope: encode/decode compute only, not HTTP or JSON
framing.

| Path | Payload | Shards | Stored | Encode | Encode throughput | Decode | Decode throughput | Peak RSS | Exact |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ${memory.label} | ${fmt(sizeMb, 0)} MiB | ${memory.shards} | ${fmt(mib(memory.storedBytes), 1)} MiB | ${fmt(memory.encodeMs / 1000)} s | ${fmt(memory.encodeMiBs, 1)} MiB/s | ${fmt(memory.decodeMs / 1000)} s | ${fmt(memory.decodeMiBs, 1)} MiB/s | ${fmt(memory.peakRssMiB, 1)} MiB | ${memory.exact ? "yes" : "no"} |
| ${stream.label} | ${fmt(sizeMb, 0)} MiB | ${stream.shards} | ${fmt(mib(stream.storedBytes), 1)} MiB | ${fmt(stream.encodeMs / 1000)} s | ${fmt(stream.encodeMiBs, 1)} MiB/s | ${fmt(stream.decodeMs / 1000)} s | ${fmt(stream.decodeMiBs, 1)} MiB/s | ${fmt(stream.peakRssMiB, 1)} MiB | ${stream.exact ? "yes" : "no"} |

- **In-memory** holds the payload, every data block, and every shard at once. It is the
  API used by the MCP put/get path, which caps input at \`RAREXT_STORAGE_MAX_BYTES\`
  (8 MiB by default).
- **Streaming** reads ${fmt(mib(stream.chunkBytes), 0)} MiB chunks, appends each shard block to a file, and decodes from only
  ${dataShards} of ${stream.shards} shard files. Peak RSS is a function of the chunk size, not
  the payload size.
- Peak RSS comes from \`process.resourceUsage().maxRSS\`; peak fell from
  ${fmt(memory.peakRssMiB, 1)} MiB to ${fmt(stream.peakRssMiB, 1)} MiB (${fmt(peakDrop, 1)}x lower) at this payload size.
- HTTP and JSON framing are excluded from the codec rows. The raw holder transport
  and its 1 GiB measurement are covered in \`NETWORK.md\`.
`;

  writeFileSync("bench/storage/THROUGHPUT.md", markdown);
  writeFileSync(
    "bench/storage/THROUGHPUT.json",
    `${JSON.stringify({ measuredAt, ...env, payloadBytes: size, dataShards, parityShards, runs }, null, 2)}\n`,
  );
  console.log(markdown);
  console.error("wrote bench/storage/THROUGHPUT.md and THROUGHPUT.json");

  if (!memory.exact || !stream.exact) process.exitCode = 1;
}
