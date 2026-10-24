/**
 * Runnable sealed-storage example: start three holders and an API, then exercise
 * the real MCP put/get path with sealed:true. The payload is encrypted with
 * HKDF-SHA256 + AES-256-GCM before erasure coding, so holder directories contain
 * only ciphertext and the placement roots commit to that ciphertext.
 *
 *   node --experimental-strip-types examples/sealed-storage/main.ts
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../../apps/api/src/app.ts";
import { DurabilityLedger, httpHolder } from "../../apps/api/src/durability.ts";
import { createHolderServer } from "../../apps/api/src/holder-server.ts";
import { PlacementRegistry } from "../../apps/api/src/placements.ts";
import { BlobStore } from "../../apps/api/src/storage.ts";
import { RarextStore } from "../../apps/api/src/store.ts";
import { createAgentKeyfile, writeAgentKeyfile } from "../../packages/agent-sdk/src/index.ts";
import { storageAudit, storageGet, storagePut } from "../../apps/mcp/src/storage.ts";

async function close(server: { closeAllConnections(): void; close(cb: () => void): void }) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function filesUnder(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile() && statSync(path).size > 0) files.push(path);
  }

  return files;
}

const root = mkdtempSync(join(tmpdir(), "rarext-sealed-example-"));
const SECRET = "sealed-example-secret-pick-a-real-one";
const HOLDERS = 3;
const holderServers = Array.from({ length: HOLDERS }, (_, index) =>
  createHolderServer({ id: `holder-${index}`, directory: join(root, `holder-${index}`) }),
);
let api: ReturnType<typeof createApp> | null = null;

try {
  for (const server of holderServers) server.listen(0, "127.0.0.1");
  await Promise.all(holderServers.map((server) => once(server, "listening")));

  const holderUrls = holderServers.map(
    (server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  const holders = holderUrls.map((url, index) => httpHolder(`holder-${index}`, url));

  api = createApp({
    store: new RarextStore(),
    blobs: new BlobStore(join(root, "blobs")),
    placements: new PlacementRegistry(join(root, "placements")),
    durability: new DurabilityLedger(),
    holders,
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");

  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const keyPath = join(root, "agent-key.json");
  await writeAgentKeyfile(createAgentKeyfile("sealed-example"), keyPath);

  process.env.RAREXT_API = apiUrl;
  process.env.RAREXT_AGENT_KEY = keyPath;
  process.env.RAREXT_STORAGE_HOLDERS = holderUrls
    .map((url, index) => `holder-${index}=${url}`)
    .join(",");
  process.env.RAREXT_SEALED_SECRET = SECRET;

  const payload = Buffer.from(
    "SEALED EXAMPLE PLAINTEXT ".repeat(32) + "holders must only see ciphertext",
  );

  console.log(`payload: ${payload.length} bytes, code 2+1, ${HOLDERS} holders`);
  console.log(`secret: RAREXT_SEALED_SECRET (${SECRET.length} chars)`);

  const put = (await storagePut({
    content: payload.toString("base64"),
    dataShards: 2,
    parityShards: 1,
    sealed: true,
  })) as {
    blobHash: string;
    bytes: number;
    storedBytes: number;
    placement: {
      record: {
        placement: {
          sealed?: { algorithm: string; kdf: string; keyId?: string };
          shards: { holder: string }[];
        };
      };
    };
  };

  console.log(`put: ${put.blobHash}`);
  console.log(
    `  plaintext ${put.bytes} bytes -> ciphertext ${put.storedBytes} bytes, ` +
      `kdf=${put.placement.record.placement.sealed?.kdf}, cipher=${put.placement.record.placement.sealed?.algorithm}, ` +
      `keyId=${put.placement.record.placement.sealed?.keyId}`,
  );
  assert.equal(put.placement.record.placement.sealed?.keyId, "legacy");

  const files = holderServers.flatMap((_, index) => filesUnder(join(root, `holder-${index}`)));
  assert.ok(files.length >= HOLDERS);
  const leaked = files.filter((file) => readFileSync(file).includes(payload));
  assert.equal(leaked.length, 0);
  console.log(`holders: ${files.length} shard files, ${leaked.length} containing plaintext`);

  const got = (await storageGet({ blobHash: put.blobHash })) as {
    content: string;
    sealed: boolean;
  };
  assert.equal(got.sealed, true);
  assert.deepEqual(Buffer.from(got.content, "base64"), payload);
  console.log("get: decrypted client-side, bytes match");

  const audited = (await storageAudit({ blobHash: put.blobHash, challenge: true })) as {
    audit: { status: string; live: number };
  };
  assert.equal(audited.audit.status, "ok");
  console.log(`audit: ${audited.audit.status}, ${audited.audit.live}/${HOLDERS} live`);

  console.log("\nOK: sealed put encrypted before erasure coding and the holders stored ciphertext.");
} finally {
  if (api) await close(api);
  await Promise.all(holderServers.map(close));
  rmSync(root, { recursive: true, force: true });
}
