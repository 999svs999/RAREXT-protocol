import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DurabilityLedger,
  httpHolder,
  type DurabilityHolder,
} from "../src/durability.ts";
import { decodeBytes, encodeBytes } from "../src/erasure.ts";
import { createHolderServer } from "../src/holder-server.ts";

interface RunningHolder {
  holder: DurabilityHolder;
  stop: () => Promise<void>;
}

async function startHolder(id: string, root: string): Promise<RunningHolder> {
  const server = createHolderServer({ id, directory: join(root, id) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;

  return {
    holder: httpHolder(id, `http://127.0.0.1:${port}`),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a ledger places and challenges real holders over HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-transport-"));

  try {
    const payload = randomBytes(32 * 1024);
    const shards = encodeBytes(payload, 4, 2);
    const ledger = new DurabilityLedger();
    const running = await Promise.all(
      Array.from({ length: 7 }, (_, index) => startHolder(`holder-${index}`, root)),
    );
    const holders = running.map((entry) => entry.holder);

    try {
      const placement = await ledger.place(shards, holders, "durable");

      assert.equal(placement.shards.length, 6);
      assert.equal(new Set(placement.shards.map((shard) => shard.holder)).size, 6);
      assert.ok(placement.shards.every((shard) => shard.leaves >= 2));

      const outcomes = await ledger.challenge(placement.blobHash, holders);
      const audit = ledger.audit(placement.blobHash);

      assert.ok(outcomes.every((outcome) => outcome.ok));
      assert.equal(audit.status, "ok");
      assert.equal(audit.live, 6);
    } finally {
      await Promise.all(running.map((entry) => entry.stop()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreachable holder degrades the audit and is skipped when repairing", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-repair-"));

  try {
    const payload = randomBytes(16 * 1024);
    const shards = encodeBytes(payload, 3, 2);
    const ledger = new DurabilityLedger();
    const running = await Promise.all(
      Array.from({ length: 8 }, (_, index) => startHolder(`holder-${index}`, root)),
    );
    const holders = running.map((entry) => entry.holder);

    try {
      const placement = await ledger.place(shards, holders.slice(1, 7), "durable");
      const lost = placement.shards[0]!;
      const lostHolder = lost.holder;
      const lostServer = Number(lostHolder.split("-")[1]);

      await running[0]!.stop();
      await running[lostServer]!.stop();

      const before = await ledger.challenge(placement.blobHash, holders);
      const failed = before.find((outcome) => outcome.index === lost.index)!;
      const auditBefore = ledger.audit(placement.blobHash);

      assert.equal(failed.ok, false);
      assert.equal(failed.reason, "holder-missing");
      assert.equal(auditBefore.status, "under-replicated");

      const repaired = await ledger.repair(placement.blobHash, holders);
      const moved = repaired.placement.shards.find((shard) => shard.index === lost.index)!;

      assert.equal(repaired.filled, 1);
      assert.ok(repaired.writtenBytes > 0);
      assert.notEqual(moved.holder, "holder-0", "the offline free holder is not chosen");
      assert.notEqual(moved.holder, lostHolder);

      const after = await ledger.challenge(repaired.placement.blobHash, holders);
      const auditAfter = ledger.audit(repaired.placement.blobHash);

      assert.ok(after.every((outcome) => outcome.ok));
      assert.equal(auditAfter.status, "ok");

      const group = after
        .filter((outcome) => outcome.ok)
        .map((outcome) => repaired.placement.shards.find((shard) => shard.index === outcome.index)!)
        .slice(0, 3);
      const fetched = await Promise.all(
        group.map(async (shard) => {
          const holder = holders.find((candidate) => candidate.id === shard.holder)!;

          return {
            index: shard.index,
            dataShards: repaired.placement.dataShards,
            parityShards: repaired.placement.parityShards,
            length: repaired.placement.length,
            payloadDigest: repaired.placement.blobHash,
            bytes: Uint8Array.from((await holder.get(shard.storedAs))!),
            digest: shard.digest,
          };
        }),
      );

      assert.deepEqual(Buffer.from(decodeBytes(fetched)), payload);
    } finally {
      await Promise.all(running.map((entry) => entry.stop()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a holder answers a challenge without being told which blob it holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-challenge-"));

  try {
    const running = await startHolder("holder-0", root);
    const bytes = randomBytes(10 * 1024);
    const storedAs = await running.holder.put(bytes);

    const first = await running.holder.respond({ storedAs, leafIndex: 1, nonce: "alpha" });
    const second = await running.holder.respond({ storedAs, leafIndex: 1, nonce: "beta" });

    assert.ok(first && second);
    assert.equal(first.leaf, second.leaf);
    assert.notEqual(first.digest, second.digest);
    assert.equal(await running.holder.respond({ storedAs, leafIndex: 99, nonce: "x" }), null);
    assert.equal(
      await running.holder.respond({ storedAs: "0".repeat(64), leafIndex: 0, nonce: "x" }),
      null,
    );
    assert.equal(await running.holder.has(storedAs), true);

    await running.stop();
    await assert.rejects(() => running.holder.has(storedAs));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
