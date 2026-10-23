import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentKeyfile,
  writeAgentKeyfile,
} from "../../../packages/agent-sdk/src/index.ts";
import { createHolderServer } from "../src/holder-server.ts";
import { BlobStore } from "../src/storage.ts";
import { PlacementRegistry } from "../src/placements.ts";
import { DurabilityLedger, httpHolder } from "../src/durability.ts";
import { createPinServer, PinStore } from "../src/pin-server.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop } from "./helpers.ts";
import {
  storageAudit,
  storageChallenge,
  storageGet,
  storagePin,
  storagePut,
} from "../../mcp/src/storage.ts";

async function close(server: { closeAllConnections(): void; close(cb: () => void): void }) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("MCP storage verbs put, get, challenge, audit, and pin through the network", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-mcp-storage-"));
  const keys = ["RAREXT_STORAGE_HOLDERS", "RAREXT_HOLDERS", "RAREXT_API", "RAREXT_AGENT_KEY", "RAREXT_PIN_URL", "RAREXT_HOLDER_TOKEN", "RAREXT_PIN_TOKEN"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const holderServers = Array.from({ length: 3 }, (_, index) =>
    createHolderServer({ id: `holder-${index}`, directory: join(root, `holder-${index}`) }),
  );

  for (const server of holderServers) {
    server.listen(0, "127.0.0.1");
  }

  await Promise.all(holderServers.map((server) => once(server, "listening")));

  const holderUrls = holderServers.map(
    (server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  const holders = holderUrls.map((url, index) => httpHolder(`holder-${index}`, url));
  const pinStore = new PinStore(join(root, "pins"));
  const pinServer = createPinServer(pinStore);
  pinServer.listen(0, "127.0.0.1");
  await once(pinServer, "listening");
  const { server, base } = await start(new RarextStore(), {
    blobs: new BlobStore(join(root, "blobs")),
    placements: new PlacementRegistry(join(root, "placements")),
    durability: new DurabilityLedger(),
    holders,
  });
  const keyPath = join(root, "agent-key.json");

  await writeAgentKeyfile(createAgentKeyfile("storage-agent"), keyPath);
  process.env.RAREXT_STORAGE_HOLDERS = holderUrls
    .map((url, index) => `holder-${index}=${url}`)
    .join(",");
  process.env.RAREXT_API = base;
  process.env.RAREXT_AGENT_KEY = keyPath;
  process.env.RAREXT_PIN_URL = `http://127.0.0.1:${(pinServer.address() as AddressInfo).port}/v1/pins`;

  try {
    const content = Buffer.from("an agent stores this across three holders");
    const put = (await storagePut({
      content: content.toString("base64"),
      dataShards: 2,
      parityShards: 1,
    })) as {
      blobHash: string;
      registration: { recorded: boolean };
      placement: { record: { placement: { shards: unknown[] } } };
    };

    assert.equal(put.registration.recorded, true);
    assert.equal(put.placement.record.placement.shards.length, 3);

    const loaded = (await storageGet({ blobHash: put.blobHash })) as {
      content: string;
      shardsRead: number;
    };

    assert.equal(loaded.shardsRead, 2);
    assert.deepEqual(Buffer.from(loaded.content, "base64"), content);

    const challenged = (await storageChallenge({ blobHash: put.blobHash })) as {
      audit: { status: string; live: number };
    };

    assert.equal(challenged.audit.status, "ok");
    assert.equal(challenged.audit.live, 3);

    const audited = (await storageAudit({ blobHash: put.blobHash })) as {
      audit: { status: string };
    };

    assert.equal(audited.audit.status, "ok");

    const pinned = (await storagePin({
      content: content.toString("base64"),
      root: "a".repeat(64),
      publicationIds: ["pub-agent"],
    })) as { cid: string; reference: string };

    assert.equal(pinned.reference, `pin:${pinned.cid}`);
    assert.equal(pinStore.has(pinned.cid), true);
  } finally {
    await stop(server);
    await close(pinServer);
    await Promise.all(holderServers.map(close));

    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP storage verbs reject the injected failure modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-mcp-storage-fault-"));
  const keys = ["RAREXT_STORAGE_HOLDERS", "RAREXT_HOLDERS", "RAREXT_API", "RAREXT_AGENT_KEY", "RAREXT_PIN_URL", "RAREXT_HOLDER_TOKEN", "RAREXT_PIN_TOKEN"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const holderToken = "mcp-fault-holder-token";
  const pinToken = "mcp-fault-pin-token";
  const holderServers = Array.from({ length: 3 }, (_, index) =>
    createHolderServer({ id: `holder-${index}`, directory: join(root, `holder-${index}`), token: holderToken }),
  );

  for (const server of holderServers) {
    server.listen(0, "127.0.0.1");
  }

  await Promise.all(holderServers.map((server) => once(server, "listening")));

  const holderUrls = holderServers.map(
    (server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  const holders = holderUrls.map((url, index) => httpHolder(`holder-${index}`, url, { token: holderToken }));
  const pinStore = new PinStore(join(root, "pins"));
  const pinServer = createPinServer(pinStore, { token: pinToken });
  pinServer.listen(0, "127.0.0.1");
  await once(pinServer, "listening");
  const { server, base } = await start(new RarextStore(), {
    blobs: new BlobStore(join(root, "blobs")),
    placements: new PlacementRegistry(join(root, "placements")),
    durability: new DurabilityLedger(),
    holders,
  });
  const keyPath = join(root, "agent-key.json");

  await writeAgentKeyfile(createAgentKeyfile("fault-agent"), keyPath);
  process.env.RAREXT_STORAGE_HOLDERS = holderUrls
    .map((url, index) => `holder-${index}=${url}`)
    .join(",");
  process.env.RAREXT_API = base;
  process.env.RAREXT_AGENT_KEY = keyPath;
  process.env.RAREXT_PIN_URL = `http://127.0.0.1:${(pinServer.address() as AddressInfo).port}/v1/pins`;
  process.env.RAREXT_HOLDER_TOKEN = holderToken;
  process.env.RAREXT_PIN_TOKEN = pinToken;

  async function rejects(fn: () => Promise<unknown>, pattern: RegExp, label: string) {
    await assert.rejects(fn, pattern, label);
  }

  try {
    const content = Buffer.from("fault injection payload");
    const put = (await storagePut({
      content: content.toString("base64"),
      dataShards: 2,
      parityShards: 1,
    })) as { blobHash: string };

    // A challenge for an unknown blob is a clean rejection, not a crash.
    await rejects(
      () => storageChallenge({ blobHash: "0".repeat(64) }),
      /no placement for/,
      "challenge an unknown blob",
    );

    // The same for audit, and the read-only audit never contacts holders.
    await rejects(
      () => storageAudit({ blobHash: "0".repeat(64) }),
      /no placement for/,
      "audit an unknown blob",
    );

    // A pin of a blob that was never stored: the root must be a well-formed
    // digest, and the claimed CID must match the content.
    await rejects(
      () => storagePin({ content: Buffer.from("never stored").toString("base64"), root: "zz".padEnd(64, "0") }),
      /root must be a sha256 hex digest/,
      "pin with a malformed root",
    );
    await rejects(
      () => storagePin({ content: Buffer.from("never stored").toString("base64"), cid: "bafkrei" + "0".repeat(40) }),
      /cid does not match the content/,
      "pin with a mismatched CID",
    );

    // An audit that names a holder which is not in the placement degrades
    // rather than crashing: the read-only audit reports it not live.
    process.env.RAREXT_STORAGE_HOLDERS = `holder-0=${holderUrls[0]}`;
    const degradedAudit = (await storageAudit({ blobHash: put.blobHash })) as {
      audit: { status: string; live: number; required: number };
    };
    assert.equal(degradedAudit.audit.status, "under-replicated");
    assert.ok(degradedAudit.audit.live < degradedAudit.audit.required, "a missing holder degrades the audit");
    process.env.RAREXT_STORAGE_HOLDERS = holderUrls
      .map((url, index) => `holder-${index}=${url}`)
      .join(",");

    // A holder that drops mid-put (returns 5xx on the shard upload) fails the
    // put, and no placement is registered.
    const dead = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mid-put drop" }));
    });
    dead.listen(0, "127.0.0.1");
    await once(dead, "listening");
    const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    process.env.RAREXT_STORAGE_HOLDERS = [
      `holder-0=${deadUrl}`,
      `holder-1=${holderUrls[1]}`,
      `holder-2=${holderUrls[2]}`,
    ].join(",");
    await rejects(
      () => storagePut({ content: Buffer.from("another").toString("base64"), dataShards: 2, parityShards: 1 }),
      /holder holder-0 failed put: 500/,
      "a holder that drops mid-put",
    );
    dead.closeAllConnections();
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    // A wrong holder token makes every challenge answer 401, which the MCP
    // layer surfaces as a rejection instead of a silent under-replicated audit.
    process.env.RAREXT_STORAGE_HOLDERS = holderUrls
      .map((url, index) => `holder-${index}=${url}`)
      .join(",");
    process.env.RAREXT_HOLDER_TOKEN = "expired-or-wrong";
    await rejects(
      () => storageChallenge({ blobHash: put.blobHash }),
      /rejected the challenge|RAREXT_HOLDER_TOKEN/,
      "a wrong holder token",
    );

    // A pin token that is wrong is refused by the pin service.
    process.env.RAREXT_HOLDER_TOKEN = holderToken;
    process.env.RAREXT_PIN_TOKEN = "wrong-pin-token";
    await rejects(
      () => storagePin({ content: Buffer.from("x").toString("base64") }),
      /unauthorized/,
      "a wrong pin token",
    );
  } finally {
    await stop(server);
    await close(pinServer);
    await Promise.all(holderServers.map(close));

    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    rmSync(root, { recursive: true, force: true });
  }
});
