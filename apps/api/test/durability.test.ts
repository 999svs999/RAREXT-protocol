import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DurabilityLedger,
  directoryHolder,
  requiredHolders,
  respondToChallenge,
  verifyChallengeResponse,
  type DurabilityHolder,
} from "../src/durability.ts";
import { decodeBytes, encodeBytes } from "../src/erasure.ts";

function setup(count: number): {
  root: string;
  holders: DurabilityHolder[];
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "rarext-durability-"));
  const holders = Array.from({ length: count }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );

  return { root, holders, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("every shard lands on a distinct holder", async () => {
  const { holders, cleanup } = setup(6);

  try {
    const payload = randomBytes(2048);
    const shards = encodeBytes(payload, 4, 2);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(shards, holders, "durable");

    assert.equal(placement.shards.length, 6);
    assert.equal(new Set(placement.shards.map((shard) => shard.holder)).size, 6);
    assert.equal(placement.tier, "durable");
    assert.equal(placement.required, 6);
    assert.equal(placement.blobHash, shards[0]!.payloadDigest);

    for (const shard of placement.shards) {
      const holder = holders.find((candidate) => candidate.id === shard.holder)!;
      const bytes = await holder.get(shard.storedAs);
      assert.ok(bytes);
      assert.equal(bytes.length, shard.size);
    }
  } finally {
    cleanup();
  }
});

test("placement refuses when there are fewer holders than shards", async () => {
  const { holders, cleanup } = setup(4);

  try {
    const ledger = new DurabilityLedger();
    await assert.rejects(
      () => ledger.place(encodeBytes(randomBytes(512), 3, 2), holders, "durable"),
      /5 distinct holders/,
    );
  } finally {
    cleanup();
  }
});

test("placement is deterministic for the same blob and holder set", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const shards = encodeBytes(randomBytes(4096), 4, 2);
    const first = await new DurabilityLedger().place(shards, holders, "durable");
    const shuffled = [...holders].reverse();
    const second = await new DurabilityLedger().place(shards, shuffled, "durable");

    assert.deepEqual(
      first.shards.map((shard) => shard.holder),
      second.shards.map((shard) => shard.holder),
    );
    assert.deepEqual(
      first.shards.map((shard) => shard.root),
      second.shards.map((shard) => shard.root),
    );
  } finally {
    cleanup();
  }
});

test("a challenge passes while the holder has the shard", async () => {
  const { holders, cleanup } = setup(6);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(1024), 4, 2), holders, "durable");
    const outcomes = await ledger.challenge(placement.blobHash, holders);

    assert.equal(outcomes.length, 6);
    assert.ok(outcomes.every((outcome) => outcome.ok), JSON.stringify(outcomes));
    assert.equal(ledger.audit(placement.blobHash).status, "ok");
  } finally {
    cleanup();
  }
});

test("losing the bytes fails the challenge and the audit says so", async () => {
  const { holders, cleanup } = setup(5);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(1024), 3, 2), holders, "durable");
    const lost = placement.shards[2]!;
    const lostHolder = holders.find((candidate) => candidate.id === lost.holder)!;

    assert.equal(await lostHolder.remove(lost.storedAs), true);

    const outcomes = await ledger.challenge(placement.blobHash, holders);
    assert.equal(outcomes.find((outcome) => outcome.index === 2)?.ok, false);

    const report = ledger.audit(placement.blobHash);
    assert.equal(report.live, 4);
    assert.equal(report.required, 5);
    assert.equal(report.status, "under-replicated");
    assert.equal(report.shards.find((shard) => shard.index === 2)?.ok, false);
    assert.ok((report.shards.find((shard) => shard.index === 2)?.misses ?? 0) > 0);
  } finally {
    cleanup();
  }
});

test("a challenge response is bound to its nonce", async () => {
  const { holders, cleanup } = setup(2);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(256), 1, 1), holders, "durable");
    const shard = placement.shards[0]!;
    const holder = holders.find((candidate) => candidate.id === shard.holder)!;
    const bytes = Uint8Array.from((await holder.get(shard.storedAs))!);

    const answer = respondToChallenge(bytes, 0, "nonce-one")!;
    assert.equal(verifyChallengeResponse(shard, answer), true);

    const replayed = { ...answer, nonce: "nonce-two" };
    assert.equal(verifyChallengeResponse(shard, replayed), false);
  } finally {
    cleanup();
  }
});

test("a response for one leaf does not verify as another leaf", async () => {
  const { holders, cleanup } = setup(2);

  try {
    const ledger = new DurabilityLedger();
    const payload = randomBytes(8192);
    const placement = await ledger.place(encodeBytes(payload, 1, 1), holders, "durable");
    const shard = placement.shards[0]!;
    const holder = holders.find((candidate) => candidate.id === shard.holder)!;
    const bytes = Uint8Array.from((await holder.get(shard.storedAs))!);

    const answer = respondToChallenge(bytes, 0, "nonce")!;
    const moved = { ...answer, index: 1, proof: answer.proof };
    assert.equal(verifyChallengeResponse(shard, moved), false);
  } finally {
    cleanup();
  }
});

test("the audit goes stale when the challenge window passes", async () => {
  const { holders, cleanup } = setup(4);

  try {
    let clock = 1_000_000;
    const ledger = new DurabilityLedger({ now: () => clock, windowMs: 60_000 });
    const placement = await ledger.place(encodeBytes(randomBytes(512), 3, 1), holders, "durable");

    await ledger.challenge(placement.blobHash, holders);
    assert.equal(ledger.audit(placement.blobHash).status, "ok");

    clock += 120_000;
    const stale = ledger.audit(placement.blobHash);
    assert.equal(stale.live, 0);
    assert.equal(stale.status, "under-replicated");
  } finally {
    cleanup();
  }
});

test("the required holder count follows the tier", async () => {
  assert.equal(requiredHolders("ephemeral", { dataShards: 4, parityShards: 2 }), 1);
  assert.equal(requiredHolders("pinned", { dataShards: 4, parityShards: 2 }), 5);
  assert.equal(requiredHolders("durable", { dataShards: 4, parityShards: 2 }), 6);
});

test("repair rebuilds the lost shard and the blob still decodes", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const payload = randomBytes(4096);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 4, 2), holders, "durable");
    const lost = placement.shards[1]!;
    const shardSize = lost.size;
    const lostHolderId = lost.holder;

    const lostHolder = holders.find((candidate) => candidate.id === lostHolderId)!;
    assert.equal(await lostHolder.remove(lost.storedAs), true);

    await ledger.challenge(placement.blobHash, holders);
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");

    const repaired = await ledger.repair(placement.blobHash, holders);
    assert.equal(repaired.filled, 1);
    assert.equal(repaired.writtenBytes, shardSize);
    assert.equal(repaired.readBytes, shardSize * 4);

    const after = ledger.get(placement.blobHash)!;
    const moved = after.shards.find((shard) => shard.index === 1)!;
    assert.notEqual(moved.holder, lostHolderId, "the replacement is a different holder");

    const afterRepair = ledger.get(placement.blobHash)!;
    const all = await Promise.all(afterRepair.shards.map(async (shard) => {
      const holder = holders.find((candidate) => candidate.id === shard.holder)!;
      return {
        index: shard.index,
        dataShards: afterRepair.dataShards,
        parityShards: afterRepair.parityShards,
        length: afterRepair.length,
        payloadDigest: afterRepair.blobHash,
        bytes: Uint8Array.from((await holder.get(shard.storedAs))!),
        digest: shard.digest,
      };
    }));

    assert.deepEqual(Buffer.from(decodeBytes(all.slice(0, 4))), payload);

    await ledger.challenge(placement.blobHash, holders);
    const report = ledger.audit(placement.blobHash);
    assert.equal(report.status, "ok");
    assert.equal(report.live, 6);
  } finally {
    cleanup();
  }
});

test("repair refuses when fewer than k shards survive", async () => {
  const { holders, cleanup } = setup(6);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(2048), 3, 1), holders, "durable");

    for (const shard of placement.shards.slice(0, 2)) {
      const holder = holders.find((candidate) => candidate.id === shard.holder)!;
      await holder.remove(shard.storedAs);
    }

    await ledger.challenge(placement.blobHash, holders);
    await assert.rejects(() => ledger.repair(placement.blobHash, holders), /only 2 of 3/);
  } finally {
    cleanup();
  }
});

test("repair will not co-locate a shard and needs a spare holder", async () => {
  const { holders, cleanup } = setup(4);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(1024), 3, 1), holders, "durable");
    const lost = placement.shards[0]!;
    await holders.find((candidate) => candidate.id === lost.holder)!.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);

    await assert.rejects(() => ledger.repair(placement.blobHash, holders), /no spare holder/);
  } finally {
    cleanup();
  }
});

test("repair refuses before writing when there are not enough spares", async () => {
  const { holders, cleanup } = setup(7);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(1024), 4, 2), holders, "durable");

    for (const shard of placement.shards.slice(0, 2)) {
      const holder = holders.find((candidate) => candidate.id === shard.holder)!;
      await holder.remove(shard.storedAs);
    }

    await ledger.challenge(placement.blobHash, holders);
    const before = ledger.get(placement.blobHash)!.shards.map((shard) => shard.holder);

    await assert.rejects(() => ledger.repair(placement.blobHash, holders), /no spare holder/);
    assert.deepEqual(
      ledger.get(placement.blobHash)!.shards.map((shard) => shard.holder),
      before,
      "a refused repair changes nothing",
    );
  } finally {
    cleanup();
  }
});
