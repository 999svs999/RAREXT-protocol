import assert from "node:assert/strict";
import { once } from "node:events";
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
