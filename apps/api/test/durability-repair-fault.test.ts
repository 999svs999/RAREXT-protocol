import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DurabilityLedger,
  directoryHolder,
  type DurabilityHolder,
} from "../src/durability.ts";
import {
  ChallengeScheduler,
  type SchedulerTimers,
} from "../src/durability-schedule.ts";
import { decodeBytes, encodeBytes } from "../src/erasure.ts";

function setup(count: number) {
  const base = join(process.cwd(), ".data");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "rarext-repair-fault-"));
  const holders = Array.from({ length: count }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );

  return {
    root,
    holders,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function reconstruct(
  placement: ReturnType<DurabilityLedger["list"]>[number],
  holders: DurabilityHolder[],
): Promise<Uint8Array> {
  const shards = [];

  for (const shard of placement.shards) {
    if (shards.length >= placement.dataShards) break;

    const holder = holders.find((candidate) => candidate.id === shard.holder);
    assert.ok(holder, `holder ${shard.holder} is configured`);
    const bytes = await holder.get(shard.storedAs);
    if (!bytes) continue;
    shards.push({
      index: shard.index,
      dataShards: placement.dataShards,
      parityShards: placement.parityShards,
      length: placement.length,
      payloadDigest: placement.blobHash,
      bytes: Uint8Array.from(bytes),
      digest: shard.digest,
    });
  }

  assert.equal(shards.length, placement.dataShards, "enough shards are readable");
  return decodeBytes(shards);
}

function fakeClock(start = 0) {
  let now = start;

  return { now: () => now, set: (value: number) => (now = value) };
}

function fakeTimers(clock: ReturnType<typeof fakeClock>): SchedulerTimers & {
  advance: (ms: number) => Promise<void>;
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

test("a survivor that drops between the probe and the read is skipped", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const payload = randomBytes(4096);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 4, 2), holders, "durable");
    const lost = placement.shards[0]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);

    // This survivor passed `has` during the repair's presence scan, then its
    // bytes become unreachable. Repair must read another survivor instead of
    // abandoning a recoverable blob.
    const survivor = placement.shards[1]!;
    const original = holders.find((holder) => holder.id === survivor.holder)!;
    let reads = 0;
    const flaky: DurabilityHolder = {
      ...original,
      async get(storedAs) {
        reads += 1;
        throw new Error("connection dropped during repair");
      },
    };
    const withFlaky = holders.map((holder) => (holder.id === flaky.id ? flaky : holder));

    const repaired = await ledger.repair(placement.blobHash, withFlaky);

    assert.equal(reads, 1, "the dropping survivor was attempted first");
    assert.equal(repaired.filled, 1);
    await ledger.challenge(placement.blobHash, holders);
    assert.equal(ledger.audit(placement.blobHash).status, "ok");
    assert.deepEqual(
      Buffer.from(await reconstruct(ledger.get(placement.blobHash)!, holders)),
      payload,
    );
  } finally {
    cleanup();
  }
});

test("a spare that rejects the write is skipped for the next spare", async () => {
  const { holders, cleanup } = setup(6);

  try {
    const payload = randomBytes(2048);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 3, 1), holders, "durable");
    const lost = placement.shards[0]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);

    const used = new Set(placement.shards.map((shard) => shard.holder));
    const spares = holders
      .filter((holder) => !used.has(holder.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.equal(spares.length, 2);

    let rejected = 0;
    const refusing: DurabilityHolder = {
      ...spares[0]!,
      async put() {
        rejected += 1;
        throw new Error("insufficient storage: byte quota exceeded");
      },
    };
    const withRefusing = holders.map((holder) =>
      holder.id === refusing.id ? refusing : holder,
    );

    const repaired = await ledger.repair(placement.blobHash, withRefusing);
    const moved = repaired.placement.shards.find((shard) => shard.index === lost.index)!;

    assert.equal(rejected, 1);
    assert.equal(repaired.filled, 1);
    assert.equal(moved.holder, spares[1]!.id);
    assert.deepEqual(
      Buffer.from(await reconstruct(ledger.get(placement.blobHash)!, holders)),
      payload,
    );
  } finally {
    cleanup();
  }
});

test("a source holder that is gone when repair starts is rebuilt from the rest", async () => {
  const { holders, cleanup } = setup(6);

  try {
    const payload = randomBytes(3072);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 3, 1), holders, "durable");
    const gone = placement.shards[3]!;
    const goneHolder = gone.holder;
    const original = holders.find((holder) => holder.id === goneHolder)!;
    let probed = 0;
    const offline: DurabilityHolder = {
      ...original,
      async has() {
        probed += 1;
        throw new Error("ECONNREFUSED");
      },
      async get() {
        throw new Error("ECONNREFUSED");
      },
    };
    const withOffline = holders.map((holder) =>
      holder.id === offline.id ? offline : holder,
    );

    const repaired = await ledger.repair(placement.blobHash, withOffline);

    assert.equal(probed, 1);
    assert.equal(repaired.filled, 1, "the unreachable shard was rebuilt on a spare");
    assert.notEqual(
      ledger.get(placement.blobHash)!.shards.find((shard) => shard.index === gone.index)!.holder,
      goneHolder,
    );
    assert.deepEqual(
      Buffer.from(await reconstruct(ledger.get(placement.blobHash)!, holders)),
      payload,
    );
  } finally {
    cleanup();
  }
});

test("a repair refuses to commit after the placement is forgotten mid-read", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(4096), 4, 2), holders, "durable");
    const lost = placement.shards[0]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);

    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const survivor = placement.shards[1]!;
    const original = holders.find((holder) => holder.id === survivor.holder)!;
    let writes = 0;
    const slow: DurabilityHolder = {
      ...original,
      async get(storedAs) {
        entered();
        await gate;
        return original.get(storedAs);
      },
      async put(bytes) {
        writes += 1;
        return original.put(bytes);
      },
    };
    const withSlow = holders.map((holder) => (holder.id === slow.id ? slow : holder));
    const repairing = ledger.repair(placement.blobHash, withSlow);

    await started;
    assert.equal(ledger.forget(placement.blobHash), true);
    release();

    await assert.rejects(repairing, /no longer current|repair lease/);
    assert.equal(ledger.get(placement.blobHash), null);
    assert.equal(writes, 0, "no shard was written after the placement disappeared");
  } finally {
    cleanup();
  }
});

test("a repair refuses after its repair lease expires", async () => {
  const { holders, cleanup } = setup(8);

  try {
    let clock = 1000;
    const ledger = new DurabilityLedger({
      now: () => clock,
      repairLeaseMs: 100,
    });
    const payload = randomBytes(4096);
    const placement = await ledger.place(encodeBytes(payload, 4, 2), holders, "durable");
    const lost = placement.shards[0]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);
    const before = JSON.stringify(placement);

    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const survivor = placement.shards[1]!;
    const original = holders.find((holder) => holder.id === survivor.holder)!;
    const slow: DurabilityHolder = {
      ...original,
      async get(storedAs) {
        entered();
        await gate;
        return original.get(storedAs);
      },
    };
    const withSlow = holders.map((holder) => (holder.id === slow.id ? slow : holder));
    const repairing = ledger.repair(placement.blobHash, withSlow);

    await started;
    clock = 1200;
    release();

    await assert.rejects(repairing, /repair lease expired/);
    assert.equal(JSON.stringify(ledger.get(placement.blobHash)), before);
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");
    assert.deepEqual(
      Buffer.from(await reconstruct(placement, holders)),
      payload,
      "the surviving shards still reconstruct the original payload",
    );
  } finally {
    cleanup();
  }
});

test("a repair after the placement is removed is refused as unknown", async () => {
  const { holders, cleanup } = setup(6);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(1024), 3, 1), holders, "durable");
    const lost = placement.shards[0]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    ledger.forget(placement.blobHash);

    await assert.rejects(() => ledger.repair(placement.blobHash, holders), /unknown blob/);
  } finally {
    cleanup();
  }
});

test("failed repairs back off instead of storming every scheduled run", async () => {
  const { holders, cleanup } = setup(5);

  try {
    const clock = fakeClock();
    const timers = fakeTimers(clock);
    const ledger = new DurabilityLedger({ now: clock.now });
    const placement = await ledger.place(
      encodeBytes(randomBytes(2048), 3, 2),
      holders,
      "durable",
    );
    const lost = placement.shards[0]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);

    const scheduler = new ChallengeScheduler({
      ledger,
      holders: () => holders,
      intervalMs: 1000,
      repair: true,
      repairBackoffMs: 5000,
      maxRepairBackoffMs: 20_000,
      timers,
      now: clock.now,
    });

    scheduler.start();
    await timers.advance(1000);

    const first = scheduler.state.lastRun!;
    assert.deepEqual(first.underReplicated, [placement.blobHash]);
    assert.equal(first.repairErrors.length, 1);
    assert.equal(first.repairErrors[0]!.attempts, 1);
    assert.equal(first.repairDeferred.length, 0);
    assert.equal(first.repairErrors[0]!.retryAt, new Date(6000).toISOString());

    await timers.advance(3000);

    const deferred = scheduler.state.lastRun!;
    assert.equal(deferred.repairs.length, 0);
    assert.equal(deferred.repairErrors.length, 0);
    assert.equal(deferred.repairDeferred.length, 1);
    assert.equal(deferred.repairDeferred[0]!.attempts, 1);
    assert.equal(deferred.repairDeferred[0]!.retryAt, new Date(6000).toISOString());

    await timers.advance(2000);

    const second = scheduler.state.lastRun!;
    assert.equal(second.repairErrors.length, 1);
    assert.equal(second.repairErrors[0]!.attempts, 2);
    assert.equal(second.repairErrors[0]!.retryAt, new Date(16_000).toISOString());

    scheduler.stop();
  } finally {
    cleanup();
  }
});
