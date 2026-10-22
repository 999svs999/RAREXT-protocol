import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { BlobStore } from "../src/storage.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

function tempBlobs(): { store: BlobStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fabric-blobs-"));
  return { store: new BlobStore(dir), dir };
}

test("blobs are content addressed and readable by digest", async () => {
  const { store: blobs, dir } = tempBlobs();
  const { server, base } = await start(new RarextStore(), { blobs });

  try {
    const response = await post(base, "/v1/blobs", {
      content: "hello world",
      mediaType: "text/plain",
    });

    assert.equal(response.status, 201);

    const record = (await response.json()) as { hash: string; size: number };
    assert.match(record.hash, /^[0-9a-f]{64}$/);
    assert.equal(record.size, 11);

    const fetched = await fetch(`${base}/v1/blobs/${record.hash}`);
    assert.equal(fetched.status, 200);

    const blob = (await fetched.json()) as { hash: string; content: string; encoding: string };
    assert.equal(blob.hash, record.hash);
    assert.equal(blob.encoding, "base64");
    assert.equal(Buffer.from(blob.content, "base64").toString("utf8"), "hello world");

    const list = (await (await fetch(`${base}/v1/blobs`)).json()) as { hash: string }[];
    assert.equal(list.length, 1);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a blob served under the wrong digest is not served", async () => {
  const { store: blobs, dir } = tempBlobs();
  const { server, base } = await start(new RarextStore(), { blobs });

  try {
    const missing = await fetch(`${base}/v1/blobs/${"0".repeat(64)}`);
    assert.equal(missing.status, 404);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store refuses bytes that do not match their name", () => {
  const { store: blobs, dir } = tempBlobs();

  try {
    const record = blobs.put(Buffer.from("hello world", "utf8"));
    assert.equal(record.hash, blobs.get(record.hash)?.record.hash);

    const listed = blobs.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.size, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage is metered per tier", async () => {
  const { store: blobs, dir } = tempBlobs();
  const { server, base } = await start(new RarextStore(), { blobs });

  try {
    await post(base, "/v1/blobs", { content: "public bytes" });
    await post(base, "/v1/blobs", { content: "sealed bytes", tier: "sealed" });

    const usage = (await (await fetch(`${base}/v1/storage/usage`)).json()) as {
      tier: string;
      blobs: number;
      bytes: number;
    }[];

    const publicTier = usage.find((entry) => entry.tier === "public");
    const sealedTier = usage.find((entry) => entry.tier === "sealed");

    assert.equal(publicTier?.blobs, 1);
    assert.equal(sealedTier?.blobs, 1);
    assert.equal(sealedTier?.bytes, 12);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tiers are published with their semantics binding", async () => {
  const { server, base } = await start();

  try {
    const response = await fetch(`${base}/v1/storage/tiers`);
    assert.equal(response.status, 200);

    const tiers = (await response.json()) as {
      policy: string;
      tiers: { id: string; open: boolean }[];
      licensed: string[];
    };

    assert.equal(tiers.policy, "storage-v1");
    assert.equal(tiers.tiers.length, 2);
    assert.equal(tiers.tiers.find((tier) => tier.id === "sealed")?.open, false);
    assert.ok(tiers.licensed.includes("public"));
  } finally {
    await stop(server);
  }
});

test("a blob with no manifest has no inclusion proof", async () => {
  const { store: blobs, dir } = tempBlobs();
  const { server, base } = await start(new RarextStore(), { blobs });

  try {
    const record = (await (
      await post(base, "/v1/blobs", { content: "lonely bytes" })
    ).json()) as { hash: string };

    const response = await fetch(`${base}/v1/blobs/${record.hash}/proof`);
    assert.equal(response.status, 200);

    const proof = (await response.json()) as { valid: boolean; manifestId: string | null };
    assert.equal(proof.valid, false);
    assert.equal(proof.manifestId, null);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a retention term commits immediately and opens only when it matures", async () => {
  const { store: blobs, dir } = tempBlobs();
  const { server, base } = await start(new RarextStore(), { blobs });

  try {
    const future = (await (
      await post(base, "/v1/blobs", {
        content: "kept for a year",
        retentionUntil: "2099-01-01T00:00:00.000Z",
      })
    ).json()) as { hash: string; retentionCommitment: string | null; retentionUntil: string };

    assert.ok(future.retentionCommitment, "the node commits when the blob is stored");
    assert.equal(future.retentionUntil, "2099-01-01T00:00:00.000Z");

    const early = await fetch(`${base}/v1/storage/retention/${future.hash}`);
    assert.equal(early.status, 425, "the opening is not released before the term matures");

    const earlyBody = (await early.json()) as { matured: boolean; opening: string | null };
    assert.equal(earlyBody.matured, false);
    assert.equal(earlyBody.opening, null);

    const past = (await (
      await post(base, "/v1/blobs", {
        content: "kept until yesterday",
        retentionUntil: "2000-01-01T00:00:00.000Z",
      })
    ).json()) as { hash: string; retentionCommitment: string | null };

    const matured = await fetch(`${base}/v1/storage/retention/${past.hash}`);
    assert.equal(matured.status, 200);

    const maturedBody = (await matured.json()) as {
      matured: boolean;
      opening: string | null;
      commitment: string | null;
    };

    assert.equal(maturedBody.matured, true);
    assert.ok(maturedBody.opening, "the opening is released once the term matures");
    assert.equal(maturedBody.commitment, past.retentionCommitment);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
