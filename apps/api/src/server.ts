import { readFileSync } from "node:fs";

import { createApp } from "./app.ts";
import { ChallengeScheduler } from "./durability-schedule.ts";
import { DurabilityLedger } from "./durability.ts";
import { GcScheduler, NodeGc } from "./gc-schedule.ts";
import { holdersFromEnv } from "./holders.ts";
import { BlobStore } from "./storage.ts";
import { RarextStore } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA = process.env.RAREXT_DATA;
const PUBLIC_DIR = process.env.RAREXT_PUBLIC_DIR;
const store = DATA === "none" ? new RarextStore() : new RarextStore(DATA ?? ".data/rarext.json");
const blobs = new BlobStore(process.env.RAREXT_BLOB_DIR ?? ".data/blobs", {
  maxTotalBytes: process.env.RAREXT_BLOB_QUOTA_BYTES
    ? Number(process.env.RAREXT_BLOB_QUOTA_BYTES)
    : undefined,
});

const holders = holdersFromEnv(undefined, {
  token: process.env.RAREXT_HOLDER_TOKEN || undefined,
});

const rawHolderUrls = process.env.RAREXT_STORAGE_HOLDERS ?? process.env.RAREXT_HOLDERS ?? "";
const holderUrls = new Map<string, string>(
  rawHolderUrls.split(",").filter(Boolean).map((s) => {
    const parts = s.split("=");
    if (parts.length !== 2) throw new Error(`invalid holder spec: ${s}`);
    return [parts[0], parts[1]];
  }),
);

const durability = new DurabilityLedger();
const intervalMs = Number(process.env.RAREXT_CHALLENGE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
const scheduler = new ChallengeScheduler({
  ledger: durability,
  holders: () => holders,
  repair: true,
  intervalMs,
});

const gcIntervalMs = Number(process.env.RAREXT_GC_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
const gcGracePeriodMs = Number(process.env.RAREXT_GC_GRACE_MS ?? 24 * 60 * 60 * 1000);
const gcDryRun = process.env.RAREXT_GC_DRY_RUN !== "false";
const nodeGc = new NodeGc({
  store,
  blobs,
  ledger: durability,
  holderUrls,
  token: process.env.RAREXT_HOLDER_TOKEN || undefined,
  gracePeriodMs: gcGracePeriodMs,
  dryRun: gcDryRun,
});
const gcScheduler = gcIntervalMs > 0
  ? new GcScheduler({
    run: () => nodeGc.run(),
    intervalMs: gcIntervalMs,
    onRun: (run) => {
      const deleted =
        run.blobs.deleted +
        run.holders.reduce((sum, result) => sum + (result.deleted ?? 0), 0);
      console.log(
        `storage gc: dryRun=${run.dryRun} blobs deleted=${run.blobs.deleted} ` +
          `holders=${run.holders.length} shards deleted=${deleted - run.blobs.deleted}`,
      );
    },
    onError: (error) => {
      console.error(`storage gc failed: ${error instanceof Error ? error.message : error}`);
    },
  })
  : null;

const tlsCert = process.env.RAREXT_TLS_CERT;
const tlsKey = process.env.RAREXT_TLS_KEY;

if (Boolean(tlsCert) !== Boolean(tlsKey)) {
  throw new Error("set both RAREXT_TLS_CERT and RAREXT_TLS_KEY, or neither");
}

const tls = tlsCert && tlsKey
  ? { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }
  : undefined;

const server = createApp({
  store,
  publicDir: PUBLIC_DIR,
  durability,
  holders,
  scheduler,
  holderUrls,
  blobs,
  tls,
});

server.listen(PORT, HOST, () => {
  console.log(`RAREXT API listening on ${tls ? "https" : "http"}://${HOST}:${PORT}`);

  if (holders.length > 0) {
    scheduler.start();
    console.log(
      `retention challenges every ${Math.round(intervalMs / 1000)}s across ${holders.length} holder(s)`,
    );
  } else {
    console.log("retention challenges idle: set RAREXT_HOLDERS to enable them");
  }

  if (gcScheduler) {
    gcScheduler.start();
    console.log(
      `storage gc every ${Math.round(gcIntervalMs / 1000)}s ` +
        `(dryRun=${gcDryRun}, grace ${Math.round(gcGracePeriodMs / 1000)}s)`,
    );
  } else {
    console.log("storage gc disabled: RAREXT_GC_INTERVAL_MS=0");
  }
});

function shutdown(signal: string): void {
  console.log(`${signal}: shutting down`);
  scheduler.stop();
  gcScheduler?.stop();
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
