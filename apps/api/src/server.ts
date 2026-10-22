import { createApp } from "./app.ts";
import { ChallengeScheduler } from "./durability-schedule.ts";
import { DurabilityLedger } from "./durability.ts";
import { holdersFromEnv } from "./holders.ts";
import { RarextStore } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA = process.env.RAREXT_DATA;
const PUBLIC_DIR = process.env.RAREXT_PUBLIC_DIR;
const store = DATA === "none" ? new RarextStore() : new RarextStore(DATA ?? ".data/rarext.json");

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

const server = createApp({
  store,
  publicDir: PUBLIC_DIR,
  durability,
  holders,
  scheduler,
  holderUrls,
});

server.listen(PORT, HOST, () => {
  console.log(`RAREXT API listening on http://${HOST}:${PORT}`);

  if (holders.length > 0) {
    scheduler.start();
    console.log(
      `retention challenges every ${Math.round(intervalMs / 1000)}s across ${holders.length} holder(s)`,
    );
  } else {
    console.log("retention challenges idle: set RAREXT_HOLDERS to enable them");
  }
});
