#!/usr/bin/env node
// npm run bench:soak -- [--seconds 600] [--holders 8] [--k 4] [--m 2]
//
// Continuous put, challenge/audit, repair, and retrieval against real holder
// child processes, with random holder kills and restarts. Publishes operation
// success rates, repair outcomes, and memory samples. This is a local chaos
// run, not a durability proof: see the caveats in SOAK.md.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeBytes, encodeBytes } from "../../apps/api/src/erasure.ts";
import { DurabilityLedger, httpHolder } from "../../apps/api/src/durability.ts";

const MIB = 1024 * 1024;
const TOKEN = "soak-holder-token";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be positive`);
  return parsed;
}

const durationSeconds = option("seconds", 600);
const holderCount = Math.max(6, Math.floor(option("holders", 8)));
const dataShards = option("k", 4);
const parityShards = option("m", 2);
const payloadBytes = Math.round(option("payload-kb", 64) * 1024);
const killMinSeconds = option("kill-min", 15);
const killMaxSeconds = option("kill-max", 30);
const outageMinSeconds = option("outage-min", 2);
const outageMaxSeconds = option("outage-max", 6);
const activeLimit = 24;

if (dataShards + parityShards > holderCount) {
  throw new Error("holders must cover k + m");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const mib = (bytes) => bytes / MIB;
const fmt = (value, digits = 2) => value.toFixed(digits);
const rate = (ok, attempted) => (attempted === 0 ? "—" : `${fmt((ok / attempted) * 100, 1)}%`);

const startedAt = new Date();
const deadline = Date.now() + durationSeconds * 1000;
const root = mkdtempSync(join(tmpdir(), "rarext-soak-"));

const stats = {
  cycles: 0,
  puts: { attempted: 0, ok: 0, failed: 0 },
  audits: { attempted: 0, ok: 0, under: 0 },
  challenges: { attempted: 0, ok: 0, failed: 0 },
  repairs: { attempted: 0, ok: 0, failed: 0, filled: 0, reauditOk: 0, reauditFailed: 0 },
  retrievals: { attempted: 0, ok: 0, failed: 0 },
  holderKills: 0,
  holderRestarts: 0,
  errors: [],
};

const errors = (label, error) => {
  const message = error instanceof Error ? error.message : String(error);
  stats.errors.push({ at: new Date().toISOString(), operation: label, message });
  if (stats.errors.length > 50) stats.errors.shift();
};

function spawnHolder(id, directory) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./network-holder.mjs", import.meta.url))], {
    env: { ...process.env, HOLDER_ID: id, HOLDER_DIR: directory, HOLDER_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "ignore"],
  });

  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${id} did not report a port`));
    }, 15_000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/PORT (\d+)/);

      if (!match) return;
      clearTimeout(timer);
      resolve({
        id,
        directory,
        child,
        url: `http://127.0.0.1:${match[1]}`,
        holder: httpHolder(id, `http://127.0.0.1:${match[1]}`, { token: TOKEN }),
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${id} exited while starting (${code})`));
    });
  });
}

async function stopHolder(entry) {
  entry.child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.child.kill("SIGKILL");
      resolve();
    }, 5000);
    entry.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function liveHolders() {
  return [...live.values()].map((entry) => entry.holder);
}

function placementFor(blobHash) {
  return ledger.get(blobHash) ?? null;
}

async function retrieve(blobHash) {
  const placement = placementFor(blobHash);
  if (!placement) throw new Error("placement is gone");

  const chosen = [];
  for (const shard of placement.shards) {
    if (chosen.length >= placement.dataShards) break;
    const entry = [...live.values()].find((candidate) => candidate.id === shard.holder);
    if (!entry) continue;

    try {
      const bytes = await entry.holder.get(shard.storedAs);
      if (!bytes) continue;
      chosen.push({
        index: shard.index,
        dataShards: placement.dataShards,
        parityShards: placement.parityShards,
        length: placement.length,
        payloadDigest: placement.blobHash,
        digest: shard.digest,
        bytes: Uint8Array.from(bytes),
      });
    } catch {
      // Holder died mid-read; try another shard.
    }
  }

  if (chosen.length < placement.dataShards) {
    throw new Error(`only ${chosen.length} of ${placement.dataShards} shards were readable`);
  }

  const payload = decodeBytes(chosen);
  const digest = createHash("sha256").update(payload).digest("hex");

  if (digest !== placement.blobHash) throw new Error("decoded payload does not match its digest");
}

function sampleRss(pids) {
  if (pids.length === 0) return { max: 0, sum: 0 };
  try {
    const output = spawnSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    const values = output.stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isFinite(value))
      .map((value) => value / 1024);

    return {
      max: values.length > 0 ? Math.max(...values) : 0,
      sum: values.reduce((total, value) => total + value, 0),
    };
  } catch {
    return { max: 0, sum: 0 };
  }
}

const ledger = new DurabilityLedger();
const live = new Map();
const holderDirectories = new Map();
const memorySeries = [];
const active = [];
let restarting = false;

console.log(`[RAREXT Soak] Starting ${holderCount} holders for ${durationSeconds}s in ${root}...`);

for (let index = 0; index < holderCount; index += 1) {
  const id = `holder-${index}`;
  const directory = join(root, id);
  holderDirectories.set(id, directory);
  live.set(id, await spawnHolder(id, directory));
}

console.log(`[RAREXT Soak] ${live.size} holders live. Payload ${payloadBytes} bytes at ${dataShards}+${parityShards}.`);

let sampling = true;
const memorySampler = (async () => {
  while (sampling) {
    const pids = [...live.values()].map((entry) => entry.child.pid);
    const holders = sampleRss(pids);
    memorySeries.push({
      at: new Date().toISOString(),
      elapsedSeconds: (Date.now() - startedAt.getTime()) / 1000,
      clientRssMiB: process.memoryUsage().rss / MIB,
      holderMaxRssMiB: holders.max,
      holderSumRssMiB: holders.sum,
      holdersLive: live.size,
    });
    await sleep(2000);
  }
})();

async function chaos() {
  while (Date.now() < deadline) {
    await sleep(randomBetween(killMinSeconds, killMaxSeconds) * 1000);
    if (Date.now() >= deadline || restarting) continue;

    const candidates = [...live.keys()];
    if (candidates.length <= dataShards + parityShards) continue;

    const id = candidates[Math.floor(Math.random() * candidates.length)];
    const entry = live.get(id);
    if (!entry) continue;

    restarting = true;
    live.delete(id);
    stats.holderKills += 1;
    console.log(`[RAREXT Soak] Killing ${id}; ${live.size} holders remain.`);
    await stopHolder(entry);

    await sleep(randomBetween(outageMinSeconds, outageMaxSeconds) * 1000);

    try {
      const restarted = await spawnHolder(id, holderDirectories.get(id));
      live.set(id, restarted);
      stats.holderRestarts += 1;
      console.log(`[RAREXT Soak] Restarted ${id}; ${live.size} holders live.`);
    } catch (error) {
      errors("restart", error);
    } finally {
      restarting = false;
    }
  }
}

const chaosRun = chaos();

while (Date.now() < deadline) {
  stats.cycles += 1;

  try {
    const holders = liveHolders();
    if (holders.length < dataShards + parityShards) throw new Error("not enough live holders to place");
    const payload = randomBytes(payloadBytes);
    const placement = await ledger.place(encodeBytes(payload, dataShards, parityShards), holders, "durable");
    stats.puts.ok += 1;
    active.push(placement.blobHash);
    while (active.length > activeLimit) active.shift();
  } catch (error) {
    stats.puts.failed += 1;
    errors("put", error);
  }
  stats.puts.attempted += 1;

  if (active.length > 0) {
    const blobHash = active[Math.floor(Math.random() * active.length)];

    try {
      const holders = liveHolders();
      const outcomes = await ledger.challenge(blobHash, holders);
      stats.challenges.attempted += outcomes.length;
      stats.challenges.ok += outcomes.filter((outcome) => outcome.ok).length;
      stats.challenges.failed += outcomes.filter((outcome) => !outcome.ok).length;
      const audit = ledger.audit(blobHash);
      stats.audits.attempted += 1;

      if (audit.status === "ok") {
        stats.audits.ok += 1;
      } else {
        stats.audits.under += 1;
        stats.repairs.attempted += 1;

        try {
          const repaired = await ledger.repair(blobHash, liveHolders());
          stats.repairs.ok += 1;
          stats.repairs.filled += repaired.filled;
          await ledger.challenge(blobHash, liveHolders());
          const after = ledger.audit(blobHash);

          if (after.status === "ok") stats.repairs.reauditOk += 1;
          else stats.repairs.reauditFailed += 1;
        } catch (error) {
          stats.repairs.failed += 1;
          errors("repair", error);
        }
      }
    } catch (error) {
      stats.audits.attempted += 1;
      stats.audits.under += 1;
      errors("audit", error);
    }

    stats.retrievals.attempted += 1;

    try {
      await retrieve(blobHash);
      stats.retrievals.ok += 1;
    } catch (error) {
      stats.retrievals.failed += 1;
      errors("retrieve", error);
    }
  }

  await sleep(50);
}

sampling = false;
await memorySampler;
await chaosRun;

for (const entry of live.values()) await stopHolder(entry);
live.clear();

const finishedAt = new Date();
const series = memorySeries.filter((sample) => sample.holdersLive > 0);
const peakClient = series.reduce((peak, sample) => Math.max(peak, sample.clientRssMiB), 0);
const peakHolderMax = series.reduce((peak, sample) => Math.max(peak, sample.holderMaxRssMiB), 0);
const peakHolderSum = series.reduce((peak, sample) => Math.max(peak, sample.holderSumRssMiB), 0);
const sampled = [];
const step = Math.max(1, Math.ceil(series.length / 20));

for (let index = 0; index < series.length; index += step) sampled.push(series[index]);
if (series.length > 0 && sampled.at(-1) !== series.at(-1)) sampled.push(series.at(-1));

const report = {
  kind: "rarext.storage.soak",
  version: 1,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationSeconds: Math.round((finishedAt - startedAt) / 1000),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
  },
  configuration: {
    holders: holderCount,
    dataShards,
    parityShards,
    payloadBytes,
    activeBlobs: activeLimit,
    killIntervalSeconds: [killMinSeconds, killMaxSeconds],
    outageSeconds: [outageMinSeconds, outageMaxSeconds],
    loopback: true,
  },
  stats,
  memory: {
    peakClientRssMiB: peakClient,
    peakHolderMaxRssMiB: peakHolderMax,
    peakHolderSumRssMiB: peakHolderSum,
    samples: series.length,
    series: sampled,
  },
};

const markdown = `<!-- Generated by \`npm run bench:soak\`; this is a local chaos run, not a durability proof. -->

## Soak and chaos

Run on ${report.startedAt} for ${report.durationSeconds}s with Node \`${report.environment.node}\`
on ${report.environment.cpu}. ${holderCount} holder child processes on loopback,
${dataShards}+${parityShards}, ${payloadBytes}-byte payloads, ${activeLimit} active blobs.
A random holder is killed every ${killMinSeconds}-${killMaxSeconds}s and restarted after
${outageMinSeconds}-${outageMaxSeconds}s. Scope: one machine, loopback, small payloads; not a
statement about disks, power loss, TLS, or multi-writer coordination.

| Operation | Attempts | Success | Failure | Success rate |
| --- | ---: | ---: | ---: | ---: |
| Put | ${stats.puts.attempted} | ${stats.puts.ok} | ${stats.puts.failed} | ${rate(stats.puts.ok, stats.puts.attempted)} |
| Challenge response | ${stats.challenges.attempted} | ${stats.challenges.ok} | ${stats.challenges.failed} | ${rate(stats.challenges.ok, stats.challenges.attempted)} |
| Audit | ${stats.audits.attempted} | ${stats.audits.ok} | ${stats.audits.under} under | ${rate(stats.audits.ok, stats.audits.attempted)} |
| Repair | ${stats.repairs.attempted} | ${stats.repairs.ok} | ${stats.repairs.failed} | ${rate(stats.repairs.ok, stats.repairs.attempted)} |
| Retrieval | ${stats.retrievals.attempted} | ${stats.retrievals.ok} | ${stats.retrievals.failed} | ${rate(stats.retrievals.ok, stats.retrievals.attempted)} |

- Repairs filled **${stats.repairs.filled}** shard(s); **${stats.repairs.reauditOk}** re-audits
  passed and **${stats.repairs.reauditFailed}** did not.
- Holder kills: **${stats.holderKills}**; restarts: **${stats.holderRestarts}**.
- The audit failures are expected while a holder is down; repair is attempted on the next
  cycle, and the re-audit is the number that matters.
- Peak client RSS: **${fmt(peakClient, 1)} MiB**. Peak holder RSS (max single holder):
  **${fmt(peakHolderMax, 1)} MiB**; peak sum across live holders: **${fmt(peakHolderSum, 1)} MiB**.
- Errors recorded: ${stats.errors.length}${stats.errors.length > 0 ? `; last: ${stats.errors.at(-1).operation}: ${stats.errors.at(-1).message}` : ""}.

### Memory over time

| Elapsed | Client RSS | Holder max | Holder sum | Holders |
| ---: | ---: | ---: | ---: | ---: |
${sampled
  .map(
    (sample) =>
      `| ${fmt(sample.elapsedSeconds, 0)}s | ${fmt(sample.clientRssMiB, 1)} MiB | ${fmt(
        sample.holderMaxRssMiB,
        1,
      )} MiB | ${fmt(sample.holderSumRssMiB, 1)} MiB | ${sample.holdersLive} |`,
  )
  .join("\n")}

### Caveats

- This is loopback on one machine with child processes, not independent operators. A
  holder restart reuses the same directory and identity; a real operator failure may
  lose the directory or return as a different actor.
- Payloads are ${payloadBytes} bytes. The 1 GiB bounded path is measured separately in
  \`NETWORK.md\`; this run exercises control-plane reliability, not large-file memory.
- Kills are random, not adversarial and not correlated with repairs. TLS, shared tokens,
  disk-full, power loss, clock skew, and multi-writer races are outside this run.
- An audit failure is reported as such, not hidden. Repair failures are counted; the run
  does not fail the process merely because the network was intentionally disrupted.
- The ledger and holder processes keep old placements and shards for the duration; there
  is no GC pass here. Memory and disk numbers include that growth.
`;

const { writeFileSync } = await import("node:fs");
writeFileSync("bench/storage/SOAK.md", markdown);
writeFileSync("bench/storage/SOAK.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(markdown);
console.error("wrote bench/storage/SOAK.md and SOAK.json");

rmSync(root, { recursive: true, force: true });
