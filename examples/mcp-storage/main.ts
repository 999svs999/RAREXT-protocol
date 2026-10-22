/**
 * Runnable MCP storage example: start a local holder set, an API, and a pin
 * service, then drive the real MCP stdio server through put -> get -> challenge
 * -> audit -> pin.
 *
 *   node --experimental-strip-types examples/mcp-storage/main.ts
 *
 * Everything is temporary and removed on exit. The MCP child receives the same
 * holder URLs and bearer token as the API, so this also exercises the token path.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { createApp } from "../../apps/api/src/app.ts";
import { DurabilityLedger, httpHolder } from "../../apps/api/src/durability.ts";
import { createHolderServer } from "../../apps/api/src/holder-server.ts";
import { createPinServer, PinStore } from "../../apps/api/src/pin-server.ts";
import { PlacementRegistry } from "../../apps/api/src/placements.ts";
import { BlobStore } from "../../apps/api/src/storage.ts";
import { RarextStore } from "../../apps/api/src/store.ts";
import { VerifierOperatorRegistry } from "../../apps/api/src/verifier-operators.ts";
import {
  createAgentKeyfile,
  writeAgentKeyfile,
} from "../../packages/agent-sdk/src/index.ts";

const root = mkdtempSync(join(tmpdir(), "rarext-mcp-storage-example-"));
const HOLDER_TOKEN = "example-holder-token";
const PIN_TOKEN = "example-pin-token";
const K = 4;
const M = 2;
const HOLDERS = K + M;
const holderServers = Array.from({ length: HOLDERS }, (_, index) =>
  createHolderServer({
    id: `holder-${index}`,
    directory: join(root, `holder-${index}`),
    token: HOLDER_TOKEN,
  }),
);
const pinStore = new PinStore(join(root, "pins"));
const pinServer = createPinServer(pinStore, { token: PIN_TOKEN });
let api: ReturnType<typeof createApp> | null = null;
let child: ReturnType<typeof spawn> | null = null;

async function close(server: { closeAllConnections(): void; close(cb: () => void): void }) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function rpcClient(process: ReturnType<typeof spawn>) {
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let stderr = "";

  process.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
  });
  const lines = createInterface({ input: process.stdout! });

  lines.on("line", (line) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }

    if (typeof message.id !== "number") return;
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);

    if (message.error) pending.reject(new Error(message.error.message ?? "JSON-RPC error"));
    else pending.resolve(message.result);
  });

  process.on("exit", (code) => {
    for (const pending of waiting.values()) {
      pending.reject(new Error(`MCP server exited (${code}): ${stderr.trim()}`));
    }
    waiting.clear();
  });

  return async function rpc(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`MCP ${method} timed out; stderr: ${stderr.trim()}`));
      }, 30_000);

      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    process.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
}

try {
  for (const server of holderServers) {
    server.listen(0, "127.0.0.1");
  }
  await Promise.all(holderServers.map((server) => once(server, "listening")));

  const holderUrls = holderServers.map(
    (server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  const holders = holderUrls.map((url, index) =>
    httpHolder(`holder-${index}`, url, { token: HOLDER_TOKEN }),
  );

  pinServer.listen(0, "127.0.0.1");
  await once(pinServer, "listening");

  api = createApp({
    store: new RarextStore(),
    blobs: new BlobStore(join(root, "blobs")),
    placements: new PlacementRegistry(join(root, "placements")),
    durability: new DurabilityLedger(),
    holders,
    operators: new VerifierOperatorRegistry(join(root, "operators")),
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");

  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const pinUrl = `http://127.0.0.1:${(pinServer.address() as AddressInfo).port}/v1/pins`;
  const keyPath = join(root, "agent-key.json");
  await writeAgentKeyfile(createAgentKeyfile("mcp-storage-example"), keyPath);

  const env = {
    ...process.env,
    RAREXT_API: apiUrl,
    RAREXT_AGENT_KEY: keyPath,
    RAREXT_STORAGE_HOLDERS: holderUrls.map((url, index) => `holder-${index}=${url}`).join(","),
    RAREXT_HOLDER_TOKEN: HOLDER_TOKEN,
    RAREXT_PIN_URL: pinUrl,
    RAREXT_PIN_TOKEN: PIN_TOKEN,
  };
  child = spawn(process.execPath, ["apps/mcp/src/server.ts"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = rpcClient(child);

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-storage-example", version: "1" },
  });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await rpc("tools/call", { name, arguments: args })) as {
      content?: { text?: string }[];
      isError?: boolean;
    };
    const text = result.content?.[0]?.text ?? "";

    if (result.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as unknown;
  }

  const payload = Buffer.from(
    "RAREXT MCP storage example\n".repeat(64) +
      "put, get, challenge, audit, and pin are ordinary MCP tools.\n",
  );
  console.log(`payload: ${payload.length} bytes, code ${K}+${M}, ${HOLDERS} token-protected holders`);

  const put = (await call("rarext_storage_put", {
    content: payload.toString("base64"),
    dataShards: K,
    parityShards: M,
    tier: "durable",
  })) as {
    blobHash: string;
    registration: { recorded: boolean; error?: string };
    placement: { record: { placement: { shards: { index: number; holder: string; storedAs: string }[] } } };
  };
  assert.equal(put.registration.recorded, true, put.registration.error);
  assert.equal(put.placement.record.placement.shards.length, HOLDERS);
  console.log(`put: ${put.blobHash}`);
  for (const shard of put.placement.record.placement.shards) {
    console.log(`  shard ${shard.index}: ${shard.holder} ${shard.storedAs.slice(0, 12)}...`);
  }

  const got = (await call("rarext_storage_get", { blobHash: put.blobHash })) as {
    content: string;
    shardsRead: number;
    errors: unknown[];
  };
  assert.deepEqual(Buffer.from(got.content, "base64"), payload);
  console.log(`get: ${got.shardsRead} shards read, ${got.errors.length} errors, bytes match`);

  const challenged = (await call("rarext_storage_challenge", {
    blobHash: put.blobHash,
  })) as { outcomes: { ok: boolean }[]; audit: { status: string; live: number; required: number } };
  assert.ok(challenged.outcomes.every((outcome) => outcome.ok));
  assert.equal(challenged.audit.status, "ok");
  console.log(`challenge: ${challenged.audit.live}/${HOLDERS} live, ${challenged.audit.required} required`);

  const audited = (await call("rarext_storage_audit", {
    blobHash: put.blobHash,
  })) as { audit: { status: string; challenged: boolean } };
  assert.equal(audited.audit.status, "ok");
  assert.equal(audited.audit.challenged, true);
  console.log(`audit: ${audited.audit.status} (challenged=${audited.audit.challenged})`);

  const pinned = (await call("rarext_storage_pin", {
    content: payload.toString("base64"),
    root: put.blobHash,
    publicationIds: ["example-publication"],
  })) as { cid: string; reference: string; bytes: number };
  assert.equal(pinned.bytes, payload.length);
  assert.equal(pinStore.has(pinned.cid), true);
  console.log(`pin: ${pinned.reference}`);

  console.log("\nOK: an MCP client stored, read, challenged, audited, and pinned content.");
} finally {
  if (child) {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  if (api) await close(api);
  await close(pinServer);
  await Promise.all(holderServers.map(close));
  rmSync(root, { recursive: true, force: true });
}
