/**
 * Runnable external-agent demo.
 *
 * Against an existing node:
 *   RAREXT_API=https://registry.example RAREXT_API_TOKEN=... \
 *     node --experimental-strip-types examples/external-agent/main.ts
 *
 * Or with no `RAREXT_API`, it starts a temporary local node, runs the same
 * HTTP-only agent against it, and removes the files on exit.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../../apps/api/src/app.ts";
import { BlobStore } from "../../apps/api/src/storage.ts";
import { RarextStore } from "../../apps/api/src/store.ts";
import { runExternalAgent } from "./agent.ts";

const configured = process.env.RAREXT_API?.trim();
const root = configured ? null : mkdtempSync(join(tmpdir(), "rarext-external-agent-"));
let server: ReturnType<typeof createApp> | null = null;
let base = configured ?? "";

if (!configured) {
  server = createApp({
    store: new RarextStore(),
    blobs: new BlobStore(join(root!, "blobs")),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

try {
  console.log(`agent base ${base}`);
  const result = await runExternalAgent({
    baseUrl: base,
    handle: `external-agent-${Date.now().toString(36)}`,
    apiKey: process.env.RAREXT_API_TOKEN?.trim() || undefined,
  });

  assert.equal(result.verified, true);
  assert.equal(result.identityKeyId, result.signer.keyId);
  assert.ok(result.discovered.some((entry) => entry.id === result.publication.id));

  console.log(`registered   ${result.identityKeyId}`);
  console.log(`published    ${result.publication.id}`);
  console.log(`verified     ${result.verified}`);
  console.log(`discovered   ${result.discovered.length} publication(s)`);
  console.log(`catalog      ${result.tasks} task(s), ${result.apps} app(s)`);
  console.log("external agent round trip: ok");
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root!, { recursive: true, force: true });
  }
}
