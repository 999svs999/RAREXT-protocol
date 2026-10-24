import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
import { DurabilityLedger, chunkLeaves, httpHolder } from "../src/durability.ts";
import { shardDigest } from "../src/erasure.ts";
import { merkleRoot } from "../src/merkle.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop } from "./helpers.ts";
import { storageAudit, storageGet, storagePut } from "../../mcp/src/storage.ts";

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

test("the sealed path encrypts before erasure coding and commits to ciphertext", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-sealed-path-"));
  const secret = "sealed-path-test-secret-at-least-16";
  const keys = [
    "RAREXT_STORAGE_HOLDERS",
    "RAREXT_HOLDERS",
    "RAREXT_API",
    "RAREXT_AGENT_KEY",
    "RAREXT_HOLDER_TOKEN",
    "RAREXT_SEALED_SECRET",
    "RAREXT_SEALED_KEYS",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  delete process.env.RAREXT_SEALED_KEYS;
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
  const { server, base } = await start(new RarextStore(), {
    blobs: new BlobStore(join(root, "blobs")),
    placements: new PlacementRegistry(join(root, "placements")),
    durability: new DurabilityLedger(),
    holders,
  });
  const keyPath = join(root, "agent-key.json");

  await writeAgentKeyfile(createAgentKeyfile("sealed-agent"), keyPath);
  process.env.RAREXT_STORAGE_HOLDERS = holderUrls
    .map((url, index) => `holder-${index}=${url}`)
    .join(",");
  process.env.RAREXT_API = base;
  process.env.RAREXT_AGENT_KEY = keyPath;
  process.env.RAREXT_SEALED_SECRET = secret;

  try {
    const payload = Buffer.from(
      "SEALED_PATH_PLAINTEXT_MARKER ".repeat(32) + "the holders must never see this",
    );
    const put = (await storagePut({
      content: payload.toString("base64"),
      dataShards: 2,
      parityShards: 1,
      sealed: true,
    })) as {
      blobHash: string;
      bytes: number;
      storedBytes: number;
      sealed: boolean;
      sealedMetadata: {
        algorithm: string;
        kdf: string;
        salt: string;
        iv: string;
        authTag: string;
        keyId?: string;
      };
      placement: {
        record: {
          placement: {
            length: number;
            sealed?: {
              algorithm: string;
              kdf: string;
              salt: string;
              iv: string;
              authTag: string;
              keyId?: string;
            };
            shards: { index: number; holder: string; storedAs: string; digest: string; root: string }[];
          };
        };
      };
    };

    assert.equal(put.sealed, true);
    assert.equal(put.bytes, payload.length);
    assert.ok(put.storedBytes >= payload.length);
    assert.equal(put.placement.record.placement.sealed?.kdf, "hkdf-sha256");
    assert.equal(put.placement.record.placement.sealed?.algorithm, "aes-256-gcm");
    assert.equal(put.placement.record.placement.length, put.storedBytes);
    assert.notEqual(put.blobHash, createHash("sha256").update(payload).digest("hex"));

    const files = holderServers.flatMap((_, index) => filesUnder(join(root, `holder-${index}`)));
    assert.ok(files.length >= 3, "the holders must actually hold shard files");
    for (const file of files) {
      const content = readFileSync(file);
      assert.equal(content.includes(payload), false, `plaintext found in ${file}`);
      assert.equal(content.includes(secret), false, `sealing secret found in ${file}`);
    }

    assert.equal(put.sealedMetadata.keyId, "legacy");
    assert.equal(put.placement.record.placement.sealed?.keyId, "legacy");

    const placement = put.placement.record.placement;

    for (const shard of placement.shards) {
      const holder = holders.find((entry) => entry.id === shard.holder)!;
      const bytes = await holder.get(shard.storedAs);
      assert.ok(bytes, `missing shard on ${shard.holder}`);

      assert.equal(
        shardDigest({
          index: shard.index,
          dataShards: 2,
          parityShards: 1,
          length: placement.length,
          payloadDigest: put.blobHash,
          bytes,
        }),
        shard.digest,
        "the shard digest must cover ciphertext",
      );
      assert.equal(
        merkleRoot(chunkLeaves(bytes)),
        shard.root,
        "the placement Merkle root must commit to ciphertext",
      );
    }

    const got = (await storageGet({ blobHash: put.blobHash })) as {
      content: string;
      bytes: number;
      storedBytes: number;
      sealed: boolean;
    };

    assert.equal(got.sealed, true);
    assert.equal(got.bytes, payload.length);
    assert.equal(got.storedBytes, put.storedBytes);
    assert.deepEqual(Buffer.from(got.content, "base64"), payload);

    delete process.env.RAREXT_SEALED_SECRET;
    await assert.rejects(
      () => storageGet({ blobHash: put.blobHash }),
      /RAREXT_SEALED_SECRET/,
    );

    process.env.RAREXT_SEALED_SECRET = "wrong-secret-but-long-enough";
    await assert.rejects(() => storageGet({ blobHash: put.blobHash }));

    process.env.RAREXT_SEALED_SECRET = secret;

    const secondSecret = "sealed-path-second-key-at-least-16";
    const thirdSecret = "sealed-path-third-key-at-least-16";
    const fourthSecret = "sealed-path-fourth-key-at-least-16";
    const opened = async (blobHash: string): Promise<Buffer> => {
      const got = (await storageGet({ blobHash })) as { content: string };
      return Buffer.from(got.content, "base64");
    };

    process.env.RAREXT_SEALED_KEYS = JSON.stringify({
      active: "k2",
      keys: { k2: secondSecret },
    });
    assert.deepEqual(await opened(put.blobHash), payload);

    const put2 = (await storagePut({
      content: payload.toString("base64"),
      dataShards: 2,
      parityShards: 1,
      sealed: true,
    })) as typeof put;

    assert.equal(put2.sealedMetadata.keyId, "k2");
    assert.equal(put2.placement.record.placement.sealed?.keyId, "k2");
    assert.notEqual(put2.blobHash, put.blobHash);
    assert.deepEqual(await opened(put2.blobHash), payload);
    assert.deepEqual(await opened(put.blobHash), payload);

    process.env.RAREXT_SEALED_KEYS = JSON.stringify({
      active: "k3",
      keys: { k2: secondSecret, k3: thirdSecret },
    });
    const put3 = (await storagePut({
      content: payload.toString("base64"),
      dataShards: 2,
      parityShards: 1,
      sealed: true,
    })) as typeof put;

    assert.equal(put3.sealedMetadata.keyId, "k3");
    assert.notEqual(put3.blobHash, put2.blobHash);
    assert.deepEqual(await opened(put2.blobHash), payload);
    assert.deepEqual(await opened(put3.blobHash), payload);

    const rotatedFiles = holderServers.flatMap((_, index) =>
      filesUnder(join(root, `holder-${index}`)),
    );
    for (const file of rotatedFiles) {
      const content = readFileSync(file);
      for (const forbidden of [secret, secondSecret, thirdSecret]) {
        assert.equal(content.includes(forbidden), false, `sealing key found in ${file}`);
      }
    }

    process.env.RAREXT_SEALED_KEYS = JSON.stringify({
      active: "k3",
      keys: { k2: secondSecret, k3: thirdSecret },
      revoked: ["k2"],
    });
    await assert.rejects(
      () => storageGet({ blobHash: put2.blobHash }),
      /k2 is revoked/,
    );
    assert.deepEqual(await opened(put3.blobHash), payload);
    assert.deepEqual(await opened(put.blobHash), payload);

    process.env.RAREXT_SEALED_KEYS = JSON.stringify({
      active: "k3",
      keys: { k3: thirdSecret },
    });
    await assert.rejects(
      () => storageGet({ blobHash: put2.blobHash }),
      /unknown sealed key id: k2/,
    );

    process.env.RAREXT_SEALED_KEYS = "{not json";
    await assert.rejects(
      () =>
        storagePut({
          content: payload.toString("base64"),
          dataShards: 2,
          parityShards: 1,
          sealed: true,
        }),
      /valid JSON/,
    );

    process.env.RAREXT_SEALED_KEYS = JSON.stringify({
      active: "k3",
      keys: { k3: "leaky-config" },
    });
    await assert.rejects(
      () =>
        storagePut({
          content: payload.toString("base64"),
          dataShards: 2,
          parityShards: 1,
          sealed: true,
        }),
      (error: unknown) => {
        const text = String(error);
        assert.equal(text.includes("leaky-config"), false);
        return /at least 16 bytes/.test(text);
      },
    );

    process.env.RAREXT_SEALED_KEYS = JSON.stringify({
      active: "k3",
      keys: { k3: thirdSecret },
    });

    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;

    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (!paused && url.includes("/v1/holder/shards/")) {
        paused = true;
        entered();
        await gate;
      }

      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const pending = storageGet({ blobHash: put3.blobHash });
      await enteredPromise;
      process.env.RAREXT_SEALED_KEYS = JSON.stringify({
        active: "k4",
        keys: { k4: fourthSecret },
      });
      release();
      const got = (await pending) as { content: string };
      assert.deepEqual(Buffer.from(got.content, "base64"), payload);
    } finally {
      release();
      globalThis.fetch = originalFetch;
      process.env.RAREXT_SEALED_KEYS = JSON.stringify({
        active: "k3",
        keys: { k3: thirdSecret },
      });
    }

    const audited = (await storageAudit({ blobHash: put.blobHash, challenge: true })) as {
      audit: { status: string; live: number };
    };
    assert.equal(audited.audit.status, "ok");
    assert.equal(audited.audit.live, 3);
  } finally {
    await stop(server);
    await Promise.all(holderServers.map(close));

    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    rmSync(root, { recursive: true, force: true });
  }
});
