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
import type { Publication } from "../../../packages/core/src/index.ts";
import {
  DurabilityLedger,
  directoryHolder,
  type DurabilityHolder,
} from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import { PlacementRegistry, recordDigest, signPlacement } from "../src/placements.ts";
import { publicationDurability } from "../src/publication-durability.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

function manifest(...hashes: string[]): Pick<Publication, "artifact"> {
  return {
    artifact: {
      app: "storage",
      kind: "storage.manifest",
      version: 1,
      mediaType: "application/json",
      body: { blobs: hashes.map((hash) => ({ hash })) },
    },
  };
}

async function setup(count = 8) {
  const root = mkdtempSync(join(tmpdir(), "rarext-pub-durability-"));
  const holders: DurabilityHolder[] = Array.from({ length: count }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );
  const ledger = new DurabilityLedger({ now: () => 1_700_000_000_000 });
  const registry = new PlacementRegistry();
  const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);

  return {
    root,
    holders,
    ledger,
    registry,
    signer,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a publication without blobs carries no durability observation", async () => {
  const { root, registry, ledger, cleanup } = await setup(1);

  try {
    assert.equal(
      publicationDurability(
        { artifact: { app: "logic", kind: "logic.netlist", version: 1, mediaType: "application/json", body: null } },
        registry,
        ledger,
      ),
      null,
    );
    assert.equal(publicationDurability(manifest(), registry, ledger), null);
  } finally {
    cleanup();
  }
});

test("an unplaced blob is unplaced, not ok", async () => {
  const { root, registry, ledger, cleanup } = await setup(1);
  const hash = "a".repeat(64);

  try {
    const observed = publicationDurability(manifest(hash), registry, ledger, {
      now: () => 1_700_000_000_000,
    })!;

    assert.equal(observed.policy, "durability-v1");
    assert.equal(observed.source, "registry-observation");
    assert.equal(observed.status, "unplaced");
    assert.equal(observed.tier, null);
    assert.equal(observed.live, 0);
    assert.equal(observed.required, 0);
    assert.equal(observed.observedAt, "2023-11-14T22:13:20.000Z");
    assert.deepEqual(observed.blobs, [
      {
        hash,
        tier: null,
        required: 0,
        live: 0,
        status: "unplaced",
        sequence: null,
        placementDigest: null,
      },
    ]);
  } finally {
    cleanup();
  }
});

test("a placed but unchallenged blob is unverified, then ok after a run", async () => {
  const { root, holders, ledger, registry, signer, cleanup } = await setup();

  try {
    const placement = await ledger.place(
      encodeBytes(randomBytes(4096), 3, 2),
      holders,
      "durable",
    );
    const signed = signPlacement(placement, signer);

    registry.put(signed);

    const before = publicationDurability(manifest(placement.blobHash), registry, ledger)!;

    assert.equal(before.status, "unverified");
    assert.equal(before.tier, "durable");
    assert.equal(before.required, 5);
    assert.equal(before.live, 0);
    assert.equal(before.blobs[0]!.sequence, 0);
    assert.equal(before.blobs[0]!.placementDigest, recordDigest(signed.record));
    assert.equal(before.windowMs, 24 * 60 * 60 * 1000);

    await ledger.challenge(placement.blobHash, holders);

    const after = publicationDurability(manifest(placement.blobHash), registry, ledger)!;

    assert.equal(after.status, "ok");
    assert.equal(after.live, 5);
    assert.equal(after.required, 5);
    assert.equal(after.blobs[0]!.status, "ok");
  } finally {
    cleanup();
  }
});

test("a lost shard shows up as under-replicated, and a repair clears it", async () => {
  const { root, holders, ledger, registry, signer, cleanup } = await setup();

  try {
    const shards = encodeBytes(randomBytes(4096), 3, 2);
    const placement = await ledger.place(shards, holders, "durable");
    const signed = signPlacement(placement, signer);

    registry.put(signed);
    await ledger.challenge(placement.blobHash, holders);

    const lost = placement.shards[0]!;
    const holder = holders.find((candidate) => candidate.id === lost.holder)!;

    await holder.remove(lost.storedAs);
    await ledger.challenge(placement.blobHash, holders);

    const degraded = publicationDurability(manifest(placement.blobHash), registry, ledger)!;

    assert.equal(degraded.status, "under-replicated");
    assert.equal(degraded.live, 4);
    assert.equal(degraded.required, 5);
    assert.equal(degraded.blobs[0]!.status, "under-replicated");

    const repaired = await ledger.repair(placement.blobHash, holders);
    const next = signPlacement(repaired.placement, signer, signed);

    registry.put(next);
    await ledger.challenge(placement.blobHash, holders);

    const recovered = publicationDurability(manifest(placement.blobHash), registry, ledger)!;

    assert.equal(recovered.status, "ok");
    assert.equal(recovered.live, 5);
    assert.equal(recovered.blobs[0]!.sequence, 1);
    assert.equal(recovered.blobs[0]!.placementDigest, recordDigest(next.record));
  } finally {
    cleanup();
  }
});

test("a manifest with mixed tiers reports the weakest tier and every blob", async () => {
  const { root, holders, ledger, registry, signer, cleanup } = await setup();

  try {
    const durable = await ledger.place(
      encodeBytes(randomBytes(4096), 3, 2),
      holders,
      "durable",
    );
    const pinnedShards = encodeBytes(randomBytes(2048), 3, 2);
    const pinned = await ledger.place(pinnedShards, holders, "pinned");

    registry.put(signPlacement(durable, signer));
    registry.put(signPlacement(pinned, signer));
    await ledger.challenge(durable.blobHash, holders);
    await ledger.challenge(pinned.blobHash, holders);

    for (const shard of pinned.shards.slice(0, 2)) {
      const holder = holders.find((candidate) => candidate.id === shard.holder)!;

      await holder.remove(shard.storedAs);
    }

    await ledger.challenge(pinned.blobHash, holders);

    const observed = publicationDurability(
      manifest(durable.blobHash, pinned.blobHash),
      registry,
      ledger,
    )!;

    assert.equal(observed.tier, "pinned");
    assert.equal(observed.status, "under-replicated");
    assert.equal(observed.required, 9);
    assert.equal(observed.live, 8);
    assert.deepEqual(
      observed.blobs.map((blob) => [blob.hash, blob.tier, blob.status]),
      [
        [durable.blobHash, "durable", "ok"],
        [pinned.blobHash, "pinned", "under-replicated"],
      ],
    );
  } finally {
    cleanup();
  }
});

test("a manifest with one unplaced blob is unplaced overall", async () => {
  const { root, holders, ledger, registry, signer, cleanup } = await setup();

  try {
    const placement = await ledger.place(
      encodeBytes(randomBytes(2048), 2, 1),
      holders,
      "pinned",
    );

    registry.put(signPlacement(placement, signer));
    await ledger.challenge(placement.blobHash, holders);

    const observed = publicationDurability(
      manifest(placement.blobHash, "b".repeat(64)),
      registry,
      ledger,
    )!;

    assert.equal(observed.status, "unplaced");
    assert.equal(observed.tier, "pinned");
    assert.equal(observed.live, 3);
    assert.equal(observed.required, 3);
  } finally {
    cleanup();
  }
});

test("the publication endpoint carries the observation, the feed too", async () => {
  const { root, holders, ledger, registry, signer, cleanup } = await setup();

  try {
    const placement = await ledger.place(
      encodeBytes(randomBytes(4096), 3, 2),
      holders,
      "durable",
    );

    registry.put(signPlacement(placement, signer));

    const store = new RarextStore();
    const publication = {
      id: "pub-storage-1",
      author: "alice",
      authorKey: null,
      signatureAlgorithm: "ecdsa-p256",
      title: "manifest",
      body: "",
      app: "storage",
      challengeId: "storage",
      taskId: "storage",
      artifact: manifest(placement.blobHash).artifact,
      visibility: "public",
      createdAt: new Date(0).toISOString(),
      attestedAt: new Date(0).toISOString(),
      verified: true,
      signature: null,
      nonce: "nonce-1",
      parentId: null,
      source: null,
      artifactCommitment: null,
      attestation: {
        id: "att-1",
        verifier: "storage",
        taskId: "storage",
        circuitHash: "0".repeat(64),
        traceHash: "0".repeat(64),
        correct: true,
        score: 1,
        gateCount: 0,
        semanticsId: "storage/storage-v1",
        semanticsVersion: 1,
        semanticsHash: "0".repeat(64),
        claimKind: "produces",
        scope: null,
        verifierHash: "0".repeat(64),
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        createdAt: new Date(0).toISOString(),
      },
    } as Publication;

    store.addPublication(publication);

    const { server, base } = await start(store, {
      placements: registry,
      durability: ledger,
      holders,
    });

    try {
      const before = (await (
        await fetch(`${base}/v1/publications/${publication.id}`)
      ).json()) as Publication;

      assert.equal(before.durability!.status, "unverified");
      assert.equal(before.durability!.tier, "durable");

      assert.equal((await post(base, "/v1/durability/challenge", {})).status, 200);

      const after = (await (
        await fetch(`${base}/v1/publications/${publication.id}`)
      ).json()) as Publication;
      const feed = (await (await fetch(`${base}/v1/feed`)).json()) as Publication[];

      assert.equal(after.durability!.status, "ok");
      assert.equal(after.durability!.live, 5);
      assert.equal(feed[0]!.id, publication.id);
      assert.equal(feed[0]!.durability!.live, 5);
      assert.equal(feed[0]!.durability!.blobs[0]!.placementDigest?.length, 64);
    } finally {
      await stop(server);
    }
  } finally {
    cleanup();
  }
});
