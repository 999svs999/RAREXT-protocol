import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeBytes,
  encodeBytes,
  shardDigest,
  verifyShard,
  type ErasureShard,
} from "../src/erasure.ts";
import {
  DurabilityLedger,
  httpHolder,
  requiredHolders,
  type DurabilityTier,
  type Placement,
} from "../src/durability.ts";
import { placementProblem } from "../src/placements.ts";
import { createHolderServer } from "../src/holder-server.ts";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytesFrom(random: () => number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = Math.floor(random() * 256);
  return bytes;
}

function hex(random: () => number): string {
  return Buffer.from(randomBytesFrom(random, 32)).toString("hex");
}

function subsets(indices: number[], size: number): number[][] {
  if (size === 0) return [[]];
  if (indices.length < size) return [];

  const [head, ...rest] = indices;
  return [
    ...subsets(rest, size - 1).map((subset) => [head!, ...subset]),
    ...subsets(rest, size),
  ];
}

function pick(random: () => number, shards: ErasureShard[], count: number): ErasureShard[] {
  const pool = [...shards];

  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
  }

  return pool.slice(0, count);
}

test("fuzz: erasure roundtrip holds across random payloads and parameters", () => {
  const random = mulberry32(0x5eed_0001);

  for (let round = 0; round < 40; round += 1) {
    const dataShards = 1 + Math.floor(random() * 6);
    const parityShards = Math.floor(random() * 5);
    const size = round < 4 ? round : Math.floor(random() * 8192);
    const payload = randomBytesFrom(random, size);
    const shards = encodeBytes(payload, dataShards, parityShards);

    assert.equal(shards.length, dataShards + parityShards);
    assert.ok(shards.every(verifyShard));
    assert.deepEqual(Buffer.from(decodeBytes(shards)), Buffer.from(payload));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const chosen = pick(random, shards, dataShards);
      assert.deepEqual(Buffer.from(decodeBytes(chosen)), Buffer.from(payload));
    }
  }
});

test("fuzz: every k-subset of n shards reconstructs, and k - 1 never does", () => {
  const random = mulberry32(0x5eed_0002);
  const payload = randomBytesFrom(random, 4096);

  for (const [dataShards, parityShards] of [
    [1, 1],
    [2, 1],
    [2, 2],
    [3, 2],
    [4, 2],
  ] as const) {
    const shards = encodeBytes(payload, dataShards, parityShards);
    const indices = shards.map((shard) => shard.index);

    for (const subset of subsets(indices, dataShards)) {
      const chosen = subset.map((index) => shards[index]!);
      assert.deepEqual(Buffer.from(decodeBytes(chosen)), Buffer.from(payload));
    }

    if (dataShards > 1) {
      const short = pick(random, shards, dataShards - 1);
      assert.throws(() => decodeBytes(short), /at least \d+ shards/);
    }
  }
});

test("fuzz: tampered, relabelled, and foreign shards are refused", () => {
  const random = mulberry32(0x5eed_0003);
  const payload = randomBytesFrom(random, 3072);
  const shards = encodeBytes(payload, 2, 2);

  for (let round = 0; round < 25; round += 1) {
    const target = Math.floor(random() * shards.length);
    const shard = shards[target]!;
    const bytes = Uint8Array.from(shard.bytes);
    const mutate = round % 3;

    if (mutate === 0) {
      bytes[Math.floor(random() * bytes.length)] ^= 1 + Math.floor(random() * 255);
      const corrupted = { ...shard, bytes };
      assert.equal(verifyShard(corrupted), false);
      assert.throws(() => decodeBytes(shards.map((s) => (s.index === shard.index ? corrupted : s))), /digest/);
    } else if (mutate === 1) {
      const index = (shard.index + 1) % shards.length;
      const relabelled = { ...shard, index };
      assert.notEqual(shardDigest(relabelled), shard.digest);
      assert.equal(verifyShard(relabelled), false);
      assert.throws(
        () => decodeBytes(shards.map((s) => (s.index === shard.index ? relabelled : s))),
        /digest|appears twice|range/,
      );
    } else {
      const foreign = encodeBytes(randomBytesFrom(random, 3072), 2, 2)[0]!;
      assert.equal(verifyShard(foreign), true);
      assert.throws(
        () => decodeBytes(shards.map((s) => (s.index === shard.index ? foreign : s))),
        /same set|same size/,
      );
    }
  }
});

function validPlacement(random: () => number): Placement {
  const tiers: DurabilityTier[] = ["ephemeral", "pinned", "durable"];
  let dataShards = 1 + Math.floor(random() * 6);
  let parityShards = 1 + Math.floor(random() * 4);
  let tier = tiers[Math.floor(random() * tiers.length)]!;

  if (tier === "pinned" && parityShards === 0) parityShards = 1;
  if (dataShards + parityShards > 255) dataShards = 255 - parityShards;

  const size = random() < 0.15 ? 0 : 1 + Math.floor(random() * 8192);
  const total = dataShards + parityShards;
  const minimum = (dataShards - 1) * size;
  const maximum = dataShards * size;
  const length = size === 0 ? 0 : minimum + Math.floor(random() * (maximum - minimum + 1));
  const leaves = Math.max(1, Math.ceil(size / 4096));

  return {
    blobHash: hex(random),
    dataShards,
    parityShards,
    length,
    tier,
    required: requiredHolders(tier, { dataShards, parityShards }),
    shards: Array.from({ length: total }, (_, index) => ({
      index,
      holder: `holder-${index}`,
      digest: hex(random),
      storedAs: hex(random),
      size,
      leaves,
      root: hex(random),
    })),
    createdAt: new Date(0).toISOString(),
  };
}

test("fuzz: generated placements satisfy the invariants and single mutations break them", () => {
  const random = mulberry32(0x5eed_0004);

  for (let round = 0; round < 50; round += 1) {
    const placement = validPlacement(random);
    assert.equal(placementProblem(placement), null);

    const mutations: Array<[string, (copy: Placement) => void]> = [
      ["duplicate holder", (copy) => { copy.shards[1]!.holder = copy.shards[0]!.holder; }],
      ["duplicate index", (copy) => { copy.shards[1]!.index = copy.shards[0]!.index; }],
      ["out-of-range index", (copy) => { copy.shards[0]!.index = copy.dataShards + copy.parityShards; }],
      ["wrong required", (copy) => { copy.required += 1; }],
      ["missing shard", (copy) => { copy.shards.pop(); }],
      ["uneven sizes", (copy) => { copy.shards[0]!.size += 1; }],
      ["wrong leaves", (copy) => { copy.shards[0]!.leaves += 1; }],
      ["bad blob hash", (copy) => { copy.blobHash = "not-a-hash"; }],
      ["unknown tier", (copy) => { copy.tier = "forever" as DurabilityTier; }],
      ["payload too long", (copy) => { copy.length = copy.dataShards * copy.shards[0]!.size + 1; }],
      ["no data shards", (copy) => { copy.dataShards = 0; }],
      ["bad shard digest", (copy) => { copy.shards[0]!.digest = "xyz"; }],
    ];

    for (const [label, mutate] of mutations) {
      const copy = structuredClone(placement);
      mutate(copy);
      assert.notEqual(placementProblem(copy), null, `mutation "${label}" was accepted`);
    }
  }
});

test("fuzz: property placementProblem is total and never throws", () => {
  const random = mulberry32(0x5eed_0005);
  const values: unknown[] = [
    null,
    undefined,
    0,
    "",
    [],
    {},
    { ...validPlacement(random), shards: null },
    { ...validPlacement(random), shards: [] },
    { ...validPlacement(random), dataShards: -1 },
    { ...validPlacement(random), parityShards: 1.5 },
    { ...validPlacement(random), length: Number.NaN },
  ];

  for (const value of values) {
    assert.doesNotThrow(() => placementProblem(value));
    assert.equal(typeof placementProblem(value), "string");
  }
});

async function closeServer(server: ReturnType<typeof createHolderServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function putRaw(base: string, bytes: Uint8Array): Promise<string> {
  const response = await fetch(`${base}/v1/holder/shards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: Buffer.from(bytes).toString("base64") }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { storedAs: string };
  return body.storedAs;
}

test("fuzz: GC never deletes a shard a live placement references", async () => {
  const random = mulberry32(0x5eed_0006);
  const root = mkdtempSync(join(tmpdir(), "rarext-gc-property-"));
  const servers = Array.from({ length: 3 }, (_, index) =>
    createHolderServer({ id: `holder-${index}`, directory: join(root, `holder-${index}`) }),
  );

  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }

    const urls = new Map(
      servers.map((server, index) => [
        `holder-${index}`,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ]),
    );
    const holders = [...urls].map(([id, url]) => httpHolder(id, url));
    const ledger = new DurabilityLedger();

    const planned: Placement[] = [];

    for (let round = 0; round < 4; round += 1) {
      const payload = randomBytesFrom(random, 512 + Math.floor(random() * 4096));
      planned.push(await ledger.place(encodeBytes(payload, 2, 1), holders, "durable"));
    }

    const orphans: string[] = [];
    for (const [id, url] of urls) {
      orphans.push(await putRaw(url, new Uint8Array([id.length, Math.floor(random() * 255)])));
    }

    assert.equal(ledger.referencedShardsByHolder().size, 3);

    for (const options of [
      { gracePeriodMs: 0, dryRun: true },
      { gracePeriodMs: 0, dryRun: false },
      { gracePeriodMs: 0, dryRun: false },
    ]) {
      const results = await ledger.gcWithUrls(urls, options);

      for (const [id, url] of urls) {
        const result = results.find((entry) => entry.holder === id)!;
        assert.equal(result.error, undefined, `GC failed on ${id}: ${result.error}`);

        for (const shard of planned.flatMap((placement) => placement.shards)) {
          if (shard.holder !== id) continue;
          const response = await fetch(`${url}/v1/holder/shards/${shard.storedAs}`);
          assert.equal(response.status, 200, `${id} lost referenced shard ${shard.storedAs}`);
        }
      }
    }

    for (const orphan of orphans) {
      const gone = await Promise.all(
        [...urls.values()].map((url) => fetch(`${url}/v1/holder/shards/${orphan}`)),
      );
      assert.ok(gone.some((response) => response.status === 404), "unreferenced shard was never collected");
    }

    for (const placement of planned) {
      const responses = await Promise.all(
        placement.shards.map((shard) =>
          fetch(`${urls.get(shard.holder)!}/v1/holder/shards/${shard.storedAs}`),
        ),
      );
      assert.ok(responses.every((response) => response.status === 200));
    }
  } finally {
    await Promise.all(servers.map(closeServer));
    rmSync(root, { recursive: true, force: true });
  }
});

test("fuzz: erasure digests are stable for identical inputs", () => {
  const random = mulberry32(0x5eed_0007);
  const payload = randomBytesFrom(random, 1024);
  const first = encodeBytes(payload, 3, 2);
  const second = encodeBytes(payload, 3, 2);

  assert.deepEqual(
    first.map((shard) => shard.digest),
    second.map((shard) => shard.digest),
  );
  assert.deepEqual(
    first.map((shard) => Buffer.from(shard.bytes).toString("hex")),
    second.map((shard) => Buffer.from(shard.bytes).toString("hex")),
  );
});

test("fuzz: a random payload never round-trips through k - 1 shards", () => {
  const random = mulberry32(0x5eed_0008);

  for (let round = 0; round < 15; round += 1) {
    const dataShards = 2 + Math.floor(random() * 4);
    const parityShards = Math.floor(random() * 3);
    const payload = randomBytesFrom(random, 128 + Math.floor(random() * 2048));
    const shards = encodeBytes(payload, dataShards, parityShards);

    assert.throws(() => decodeBytes(pick(random, shards, dataShards - 1)));
  }
});

