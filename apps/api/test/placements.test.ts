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
import { DurabilityLedger, directoryHolder } from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import {
  PlacementRegistry,
  recordDigest,
  signPlacement,
  verifyPlacement,
} from "../src/placements.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

async function placed(tier: "ephemeral" | "pinned" | "durable" = "durable") {
  const root = mkdtempSync(join(tmpdir(), "rarext-placements-"));
  const holders = Array.from({ length: 8 }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );
  const ledger = new DurabilityLedger();
  const placement = await ledger.place(
    encodeBytes(randomBytes(2048), 3, 2),
    holders,
    tier,
  );
  const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);

  return { root, holders, ledger, placement, signer };
}

test("a placement record signs, verifies, and rejects tampering", async () => {
  const { root, placement, signer } = await placed();

  try {
    const signed = signPlacement(placement, signer);
    const verified = verifyPlacement(signed);

    assert.equal(verified.ok, true);
    assert.equal(verified.digest, recordDigest(signed.record));
    assert.equal(signed.record.sequence, 0);
    assert.equal(signed.record.previous, null);
    assert.equal(signed.record.steward.keyId, signer.keyId);

    const tampered = structuredClone(signed);
    tampered.record.placement.shards[0]!.holder = "holder-evil";

    assert.equal(verifyPlacement(tampered).ok, false);
    assert.match(verifyPlacement(tampered).reason ?? "", /signature/);

    const forged = structuredClone(signed);
    forged.signature = "AAAA";

    assert.equal(verifyPlacement(forged).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the registry chains records and refuses a fork", async () => {
  const { root, placement, signer } = await placed();

  try {
    const first = signPlacement(placement, signer);
    const registry = new PlacementRegistry(join(root, "records"));

    assert.deepEqual(registry.put(first), { status: 201 });
    assert.deepEqual(registry.put(first), { status: 200 });

    const second = signPlacement(placement, signer, first);

    assert.equal(second.record.sequence, 1);
    assert.equal(second.record.previous, recordDigest(first.record));
    assert.deepEqual(registry.put(second), { status: 201 });
    assert.equal(registry.historyFor(placement.blobHash).length, 2);
    assert.equal(registry.historyFor(placement.blobHash)[1]!.record.sequence, 1);

    const fork = signPlacement(placement, signer, first);
    assert.equal(registry.put(fork).status, 409);

    const skipped = signPlacement(placement, signer, second);
    assert.deepEqual(registry.put(skipped), { status: 201 });

    const reloaded = new PlacementRegistry(join(root, "records"));

    assert.equal(reloaded.get(placement.blobHash)!.record.sequence, 2);
    assert.equal(reloaded.historyFor(placement.blobHash).length, 3);
    assert.deepEqual(reloaded.list(), [
      {
        blobHash: placement.blobHash,
        sequence: 2,
        tier: placement.tier,
        holders: 5,
        required: 5,
        createdAt: reloaded.get(placement.blobHash)!.record.createdAt,
      },
    ]);

    const badSignature = structuredClone(skipped);
    badSignature.signature = "AAAA";
    assert.equal(registry.put(badSignature).status, 401);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("placements are recorded and read back over HTTP", async () => {
  const { root, placement, signer } = await placed();
  const registry = new PlacementRegistry();
  const { server, base } = await start(new RarextStore(), { placements: registry });

  try {
    const first = signPlacement(placement, signer);
    const created = await post(base, "/v1/placements", first);

    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      status: "recorded",
      blobHash: placement.blobHash,
      sequence: 0,
    });

    const repeat = await post(base, "/v1/placements", first);
    assert.equal(repeat.status, 200);

    const latest = await fetch(`${base}/v1/placements/${placement.blobHash}`);
    assert.equal(latest.status, 200);
    assert.equal(((await latest.json()) as { record: { sequence: number } }).record.sequence, 0);

    const list = (await (await fetch(`${base}/v1/placements`)).json()) as unknown[];
    assert.equal(list.length, 1);

    const second = signPlacement(placement, signer, first);
    assert.equal((await post(base, "/v1/placements", second)).status, 201);

    const history = (await (
      await fetch(`${base}/v1/placements/${placement.blobHash}/history`)
    ).json()) as { record: { sequence: number } }[];

    assert.deepEqual(history.map((entry) => entry.record.sequence), [0, 1]);

    const tampered = structuredClone(second);
    tampered.record.placement.required = 1;
    const rejected = await post(base, "/v1/placements", tampered);

    assert.equal(rejected.status, 401);

    const unknown = await fetch(`${base}/v1/placements/${"0".repeat(64)}`);
    assert.equal(unknown.status, 404);
  } finally {
    await stop(server);
    rmSync(root, { recursive: true, force: true });
  }
});
