import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Publication } from "../../../packages/core/src/index.ts";
import { cidV1Raw } from "../src/adapters/content.ts";
import { DurabilityLedger } from "../src/durability.ts";
import type { SchedulerTimers } from "../src/durability-schedule.ts";
import {
  GcScheduler,
  NodeGc,
  PinGc,
  referencedBlobHashes,
} from "../src/gc-schedule.ts";
import { PinStore } from "../src/pin-server.ts";
import { BlobStore } from "../src/storage.ts";

function publication(hashes: string[]): Publication {
  return {
    artifact: { body: { blobs: hashes.map((hash) => ({ hash })) } },
  } as unknown as Publication;
}

function fakeClock(start = 0) {
  let now = start;

  return { now: () => now, set: (value: number) => (now = value) };
}

function fakeTimers(clock: ReturnType<typeof fakeClock>): SchedulerTimers & {
  advance: (ms: number) => Promise<void>;
  pending: () => number;
} {
  let next = 0;
  const tasks = new Map<number, { at: number; run: () => void }>();

  return {
    setTimeout(callback, ms) {
      const id = ++next;
      tasks.set(id, { at: clock.now() + ms, run: callback });
      return id;
    },
    clearTimeout(handle) {
      tasks.delete(handle as number);
    },
    pending: () => tasks.size,
    async advance(ms) {
      const target = clock.now() + ms;

      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];

        if (!due) break;

        tasks.delete(due[0]);
        clock.set(due[1].at);
        due[1].run();

        for (let turn = 0; turn < 5; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      clock.set(target);
    },
  };
}

test("referenced blob hashes come from every storage manifest and nothing else", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);

  const referenced = referencedBlobHashes([
    publication([a, b]),
    publication([a]),
    { artifact: { body: { blobs: [{ hash: "not-a-hash" }, null, 7] } } } as unknown as Publication,
    { artifact: { body: { nothing: true } } } as unknown as Publication,
    { artifact: null } as unknown as Publication,
  ]);

  assert.deepEqual([...referenced].sort(), [a, b]);
});

test("a node GC pass deletes unreferenced blobs after the grace period and keeps the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-node-gc-"));
  const blobs = new BlobStore(join(root, "blobs"));

  try {
    const kept = blobs.put(Buffer.from("referenced"));
    const orphan = blobs.put(Buffer.from("nobody points here"));
    const held = blobs.put(Buffer.from("promised until later"), {
      retentionUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const gc = new NodeGc({
      store: { listPublications: () => [publication([kept.hash])] },
      blobs,
      ledger: new DurabilityLedger(),
      gracePeriodMs: 0,
      dryRun: false,
    });

    const result = await gc.run();
    assert.equal(result.blobs.scanned, 3);
    assert.equal(result.blobs.referenced, 1);
    assert.equal(result.blobs.held, 1);
    assert.equal(result.blobs.deleted, 1);
    assert.equal(blobs.get(kept.hash)?.record.size, kept.size);
    assert.equal(blobs.get(held.hash)?.record.size, held.size);
    assert.equal(blobs.get(orphan.hash), null);
    assert.deepEqual(result.holders, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node GC is a dry run by default and records candidates instead of deleting", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-node-gc-dry-"));

  try {
    const blobs = new BlobStore(join(root, "blobs"));
    const orphan = blobs.put(Buffer.from("keep me until reviewed"));
    const gc = new NodeGc({
      store: { listPublications: () => [] },
      blobs,
      ledger: new DurabilityLedger(),
      gracePeriodMs: 0,
    });

    const result = await gc.run();
    assert.equal(result.dryRun, true);
    assert.equal(result.blobs.deleted, 0);
    assert.deepEqual(result.blobs.wouldDelete, [orphan.hash]);
    assert.ok(blobs.get(orphan.hash));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a node GC pass asks every configured holder with this node's referenced shards", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-node-gc-holders-"));
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });

    return new Response(
      JSON.stringify({
        holder: "holder-a",
        scanned: 2,
        referenced: 0,
        candidates: 2,
        deleted: 0,
        wouldDelete: ["aa", "bb"],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const blobs = new BlobStore(join(root, "blobs"));
    const gc = new NodeGc({
      store: { listPublications: () => [] },
      blobs,
      ledger: new DurabilityLedger(),
      holderUrls: new Map([["holder-a", "http://holder-a.test/"]]),
      token: "secret",
      fetch: fakeFetch,
      gracePeriodMs: 0,
      dryRun: true,
    });

    const result = await gc.run();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://holder-a.test/v1/holder/gc/scan");
    assert.equal(calls[0]!.auth, "Bearer secret");
    assert.deepEqual(calls[0]!.body, {
      referenced: [],
      gracePeriodMs: 0,
      dryRun: true,
    });
    assert.equal(result.holders[0]!.holder, "holder-a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the GC schedule fires, skips an overlapping pass, and stops cleanly", async () => {
  const clock = fakeClock(10_000);
  const timers = fakeTimers(clock);
  let runs = 0;
  let release: (() => void) | null = null;
  const scheduler = new GcScheduler({
    run: () => {
      runs += 1;
      return new Promise<number>((resolve) => {
        release = () => resolve(runs);
      });
    },
    intervalMs: 1000,
    timers,
    now: clock.now,
  });

  scheduler.start();
  assert.equal(scheduler.state.running, true);
  assert.equal(scheduler.state.nextRunAt, new Date(11_000).toISOString());

  await timers.advance(1000);
  assert.equal(runs, 1);
  assert.equal(scheduler.state.runs, 0, "the first pass is still in flight");

  // A tick during the pass is skipped and rescheduled, not run concurrently.
  await timers.advance(1000);
  assert.equal(runs, 1);

  release!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.state.runs, 1);

  await timers.advance(1000);
  assert.equal(runs, 2);
  release!();
  await new Promise((resolve) => setImmediate(resolve));

  scheduler.stop();
  assert.equal(scheduler.state.running, false);
  assert.equal(scheduler.state.nextRunAt, null);
  assert.equal(timers.pending(), 0);
});

test("a failed GC pass is recorded and the schedule keeps going", async () => {
  const clock = fakeClock(0);
  const timers = fakeTimers(clock);
  const errors: string[] = [];
  let call = 0;
  const scheduler = new GcScheduler({
    run: () => {
      call += 1;
      if (call === 1) throw new Error("disk on fire");
      return call;
    },
    intervalMs: 1000,
    timers,
    now: clock.now,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  scheduler.start();
  await timers.advance(1000);
  assert.deepEqual(errors, ["disk on fire"]);
  assert.equal(scheduler.state.runs, 0);
  assert.equal(scheduler.state.lastError, "disk on fire");

  await timers.advance(1000);
  assert.equal(scheduler.state.runs, 1);
  assert.equal(scheduler.state.lastRun, 2);
  assert.equal(scheduler.state.lastError, null);

  scheduler.stop();
});

test("pin GC reaps a content-only orphan and keeps a referenced pin", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-pin-schedule-"));
  const directory = join(root, "pins");
  const pins = new PinStore(directory);

  try {
    const kept = pins.put({
      cid: cidV1Raw(Buffer.from("referenced pin")),
      content: Buffer.from("referenced pin"),
      publicationIds: ["pub-1"],
    }).cid;
    const orphan = cidV1Raw(Buffer.from("crashed before metadata"));
    writeFileSync(join(directory, `${orphan}.bin`), "content");

    const gc = new PinGc({ pins, gracePeriodMs: 0, dryRun: false });
    const run = gc.run();

    assert.equal(run.pins.orphanContent, 1);
    assert.equal(pins.has(kept), true);
    assert.equal(pins.has(orphan), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
