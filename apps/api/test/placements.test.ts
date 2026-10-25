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
import { encryptSealedPayload, sealedMetadata } from "../src/sealed-encryption.ts";
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

test("a placement cannot change sealed metadata without re-uploading the blob", async () => {
  const { root, placement, signer } = await placed();

  try {
    const sealed = sealedMetadata(
      encryptSealedPayload(Buffer.from("sealed placement bytes"), "placement-test-secret").envelope,
    );
    const first = signPlacement({ ...placement, sealed }, signer);
    const registry = new PlacementRegistry(join(root, "records"));

    assert.equal(registry.put(first).status, 201);

    const changed = signPlacement(
      { ...placement, sealed: { ...sealed, keyId: "rotated" } },
      signer,
      first,
    );
    const rejected = registry.put(changed);

    assert.equal(rejected.status, 409);
    assert.match(rejected.error ?? "", /sealed metadata cannot change/);
    assert.equal(registry.get(placement.blobHash)!.record.sequence, 0);
    assert.equal(registry.historyFor(placement.blobHash).length, 1);

    const unsealed = signPlacement({ ...placement, sealed: undefined }, signer, first);
    assert.equal(registry.put(unsealed).status, 409);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hardening round: the placement gate. `PlacementRegistry.put` stores whatever
// `verifyPlacement` accepts, and a stored placement is what repair and
// reconstruction read — so each refusal branch is pinned by name.
// ---------------------------------------------------------------------------

test("mechanism: shape — a malformed placement record is refused, by name", async () => {
  const { root, placement, signer } = await placed();

  try {
    const base = signPlacement(placement, signer);
    const mutate = (change: (record: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(base)) as { record: Record<string, unknown> };
      change(copy.record);
      return copy;
    };

    const expectations: Array<[string, () => unknown, RegExp]> = [
      ["record missing", () => ({ signature: "AA" }), /record must be an object/],
      ["wrong kind", () => mutate((r) => { r.kind = "rarext.something"; }), /kind is not a placement/],
      ["wrong version", () => mutate((r) => { r.version = 2; }), /version is not supported/],
      [
        "signature not a string",
        () => ({ record: (base as { record: unknown }).record, signature: 42 }),
        /signature must be a string/,
      ],
      ["sequence not an integer", () => mutate((r) => { r.sequence = 1.5; }), /sequence must be a non-negative integer/],
      ["sequence negative", () => mutate((r) => { r.sequence = -1; }), /sequence must be a non-negative integer/],
      [
        "first record links backwards",
        () => mutate((r) => { r.sequence = 0; r.previous = "a".repeat(64); }),
        /the first record cannot link backwards/,
      ],
      [
        "previous is not a digest",
        () => mutate((r) => { r.sequence = 1; r.previous = "not-a-digest"; }),
        /previous must be a sha256 hex digest/,
      ],
      ["steward missing", () => mutate((r) => { r.steward = null; }), /steward is missing/],
      [
        "steward keyId is not a digest",
        () => mutate((r) => { (r.steward as Record<string, unknown>).keyId = "short"; }),
        /steward keyId must be a sha256 hex digest/,
      ],
      [
        "steward has no public key",
        () => mutate((r) => { (r.steward as Record<string, unknown>).publicKey = null; }),
        /steward publicKey is missing/,
      ],
      [
        "steward keyId is not its key",
        () => mutate((r) => { (r.steward as Record<string, unknown>).keyId = "0".repeat(64); }),
        /steward keyId does not match its public key|steward keyId must be/,
      ],
      [
        "steward algorithm mismatch",
        () => mutate((r) => { (r.steward as Record<string, unknown>).algorithm = "ed25519"; }),
        /steward algorithm is not supported/,
      ],
      ["createdAt not ISO", () => mutate((r) => { r.createdAt = "sometime"; }), /createdAt must be an ISO timestamp/],
      // The gate delegates the placement body itself; these pin that delegation
      // rather than claiming to enumerate every branch placementProblem has.
      [
        "placement body: blobHash not a digest",
        () => mutate((r) => { (r.placement as Record<string, unknown>).blobHash = "short"; }),
        /blobHash must be a sha256 hex digest/,
      ],
      [
        "placement body: unknown tier",
        () => mutate((r) => { (r.placement as Record<string, unknown>).tier = "gold"; }),
        /tier is not recognised/,
      ],
      [
        "placement body: shard list does not match k + m",
        () => mutate((r) => { (r.placement as Record<string, unknown>).shards = []; }),
        /shards must contain exactly k \+ m entries/,
      ],
    ];

    for (const [name, build, pattern] of expectations) {
      const result = verifyPlacement(build() as never);
      assert.equal(result.ok, false, `${name} must be refused`);
      assert.match(result.reason ?? "", pattern, `${name}: got ${result.reason}`);
      assert.equal(result.digest, null, `${name} must not produce a digest`);
    }

    // A shape that is fine but edited after signing fails on the signature, and
    // the honest record is still accepted (the gate is not simply refusing).
    const edited = JSON.parse(JSON.stringify(base)) as { record: Record<string, unknown> };
    edited.record.createdAt = "2026-02-02T00:00:00.000Z";
    assert.match(verifyPlacement(edited as never).reason ?? "", /signature does not verify/);
    assert.equal(verifyPlacement(base).ok, true);
    assert.equal(typeof verifyPlacement(base).digest, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mechanism: registry — a rejected record never reaches the history, and the chain stays contiguous", async () => {
  const { root, placement, signer } = await placed();

  try {
    const registry = new PlacementRegistry(join(root, "gate"));
    const first = signPlacement(placement, signer);
    const second = signPlacement(placement, signer, first);

    // An invalid record is refused with 401 and stores nothing.
    const invalid = registry.put({ record: { kind: "rarext.placement" }, signature: "AA" } as never);
    assert.equal(invalid.status, 401);
    assert.equal(registry.list().length, 0, "a refused record must not appear in history");

    assert.deepEqual(registry.put(first), { status: 201 });
    assert.deepEqual(registry.put(first), { status: 200 }, "the same record is idempotent");

    // Out-of-order: a record that does not extend the current one is refused.
    const gap = signPlacement(placement, signer, second);
    assert.equal(registry.put(gap).status, 409);
    assert.match(registry.put(gap).error ?? "", /does not extend|does not link/);
    assert.equal(registry.historyFor(placement.blobHash).length, 1, "a refused extension writes nothing");

    // The honest extension lands, and a fork off the same parent is refused.
    assert.deepEqual(registry.put(second), { status: 201 });
    const fork = signPlacement(placement, signer, first);
    assert.equal(registry.put(fork).status, 409);
    assert.equal(registry.historyFor(placement.blobHash).length, 2);

    // A restart rebuilds the same chain, so the refusals were not in-memory only.
    const reloaded = new PlacementRegistry(join(root, "gate"));
    assert.equal(reloaded.historyFor(placement.blobHash).length, 2);
    assert.equal(reloaded.get(placement.blobHash)!.record.sequence, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
