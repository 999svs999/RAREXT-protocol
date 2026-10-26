import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createAgentKeyfile, writeAgentKeyfile } from "../../../packages/agent-sdk/src/index.ts";
import { createHolderServer } from "../src/holder-server.ts";
import { BlobStore } from "../src/storage.ts";
import { PlacementRegistry } from "../src/placements.ts";
import { DurabilityLedger, httpHolder } from "../src/durability.ts";
import { createPinServer, PinStore } from "../src/pin-server.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop, post } from "./helpers.ts";
import {
  storageAudit,
  storageChallenge,
  storageGet,
  storagePin,
  storagePut,
} from "../../mcp/src/storage.ts";
import { encodeBytes } from "../src/erasure.ts";

const example = fileURLToPath(new URL("../../../examples/mcp-storage/main.ts", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

const ENV_KEYS = [
  "RAREXT_STORAGE_HOLDERS",
  "RAREXT_HOLDERS",
  "RAREXT_API",
  "RAREXT_AGENT_KEY",
  "RAREXT_PIN_URL",
  "RAREXT_HOLDER_TOKEN",
  "RAREXT_PIN_TOKEN",
  "RAREXT_STORAGE_MAX_BYTES",
] as const;

function close(server: { closeAllConnections(): void; close(cb: () => void): void }) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function setup(options?: { maxBytes?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "rarext-mcp-agent-"));
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const holderToken = "mcp-agent-holder-token";
  const holderCount = options?.maxBytes !== undefined ? 3 : 6;
  const holderServers = Array.from({ length: holderCount }, (_, index) =>
    createHolderServer({
      id: `holder-${index}`,
      directory: join(dir, `holder-${index}`),
      token: holderToken,
      ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    }),
  );

  for (const server of holderServers) server.listen(0, "127.0.0.1");
  await Promise.all(holderServers.map((server) => once(server, "listening")));

  const holderUrls = holderServers.map(
    (server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  const holders = holderUrls.map((url, index) =>
    httpHolder(`holder-${index}`, url, { token: holderToken }),
  );

  const pinStore = new PinStore(join(dir, "pins"));
  const pinServer = createPinServer(pinStore, { token: "mcp-agent-pin-token" });
  pinServer.listen(0, "127.0.0.1");
  await once(pinServer, "listening");

  const store = new RarextStore();
  const { server, base } = await start(store, {
    blobs: new BlobStore(join(dir, "blobs")),
    placements: new PlacementRegistry(join(dir, "placements")),
    durability: new DurabilityLedger(),
    holders,
  });

  const keyPath = join(dir, "agent-key.json");
  const keyfile = createAgentKeyfile("mcp-agent");
  await writeAgentKeyfile(keyfile, keyPath);

  process.env.RAREXT_STORAGE_HOLDERS = holderUrls
    .map((url, index) => `holder-${index}=${url}`)
    .join(",");
  process.env.RAREXT_API = base;
  process.env.RAREXT_AGENT_KEY = keyPath;
  process.env.RAREXT_PIN_URL = `http://127.0.0.1:${(pinServer.address() as AddressInfo).port}/v1/pins`;
  process.env.RAREXT_HOLDER_TOKEN = holderToken;
  process.env.RAREXT_PIN_TOKEN = "mcp-agent-pin-token";

  return {
    dir,
    store,
    server,
    base,
    holders,
    holderServers,
    holderUrls,
    pinServer,
    keyfile,
    previous,
    cleanup: async () => {
      await stop(server);
      await close(pinServer);
      await Promise.all(holderServers.map(close));
      for (const key of ENV_KEYS) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Put a small payload, return the blob hash and the holder directories. */
async function putPayload(content: Buffer, dataShards = 2, parityShards = 1) {
  const put = (await storagePut({
    content: content.toString("base64"),
    dataShards,
    parityShards,
    tier: "durable",
  })) as {
    blobHash: string;
    registration: { recorded: boolean; error?: string };
    placement: { record: { placement: { shards: { index: number; holder: string; storedAs: string }[] } } };
  };
  assert.equal(put.registration.recorded, true, put.registration.error);
  return put;
}

/** Corrupt a shard file in place on the holder's disk. */
function corruptShard(dir: string, holderIndex: number, storedAs: string) {
  const shardPath = join(dir, `holder-${holderIndex}`, storedAs);
  const original = readFileSync(shardPath);
  // Flip one byte in the middle; the length stays the same so the JSON
  // transport is unaffected — only the digest will disagree.
  const corrupted = Buffer.from(original);
  corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
  writeFileSync(shardPath, corrupted);
}

test("an external MCP client drives put, get, challenge, audit, and pin", { timeout: 120_000 }, async () => {
  const child = spawn(process.execPath, [example], {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(code, 0, `MCP storage example failed:\n${stderr}\n${stdout}`);
  assert.match(stdout, /payload: \d+ bytes, code 4\+2, 6 token-protected holders/);
  assert.match(stdout, /^put: [0-9a-f]{64}$/m);
  assert.match(stdout, /^get: 4 shards read, 0 errors, bytes match$/m);
  assert.match(stdout, /^challenge: 6\/6 live, 6 required$/m);
  assert.match(stdout, /^audit: ok \(challenged=true\)$/m);
  assert.match(stdout, /^pin: pin:[A-Za-z0-9]+$/m);
  assert.match(stdout, /OK: an MCP client stored, read, challenged, audited, and pinned content\./);
});

test("a blob whose declared size disagrees with the body is refused", async () => {
  const { cleanup } = await setup();

  try {
    const holderUrl = process.env.RAREXT_STORAGE_HOLDERS!.split(",")[0]!.split("=")[1]!;
    const holderToken = process.env.RAREXT_HOLDER_TOKEN!;
    const [host, port] = holderUrl.replace("http://", "").split(":");

    // A raw client so the declared content-length is under test control.
    const post = (body: string, declared: number) =>
      new Promise<{ status: number | null; body: string }>((resolve) => {
        const req = http.request(
          {
            host,
            port: Number(port),
            path: "/v1/holder/shards",
            method: "POST",
            headers: {
              authorization: `Bearer ${holderToken}`,
              "content-type": "application/json",
              "content-length": String(declared),
              connection: "close",
            },
            timeout: 5_000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("timeout", () => {
          req.destroy();
          resolve({ status: null, body: "timed out" });
        });
        req.on("error", (error) => resolve({ status: null, body: String(error) }));
        req.end(body);
      });

    // Case 1 — the body is shorter than the declared length: the client
    // sends 10 bytes against a declared 30 and stops. The holder refuses the
    // mismatch loudly: when the parser lets it, a 400 naming the
    // disagreement; when the abort has already torn the socket down (the
    // client's FIN races the response), the connection resets. Either way
    // the bytes are refused, never parsed as a fragment — the strict
    // assertion is that nothing reaches the holder's disk.
    const fullJson = JSON.stringify({ content: "aGVsbG8gd29ybGQ=" });
    const truncated = await post(fullJson.slice(0, 10), 30);
    assert.ok(
      truncated.status === 400 || truncated.status === null,
      `a truncated body must be refused loudly, got ${truncated.status}: ${truncated.body}`,
    );
    if (truncated.status === 400) {
      assert.match(truncated.body, /content-length declares/i, "the refusal names the size disagreement");
    }

    // Case 2 — the body is longer than the declared length: the parser keeps
    // exactly the declared bytes, so the JSON fragment is refused the same
    // way, and the leftover excess bytes corrupt the next request on the
    // connection (the holder must not reuse a lying socket). The holder is
    // still healthy on a fresh connection.
    const liar = await post(fullJson, 10);
    assert.ok(
      liar.status === 400 || liar.status === null,
      `an oversized body must be refused or the connection dropped, got ${liar.status}: ${liar.body}`,
    );

    // Case 3 — a clean request stores the shard exactly once.
    const clean = await post(fullJson, Buffer.byteLength(fullJson));
    assert.equal(clean.status, 201, `a clean put must succeed: ${clean.status}: ${clean.body}`);
    const shards = await fetch(`${holderUrl}/v1/holder/shards`, {
      headers: { authorization: `Bearer ${holderToken}` },
    }).then((response) => (response.json() as Promise<{ shards: unknown[] }>));
    assert.equal(shards.shards.length, 1, "only the clean put stored a shard");

    // Case 4 — the raw PUT path refuses a declared length that is not a
    // positive integer, before any bytes are streamed.
    const rawBadLength = await new Promise<{ status: number | null; body: string }>((resolve) => {
      const req = http.request(
        {
          host,
          port: Number(port),
          path: `/v1/holder/shards/${"b".repeat(64)}/raw`,
          method: "PUT",
          headers: {
            authorization: `Bearer ${holderToken}`,
            "content-length": "0",
            "content-type": "application/octet-stream",
            connection: "close",
          },
          timeout: 5_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: null, body: "timed out" });
      });
      req.on("error", (error) => resolve({ status: null, body: String(error) }));
      req.end();
    });
    assert.equal(rawBadLength.status, 400, "a zero raw length must be refused");

    // Nothing from the refused puts reached the holder's disk: the shard list
    // is unchanged from the single clean JSON put.
    const rawShards = await fetch(`${holderUrl}/v1/holder/shards`, {
      headers: { authorization: `Bearer ${holderToken}` },
    }).then((response) => (response.json() as Promise<{ shards: unknown[] }>));
    assert.equal(rawShards.shards.length, 1, "the refused raw put stored nothing");
  } finally {
    await cleanup();
  }
});

test("a holder that exceeds its byte quota rejects the put before storing bytes", async () => {
  // maxBytes: 200 — each holder accepts at most 200 total stored bytes. A 300
  // byte payload in 2+1 is 150 bytes per shard, so the first put fills its
  // holder to 150 and a second 150-byte shard to the same holder must be
  // refused with 507 before the holder writes anything.
  const { cleanup, holders, base, store } = await setup({ maxBytes: 200 });

  try {
    const content = Buffer.from("x".repeat(300));
    const put = await putPayload(content, 2, 1);
    assert.equal(put.registration.recorded, true);

    // Find which holder stores shard 0; its byte count must be the first
    // shard's size.
    const firstShard = put.placement.record.placement.shards[0] as {
      index: number;
      holder: string;
      storedAs: string;
      size: number;
    };
    const holderUrl = process.env.RAREXT_STORAGE_HOLDERS!
      .split(",")
      .find((entry) => entry.startsWith(`${firstShard.holder}=`))!
      .split("=")[1]!;
    const holderToken = process.env.RAREXT_HOLDER_TOKEN!;
    const beforeResponse = await fetch(`${holderUrl}/v1/holder`, {
      headers: { authorization: `Bearer ${holderToken}` },
    });
    assert.equal(beforeResponse.status, 200);
    const before = (await beforeResponse.json()) as { bytes: number };
    assert.equal(before.bytes, firstShard.size, "the first shard is stored exactly once");

    // A second put of different content must overflow the quota on whichever
    // holder receives its shard 0. The MCP layer surfaces the 507 as a
    // rejection: the put throws before the placement is registered.
    await assert.rejects(
      () =>
        storagePut({
          content: Buffer.from("y".repeat(300)).toString("base64"),
          dataShards: 2,
          parityShards: 1,
          tier: "durable",
        }),
      /507|insufficient storage/,
    );

    // The quota check happens before store.put: the holder's byte count must
    // not have grown after the rejected put.
    const afterResponse = await fetch(`${holderUrl}/v1/holder`, {
      headers: { authorization: `Bearer ${holderToken}` },
    });
    assert.equal(afterResponse.status, 200);
    const after = (await afterResponse.json()) as { bytes: number };
    assert.equal(after.bytes, before.bytes, "the rejected put stored nothing");
  } finally {
    await cleanup();
  }
});

test("corrupted shard bytes are refused by the digest check, never silently returned", async () => {
  const { cleanup, dir, holders, base, store, keyfile } = await setup();

  try {
    const content = Buffer.from("digest-guarded payload");
    const put = await putPayload(content, 2, 1);

    // Corrupt every shard of the blob in place on the holders' disks.
    for (const shard of put.placement.record.placement.shards) {
      const holderIndex = Number(shard.holder.replace("holder-", ""));
      corruptShard(dir, holderIndex, shard.storedAs);
    }

    // storageGet must fail loudly: all shards have been corrupted, so no
    // shard passes the digest check and fewer than dataShards are usable.
    await assert.rejects(
      () => storageGet({ blobHash: put.blobHash }),
      (error: Error) => {
        assert.match(error.message, /only 0 of 2 data shards are usable|digest does not match|shard is missing/);
        return true;
      },
    );

    // Corrupt one of the data shards in a fresh put: the get must still
    // succeed from the remaining k shards, but the corrupted shard is not
    // used (verified: the returned content is correct).
    const content2 = Buffer.from("survivor payload");
    const put2 = await putPayload(content2, 2, 1);
    const dataShards = put2.placement.record.placement.shards
      .filter((s) => s.index < 2); // data shards are index 0 and 1
    corruptShard(
      dir,
      Number(dataShards[0]!.holder.replace("holder-", "")),
      dataShards[0]!.storedAs,
    );
    const got2 = (await storageGet({ blobHash: put2.blobHash })) as {
      content: string;
      errors: { error: string }[];
    };
    assert.deepEqual(Buffer.from(got2.content, "base64"), content2);
    assert.ok(got2.errors.length > 0, "the corrupted shard is reported in errors");
    assert.match(got2.errors[0]!.error, /digest does not match|shard is missing/);
  } finally {
    await cleanup();
  }
});

test("persistence holds across a holder restart: put, restart, get", async () => {
  const { cleanup, dir, holders, holderServers, base, store } = await setup();

  try {
    const content = Buffer.from("restart-persistence payload");
    const put = await putPayload(content, 2, 1);
    const blobHash = put.blobHash;

    // Restart all holder servers: close and re-open on the same directories.
    await Promise.all(holderServers.map(close));

    const restartedServers = holders.map((holder, index) =>
      createHolderServer({
        id: `holder-${index}`,
        directory: join(dir, `holder-${index}`),
        token: process.env.RAREXT_HOLDER_TOKEN!,
      }),
    );
    for (const server of restartedServers) server.listen(0, "127.0.0.1");
    await Promise.all(restartedServers.map((server) => once(server, "listening")));

    const restartedUrls = restartedServers.map(
      (server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    process.env.RAREXT_STORAGE_HOLDERS = restartedUrls
      .map((url, index) => `holder-${index}=${url}`)
      .join(",");

    // A new ledger (fresh DurabilityLedger, no in-memory state) must still
    // retrieve the blob from the restarted holders using the persisted
    // placement record.
    const got = (await storageGet({ blobHash })) as { content: string; errors: unknown[] };
    assert.deepEqual(Buffer.from(got.content, "base64"), content);
    assert.equal(got.errors.length, 0, "no errors after restart");

    await Promise.all(restartedServers.map(close));
  } finally {
    await cleanup();
  }
});

test("a challenge after GC removed the shard reports not-live, not a stale proof", async () => {
  const { cleanup, dir, holders, base, store } = await setup();

  try {
    const content = Buffer.from("gc-then-challenge payload");
    const put = await putPayload(content, 2, 1);
    const blobHash = put.blobHash;

    // Remove every shard via the holder DELETE endpoint (simulating GC).
    const holderToken = process.env.RAREXT_HOLDER_TOKEN!;
    for (const shard of put.placement.record.placement.shards) {
      const holderIndex = Number(shard.holder.replace("holder-", ""));
      const holderUrl = process.env.RAREXT_STORAGE_HOLDERS!
        .split(",")
        .find((entry) => entry.startsWith(`${shard.holder}=`))!
        .split("=")[1]!;
      const deleteResponse = await fetch(
        `${holderUrl}/v1/holder/shards/${shard.storedAs}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${holderToken}` },
        },
      );
      assert.equal(deleteResponse.status, 204, "shard deleted");
    }

    // A challenge now reports every shard as shard-missing; the ledger
    // records not-live, not a stale ok.
    const challenged = (await storageChallenge({ blobHash })) as {
      outcomes: { ok: boolean; reason: string }[];
      audit: { status: string; live: number; required: number };
    };
    for (const outcome of challenged.outcomes) {
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, "shard-missing");
    }
    assert.equal(challenged.audit.status, "under-replicated");
    assert.equal(challenged.audit.live, 0);
    assert.equal(challenged.audit.required, 3);

    // storageGet must fail: no shards are available.
    await assert.rejects(
      () => storageGet({ blobHash }),
      /only 0 of 2 data shards are usable|shard is missing/,
    );
  } finally {
    await cleanup();
  }
});

test("two agents putting the same blob concurrently converge to one stored object", async () => {
  const { cleanup, dir, holders, base, store } = await setup();

  try {
    const content = Buffer.from("convergent-content payload");
    const contentB64 = content.toString("base64");

    // Two agents (same key, two concurrent puts of identical content) must
    // converge: the blob store is content-addressed, so both puts write the
    // same bytes to the same path. The placement registry accepts the first
    // and deduplicates the second (same placement -> 200 "unchanged").
    const results = await Promise.all([
      storagePut({ content: contentB64, dataShards: 2, parityShards: 1, tier: "durable" }),
      storagePut({ content: contentB64, dataShards: 2, parityShards: 1, tier: "durable" }),
    ]);

    const blobHashes = results.map(
      (r) => (r as { blobHash: string }).blobHash,
    );
    assert.equal(blobHashes[0], blobHashes[1], "both agents got the same blob hash");

    // Exactly one blob file on disk.
    const holderDirs = holders.map((_, index) => join(dir, `holder-${index}`));
    let blobCount = 0;
    for (const holderDir of holderDirs) {
      for (const entry of readdirSync(holderDir)) {
        if (/^[0-9a-f]{64}$/.test(entry)) blobCount += 1;
      }
    }
    // With 3 holders and 3 shards, each holder stores one shard. All three
    // shards are the same blob, so 3 files total (one per holder).
    assert.equal(blobCount, 3, "each holder stores one shard of the blob");

    // The second registration must be "unchanged" (200), not a conflict.
    const second = results[1] as { registration: { recorded: boolean; error?: string } };
    assert.equal(
      second.registration.recorded,
      true,
      `second registration: ${JSON.stringify(second.registration)}\nFIRST: ${JSON.stringify((results[0] as { placement: { record: unknown } }).placement.record)}\nSECOND: ${JSON.stringify((results[1] as { placement: { record: unknown } }).placement.record)}`,
    );

    // Both agents can retrieve the content.
    const got = (await storageGet({ blobHash: blobHashes[0]! })) as { content: string };
    assert.deepEqual(Buffer.from(got.content, "base64"), content);
  } finally {
    await cleanup();
  }
});

test("a revoked agent identity is refused a put after revocation", async () => {
  const { cleanup, dir, store, base, keyfile } = await setup();

  try {
    const content = Buffer.from("revoked-agent payload");
    // A valid put before revocation.
    const putBefore = await putPayload(content, 2, 1);
    assert.equal(putBefore.registration.recorded, true);

    // Add a revocation targeting the steward keyId. The steward keyId is the
    // SHA-256 of the agent's public key, which is keyfile.publicKey.
    const crypto = await import("node:crypto");
    const stewardKeyId = crypto.createHash("sha256")
      .update(JSON.stringify(keyfile.publicKey, Object.keys(keyfile.publicKey).sort()))
      .digest("hex");

    // The placement records the steward's keyId; find it from the put result.
    const actualStewardKeyId = (putBefore as unknown as {
      placement: { record: { steward: { keyId: string } } };
    }).placement.record.steward.keyId;

    // Revoke the steward via the store directly (bypassing the HTTP API for
    // the test; the same effect is achieved by POST /v1/revocations).
    store.addRevocation({
      id: "revoke-steward",
      kind: "capability",
      target: actualStewardKeyId,
      reason: "key compromised",
      issuer: "mcp-agent",
      issuedAt: new Date().toISOString(),
    });

    // Now a new put with the same key must be refused with 403 by the API.
    const putAfter = await storagePut({
      content: Buffer.from("post-revocation payload").toString("base64"),
      dataShards: 2,
      parityShards: 1,
      tier: "durable",
    }) as { registration: { recorded: boolean; error?: string } };

    assert.equal(putAfter.registration.recorded, false);
    assert.match(putAfter.registration.error ?? "", /403|revoked/);
  } finally {
    await cleanup();
  }
});

test("a malformed tool arguments object is handled without crashing the MCP server", async () => {
  const { cleanup, base } = await setup();

  try {
    // storagePut with no arguments: content is undefined, so it must throw
    // the documented "content must be non-empty base64 text" error, not crash.
    await assert.rejects(
      () => storagePut({}),
      /content must be non-empty base64 text|content decoded to zero bytes/,
    );

    // storagePut with a string where an object is expected: the MCP server's
    // asRecord coerces non-objects to {}, so this is equivalent to {}.
    await assert.rejects(
      () => storagePut("garbage" as unknown as Record<string, unknown>),
      /content must be non-empty base64 text/,
    );

    // storageGet with a malformed blobHash: not 64 hex chars, must reject.
    await assert.rejects(
      () => storageGet({ blobHash: "zz" }),
      /blobHash must be a sha256 hex digest/,
    );

    // storageGet with no blobHash: coerced to empty string, must reject.
    await assert.rejects(
      () => storageGet({}),
      /blobHash must be a sha256 hex digest/,
    );
  } finally {
    await cleanup();
  }
});
