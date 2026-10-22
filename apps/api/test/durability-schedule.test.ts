import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import {
  DurabilityLedger,
  directoryHolder,
  type DurabilityHolder,
} from "../src/durability.ts";
import {
  ChallengeScheduler,
  type SchedulerTimers,
} from "../src/durability-schedule.ts";
import { encodeBytes } from "../src/erasure.ts";
import { PlacementRegistry, signPlacement } from "../src/placements.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

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

async function setup(count = 7) {
  const root = mkdtempSync(join(tmpdir(), "rarext-schedule-"));
  const holders: DurabilityHolder[] = Array.from({ length: count }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );

  return {
    root,
    holders,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the schedule fires challenges with no caller and keeps firing", async () => {
  const { root, holders, cleanup } = await setup();

  try {
    const clock = fakeClock(10_000);
    const timers = fakeTimers(clock);
    const ledger = new DurabilityLedger({ now: clock.now });
    const payload = randomBytes(4096);
    const placement = await ledger.place(encodeBytes(payload, 3, 2), holders, "durable");
    const scheduler = new ChallengeScheduler({
      ledger,
      holders: () => holders,
      intervalMs: 1000,
      timers,
      now: clock.now,
    });

    assert.equal(ledger.audit(placement.blobHash).challenged, false);

    scheduler.start();
    assert.equal(scheduler.state.running, true);
    assert.equal(scheduler.state.nextRunAt, new Date(11_000).toISOString());
    assert.equal(scheduler.state.runs, 0);

    await timers.advance(1000);

    const first = scheduler.state;

    assert.equal(first.runs, 1);
    assert.equal(first.lastRun!.audits.length, 1);
    assert.equal(first.lastRun!.audits[0]!.live, 5);
    assert.equal(first.lastRun!.underReplicated.length, 0);
    assert.equal(first.nextRunAt, new Date(12_000).toISOString());
    assert.equal(ledger.audit(placement.blobHash).challenged, true);

    await timers.advance(1000);

    assert.equal(scheduler.state.runs, 2);
    assert.equal(scheduler.state.nextRunAt, new Date(13_000).toISOString());

    scheduler.stop();

    assert.equal(scheduler.state.running, false);
    assert.equal(scheduler.state.nextRunAt, null);
    assert.equal(timers.pending(), 0);
  } finally {
    cleanup();
  }
});

test("a lost shard shows up on the next scheduled run, not on a caller's command", async () => {
  const { root, holders, cleanup } = await setup();

  try {
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const ledger = new DurabilityLedger({ now: clock.now });
    const shards = encodeBytes(randomBytes(8192), 3, 2);
    const placement = await ledger.place(shards, holders, "durable");
    const lost = placement.shards[0]!;
    const holder = holders.find((candidate) => candidate.id === lost.holder)!;
    const scheduler = new ChallengeScheduler({
      ledger,
      holders: () => holders,
      intervalMs: 60_000,
      timers,
      now: clock.now,
    });

    scheduler.start();
    await timers.advance(60_000);

    assert.equal(scheduler.state.lastRun!.underReplicated.length, 0);
    assert.equal(ledger.audit(placement.blobHash).status, "ok");

    await holder.remove(lost.storedAs);
    await timers.advance(60_000);

    const degraded = ledger.audit(placement.blobHash);

    assert.equal(degraded.live, 4);
    assert.equal(degraded.status, "under-replicated");
    assert.deepEqual(scheduler.state.lastRun!.underReplicated, [placement.blobHash]);
    assert.equal(scheduler.state.lastRun!.audits[0]!.shards[0]!.misses, 1);

    await holder.put(shards[lost.index]!.bytes);
    await timers.advance(60_000);

    assert.equal(ledger.audit(placement.blobHash).status, "ok");
    assert.equal(scheduler.state.lastRun!.underReplicated.length, 0);
    assert.equal(scheduler.state.runs, 3);

    scheduler.stop();
  } finally {
    cleanup();
  }
});

test("a run in flight is shared, never doubled", async () => {
  const { root, holders, cleanup } = await setup(2);

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked: DurabilityHolder = {
    id: "holder-blocked",
    put: (bytes) => holders[0]!.put(bytes),
    get: (storedAs) => holders[0]!.get(storedAs),
    remove: (storedAs) => holders[0]!.remove(storedAs),
    has: (storedAs) => holders[0]!.has(storedAs),
    async respond(challenge) {
      await gate;
      return holders[0]!.respond(challenge);
    },
  };
  const clock = fakeClock();
  const timers = fakeTimers(clock);
  const ledger = new DurabilityLedger({ now: clock.now });
  const placement = await ledger.place(
    encodeBytes(randomBytes(2048), 1, 1),
    [blocked, holders[1]!],
    "durable",
  );
  const scheduler = new ChallengeScheduler({
    ledger,
    holders: () => [blocked, holders[1]!],
    intervalMs: 1000,
    timers,
    now: clock.now,
  });

  scheduler.start();
  await timers.advance(1000);

  assert.equal(scheduler.state.runs, 0, "the run is still blocked");

  const first = scheduler.runNow();
  const second = scheduler.runNow();

  assert.equal(first, second, "concurrent callers share one run");
  assert.equal(scheduler.state.runs, 0);

  release();
  await first;

  assert.equal(scheduler.state.runs, 1);
  assert.equal(ledger.audit(placement.blobHash).status, "ok");
  scheduler.stop();
  cleanup();
});

test("the API shows the schedule and runs a challenge on request", async () => {
  const { root, holders, cleanup } = await setup();

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(randomBytes(4096), 3, 2),
      holders,
      "durable",
    );
    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const signed = signPlacement(placement, signer);
    const registry = new PlacementRegistry();
    const scheduler = new ChallengeScheduler({
      ledger,
      holders: () => holders,
      intervalMs: 60_000,
    });
    const { server, base } = await start(new RarextStore(), {
      placements: registry,
      durability: ledger,
      holders,
      scheduler,
    });

    try {
      assert.equal((await post(base, "/v1/placements", signed)).status, 201);

      const before = (await (await fetch(`${base}/v1/durability`)).json()) as {
        schedule: { running: boolean; runs: number };
        audits: { blobHash: string; live: number; challenged: boolean; required: number }[];
      };

      assert.equal(before.schedule.running, false);
      assert.equal(before.schedule.runs, 0);
      assert.equal(before.audits.length, 1);
      assert.equal(before.audits[0]!.challenged, false);
      assert.equal(before.audits[0]!.live, 0);

      const run = (await (await post(base, "/v1/durability/challenge", {})).json()) as {
        blobs: string[];
        audits: { live: number; required: number; challenged: boolean }[];
      };

      assert.deepEqual(run.blobs, [placement.blobHash]);
      assert.equal(run.audits[0]!.live, 5);
      assert.equal(run.audits[0]!.required, 5);
      assert.equal(run.audits[0]!.challenged, true);

      const after = (await (await fetch(`${base}/v1/durability`)).json()) as {
        audits: { live: number; status: string }[];
      };

      assert.equal(after.audits[0]!.live, 5);
      assert.equal(after.audits[0]!.status, "ok");
    } finally {
      await stop(server);
    }
  } finally {
    cleanup();
  }
});

test("the app rebuilds the ledger from persisted placement records", async () => {
  const { root, holders, cleanup } = await setup();

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(randomBytes(2048), 2, 1),
      holders,
      "pinned",
    );
    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const registry = new PlacementRegistry(join(root, "records"));

    registry.put(signPlacement(placement, signer));

    const { server, base } = await start(new RarextStore(), {
      placements: registry,
      holders,
    });

    try {
      const state = (await (await fetch(`${base}/v1/durability`)).json()) as {
        audits: { blobHash: string; required: number; challenged: boolean }[];
      };

      assert.equal(state.audits.length, 1);
      assert.equal(state.audits[0]!.blobHash, placement.blobHash);
      assert.equal(state.audits[0]!.required, 3);
      assert.equal(state.audits[0]!.challenged, false);
    } finally {
      await stop(server);
    }
  } finally {
    cleanup();
  }
});

test("a scheduled run rebuilds a lost shard on a spare holder", async () => {
  const { holders, cleanup } = await setup(7);

  try {
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const ledger = new DurabilityLedger({ now: clock.now });
    const shards = encodeBytes(randomBytes(8192), 3, 2);
    const placement = await ledger.place(shards, holders, "durable");
    const lost = placement.shards[0]!;
    const original = holders.find((holder) => holder.id === lost.holder)!;
    const scheduler = new ChallengeScheduler({
      ledger,
      holders: () => holders,
      intervalMs: 60_000,
      timers,
      now: clock.now,
      repair: true,
    });

    scheduler.start();
    await timers.advance(60_000);
    assert.equal(scheduler.state.lastRun!.repairs.length, 0);

    await original.remove(lost.storedAs);
    await timers.advance(60_000);

    const run = scheduler.state.lastRun!;

    assert.deepEqual(run.underReplicated, [placement.blobHash], "the challenge saw the loss first");
    assert.equal(run.repairs.length, 1);
    assert.equal(run.repairs[0]!.blobHash, placement.blobHash);
    assert.equal(run.repairs[0]!.filled, 1);
    assert.ok(run.repairs[0]!.readBytes > 0);
    assert.ok(run.repairs[0]!.writtenBytes > 0);
    assert.equal(run.repairErrors.length, 0);
    assert.equal(run.audits[0]!.status, "ok");
    assert.equal(run.audits[0]!.live, 5);

    const healed = placement.shards[0]!;

    assert.notEqual(healed.holder, original.id, "the rebuilt shard left the failed holder");
    assert.equal(healed.index, lost.index);
    assert.ok(await holders.find((holder) => holder.id === healed.holder)!.has(healed.storedAs));
    assert.equal(ledger.audit(placement.blobHash).status, "ok");
    scheduler.stop();
  } finally {
    cleanup();
  }
});

test("a repair that cannot find a spare is reported and does not stop the schedule", async () => {
  const { holders, cleanup } = await setup(5);

  try {
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const ledger = new DurabilityLedger({ now: clock.now });
    const placement = await ledger.place(encodeBytes(randomBytes(4096), 3, 2), holders, "durable");
    const lost = placement.shards[1]!;
    const holder = holders.find((candidate) => candidate.id === lost.holder)!;
    const scheduler = new ChallengeScheduler({
      ledger,
      holders: () => holders,
      intervalMs: 1000,
      timers,
      now: clock.now,
      repair: true,
    });

    await holder.remove(lost.storedAs);
    scheduler.start();
    await timers.advance(1000);

    const run = scheduler.state.lastRun!;

    assert.equal(run.repairs.length, 0);
    assert.equal(run.repairErrors.length, 1);
    assert.match(run.repairErrors[0]!.error, /no spare holder/);
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");
    assert.equal(scheduler.state.running, true);
    assert.equal(scheduler.state.nextRunAt, new Date(2000).toISOString());
    scheduler.stop();
  } finally {
    cleanup();
  }
});

test("an on-demand run repairs through the API and reports what it healed", async () => {
  const { root, holders, cleanup } = await setup(7);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(randomBytes(4096), 3, 2),
      holders,
      "durable",
    );
    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const registry = new PlacementRegistry(join(root, "records"));
    const scheduler = new ChallengeScheduler({
      ledger,
      holders: () => holders,
      repair: true,
    });

    registry.put(signPlacement(placement, signer));

    const { server, base } = await start(new RarextStore(), {
      placements: registry,
      durability: ledger,
      holders,
      scheduler,
    });

    try {
      const lost = placement.shards[2]!;
      await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);

      const run = (await (await post(base, "/v1/durability/challenge", {})).json()) as {
        underReplicated: string[];
        repairs: { blobHash: string; filled: number; writtenBytes: number }[];
        repairErrors: unknown[];
        audits: { live: number; status: string }[];
      };

      assert.deepEqual(run.underReplicated, [placement.blobHash]);
      assert.equal(run.repairs.length, 1);
      assert.equal(run.repairs[0]!.filled, 1);
      assert.ok(run.repairs[0]!.writtenBytes > 0);
      assert.equal(run.repairErrors.length, 0);
      assert.equal(run.audits[0]!.status, "ok");
      assert.equal(run.audits[0]!.live, 5);

      const after = (await (await fetch(`${base}/v1/durability`)).json()) as {
        audits: { status: string; live: number }[];
      };

      assert.equal(after.audits[0]!.status, "ok");
      assert.equal(after.audits[0]!.live, 5);
    } finally {
      await stop(server);
    }
  } finally {
    cleanup();
  }
});
