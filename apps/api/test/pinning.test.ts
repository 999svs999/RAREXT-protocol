import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cidV1Raw, ContentPinAdapter } from "../src/adapters/content.ts";
import { createPinServer, PinStore } from "../src/pin-server.ts";

function temporaryStore(): { root: string; store: PinStore } {
  const root = mkdtempSync(join(tmpdir(), "rarext-pins-"));
  return { root, store: new PinStore(join(root, "pins")) };
}

test("the pin store checks the CID and survives a restart", () => {
  const { root, store } = temporaryStore();
  const content = Buffer.from("a pinned bundle", "utf8");
  const cid = cidV1Raw(content);

  try {
    const record = store.put({
      cid,
      content,
      root: "a".repeat(64),
      publicationIds: ["pub-1"],
    });

    assert.equal(record.cid, cid);
    assert.equal(record.bytes, content.length);
    assert.deepEqual(record.publicationIds, ["pub-1"]);

    const reopened = new PinStore(join(root, "pins"));
    assert.deepEqual(reopened.get(cid), record);
    assert.deepEqual(Buffer.from(reopened.content(cid)!), content);
    assert.equal(reopened.list().length, 1);

    assert.equal(reopened.remove(cid), true);
    assert.equal(reopened.remove(cid), false);
    assert.equal(reopened.get(cid), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pin store refuses a mismatched CID and path-like names", () => {
  const { root, store } = temporaryStore();

  try {
    const content = Buffer.from("honest bytes", "utf8");
    const wrong = cidV1Raw(Buffer.from("other bytes", "utf8"));

    assert.throws(() => store.put({ cid: wrong, content }), /does not match/);
    assert.throws(() => store.get("../../etc/passwd"), /CIDv1/);
    assert.throws(() => store.put({ cid: "babc", content }), /CIDv1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pinning HTTP service pins, reads, lists, and unpins a bundle", async () => {
  const { root, store } = temporaryStore();
  const server = createPinServer(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const content = Buffer.from('{"root":"abc","publicationIds":["pub-1"]}', "utf8");
    const cid = cidV1Raw(content);
    const response = await fetch(`${base}/v1/pins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cid,
        content: content.toString("base64"),
        root: "a".repeat(64),
        publicationIds: ["pub-1"],
      }),
    });

    assert.equal(response.status, 201);
    const pinned = (await response.json()) as { reference: string; cid: string };
    assert.equal(pinned.cid, cid);
    assert.equal(pinned.reference, `pin:${cid}`);

    const read = await fetch(`${base}/v1/pins/${cid}`);
    const record = (await read.json()) as { content: string; publicationIds: string[] };
    assert.equal(read.status, 200);
    assert.deepEqual(Buffer.from(record.content, "base64"), content);
    assert.deepEqual(record.publicationIds, ["pub-1"]);

    const listed = (await (await fetch(`${base}/v1/pins`)).json()) as { cid: string }[];
    assert.deepEqual(listed.map((entry) => entry.cid), [cid]);

    assert.equal((await fetch(`${base}/v1/pins/${cid}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/v1/pins/${cid}`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the content adapter pins through the service and the bytes round-trip", async () => {
  const { root, store } = temporaryStore();
  const server = createPinServer(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const adapter = new ContentPinAdapter({ serviceUrl: `${base}/v1/pins` });
    const receipt = await adapter.anchor("d".repeat(64), ["pub-2"]);
    const cid = receipt.reference!.replace(/^pin:/, "");
    const record = store.get(cid);

    assert.equal(receipt.status, "ok");
    assert.equal(receipt.reference, `pin:${cid}`);
    assert.ok(record);
    assert.deepEqual(
      JSON.parse(Buffer.from(store.content(cid)!).toString("utf8")),
      { root: "d".repeat(64), publicationIds: ["pub-2"] },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the service rejects a CID that does not match the sent bytes", async () => {
  const { root, store } = temporaryStore();
  const server = createPinServer(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/pins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cid: cidV1Raw(Buffer.from("claimed")),
        content: Buffer.from("different").toString("base64"),
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(store.list().length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
