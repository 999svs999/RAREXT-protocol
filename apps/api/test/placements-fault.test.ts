import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import { DurabilityLedger, directoryHolder } from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import {
  MAX_PLACEMENT_HISTORY,
  PlacementRegistry,
  signPlacement,
} from "../src/placements.ts";

async function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const holders = Array.from({ length: 8 }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );
  const ledger = new DurabilityLedger();
  const placement = await ledger.place(encodeBytes(randomBytes(2048), 3, 2), holders, "durable");
  const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const records = join(root, "records");

  return { root, placement, signer, records };
}

test("placement history compacts to the newest window and still verifies on reload", async () => {
  const { root, placement, signer, records } = await fixture("rarext-placements-compact-");

  try {
    const registry = new PlacementRegistry(records);
    const total = MAX_PLACEMENT_HISTORY + 6;
    let signed = signPlacement(placement, signer);

    assert.equal(registry.put(signed).status, 201);

    for (let sequence = 1; sequence < total; sequence += 1) {
      signed = signPlacement(placement, signer, signed);
      assert.equal(registry.put(signed).status, 201);
    }

    const history = registry.historyFor(placement.blobHash);
    assert.equal(history.length, MAX_PLACEMENT_HISTORY);
    assert.equal(history[0]!.record.sequence, total - MAX_PLACEMENT_HISTORY);
    assert.equal(history.at(-1)!.record.sequence, total - 1);
    assert.equal(registry.get(placement.blobHash)!.record.sequence, total - 1);

    const reloaded = new PlacementRegistry(records);
    assert.equal(reloaded.historyFor(placement.blobHash).length, MAX_PLACEMENT_HISTORY);
    assert.equal(reloaded.get(placement.blobHash)!.record.sequence, total - 1);
    assert.deepEqual(reloaded.list().map((entry) => entry.sequence), [total - 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed append does not leave an in-memory record the disk lacks", async () => {
  const { root, placement, signer, records } = await fixture("rarext-placements-fail-");
  const registry = new PlacementRegistry(records);

  try {
    const first = signPlacement(placement, signer);
    assert.equal(registry.put(first).status, 201);

    const second = signPlacement(placement, signer, first);

    chmodSync(records, 0o500);
    try {
      const failed = registry.put(second);
      assert.equal(failed.status, 507);
      assert.match(failed.error ?? "", /write failed/);
    } finally {
      chmodSync(records, 0o700);
    }

    assert.equal(registry.get(placement.blobHash)!.record.sequence, 0, "the failed record is not served");
    assert.equal(registry.historyFor(placement.blobHash).length, 1);

    assert.equal(registry.put(second).status, 201);
    assert.equal(new PlacementRegistry(records).get(placement.blobHash)!.record.sequence, 1);
  } finally {
    chmodSync(records, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale temp from a crashed append is ignored and does not corrupt the index", async () => {
  const { root, placement, signer, records } = await fixture("rarext-placements-crash-");

  try {
    const registry = new PlacementRegistry(records);
    const first = signPlacement(placement, signer);
    const second = signPlacement(placement, signer, first);

    assert.equal(registry.put(first).status, 201);
    assert.equal(registry.put(second).status, 201);

    writeFileSync(join(records, "placements.json.crashed.tmp"), "{ this is not json");
    assert.ok(readdirSync(records).some((name) => name.endsWith(".tmp")));

    const reloaded = new PlacementRegistry(records);
    assert.equal(reloaded.get(placement.blobHash)!.record.sequence, 1);
    assert.equal(reloaded.historyFor(placement.blobHash).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successive appends serialize and each record lands once", async () => {
  const { root, placement, signer, records } = await fixture("rarext-placements-serial-");

  try {
    const registry = new PlacementRegistry(records);
    const signed = [];
    let previous = null;

    for (let index = 0; index < 4; index += 1) {
      previous = signPlacement(placement, signer, previous);
      signed.push(previous);
    }

    const results = signed.map((record) => registry.put(record));
    assert.deepEqual(results.map((result) => result.status), [201, 201, 201, 201]);

    // Replaying the current head is idempotent. An older record no longer
    // extends the head, so it is refused as a conflict instead of appending.
    const replay = signed.map((record) => registry.put(record));
    assert.deepEqual(replay.map((result) => result.status), [409, 409, 409, 200]);

    const reloaded = new PlacementRegistry(records);
    assert.deepEqual(
      reloaded.historyFor(placement.blobHash).map((entry) => entry.record.sequence),
      [0, 1, 2, 3],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
