import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BlobQuotaError, BlobStore } from "../src/storage.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop } from "./helpers.ts";

test("the API rate limit answers 429 and does not affect other instances", async () => {
  const limited = await start(new RarextStore(), {
    maxRequestsPerWindow: 2,
    rateWindowMs: 60_000,
  });
  const open = await start();

  try {
    assert.equal((await fetch(`${limited.base}/v1/storage/quota`)).status, 200);
    assert.equal((await fetch(`${limited.base}/v1/storage/quota`)).status, 200);
    const blocked = await fetch(`${limited.base}/v1/storage/quota`);
    assert.equal(blocked.status, 429);
    assert.match(((await blocked.json()) as { error: string }).error, /rate limit/);

    assert.equal((await fetch(`${open.base}/v1/storage/quota`)).status, 200);
  } finally {
    await stop(limited.server);
    await stop(open.server);
  }
});

test("an API token guards writes but leaves reads open, and rotates across a list", async () => {
  const app = await start(new RarextStore(), { apiToken: "old-token,new-token" });

  try {
    assert.equal((await fetch(`${app.base}/v1/storage/quota`)).status, 200);

    const anonymous = await fetch(`${app.base}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(`${app.base}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ content: "hello" }),
    });
    assert.equal(wrong.status, 401);

    for (const token of ["old-token", "new-token"]) {
      const accepted = await fetch(`${app.base}/v1/blobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: `hello ${token}` }),
      });
      assert.equal(accepted.status, 201);
    }
  } finally {
    await stop(app.server);
  }
});

test("a blob quota refuses the write that would cross it and reports used bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-quota-"));
  const blobs = new BlobStore(join(root, "blobs"), { maxTotalBytes: 10 });

  try {
    assert.equal(blobs.put(Buffer.from("12345")).size, 5);
    assert.equal(blobs.totalBytes(), 5);

    // Content addressing means a repeat write is free, even at the cap.
    assert.equal(blobs.put(Buffer.from("12345")).size, 5);
    assert.equal(blobs.totalBytes(), 5);

    assert.throws(
      () => blobs.put(Buffer.from("123456")),
      (error: unknown) => error instanceof BlobQuotaError && error.status === 507,
    );
    assert.equal(blobs.totalBytes(), 5, "a refused write does not charge the quota");

    const app = await start(new RarextStore(), { blobs });

    try {
      const over = await fetch(`${app.base}/v1/blobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x".repeat(64) }),
      });
      assert.equal(over.status, 507);
      assert.match(((await over.json()) as { error: string }).error, /quota/);

      const quota = (await (await fetch(`${app.base}/v1/storage/quota`)).json()) as {
        maxTotalBytes: number | null;
        usedBytes: number;
      };
      assert.equal(quota.maxTotalBytes, 10);
      assert.equal(quota.usedBytes, 5);
    } finally {
      await stop(app.server);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unmetered blob store reports no total quota", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-quota-open-"));

  try {
    const blobs = new BlobStore(join(root, "blobs"));
    assert.equal(blobs.maxTotalBytes, null);
    blobs.put(Buffer.from("anything"));
    assert.equal(blobs.totalBytes(), 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
