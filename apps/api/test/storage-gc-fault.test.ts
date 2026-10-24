import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BlobStore, sha256Bytes } from "../src/storage.ts";
import { post, start, stop } from "./helpers.ts";

function tempStore(prefix: string): { store: BlobStore; directory: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const directory = join(root, "blobs");
  return { store: new BlobStore(directory), directory, root };
}

test("blob GC is a dry run by default and never deletes a referenced blob", () => {
  const { store, root } = tempStore("rarext-blob-gc-dry-");

  try {
    const kept = store.put(Buffer.from("kept by a reference"));
    const orphan = store.put(Buffer.from("unreferenced"));

    const preview = store.gc({ referenced: [kept.hash], gracePeriodMs: 0 });

    assert.equal(preview.dryRun, true);
    assert.equal(preview.deleted, 0);
    assert.deepEqual(preview.wouldDelete, [orphan.hash]);
    assert.equal(store.has(orphan.hash), true, "a dry run deletes nothing");

    const applied = store.gc({ referenced: [kept.hash], gracePeriodMs: 0, dryRun: false });

    assert.equal(applied.deleted, 1);
    assert.equal(store.has(kept.hash), true, "a referenced blob survives");
    assert.equal(store.has(orphan.hash), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blob GC respects the grace period before collecting a candidate", () => {
  const { store, root } = tempStore("rarext-blob-gc-grace-");

  try {
    const orphan = store.put(Buffer.from("collect me later"));
    const start = 1_000_000;

    const first = store.gc({ referenced: [], gracePeriodMs: 60_000, now: start, dryRun: false });
    assert.equal(first.deleted, 0);
    assert.equal(first.candidates, 1);
    assert.equal(store.has(orphan.hash), true);

    const early = store.gc({
      referenced: [],
      gracePeriodMs: 60_000,
      now: start + 59_999,
      dryRun: false,
    });
    assert.equal(early.deleted, 0);

    const due = store.gc({
      referenced: [],
      gracePeriodMs: 60_000,
      now: start + 60_000,
      dryRun: false,
    });
    assert.equal(due.deleted, 1);
    assert.equal(store.has(orphan.hash), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blob GC holds a blob whose retention term has not matured", () => {
  const { store, root } = tempStore("rarext-blob-gc-retention-");

  try {
    const now = Date.parse("2026-10-24T00:00:00.000Z");
    const held = store.put(Buffer.from("still committed"), {
      retentionUntil: new Date(now + 60_000).toISOString(),
    });
    const expired = store.put(Buffer.from("commitment over"), {
      retentionUntil: new Date(now - 60_000).toISOString(),
    });

    const pass = store.gc({ referenced: [], gracePeriodMs: 0, now, dryRun: false });

    assert.equal(pass.held, 1);
    assert.deepEqual(pass.wouldDelete, [expired.hash]);
    assert.equal(store.has(held.hash), true, "a live retention term protects the blob");
    assert.equal(store.has(expired.hash), false);

    const later = store.gc({
      referenced: [],
      gracePeriodMs: 0,
      now: now + 60_000,
      dryRun: false,
    });
    assert.equal(later.deleted, 1);
    assert.equal(store.has(held.hash), false, "the blob is collectable once its term matures");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blob GC sweeps interrupted-write temp files and leaves real files alone", () => {
  const { store, root, directory } = tempStore("rarext-blob-gc-temp-");

  try {
    const { hash } = store.put(Buffer.from("a real blob"));
    writeFileSync(join(directory, `_index.json.abc.tmp`), "{}");
    writeFileSync(join(directory, `${hash}.dead.tmp`), Buffer.alloc(32));

    const pass = store.gc({ referenced: [hash], gracePeriodMs: 0, dryRun: false });

    assert.ok(pass.purgedTemp >= 2);
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );
    assert.equal(store.has(hash), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two blob GC passes from one process collect each orphan exactly once", () => {
  const { store, root } = tempStore("rarext-blob-gc-concurrent-");

  try {
    const kept = store.put(Buffer.from("kept"));
    const orphans = Array.from({ length: 5 }, (_, index) =>
      store.put(Buffer.from(`orphan-${index}`)),
    );

    const first = store.gc({ referenced: [kept.hash], gracePeriodMs: 0, dryRun: false });
    const second = store.gc({ referenced: [kept.hash], gracePeriodMs: 0, dryRun: false });

    assert.equal(first.deleted + second.deleted, orphans.length);
    assert.equal(store.has(kept.hash), true);
    for (const orphan of orphans) assert.equal(store.has(orphan.hash), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the storage GC endpoint requires an explicit referenced list", async () => {
  const { store, root } = tempStore("rarext-blob-gc-http-");
  const { server, base } = await start(undefined, { blobs: store });

  try {
    const kept = store.put(Buffer.from("kept by the endpoint"));
    const orphan = store.put(Buffer.from("endpoint orphan"));

    const missing = await post(base, "/v1/storage/gc", {});
    assert.equal(missing.status, 400);

    const preview = await post(base, "/v1/storage/gc", {
      referenced: [kept.hash],
      gracePeriodMs: 0,
    });
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as { dryRun: boolean; wouldDelete: string[] };
    assert.equal(previewBody.dryRun, true);
    assert.deepEqual(previewBody.wouldDelete, [orphan.hash]);

    const applied = await post(base, "/v1/storage/gc", {
      referenced: [kept.hash],
      gracePeriodMs: 0,
      dryRun: false,
    });
    assert.equal(((await applied.json()) as { deleted: number }).deleted, 1);
    assert.equal(store.has(kept.hash), true);
    assert.equal(store.has(orphan.hash), false);
  } finally {
    await stop(server);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Scratch inside the repository, not /tmp. */
function scratch(prefix: string): string {
  const parent = join(process.cwd(), ".data");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

test("an unparseable retention timestamp fails closed", () => {
  const root = scratch("rarext-blob-gc-bad-retention-");
  const store = new BlobStore(join(root, "blobs"));

  try {
    const held = store.put(Buffer.from("a corrupt commitment must not release"), {
      retentionUntil: "not-a-timestamp",
    });
    const empty = store.put(Buffer.from("an empty term is not an absent term"), {
      retentionUntil: "",
    });

    assert.equal(store.remove(held.hash), false, "remove refuses an unparseable term");
    assert.equal(store.retention(held.hash)!.matured, false);
    assert.equal(store.retention(held.hash)!.opening, null, "the opening stays sealed");
    assert.equal(store.remove(empty.hash), false, "remove refuses an empty term");

    const pass = store.gc({ referenced: [], gracePeriodMs: 0, dryRun: false });

    assert.equal(pass.held, 2, "corrupt and empty terms are treated as still live");
    assert.equal(pass.deleted, 0);
    assert.deepEqual(pass.wouldDelete, []);
    assert.equal(store.has(held.hash), true);
    assert.equal(store.has(empty.hash), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reload hashes large blobs in bounded chunks and ignores non-file 64-hex entries", () => {
  const root = scratch("rarext-blob-reload-");
  const directory = join(root, "blobs");
  const payload = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  const hash = sha256Bytes(payload);
  const directoryName = "d".repeat(64);

  mkdirSync(join(directory, directoryName), { recursive: true });
  writeFileSync(join(directory, directoryName, "keep"), "operator data");
  writeFileSync(join(directory, hash), payload);

  const store = new BlobStore(directory);

  try {
    assert.equal(store.has(hash), true, "a multi-megabyte blob is adopted across read chunks");
    assert.equal(store.totalBytes(), payload.length);

    const pass = store.gc({ referenced: [hash], gracePeriodMs: 0, dryRun: false });
    assert.equal(pass.scanned, 1);
    assert.ok(existsSync(join(directory, directoryName, "keep")), "GC does not touch directories");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
