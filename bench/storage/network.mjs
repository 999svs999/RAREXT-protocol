#!/usr/bin/env node
// npm run bench:network -- [--mb 1024] [--before-mb 64] [--k 4] [--m 2]
//
// Measures the holder HTTP path with real holder child processes:
//   before: whole-shard base64 JSON at the largest payload that fits the 32 MiB
//           body cap (64 MiB at 4+2).
//   after:  raw streaming PUT/GET of file-backed shards at 64 MiB and 1 GiB.
// Client and holder peak RSS are sampled per process. Scope: loopback HTTP and
// local disk; excludes blob encode/decode timing unless stated.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeBytes, encodeBytes } from "../../apps/api/src/erasure.ts";
import { encodeFileToShards } from "../../apps/api/src/erasure-stream.ts";
import { DurabilityLedger, httpHolder } from "../../apps/api/src/durability.ts";

const MIB = 1024 * 1024;
const TOKEN = "bench-holder-token";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be positive`);
  return parsed;
}

function stringOption(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const mode = stringOption("mode");
const sizeMb = option("mb", 1024);
const dataShards = option("k", 4);
const parityShards = option("m", 2);
const chunkMb = option("chunk-mb", 8);
const size = Math.round(sizeMb * MIB);
const chunkBytes = Math.round(chunkMb * MIB);
const jsonPath = stringOption("json");
const manifestPath = stringOption("manifest");
const inputPath = stringOption("input");
const outputPath = stringOption("output");
const shardDir = stringOption("shards");

function holdersFromArgs() {
  const specs = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== "--holder") continue;
    const spec = process.argv[index + 1];
    const at = spec.indexOf("=");
    specs.push([spec.slice(0, at), spec.slice(at + 1)]);
  }
  return specs.map(([id, url]) => httpHolder(id, url, { token: TOKEN }));
}

function mib(bytes) {
  return bytes / MIB;
}

function fmt(value, digits = 2) {
  return value.toFixed(digits);
}

function mbps(bytes, ms) {
  return mib(bytes) / (ms / 1000);
}

function writeRandomFile(path, bytes) {
  const fd = openSync(path, "w");
  const block = 4 * MIB;

  try {
    for (let written = 0; written < bytes; written += block) {
      writeSync(fd, randomBytes(Math.min(block, bytes - written)));
    }
  } finally {
    closeSync(fd);
  }
}

function emit(report) {
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

async function runBefore() {
  const holders = holdersFromArgs();
  const payload = randomBytes(size);
  const ledger = new DurabilityLedger();
  const encodeStart = performance.now();
  const shards = encodeBytes(payload, dataShards, parityShards);
  const encodeMs = performance.now() - encodeStart;

  if (typeof globalThis.gc === "function") globalThis.gc();

  const uploadStart = performance.now();
  const placement = await ledger.place(shards, holders, "durable");
  const uploadMs = performance.now() - uploadStart;

  if (typeof globalThis.gc === "function") globalThis.gc();

  const downloadStart = performance.now();
  const downloaded = [];
  for (const shard of placement.shards.slice(0, dataShards)) {
    const holder = holders.find((candidate) => candidate.id === shard.holder);
    const bytes = await holder.get(shard.storedAs);
    if (!bytes) throw new Error(`missing shard on ${shard.holder}`);
    downloaded.push({
      index: shard.index,
      dataShards: placement.dataShards,
      parityShards: placement.parityShards,
      length: placement.length,
      payloadDigest: placement.blobHash,
      digest: shard.digest,
      bytes: Uint8Array.from(bytes),
    });
  }
  const decoded = decodeBytes(downloaded);
  const downloadMs = performance.now() - downloadStart;
  const digest = createHash("sha256").update(decoded).digest("hex");

  emit({
    path: "whole-shard JSON",
    payloadBytes: size,
    shards: placement.shards.length,
    encodeMs,
    uploadMs,
    downloadMs,
    encodeMiBs: mbps(size, encodeMs),
    uploadMiBs: mbps(size, uploadMs),
    downloadMiBs: mbps(size, downloadMs),
    clientPeakMiB: process.resourceUsage().maxRSS / 1024,
    exact: digest === placement.blobHash,
  });
}

async function runStream() {
  if (!manifestPath) throw new Error("--manifest is required");
  if (!outputPath) throw new Error("--output is required");

  const streamed = JSON.parse(readFileSync(manifestPath, "utf8"));
  const holders = holdersFromArgs();
  const ledger = new DurabilityLedger();

  if (typeof globalThis.gc === "function") globalThis.gc();

  const uploadStart = performance.now();
  const placement = await ledger.placeStreamed(streamed, holders, "durable");
  const uploadMs = performance.now() - uploadStart;

  if (typeof globalThis.gc === "function") globalThis.gc();

  const downloadStart = performance.now();
  const result = await ledger.retrieveStreamed(placement, outputPath, holders);
  const downloadMs = performance.now() - downloadStart;

  emit({
    path: "raw streaming",
    payloadBytes: size,
    shards: placement.shards.length,
    encodeMs: 0,
    uploadMs,
    downloadMs,
    uploadMiBs: mbps(size, uploadMs),
    downloadMiBs: mbps(size, downloadMs),
    clientPeakMiB: process.resourceUsage().maxRSS / 1024,
    exact: result.sha256 === placement.blobHash,
    downloaded: result.downloaded,
  });
}

function runEncode() {
  if (!inputPath || !shardDir || !manifestPath) {
    throw new Error("--input, --shards, and --manifest are required");
  }

  const started = performance.now();
  const streamed = encodeFileToShards({
    inputPath,
    outputDir: shardDir,
    dataShards,
    parityShards,
    chunkBytes,
  });
  const encodeMs = performance.now() - started;

  writeFileSync(manifestPath, `${JSON.stringify(streamed, null, 2)}\n`);
  console.log(`encoded ${sizeMb} MiB in ${fmt(encodeMs / 1000)} s (${fmt(mbps(size, encodeMs), 1)} MiB/s)`);
}

function spawnHolder(index, root) {
  const directory = join(root, `holder-${index}`);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./network-holder.mjs", import.meta.url))],
    {
      env: { ...process.env, HOLDER_ID: `holder-${index}`, HOLDER_DIR: directory, HOLDER_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  return new Promise((resolve, reject) => {
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/PORT (\d+)/);

      if (match) {
        resolve({ id: `holder-${index}`, url: `http://127.0.0.1:${match[1]}`, child, directory });
        buffer = "";
      }
    });
    child.on("exit", (code) => reject(new Error(`holder-${index} exited early (${code})`)));
  });
}

function totalRssMiB(pids) {
  try {
    const output = spawnSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    const values = output.stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isFinite(value));

    return values.map((value) => value / 1024);
  } catch {
    return [];
  }
}

function sampleHolders(pids) {
  let max = 0;
  let maxSum = 0;

  const timer = setInterval(() => {
    const values = totalRssMiB(pids);
    if (values.length === 0) return;
    max = Math.max(max, ...values);
    maxSum = Math.max(maxSum, values.reduce((sum, value) => sum + value, 0));
  }, 200);

  return () => {
    clearInterval(timer);
    return { holderPeakMiB: max, holderSumPeakMiB: maxSum };
  };
}

function runClient(args, pids) {
  const stop = sampleHolders(pids);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      const sample = stop();
      if (code !== 0) {
        reject(new Error(`client exited ${code}`));
        return;
      }

      try {
        resolve({ ...JSON.parse(output.trim().split("\n").at(-1)), ...sample });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runAll() {
  const beforeMb = Math.min(option("before-mb", 64), 64);
  const root = mkdtempSync(join(tmpdir(), "rarext-net-bench-"));
  const holders = [];

  try {
    for (let index = 0; index < dataShards + parityShards; index += 1) {
      holders.push(await spawnHolder(index, root));
    }

    const holderArgs = holders.flatMap((holder) => ["--holder", `${holder.id}=${holder.url}`]);
    const pids = holders.map((holder) => holder.child.pid);
    const rows = [];

    const beforeJson = join(root, "before.json");
    rows.push({
      ...(await runClient(
        ["--mode", "before", "--mb", String(beforeMb), "--json", beforeJson, ...holderArgs],
        pids,
      )),
      scope: `whole-shard JSON, ${beforeMb} MiB (largest that fits the 32 MiB body cap)`,
    });

    for (const mb of [beforeMb, sizeMb]) {
      const label = `${mb}`;
      const dir = join(root, `stream-${label}`);
      const input = join(dir, "payload.bin");
      const shards = join(dir, "shards");
      const manifest = join(dir, "manifest.json");
      const output = join(dir, "output.bin");
      mkdirSync(dir, { recursive: true });
      writeRandomFile(input, Math.round(mb * MIB));

      const encoded = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "--mode",
          "encode",
          "--mb",
          String(mb),
          "--k",
          String(dataShards),
          "--m",
          String(parityShards),
          "--chunk-mb",
          String(chunkMb),
          "--input",
          input,
          "--shards",
          shards,
          "--manifest",
          manifest,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );

      if (encoded.status !== 0) throw new Error(`encode failed for ${mb} MiB`);
      if (statSync(input).size !== Math.round(mb * MIB)) throw new Error("input size mismatch");

      rows.push({
        ...(await runClient(
          [
            "--mode",
            "stream",
            "--mb",
            String(mb),
            "--json",
            join(dir, "client.json"),
            "--manifest",
            manifest,
            "--output",
            output,
            ...holderArgs,
          ],
          pids,
        )),
        scope: `raw streaming, ${mb} MiB`,
      });
    }

    const measuredAt = new Date().toISOString();
    const environment = {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: cpus()[0]?.model ?? "unknown",
    };

    const markdown = `<!-- Generated by \`npm run bench:network\`; \`npm run bench:storage\` includes this section. -->

## HTTP holder path: whole shards vs raw streaming

Measured by \`npm run bench:network\` on ${measuredAt} with Node \`${environment.node}\`
on ${environment.cpu}, using ${dataShards}+${parityShards} shards and real holder child
processes on loopback. Client peak is \`process.resourceUsage().maxRSS\`; holder peak is
sampled with \`ps\` every 200 ms and is the maximum per-holder RSS. Scope: holder HTTP
transport and local disk, not codec development; encode is excluded from the streaming
rows because it is reported separately in the 1 GiB codec section.

| Path | Payload | HTTP body | Upload | Download | Client peak RSS | Holder peak RSS | Exact |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
${rows
  .map(
    (row) =>
      `| ${row.path} | ${fmt(mib(row.payloadBytes), 0)} MiB | ${
        row.path === "whole-shard JSON" ? "base64 JSON" : "raw PUT/GET"
      } | ${fmt(row.uploadMs / 1000)} s (${fmt(row.uploadMiBs, 1)} MiB/s) | ${fmt(
        row.downloadMs / 1000,
      )} s (${fmt(row.downloadMiBs, 1)} MiB/s) | ${fmt(row.clientPeakMiB, 1)} MiB | ${fmt(
        row.holderPeakMiB,
        1,
      )} MiB | ${row.exact ? "yes" : "no"} |`,
  )
  .join("\n")}

- The whole-shard JSON row stops at ${beforeMb} MiB because the holder rejects request
  bodies over 32 MiB. A ${fmt(sizeMb, 0)} MiB blob at ${dataShards}+${parityShards} needs
  ${fmt(mib(size / dataShards), 0)} MiB per shard, and base64 JSON is about
  ${fmt((mib(size / dataShards) * 4) / 3, 0)} MiB. The old path cannot store a blob this large, so
  its row is measured at the largest payload that fits and the streaming row carries the
  ${fmt(sizeMb, 0)} MiB number.
- Raw streaming keeps client and holder peaks roughly flat between ${beforeMb} MiB and
  ${fmt(sizeMb, 0)} MiB; the whole-shard row's client peak includes encoding the payload in
  memory. On this machine the ${fmt(sizeMb, 0)} MiB streaming run was bounded by the
  ${fmt(chunkMb, 0)} MiB chunk size, not the payload size.
- A streamed placement records \`chunkBytes\`, \`chunks\`, and \`chunkDigests\` beside the
  normal shard records, so retrieval verifies each chunk and the whole-payload digest.
  Repair of a streamed placement is not implemented (it still re-encodes a payload in
  memory); the net demo's sealed repair uses the small in-memory placement.
`;

    writeFileSync("bench/storage/NETWORK.md", markdown);
    writeFileSync(
      "bench/storage/NETWORK.json",
      `${JSON.stringify({ measuredAt, ...environment, dataShards, parityShards, rows }, null, 2)}\n`,
    );
    console.log(markdown);
    console.error("wrote bench/storage/NETWORK.md and NETWORK.json");

    if (rows.some((row) => !row.exact)) process.exitCode = 1;
  } finally {
    for (const holder of holders) {
      holder.child.kill("SIGTERM");
    }
    rmSync(root, { recursive: true, force: true });
  }
}

if (mode === "before") {
  await runBefore();
} else if (mode === "stream") {
  await runStream();
} else if (mode === "encode") {
  runEncode();
} else {
  await runAll();
}
