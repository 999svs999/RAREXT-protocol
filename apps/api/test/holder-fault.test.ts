import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHolderServer } from "../src/holder-server.ts";
import { httpHolder } from "../src/durability.ts";

function base(server: { address(): unknown }): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: { closeAllConnections(): void; close(cb: () => void): void }) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function putShard(
  url: string,
  content: string,
): Promise<{ hash: string; status: number }> {
  const response = await fetch(`${url}/v1/holder/shards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: Buffer.from(content).toString("base64") }),
  });
  const data = (await response.json()) as { storedAs?: string; error?: string };
  return { hash: data.storedAs ?? "", status: response.status };
}

test("a shard write that fails on I/O is a 5xx, not a 400", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-fault-ro-"));
  const dir = join(root, "holder");
  const server = createHolderServer({ id: "holder-ro", directory: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    assert.equal((await putShard(url, "writable first")).status, 201);

    // The holder's directory becomes read-only; a new shard cannot land.
    chmodSync(dir, 0o500);
    try {
      const denied = await putShard(url, "read only write");
      assert.ok(
        denied.status >= 500,
        `a read-only write must be a 5xx (got ${denied.status})`,
      );
    } finally {
      chmodSync(dir, 0o700);
    }

    // A subsequent write works again, proving the failure was not a client error.
    assert.equal((await putShard(url, "writable again")).status, 201);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a per-holder byte quota is enforced on both write paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-fault-quota-"));
  const dir = join(root, "holder");
  const server = createHolderServer({ id: "holder-quota", directory: dir, maxBytes: 8 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    assert.equal((await putShard(url, "12345678")).status, 201, "a shard at the quota fits");

    const over = await putShard(url, "123456789");
    assert.equal(over.status, 507, "a shard past the quota is refused");

    // The raw upload path enforces the same quota before any bytes are stored.
    // The name must be a valid 64-char digest to pass the shape check; the
    // content-length breach is what the quota rejects.
    const validName = createHash("sha256").update(Buffer.alloc(8)).digest("hex");
    const rawOver = await fetch(`${url}/v1/holder/shards/${validName}/raw`, {
      method: "PUT",
      headers: { "content-length": "8", "content-type": "application/octet-stream" },
      body: Buffer.alloc(8),
    });
    assert.equal(rawOver.status, 507, "the raw path refuses the quota breach too");
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a request naming a shard the holder does not have is a clean 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-fault-ghost-"));
  const server = createHolderServer({ id: "holder-ghost", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);
  const ghost = "ab".repeat(32);

  try {
    assert.equal((await fetch(`${url}/v1/holder/shards/${ghost}`)).status, 404);
    assert.equal((await fetch(`${url}/v1/holder/shards/${ghost}`, { method: "HEAD" })).status, 404);
    assert.equal(
      (
        await fetch(`${url}/v1/holder/shards/${ghost}/raw`, { method: "HEAD" })
      ).status,
      404,
    );
    // A challenge for a shard the holder never held is a 404, not an error.
    const challenge = await fetch(`${url}/v1/holder/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storedAs: ghost, leafIndex: 0, nonce: "n" }),
    });
    assert.equal(challenge.status, 404, JSON.stringify(await challenge.json()));
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a challenge answered after the shard was GC'd is an unknown-shard 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-fault-gc-"));
  const dir = join(root, "holder");
  const server = createHolderServer({ id: "holder-gc", directory: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    const stored = await putShard(url, "gc me now");
    assert.equal(stored.status, 201);

    // The retention window closes: the operator scans and deletes the shard.
    const scan = await fetch(`${url}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [], dryRun: false, gracePeriodMs: 0 }),
    });
    assert.equal((await scan.json() as { deleted: number }).deleted, 1);

    // A challenge that arrives after the window now finds no shard.
    const late = await fetch(`${url}/v1/holder/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storedAs: stored.hash, leafIndex: 0, nonce: "late" }),
    });
    assert.equal(late.status, 404);
    assert.match(JSON.stringify(await late.json()), /unknown shard/);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a challenge over a corrupted on-disk shard refuses to prove the bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-fault-corrupt-"));
  const dir = join(root, "holder");
  const server = createHolderServer({ id: "holder-corrupt", directory: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = base(server);

  try {
    const payload = Buffer.from("the shard bytes that a challenge must prove");
    const storedAs = createHash("sha256").update(payload).digest("hex");
    assert.equal((await putShard(url, payload.toString("utf8"))).status, 201);

    // The bytes on disk are corrupted or truncated after the fact. The holder
    // must not serve a Merkle proof over the wrong bytes: the challenge and
    // the leaf read both fall back to the unknown-shard path.
    writeFileSync(join(dir, storedAs), Buffer.from("corrupted bytes"));

    const challenge = await fetch(`${url}/v1/holder/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storedAs, leafIndex: 0, nonce: "n" }),
    });
    assert.equal(challenge.status, 404, "a corrupted shard cannot answer a challenge");

    const get = await fetch(`${url}/v1/holder/shards/${storedAs}`);
    assert.equal(get.status, 404, "a corrupted shard is not served by name");
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a holder restart mid-challenge still serves its shards and a dead holder errors cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-fault-restart-"));
  const dir = join(root, "holder");

  const first = createHolderServer({ id: "holder-restart", directory: dir });
  first.listen(0, "127.0.0.1");
  await once(first, "listening");
  const url = base(first);
  const stored = await putShard(url, "survives a restart");
  assert.equal(stored.status, 201);

  // The holder process dies and comes back up on a fresh socket. Its shard
  // bytes reload from disk, so a challenge still answers.
  await close(first);

  const second = createHolderServer({ id: "holder-restart", directory: dir });
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  const url2 = base(second);
  const restarted = await fetch(`${url2}/v1/holder/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storedAs: stored.hash, leafIndex: 0, nonce: "after-restart" }),
  });
  assert.equal(restarted.status, 200, "shards reload from disk after a restart");

  await close(second);

  // A holder that is not running at all surfaces a clean error to the client
  // instead of hanging the challenge loop.
  const deadHolder = httpHolder("holder-restart", `http://127.0.0.1:1`);
  await assert.rejects(
    () => deadHolder.has(stored.hash),
    /fetch failed|ECONNREFUSED|socket|timed out|connect/i,
  );

  rmSync(root, { recursive: true, force: true });
});
