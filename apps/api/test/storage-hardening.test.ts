import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
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
  respondToChallenge,
  type DurabilityHolder,
  type Placement,
} from "../src/durability.ts";
import { decodeBytes, encodeBytes } from "../src/erasure.ts";
import { PlacementRegistry, placementProblem, signPlacement } from "../src/placements.ts";
import { BlobStore, blobHash, MAX_BLOB_BYTES } from "../src/storage.ts";

function setup(count: number) {
  const root = mkdtempSync(join(tmpdir(), "rarext-hardening-"));
  const holders = Array.from({ length: count }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );

  return { root, holders, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function reconstruct(placement: Placement, holders: DurabilityHolder[]): Promise<Uint8Array> {
  const shards = [];

  for (const shard of placement.shards.slice(0, placement.dataShards)) {
    const holder = holders.find((candidate) => candidate.id === shard.holder);
    assert.ok(holder, `holder ${shard.holder} is still configured`);
    const bytes = await holder.get(shard.storedAs);
    assert.ok(bytes, `shard ${shard.index} is readable`);
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

  return decodeBytes(shards);
}

test("a failed repair write leaves the signed placement unchanged and is retryable", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const payload = randomBytes(4096);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 4, 2), holders, "durable");
    const lost = placement.shards.slice(0, 2);
    for (const shard of lost) {
      await holders.find((holder) => holder.id === shard.holder)!.remove(shard.storedAs);
    }
    await ledger.challenge(placement.blobHash, holders);

    const before = JSON.stringify(ledger.get(placement.blobHash));
    let writes = 0;
    const faulty = holders.map((holder) => ({
      ...holder,
      async put(bytes: Uint8Array) {
        writes += 1;
        if (writes === 2) throw new Error("ENOSPC: no space left on device");
        return holder.put(bytes);
      },
    }));

    await assert.rejects(
      () => ledger.repair(placement.blobHash, faulty),
      /repair write failed for shard .*ENOSPC/,
    );

    assert.equal(writes, 2, "the second staged write failed");
    assert.equal(
      JSON.stringify(ledger.get(placement.blobHash)),
      before,
      "a partially staged repair must not move the placement",
    );
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");

    const repaired = await ledger.repair(placement.blobHash, holders);
    assert.equal(repaired.filled, 2);
    assert.equal(repaired.readBytes, lost[0]!.size * 4);
    assert.deepEqual(Buffer.from(await reconstruct(ledger.get(placement.blobHash)!, holders)), payload);
  } finally {
    cleanup();
  }
});

test("a tampered shard produces a bad challenge proof and cannot poison repair", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const payload = randomBytes(2048);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 4, 2), holders, "durable");
    const victim = placement.shards[0]!;
    const honest = holders.find((holder) => holder.id === victim.holder)!;
    const corrupt: DurabilityHolder = {
      ...honest,
      async get(storedAs) {
        const bytes = await honest.get(storedAs);
        if (!bytes) return null;
        const tampered = Uint8Array.from(bytes);
        tampered[0] ^= 0xff;
        return tampered;
      },
      async respond(challenge) {
        const bytes = await this.get(challenge.storedAs);
        return bytes ? respondToChallenge(bytes, challenge.leafIndex, challenge.nonce) : null;
      },
    };
    const withCorruption = holders.map((holder) => (holder.id === corrupt.id ? corrupt : holder));

    const outcomes = await ledger.challenge(placement.blobHash, withCorruption);
    assert.equal(outcomes.find((outcome) => outcome.index === 0)!.reason, "bad-proof");
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");

    // A corrupt survivor selected by repair fails its digest instead of being
    // silently decoded around.
    const clean = new DurabilityLedger();
    const cleanPlacement = await clean.place(encodeBytes(payload, 4, 2), holders, "durable");
    const lost = cleanPlacement.shards[5]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    const corruptIndex = cleanPlacement.shards[0]!.holder;
    const poisoned = holders.map((holder) =>
      holder.id === corruptIndex ? corrupt : holder,
    );

    await assert.rejects(
      () => clean.repair(cleanPlacement.blobHash, poisoned),
      /does not match its digest/,
    );
    assert.equal(clean.audit(cleanPlacement.blobHash).status, "under-replicated");

    const repaired = await clean.repair(cleanPlacement.blobHash, holders);
    assert.equal(repaired.filled, 1);
    assert.deepEqual(Buffer.from(await reconstruct(clean.get(cleanPlacement.blobHash)!, holders)), payload);
  } finally {
    cleanup();
  }
});

test("repair recovers after a crash and a restart from the signed placement", async () => {
  const { root, holders, cleanup } = setup(8);

  try {
    const payload = randomBytes(4096);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 4, 2), holders, "durable");
    const lost = placement.shards[2]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);

    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const signed = signPlacement(placement, signer);
    const registry = new PlacementRegistry(join(root, "records"));
    assert.equal(registry.put(signed).status, 201);
    const before = JSON.stringify(placement);

    let writes = 0;
    const crashing = holders.map((holder) => ({
      ...holder,
      async put(bytes: Uint8Array) {
        writes += 1;
        const storedAs = await holder.put(bytes);
        if (writes === 1) throw new Error("simulated crash after first write");
        return storedAs;
      },
    }));

    await assert.rejects(() => ledger.repair(placement.blobHash, crashing), /simulated crash/);
    assert.equal(JSON.stringify(placement), before);

    const recovered = new DurabilityLedger();
    const reloaded = new PlacementRegistry(join(root, "records"));
    const restored = reloaded.get(placement.blobHash)!;
    recovered.adopt(structuredClone(restored.record.placement));

    const reopened = Array.from({ length: 8 }, (_, index) =>
      directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
    );
    await recovered.challenge(placement.blobHash, reopened);
    assert.equal(recovered.audit(placement.blobHash).status, "under-replicated");

    const repaired = await recovered.repair(placement.blobHash, reopened);
    assert.equal(repaired.filled, 1);
    const after = recovered.get(placement.blobHash)!;
    assert.equal(new Set(after.shards.map((shard) => shard.holder)).size, after.shards.length);
    assert.deepEqual(Buffer.from(await reconstruct(after, reopened)), payload);
    await recovered.challenge(placement.blobHash, reopened);
    assert.equal(recovered.audit(placement.blobHash).status, "ok");
  } finally {
    cleanup();
  }
});

test("holder churn and two simultaneous losses repair without co-location", async () => {
  const { root, holders, cleanup } = setup(8);

  try {
    const payload = randomBytes(8192);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(payload, 4, 2), holders, "durable");

    for (const index of [1, 4]) {
      const shard = placement.shards[index]!;
      await holders.find((holder) => holder.id === shard.holder)!.remove(shard.storedAs);
    }

    await ledger.challenge(placement.blobHash, holders);
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");

    const first = await ledger.repair(placement.blobHash, holders);
    assert.equal(first.filled, 2);
    assert.equal(first.readBytes, placement.shards[0]!.size * 4);
    assert.equal(first.writtenBytes, placement.shards[0]!.size * 2);
    const afterFirst = ledger.get(placement.blobHash)!;
    assert.equal(new Set(afterFirst.shards.map((shard) => shard.holder)).size, 6);
    assert.deepEqual(Buffer.from(await reconstruct(afterFirst, holders)), payload);

    const churnVictim = afterFirst.shards[0]!;
    await holders.find((holder) => holder.id === churnVictim.holder)!.remove(churnVictim.storedAs);
    const newcomer = directoryHolder("holder-8", join(root, "holder-8"));
    const churned = [...holders, newcomer];
    await ledger.challenge(placement.blobHash, churned);
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");

    const second = await ledger.repair(placement.blobHash, churned);
    assert.equal(second.filled, 1);
    const afterSecond = ledger.get(placement.blobHash)!;
    assert.equal(new Set(afterSecond.shards.map((shard) => shard.holder)).size, 6);
    assert.deepEqual(Buffer.from(await reconstruct(afterSecond, churned)), payload);
  } finally {
    cleanup();
  }
});

test("a read-only blob directory and a failed index write do not leave half-blobs", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-blob-hardening-"));

  try {
    const directory = join(root, "blobs");
    const store = new BlobStore(directory);
    const alpha = store.put(Buffer.from("alpha"));
    const beta = blobHash(Buffer.from("beta"));

    chmodSync(directory, 0o500);

    try {
      assert.throws(() => store.put(Buffer.from("beta")));
    } finally {
      chmodSync(directory, 0o700);
    }

    assert.equal(existsSync(join(directory, beta)), false);
    assert.deepEqual(store.list().map((record) => record.hash), [alpha.hash]);
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );

    const indexPath = join(directory, "_index.json");
    rmSync(indexPath);
    mkdirSync(indexPath);

    const gamma = blobHash(Buffer.from("gamma"));
    assert.throws(() => store.put(Buffer.from("gamma")));
    assert.equal(existsSync(join(directory, gamma)), false, "the blob is rolled back when its index cannot be written");
    assert.deepEqual(store.list().map((record) => record.hash), [alpha.hash]);

    rmSync(indexPath, { recursive: true, force: true });
    assert.equal(store.put(Buffer.from("gamma")).hash, gamma);
    assert.deepEqual(new BlobStore(directory).list().map((record) => record.hash).sort(), [alpha.hash, gamma].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a placement with a malformed or truncated shard digest is refused", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encodeBytes(randomBytes(2048), 3, 2), holders, "durable");
    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);

    const badDigest = structuredClone(placement);
    badDigest.shards[0]!.digest = "zz".padEnd(64, "0");
    assert.equal(placementProblem(badDigest), "shard digests must be sha256 hex values");

    const truncatedRoot = structuredClone(placement);
    truncatedRoot.shards[0]!.root = truncatedRoot.shards[0]!.root!.slice(0, 8);
    assert.equal(placementProblem(truncatedRoot), "shard digests must be sha256 hex values");

    assert.throws(
      () => signPlacement(badDigest, signer),
      /sha256 hex/,
    );

    const good = signPlacement(placement, signer);
    assert.equal(good.record.placement.blobHash, placement.blobHash);
  } finally {
    cleanup();
  }
});

test("BlobStore enforces the MAX_BLOB_BYTES cap and reports the exact size", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-blob-cap-"));

  try {
    const store = new BlobStore(join(root, "blobs"));
    assert.equal(store.maxBytes, MAX_BLOB_BYTES);

    const justBelow = Buffer.alloc(MAX_BLOB_BYTES - 1);
    assert.equal(store.put(justBelow).size, MAX_BLOB_BYTES - 1);

    const atCap = Buffer.alloc(MAX_BLOB_BYTES);
    assert.equal(store.put(atCap).size, MAX_BLOB_BYTES);

    const above = Buffer.alloc(MAX_BLOB_BYTES + 1);
    assert.throws(
      () => store.put(above),
      /above the .* byte cap/,
    );

    const custom = new BlobStore(join(root, "custom"), { maxBytes: 8 });
    assert.throws(() => custom.put(Buffer.alloc(9)), /byte cap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /v1/blobs returns 201 and GET returns the exact bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-blobs-http-"));
  const store = new BlobStore(join(root, "blobs"));
  const { RarextStore } = await import("../src/store.ts");
  const { start, stop, post } = await import("./helpers.ts");
  const { server, base } = await start(new RarextStore(), { blobs: store });

  try {
    const ok = await post(base, "/v1/blobs", {
      content: Buffer.from("hello storage").toString("base64"),
      encoding: "base64",
    });
    assert.equal(ok.status, 201);
    const record = (await ok.json()) as { hash: string; size: number };
    assert.equal(record.size, 13);

    const fetched = await fetch(`${base}/v1/blobs/${record.hash}`);
    assert.equal(fetched.status, 200);
    const body = (await fetched.json()) as { content: string; encoding: string };
    assert.equal(body.encoding, "base64");
    assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "hello storage");

    const missing = await fetch(`${base}/v1/blobs/${"0".repeat(64)}`);
    assert.equal(missing.status, 404);
  } finally {
    await stop(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair with fewer than k shards live is refused before any write", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(randomBytes(2048), 3, 1),
      holders,
      "durable",
    );

    // Remove 2 of 3 data shards: only 1 survivor, but k=3 is required.
    for (const index of [0, 1]) {
      const shard = placement.shards[index]!;
      await holders.find((holder) => holder.id === shard.holder)!.remove(shard.storedAs);
    }

    await ledger.challenge(placement.blobHash, holders);
    assert.equal(ledger.audit(placement.blobHash).status, "under-replicated");

    const before = JSON.stringify(ledger.get(placement.blobHash));
    await assert.rejects(
      () => ledger.repair(placement.blobHash, holders),
      /only 1 of 3 data shards survive/,
    );
    assert.equal(
      JSON.stringify(ledger.get(placement.blobHash)),
      before,
      "a refused repair must not move the placement",
    );
  } finally {
    cleanup();
  }
});

test("repair reports a missing holder for a surviving shard instead of a crash", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(randomBytes(2048), 3, 2),
      holders,
      "durable",
    );

    // A survivor's holder is no longer configured, and 2 of k=3 shards are gone.
    const survivor = placement.shards[3]!;
    const victim = placement.shards[0]!;
    await holders.find((holder) => holder.id === victim.holder)!.remove(victim.storedAs);
    const withoutSurvivor = holders.filter((holder) => holder.id !== survivor.holder);

    await ledger.challenge(placement.blobHash, holders);

    await assert.rejects(
      () => ledger.repair(placement.blobHash, withoutSurvivor),
      /is not configured/,
    );
  } finally {
    cleanup();
  }
});

test("concurrent repairs of the same shard share one in-flight write", async () => {
  const { holders, cleanup } = setup(8);

  try {
    const payload = randomBytes(2048);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(payload, 4, 2),
      holders,
      "durable",
    );

    const lost = placement.shards[0]!;
    await holders.find((holder) => holder.id === lost.holder)!.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);

    const [first, second] = await Promise.all([
      ledger.repair(placement.blobHash, holders),
      ledger.repair(placement.blobHash, holders),
    ]);

    assert.equal(first, second, "the second caller joins the in-flight repair");
    assert.equal(first.filled, 1);

    const after = ledger.get(placement.blobHash)!;
    assert.equal(new Set(after.shards.map((shard) => shard.holder)).size, after.shards.length);
    assert.deepEqual(
      Buffer.from(await reconstruct(after, holders)),
      payload,
      "the repaired placement still reconstructs the original payload",
    );

    // A sequential re-repair after a fresh challenge is a no-op.
    await ledger.challenge(placement.blobHash, holders);
    const noop = await ledger.repair(placement.blobHash, holders);
    assert.equal(noop.filled, 0);
  } finally {
    cleanup();
  }
});

