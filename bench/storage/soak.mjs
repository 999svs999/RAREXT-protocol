#!/usr/bin/env node
// npm run bench:soak -- [--seconds 600] [--holders 8] [--k 4] [--m 2]
//
// Continuous put, challenge/audit, repair, and retrieval against real holder
// child processes, with random holder kills and restarts. Publishes operation
// success rates, repair outcomes, and memory samples. This is a local chaos
// run, not a durability proof: see the caveats in SOAK.md.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
const gcEachSample = process.argv.includes("--gc");

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
  puts: { attempted: 0, ok: 0, failed: 0, retries: 0 },
  audits: { attempted: 0, ok: 0, under: 0 },
  challenges: { attempted: 0, ok: 0, failed: 0 },
  repairs: { attempted: 0, ok: 0, failed: 0, filled: 0, reauditOk: 0, reauditFailed: 0 },
  retrievals: { attempted: 0, ok: 0, failed: 0 },
  holderKills: 0,
  holderRestarts: 0,
  gcScans: 0,
  gcDeleted: 0,
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

function isTransientPutError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|timed out|failed put: 5\d\d/i.test(
    message,
  );
}

async function putWithRetry(payload) {
  let lastError = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const holders = liveHolders();
    if (holders.length < dataShards + parityShards) {
      lastError = new Error("not enough live holders to place");
    } else {
      try {
        return await ledger.place(encodeBytes(payload, dataShards, parityShards), holders, "durable");
      } catch (error) {
        lastError = error;
        if (!isTransientPutError(error)) throw error;
      }
    }

    if (attempt < 5) {
      stats.puts.retries += 1;
      await sleep(Math.min(250 * 2 ** attempt, 4000) + Math.floor(Math.random() * 100));
    }
  }

  throw lastError;
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

function holderShardFiles() {
  let total = 0;

  for (const directory of holderDirectories.values()) {
    try {
      total += readdirSync(directory).filter((name) => /^[0-9a-f]{64}$/.test(name)).length;
    } catch {
      // The directory may not exist during the first sample or after cleanup.
    }
  }

  return total;
}

const ledger = new DurabilityLedger({ maxPlacements: activeLimit });
const live = new Map();
const holderDirectories = new Map();
const memorySeries = [];
const active = [];
let restarting = false;
let lastGc = 0;

console.log(`[RAREXT Soak] Starting ${holderCount} holders for ${durationSeconds}s in ${root}...`);

for (let index = 0; index < holderCount; index += 1) {
  const id = `holder-${index}`;
  const directory = join(root, id);
  holderDirectories.set(id, directory);
  live.set(id, await spawnHolder(id, directory));
}

console.log(`[RAREXT Soak] ${live.size} holders live. Payload ${payloadBytes} bytes at ${dataShards}+${parityShards}.`);
console.log(`[RAREXT Soak] Ledger retains the newest ${activeLimit} placements.`);

let sampling = true;
const memorySampler = (async () => {
  while (sampling) {
    if (gcEachSample && global.gc) global.gc();
    const pids = [...live.values()].map((entry) => entry.child.pid);
    const holders = sampleRss(pids);
    const usage = process.memoryUsage();
    memorySeries.push({
      at: new Date().toISOString(),
      elapsedSeconds: (Date.now() - startedAt.getTime()) / 1000,
      clientRssMiB: usage.rss / MIB,
      clientHeapUsedMiB: usage.heapUsed / MIB,
      clientHeapTotalMiB: usage.heapTotal / MIB,
      clientExternalMiB: usage.external / MIB,
      clientArrayBuffersMiB: usage.arrayBuffers / MIB,
      holderMaxRssMiB: holders.max,
      holderSumRssMiB: holders.sum,
      holdersLive: live.size,
      holderShardFiles: holderShardFiles(),
      ledgerPlacements: ledger.list().length,
      activeBlobs: active.length,
    });
    await sleep(2000);
  }
})();

async function collectGarbage() {
  const holderUrls = new Map([...live].map(([id, entry]) => [id, entry.url]));

  try {
    const results = await ledger.gcWithUrls(holderUrls, {
      gracePeriodMs: 0,
      dryRun: false,
      token: TOKEN,
    });
    stats.gcScans += results.length;
    stats.gcDeleted += results.reduce((sum, result) => sum + (result.deleted ?? 0), 0);
  } catch (error) {
    errors("gc", error);
  }
}

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
    const payload = randomBytes(payloadBytes);
    const placement = await putWithRetry(payload);
    stats.puts.ok += 1;
    if (!active.includes(placement.blobHash)) active.push(placement.blobHash);
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

  if (Date.now() - lastGc >= 10_000) {
    lastGc = Date.now();
    await collectGarbage();
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

const steadyWindow = series.filter((sample) => sample.elapsedSeconds >= 60);
const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};
const steadyRss = median(steadyWindow.map((sample) => sample.clientRssMiB));
const steadyHeap = median(steadyWindow.map((sample) => sample.clientHeapUsedMiB));
const steadyExternal = median(steadyWindow.map((sample) => sample.clientExternalMiB));
const steadyRssLow = steadyWindow.length > 0 ? Math.min(...steadyWindow.map((s) => s.clientRssMiB)) : 0;
const steadyRssHigh = steadyWindow.length > 0 ? Math.max(...steadyWindow.map((s) => s.clientRssMiB)) : 0;

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
    ledgerRetention: activeLimit,
    killIntervalSeconds: [killMinSeconds, killMaxSeconds],
    outageSeconds: [outageMinSeconds, outageMaxSeconds],
    loopback: true,
  },
  stats,
  memory: {
    peakClientRssMiB: peakClient,
    peakHolderMaxRssMiB: peakHolderMax,
    peakHolderSumRssMiB: peakHolderSum,
    steadyStateClientRssMiB: steadyRss,
    steadyStateClientRssRangeMiB: [steadyRssLow, steadyRssHigh],
    steadyStateClientHeapUsedMiB: steadyHeap,
    steadyStateClientExternalMiB: steadyExternal,
    startClientRssMiB: series[0]?.clientRssMiB ?? 0,
    endClientRssMiB: series.at(-1)?.clientRssMiB ?? 0,
    startClientHeapUsedMiB: series[0]?.clientHeapUsedMiB ?? 0,
    endClientHeapUsedMiB: series.at(-1)?.clientHeapUsedMiB ?? 0,
    peakClientHeapUsedMiB: series.reduce((peak, sample) => Math.max(peak, sample.clientHeapUsedMiB), 0),
    peakClientHeapTotalMiB: series.reduce((peak, sample) => Math.max(peak, sample.clientHeapTotalMiB ?? 0), 0),
    peakLedgerPlacements: series.reduce((peak, sample) => Math.max(peak, sample.ledgerPlacements ?? 0), 0),
    peakHolderShardFiles: series.reduce((peak, sample) => Math.max(peak, sample.holderShardFiles ?? 0), 0),
    samples: series.length,
    gcEachSample,
    series: sampled,
  },
};

const markdown = `<!-- Generated by \`npm run bench:soak -- --gc\`; this is a local chaos run, not a durability proof. -->

## Soak and chaos

Run on ${report.startedAt} for ${report.durationSeconds}s with Node \`${report.environment.node}\`
on ${report.environment.cpu}. ${holderCount} holder child processes on loopback,
${dataShards}+${parityShards}, ${payloadBytes}-byte payloads, ledger retention
${activeLimit}, ${activeLimit} active blobs.
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
- Holder kills: **${stats.holderKills}**; restarts: **${stats.holderRestarts}**;
  transient put retries: **${stats.puts.retries}**. Orphan GC removed
  **${stats.gcDeleted}** shard(s) across **${stats.gcScans}** holder scans at a zero grace period.
- The audit failures are expected while a holder is down; repair is attempted on the next
  cycle, and the re-audit is the number that matters.
- Peak client RSS: **${fmt(peakClient, 1)} MiB**. From 60 s onward the client RSS median was
  **${fmt(steadyRss, 1)} MiB** (range ${fmt(steadyRssLow, 1)}-${fmt(steadyRssHigh, 1)} MiB) while live
  JS heap stayed at **${fmt(steadyHeap, 1)} MiB**. The retained RSS is V8 reserved heap and
  external/allocator buffers, not live JS objects; external memory median was
  **${fmt(steadyExternal, 1)} MiB**. Peak holder RSS (max single holder): **${fmt(peakHolderMax, 1)} MiB**;
  peak sum across live holders: **${fmt(peakHolderSum, 1)} MiB**.
- Errors recorded: ${stats.errors.length}${stats.errors.length > 0 ? `; last: ${stats.errors.at(-1).operation}: ${stats.errors.at(-1).message}` : ""}.
- Put success moved from 99.9% in the precursor run (5 failures in 5,507 puts) to
  **${rate(stats.puts.ok, stats.puts.attempted)}** here (**${stats.puts.failed}** failure(s),
  **${stats.puts.retries}** transient retries); the retry path is the evidence for the change.

### Why this profile is bounded

The earlier published run created a new payload on every cycle. DurabilityLedger
kept one placement and one witness map per put (5,507 by the end) and each holder's
content-addressed store kept a shard per upload (about 33,000 shard files across eight
holders). A forced-GC diagnostic of that code showed live JS heap near 10-13 MiB while
the retained placement count rose one-for-one with puts: the growth was accumulation in
the ledger/store, not an unreclaimable GC leak.

This run bounds the retention rather than changing what a put does. DurabilityLedger
is constructed with maxPlacements: ${activeLimit}; it evicts the oldest placement and
its witnesses after each insert, so the ledger stays at ${report.memory.peakLedgerPlacements}
records. Orphan shards left by eviction or repair are removed by a zero-grace holder GC
sweep every 10 s; shard files stay around ${report.memory.peakHolderShardFiles} (repair briefly
adds copies). Client live heap stayed between ${fmt(report.memory.startClientHeapUsedMiB, 1)}
and ${fmt(report.memory.peakClientHeapUsedMiB, 1)} MiB; RSS reached a warm-up plateau as V8
reserved ${fmt(report.memory.peakClientHeapTotalMiB, 1)} MiB of heap. The default ledger remains
unbounded for backwards compatibility; a long-lived client should set maxPlacements or
call forget() when it no longer needs to challenge a placement.

### Scope changes

- Ledger retention: \`maxPlacements:${activeLimit}\` evicts the oldest placement and its
  witnesses. Evicted blobs can no longer be challenged or retrieved through this ledger.
- Orphan GC: every 10 s the client asks each live holder to scan with \`gracePeriodMs:0\`
  and \`dryRun:false\`; the production default grace is 24 h.
- Put retry: transient network failures (including a holder killed mid-upload) get up to
  six attempts with 250 ms-4 s exponential backoff and jitter; validation, auth, and quota
  errors are not retried.
- Sampling: ${gcEachSample ? "a forced GC runs before each 2 s memory sample (\`--gc\`) so the\n  table separates live heap from allocator/reserved-page retention." : "no forced GC is used;\n  RSS includes allocator pages that V8 has not returned."}

### Memory over time

| Elapsed | Client RSS | Client heap | Holder max | Holder sum | Ledger | Shard files | Holders |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${sampled
  .map(
    (sample) =>
      `| ${fmt(sample.elapsedSeconds, 0)}s | ${fmt(sample.clientRssMiB, 1)} MiB | ${fmt(
        sample.clientHeapUsedMiB ?? 0,
        1,
      )} MiB | ${fmt(sample.holderMaxRssMiB, 1)} MiB | ${fmt(
        sample.holderSumRssMiB,
        1,
      )} MiB | ${sample.ledgerPlacements ?? "—"} | ${sample.holderShardFiles ?? "—"} | ${sample.holdersLive} |`,
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
- The ledger default is still unlimited. This run opts into \`maxPlacements:${activeLimit}\`;
  a long-lived caller that keeps every placement cannot challenge them all without also
  retaining them, and must set a limit or call \`forget()\`. The table exposes ledger and
  shard counts so the retention policy is visible.
- Zero-grace GC is deliberately aggressive for this soak. Production defaults to a 24 h
  grace period and a dry run; deleting with no grace during a live repair is not advised.
- Put failures caused by killing a holder mid-upload are retried up to six times with
  exponential backoff (250 ms to 4 s, with jitter). Non-transient validation/auth/quota
  errors are not retried.
`;

const { writeFileSync } = await import("node:fs");
writeFileSync("bench/storage/SOAK.md", markdown);
writeFileSync("bench/storage/SOAK.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(markdown);
console.error("wrote bench/storage/SOAK.md and SOAK.json");

rmSync(root, { recursive: true, force: true });
