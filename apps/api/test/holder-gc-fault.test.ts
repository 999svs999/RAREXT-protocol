import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHolderServer } from "../src/holder-server.ts";
import { DurabilityLedger, httpHolder } from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import { BlobStore } from "../src/storage.ts";

function base(server: { address(): unknown }): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Scratch inside the repository, not /tmp. */
function scratch(prefix: string): string {
  const parent = join(process.cwd(), ".data");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function close(server: { closeAllConnections(): void; close(cb: () => void): void }) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function put(url: string, content: Buffer): Promise<string> {
  const response = await fetch(`${url}/v1/holder/shards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.toString("base64") }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { storedAs: string }).storedAs;
}

async function scan(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/v1/holder/gc/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

function stream(url: string, path: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}${path}`, (response) => resolve(response));
    request.on("error", reject);
  });
}

test("GC defers a shard with an in-flight read and the reader sees every byte", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-gc-read-"));
  const server = createHolderServer({ id: "gc-read", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    const payload = Buffer.alloc(4 * 1024 * 1024, 9);
    const hash = await put(url, payload);

    const response = await stream(url, `/v1/holder/shards/${hash}/raw`);
    const iterator = response[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false, "the reader got a first chunk");

    // A GC pass lands while the reader is paused mid-stream.
    const during = await scan(url, { referenced: [], dryRun: false, gracePeriodMs: 0 });
    assert.equal(during.deleted, 0, "a shard being read is not deleted");
    assert.equal(during.deferred, 1);
    assert.deepEqual(during.deferredShards, [hash]);

    // The stream still finishes with the full content.
    let total = (first.value as Buffer).length;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      total += (next.value as Buffer).length;
    }
    assert.equal(total, payload.length, "the reader is not truncated by GC");

    // The server releases its reader after the response flushes, a tick after
    // the client sees EOF.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Once the read is closed the next pass collects the shard.
    const after = await scan(url, { referenced: [], dryRun: false, gracePeriodMs: 0 });
    assert.equal(after.deleted, 1);
    assert.equal((await fetch(`${url}/v1/holder/shards/${hash}`)).status, 404);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC invalidates the leaf cache so a collected shard cannot answer a challenge", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-gc-cache-"));
  const server = createHolderServer({ id: "gc-cache", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    const hash = await put(url, Buffer.from("cache me before collecting"));

    const challenge = () =>
      fetch(`${url}/v1/holder/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storedAs: hash, leafIndex: 0, nonce: "n" }),
      });

    assert.equal((await challenge()).status, 200, "the first challenge caches leaves");

    const collected = await scan(url, { referenced: [], dryRun: false, gracePeriodMs: 0 });
    assert.equal(collected.deleted, 1);

    assert.equal(
      (await challenge()).status,
      404,
      "a cached proof must not outlive the shard it describes",
    );
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crashed write's orphaned temp files are swept on restart and during GC", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-gc-orphan-"));
  const directory = join(root, "holder");
  mkdirSync(directory, { recursive: true });

  const first = createHolderServer({ id: "gc-orphan", directory });
  first.listen(0, "127.0.0.1");
  await once(first, "listening");
  const hash = await put(base(first), Buffer.from("survives the sweep"));
  await close(first);

  // A crash left a partial raw upload, a temp index, and a temp shard copy.
  writeFileSync(join(directory, "_upload.deadbeef.tmp"), Buffer.alloc(1024));
  writeFileSync(join(directory, "_index.json.cafe.tmp"), "{}");
  writeFileSync(join(directory, `${hash}.dead.tmp`), Buffer.alloc(2048));

  const second = createHolderServer({ id: "gc-orphan", directory });
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  const url = base(second);

  try {
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
      "startup sweeps stale temp files",
    );
    assert.equal((await fetch(`${url}/v1/holder/shards/${hash}`)).status, 200, "real shard survives");

    // A temp file that appears while the holder runs is swept by the next pass.
    writeFileSync(join(directory, "_upload.later.tmp"), Buffer.alloc(16));
    const result = await scan(url, { referenced: [hash], dryRun: true, gracePeriodMs: 0 });
    assert.ok(Number(result.purgedTemp) >= 1);
    assert.ok(!readdirSync(directory).includes("_upload.later.tmp"));
  } finally {
    await close(second);
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC protects a live placement's shards and collects only the orphan", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-gc-lease-"));
  const servers = Array.from({ length: 3 }, (_, index) =>
    createHolderServer({ id: `gc-lease-${index}`, directory: join(root, `holder-${index}`) }),
  );

  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const urls = new Map(servers.map((server, index) => [`gc-lease-${index}`, base(server)]));
    const holders = [...urls].map(([id, url]) => httpHolder(id, url));
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(Buffer.from("a live placement payload"), 2, 1),
      holders,
      "durable",
    );

    // An orphan shard lands on one holder without any placement referencing it.
    const [firstId, firstUrl] = [...urls][0]!;
    const orphan = await put(firstUrl, Buffer.from("nobody references me"));

    const results = await ledger.gcWithUrls(urls, { gracePeriodMs: 0, dryRun: false });

    for (const shard of placement.shards) {
      const response = await fetch(`${urls.get(shard.holder)!}/v1/holder/shards/${shard.storedAs}`);
      assert.equal(response.status, 200, `${shard.holder} lost a live shard`);
    }
    assert.equal((await fetch(`${firstUrl}/v1/holder/shards/${orphan}`)).status, 404);
    assert.equal(results.find((entry) => entry.holder === firstId)!.deleted, 1);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent GC passes never double-count or lose a live shard", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-gc-concurrent-"));
  const directory = join(root, "holder");
  const server = createHolderServer({ id: "gc-concurrent", directory });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    const live = await put(url, Buffer.from("live shard"));
    const orphans = [];
    for (let index = 0; index < 6; index += 1) {
      orphans.push(await put(url, Buffer.from(`orphan-${index}`)));
    }

    const [left, right] = await Promise.all([
      scan(url, { referenced: [live], dryRun: false, gracePeriodMs: 0 }),
      scan(url, { referenced: [live], dryRun: false, gracePeriodMs: 0 }),
    ]);

    assert.equal(
      Number(left.deleted) + Number(right.deleted),
      orphans.length,
      "each orphan is deleted exactly once across both passes",
    );
    assert.equal((await fetch(`${url}/v1/holder/shards/${live}`)).status, 200);
    for (const orphan of orphans) {
      assert.equal((await fetch(`${url}/v1/holder/shards/${orphan}`)).status, 404);
    }
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retained blob is protected until its term matures, then collectable", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-gc-retention-"));
  const directory = join(root, "blobs");
  const store = new BlobStore(directory);

  try {
    const future = store.put(Buffer.from("held for a term"), {
      retentionUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(store.remove(future.hash), false, "a live hold cannot be collected");
    assert.equal(store.has(future.hash), true);
    assert.equal(store.retention(future.hash)!.opening, null, "the opening stays sealed");

    const matured = store.put(Buffer.from("the term is over"), {
      retentionUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const term = store.retention(matured.hash)!;
    assert.equal(term.matured, true);
    assert.ok(term.opening, "the opening is released once the term matures");
    assert.equal(store.remove(matured.hash), true, "a matured blob is collectable");
    assert.equal(store.has(matured.hash), false);
    assert.equal(store.retention(matured.hash), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC does not sweep the temp file of an in-flight raw upload", async () => {
  const root = scratch("rarext-gc-upload-");
  const directory = join(root, "holder");
  const server = createHolderServer({ id: "gc-upload", directory });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);
  const payload = Buffer.alloc(2 * 1024 * 1024, 5);
  const hash = createHash("sha256").update(payload).digest("hex");

  const request = http.request(`${url}/v1/holder/shards/${hash}/raw`, {
    method: "PUT",
    headers: {
      "content-length": String(payload.length),
      "content-type": "application/octet-stream",
    },
  });
  const responded = new Promise<http.IncomingMessage>((resolve, reject) => {
    request.on("response", resolve);
    request.on("error", reject);
  });

  try {
    request.write(payload.subarray(0, 256 * 1024));
    await waitFor(() => readdirSync(directory).some((name) => name.startsWith("_upload.")));

    // The upload is mid-stream, so its temp file is a live writer, not a
    // crash leftover. The sweep must leave it for the writer to rename.
    const during = await scan(url, { referenced: [], dryRun: false, gracePeriodMs: 0 });
    assert.equal(during.purgedTemp, 0, "an in-flight upload is not a stale temp");
    assert.ok(
      readdirSync(directory).some((name) => name.startsWith("_upload.")),
      "the upload temp file survives GC",
    );

    request.end(payload.subarray(256 * 1024));
    const response = await responded;
    assert.equal(response.statusCode, 201, "the upload still commits after GC ran");

    const head = await fetch(`${url}/v1/holder/shards/${hash}/raw`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(
      readdirSync(directory).some((name) => name.startsWith("_upload.")),
      false,
      "a committed upload leaves no temp file",
    );
  } finally {
    request.destroy();
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup ignores a 64-hex directory and a misnamed 64-hex file, and GC leaves both", async () => {
  const root = scratch("rarext-gc-orphan-dir-");
  const directory = join(root, "holder");
  const directoryName = "a".repeat(64);
  const misnamed = "b".repeat(64);
  const payload = Buffer.from("a real shard adopted from disk");
  const real = createHash("sha256").update(payload).digest("hex");

  mkdirSync(join(directory, directoryName), { recursive: true });
  writeFileSync(join(directory, directoryName, "README"), "operator data");
  mkdirSync(join(directory, "_upload.dir.tmp"), { recursive: true });
  writeFileSync(join(directory, "_upload.dir.tmp", "keep"), "not a temp file");
  writeFileSync(join(directory, misnamed), "these bytes do not hash to b...");
  writeFileSync(join(directory, real), payload);

  // A crash that leaves a directory under a digest-shaped name must not stop
  // the store from adopting the real shard next to it.
  const server = createHolderServer({ id: "gc-orphan-dir", directory });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    const result = await scan(url, { referenced: [], dryRun: false, gracePeriodMs: 0 });
    assert.equal(result.scanned, 1, "only the hash-verified file is a shard");
    assert.equal(result.deleted, 1);
    assert.equal(
      (await fetch(`${url}/v1/holder/shards/${real}`)).status,
      404,
      "the real orphan is collected",
    );

    assert.ok(existsSync(join(directory, directoryName, "README")));
    assert.equal(
      readdirSync(directory).includes(directoryName),
      true,
      "a digest-shaped directory is ignored, never deleted by GC",
    );
    assert.equal(
      readdirSync(directory).includes(misnamed),
      true,
      "a 64-hex file whose bytes do not match its name is not adopted or deleted",
    );
    assert.ok(
      existsSync(join(directory, "_upload.dir.tmp", "keep")),
      "a directory ending in .tmp is not recursively deleted by the sweep",
    );
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a placement keeps its shards until the ledger forgets it", async () => {
  const root = scratch("rarext-gc-placement-lease-");
  const servers = Array.from({ length: 3 }, (_, index) =>
    createHolderServer({ id: `gc-forget-${index}`, directory: join(root, `holder-${index}`) }),
  );

  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }

    const urls = new Map(servers.map((server, index) => [`gc-forget-${index}`, base(server)]));
    const holders = [...urls].map(([id, url]) => httpHolder(id, url));
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(Buffer.from("a placement with no lease field"), 2, 1),
      holders,
      "durable",
    );

    const first = await ledger.gcWithUrls(urls, { gracePeriodMs: 0, dryRun: false });
    assert.ok(first.every((entry) => entry.error === undefined));
    assert.ok(first.every((entry) => entry.deleted === 0), "a live placement holds every shard");

    // A placement has no expiry timestamp; forgetting it is the release.
    // Retention expiry on the node's blob store does not release these copies.
    assert.equal(ledger.forget(placement.blobHash), true);

    const second = await ledger.gcWithUrls(urls, { gracePeriodMs: 0, dryRun: false });
    assert.equal(
      second.reduce((sum, entry) => sum + entry.deleted, 0),
      placement.shards.length,
      "forgetting the placement makes all of its shards collectable",
    );

    for (const shard of placement.shards) {
      const response = await fetch(`${urls.get(shard.holder)!}/v1/holder/shards/${shard.storedAs}`);
      assert.equal(response.status, 404);
    }
  } finally {
    await Promise.all(servers.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected GC call is reported as an error, not a zero-delete success", async () => {
  const root = scratch("rarext-gc-token-");
  const server = createHolderServer({
    id: "gc-token",
    directory: join(root, "holder"),
    token: "holder-secret",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const ledger = new DurabilityLedger();
    const urls = new Map([["gc-token", base(server)]]);
    const results = await ledger.gcWithUrls(urls, { gracePeriodMs: 0, dryRun: false });

    assert.equal(results.length, 1);
    assert.match(results[0]!.error ?? "", /unauthorized/);
    assert.equal(results[0]!.deleted, undefined);

    const authorized = await ledger.gcWithUrls(urls, {
      gracePeriodMs: 0,
      dryRun: false,
      token: "holder-secret",
    });
    assert.equal(authorized[0]!.error, undefined);
    assert.equal(authorized[0]!.deleted, 0);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});
