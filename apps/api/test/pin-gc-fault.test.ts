import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cidV1Raw } from "../src/adapters/content.ts";
import { createPinServer, PinStore } from "../src/pin-server.ts";

function temporaryStore(prefix = "rarext-pin-gc-"): { root: string; store: PinStore; directory: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const directory = join(root, "pins");
  return { root, store: new PinStore(directory), directory };
}

function pin(store: PinStore, content: string, publicationIds: string[] = []) {
  const bytes = Buffer.from(content);
  const cid = cidV1Raw(bytes);
  store.put({ cid, content: bytes, publicationIds });
  return cid;
}

test("pin GC sweeps content-only, metadata-only, and temp orphans", () => {
  const { root, store, directory } = temporaryStore();

  try {
    const contentOnly = cidV1Raw(Buffer.from("crashed before metadata"));
    writeFileSync(join(directory, `${contentOnly}.bin`), "content");
    const metadataOnly = cidV1Raw(Buffer.from("lost content"));
    writeFileSync(join(directory, `${metadataOnly}.json`), "{}");
    writeFileSync(join(directory, "_upload.tmp"), "partial");

    const scan = store.gc({ gracePeriodMs: 0, dryRun: true });
    assert.equal(scan.orphanContent, 1);
    assert.equal(scan.orphanMetadata, 1);
    assert.equal(scan.deleted, 0, "the default is a dry run");
    assert.ok(scan.purgedTemp >= 1, "temp files are swept even in a dry run");

    const applied = store.gc({ gracePeriodMs: 0, dryRun: false });
    assert.equal(applied.orphanContent, 1);
    assert.equal(applied.orphanMetadata, 1);
    assert.equal(store.has(contentOnly), false);
    assert.equal(store.has(metadataOnly), false);
    assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin GC collects an unreferenced pin only after the grace period", () => {
  const { root, store } = temporaryStore();

  try {
    const pinned = pin(store, "nobody references me");
    const start = 2_000_000;

    const first = store.gc({ referenced: [], gracePeriodMs: 60_000, now: start, dryRun: false });
    assert.equal(first.deleted, 0);
    assert.equal(first.candidates, 1);
    assert.equal(store.has(pinned), true);

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
    assert.equal(store.has(pinned), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin GC never collects a referenced pin or a live publication hold", () => {
  const { root, store } = temporaryStore();

  try {
    const referenced = pin(store, "referenced by the caller");
    const held = pin(store, "held by a publication", ["pub-1"]);

    const pass = store.gc({
      referenced: [referenced],
      gracePeriodMs: 0,
      dryRun: false,
    });

    assert.equal(pass.held, 1);
    assert.equal(pass.deleted, 0);
    assert.equal(store.has(referenced), true);
    assert.equal(store.has(held), true, "a pin with publicationIds is a live hold");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin GC treats a corrupt content/metadata pair as an orphan", () => {
  const { root, store, directory } = temporaryStore();

  try {
    const cid = pin(store, "honest content");
    writeFileSync(join(directory, `${cid}.bin`), "tampered content");

    const pass = store.gc({ gracePeriodMs: 0, dryRun: false });

    assert.equal(pass.orphanMetadata, 1);
    assert.equal(pass.deleted, 1);
    assert.equal(store.has(cid), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two pin GC passes collect each orphan exactly once", () => {
  const { root, store } = temporaryStore();

  try {
    const kept = pin(store, "kept");
    const orphans = Array.from({ length: 4 }, (_, index) => pin(store, `orphan-${index}`));

    const first = store.gc({ referenced: [kept], gracePeriodMs: 0, dryRun: false });
    const second = store.gc({ referenced: [kept], gracePeriodMs: 0, dryRun: false });

    assert.equal(first.deleted + second.deleted, orphans.length);
    assert.equal(store.has(kept), true);
    for (const orphan of orphans) assert.equal(store.has(orphan), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pin GC endpoint defaults to a dry run and validates referenced", async () => {
  const { root, store } = temporaryStore("rarext-pin-gc-http-");
  const server = createPinServer(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const orphan = pin(store, "endpoint orphan");

    const invalid = await fetch(`${base}/v1/pins/gc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: ["not-a-cid"] }),
    });
    assert.equal(invalid.status, 400);

    const preview = await fetch(`${base}/v1/pins/gc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [], gracePeriodMs: 0 }),
    });
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as { dryRun: boolean; wouldDelete: string[] };
    assert.equal(previewBody.dryRun, true);
    assert.deepEqual(previewBody.wouldDelete, [orphan]);
    assert.equal(store.has(orphan), true);

    const applied = await fetch(`${base}/v1/pins/gc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ referenced: [], gracePeriodMs: 0, dryRun: false }),
    });
    assert.equal(((await applied.json()) as { deleted: number }).deleted, 1);
    assert.equal(store.has(orphan), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
