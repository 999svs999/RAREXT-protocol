import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHolderServer } from "../src/holder-server.ts";

async function close(server: { closeAllConnections(): void; close(cb: () => void): void }) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Scratch inside the repository, not /tmp. */
function scratch(prefix: string): string {
  const parent = join(process.cwd(), ".data");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

async function putShard(base: string, content: string, token?: string): Promise<{ hash: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const resp = await fetch(`${base}/v1/holder/shards`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: Buffer.from(content).toString("base64") }),
  });
  const data = await resp.json() as { storedAs: string };
  return { hash: data.storedAs };
}

test("holder GC dry-run identifies unreferenced shards", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-gc-"));
  const server = createHolderServer({ id: "holder-gc", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Put three shards via holder API
    const shard1 = await putShard(base, "shard one content");
    const shard2 = await putShard(base, "shard two content");
    const shard3 = await putShard(base, "shard three content");

    // Dry-run with only shard1 referenced - should mark shard2, shard3 as candidates
    const scan1 = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [shard1.hash], dryRun: true, gracePeriodMs: 0 }),
    });
    const result1 = await scan1.json() as { wouldDelete: string[]; candidates: number; scanned: number };
    assert.equal(scan1.status, 200);
    assert.equal(result1.scanned, 3);
    assert.deepEqual(result1.wouldDelete.sort(), [shard2.hash, shard3.hash].sort());
    assert.equal(result1.candidates, 2);

    // Dry-run again with grace period - still candidates
    const scan2 = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [shard1.hash], dryRun: true, gracePeriodMs: 0 }),
    });
    const result2 = await scan2.json() as { wouldDelete: string[] };
    assert.deepEqual(result2.wouldDelete.sort(), [shard2.hash, shard3.hash].sort());

    // Now execute with grace period 0 - should delete
    const scan3 = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [shard1.hash], dryRun: false, gracePeriodMs: 0 }),
    });
    const result3 = await scan3.json() as { deleted: number; wouldDelete: string[] };
    assert.equal(result3.deleted, 2);
    assert.deepEqual(result3.wouldDelete.sort(), [shard2.hash, shard3.hash].sort());

    // Shards 2 and 3 should be gone
    const get2 = await fetch(`${base}/v1/holder/shards/${shard2.hash}`);
    assert.equal(get2.status, 404);
    const get3 = await fetch(`${base}/v1/holder/shards/${shard3.hash}`);
    assert.equal(get3.status, 404);
    const get1 = await fetch(`${base}/v1/holder/shards/${shard1.hash}`);
    assert.equal(get1.status, 200);

    // Candidates list should be empty now
    const candidates = await fetch(`${base}/v1/holder/gc/candidates`).then(r => r.json()) as { candidates: { storedAs: string }[] };
    assert.equal(candidates.candidates.length, 0);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("holder GC respects grace period", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-gc-grace-"));
  const server = createHolderServer({ id: "holder-gc-grace", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const shard = await putShard(base, "shard to be gc'd");

    // First scan with grace period 1 hour - should create candidate but not delete
    const scan1 = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [], dryRun: false, gracePeriodMs: 3600_000 }),
    });
    const result1 = await scan1.json() as { deleted: number; candidates: number; scanned: number };
    assert.equal(scan1.status, 200);
    assert.equal(result1.scanned, 1);
    assert.equal(result1.deleted, 0);
    assert.equal(result1.candidates, 1);

    // Immediate second scan with grace period 0 - should delete now
    const scan2 = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [], dryRun: false, gracePeriodMs: 0 }),
    });
    const result2 = await scan2.json() as { deleted: number };
    assert.equal(result2.deleted, 1);

    // Shard should be gone
    const get = await fetch(`${base}/v1/holder/shards/${shard.hash}`);
    assert.equal(get.status, 404);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("holder GC reset clears candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-gc-reset-"));
  const server = createHolderServer({ id: "holder-gc-reset", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const shard = await putShard(base, "shard");

    // Create candidate (with grace period so shard isn't deleted immediately)
    await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [], dryRun: false, gracePeriodMs: 3600_000 }),
    });

    // Reset
    const reset = await fetch(`${base}/v1/holder/gc/reset`, { method: "POST" });
    assert.equal(reset.status, 200);

    // Shard should still exist (reset only clears candidates, doesn't delete)
    const get = await fetch(`${base}/v1/holder/shards/${shard.hash}`);
    assert.equal(get.status, 200);

    // Candidates list empty
    const candidates = await fetch(`${base}/v1/holder/gc/candidates`).then(r => r.json()) as { candidates: unknown[] };
    assert.equal(candidates.candidates.length, 0);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("holder GC requires auth when token configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-gc-auth-"));
  const server = createHolderServer({
    id: "holder-gc-auth",
    directory: join(root, "holder"),
    token: "secret-token",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Without token
    const noAuth = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [] }),
    });
    assert.equal(noAuth.status, 401);

    // With wrong token
    const wrongAuth = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ referenced: [] }),
    });
    assert.equal(wrongAuth.status, 401);

    // With correct token
    const ok = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ referenced: [] }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a referenced shard's grace candidate is cleared and the shard survives", async () => {
  const root = scratch("rarext-holder-gc-lease-");
  const server = createHolderServer({ id: "holder-gc-lease", directory: join(root, "holder") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const shard = await putShard(base, "a shard with a live placement");

    // The first pass, with no reference, starts the grace clock.
    const first = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [], dryRun: false, gracePeriodMs: 3_600_000 }),
    }).then((response) => response.json()) as { candidates: number; deleted: number };
    assert.equal(first.deleted, 0);
    assert.equal(first.candidates, 1);

    // The placement appears: the shard is referenced, so the candidate entry
    // must be cleared and the destructive pass must keep the bytes.
    const held = await fetch(`${base}/v1/holder/gc/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [shard.hash], dryRun: false, gracePeriodMs: 0 }),
    }).then((response) => response.json()) as { candidates: number; deleted: number };
    assert.equal(held.deleted, 0);
    assert.equal(held.candidates, 0, "a referenced shard is not left as a grace candidate");

    const candidates = await fetch(`${base}/v1/holder/gc/candidates`)
      .then((response) => response.json()) as { candidates: unknown[] };
    assert.equal(candidates.candidates.length, 0);
    assert.equal((await fetch(`${base}/v1/holder/shards/${shard.hash}`)).status, 200);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});
