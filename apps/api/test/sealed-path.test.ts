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
import {
  SEALED_ALGORITHM,
  SEALED_KDF,
  decryptSealedPayload,
  encryptSealedPayload,
  isSealedMetadata,
  sealedEnvelope,
  sealedMetadata,
  type SealedEnvelope,
} from "../src/sealed-encryption.ts";

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

// The sealed primitives' own fault surface. The end-to-end test above proves
// the path works; these pin what it must refuse: a tampered or malformed
// ciphertext never decrypts, two encryptions never share salt/iv, and the
// metadata a placement records carries no plaintext.
test("the sealed primitives refuse tampering, wrong keys, and malformed envelopes", async (t) => {
  const secret = "correct horse battery staple";
  const payload = Buffer.from("TOP-SECRET-MARKER: the mirror must never read this", "utf8");

  await t.test("an honest round trip works, and tampering is refused", () => {
    const { envelope, ciphertextBytes } = encryptSealedPayload(payload, secret);

    // Positive control: the honest envelope decrypts byte-exact.
    assert.deepEqual(decryptSealedPayload(envelope, secret), new Uint8Array(payload));

    // Flip one bit of the ciphertext: GCM authentication must refuse it.
    const tamperedBytes = Uint8Array.from(ciphertextBytes);
    tamperedBytes[0] ^= 0x01;
    const tamperedCiphertext: SealedEnvelope = {
      ...envelope,
      ciphertext: Buffer.from(tamperedBytes).toString("base64"),
    };
    assert.throws(() => decryptSealedPayload(tamperedCiphertext, secret), /authentication failed/);

    // Flip one bit of the auth tag: same refusal, never wrong bytes.
    const tag = Buffer.from(envelope.authTag, "base64");
    tag[0] ^= 0x01;
    assert.throws(
      () => decryptSealedPayload({ ...envelope, authTag: tag.toString("base64") }, secret),
      /authentication failed/,
    );
  });

  await t.test("a wrong or too-short secret is refused, never guessed at", () => {
    const { envelope } = encryptSealedPayload(payload, secret);

    assert.throws(() => decryptSealedPayload(envelope, "another correct horse battery"), /authentication failed/);
    // The secret floor is enforced at encryption too, with the documented floor.
    assert.throws(() => encryptSealedPayload(payload, "short"), /at least 16 bytes/);
  });

  await t.test("malformed envelope fields are refused by validation, not by crashing", () => {
    const { envelope } = encryptSealedPayload(payload, secret);

    // Fields with a fixed size or encoding are named in the refusal: the
    // validator catches them before any crypto runs.
    for (const [field, broken] of [
      ["iv", { ...envelope, iv: "" }],
      ["salt", { ...envelope, salt: "not base64!!" }],
      ["authTag", { ...envelope, authTag: Buffer.from([1, 2]).toString("base64") }],
    ] as const) {
      assert.throws(
        () => decryptSealedPayload(broken as SealedEnvelope, secret),
        new RegExp(field, "i"),
        `a malformed ${field} must be named in the refusal`,
      );
    }

    // An empty ciphertext is valid base64, so it is refused by the
    // authentication check instead — still refused, never a wrong result.
    assert.throws(
      () => decryptSealedPayload({ ...envelope, ciphertext: "" }, secret),
      /authentication failed/,
    );
  });

  await t.test("metadata is bound to its ciphertext: a swapped pair is refused", () => {
    const first = encryptSealedPayload(payload, secret);
    const second = encryptSealedPayload(payload, secret);

    // The honest rebuild (metadata + decoded ciphertext) round-trips.
    const rebuilt = sealedEnvelope(sealedMetadata(first.envelope), first.ciphertextBytes);
    assert.deepEqual(decryptSealedPayload(rebuilt, secret), new Uint8Array(payload));

    // Second encryption's metadata over the FIRST ciphertext: the iv/authTag
    // no longer match these bytes, so it must refuse rather than return
    // something plausible.
    const crossed = sealedEnvelope(sealedMetadata(second.envelope), first.ciphertextBytes);
    assert.throws(() => decryptSealedPayload(crossed, secret), /authentication failed/);

    // The metadata carries the algorithm and KDF names the doc publishes.
    const metadata = sealedMetadata(first.envelope);
    assert.equal(metadata.algorithm, SEALED_ALGORITHM);
    assert.equal(metadata.kdf, SEALED_KDF);
    assert.equal(isSealedMetadata(metadata), true);
    assert.equal(isSealedMetadata({ ...metadata, iv: "" }), false);
  });

  await t.test("two encryptions of the same plaintext share no salt, iv, or ciphertext", () => {
    const a = encryptSealedPayload(payload, secret);
    const b = encryptSealedPayload(payload, secret);

    assert.notEqual(a.envelope.salt, b.envelope.salt);
    assert.notEqual(a.envelope.iv, b.envelope.iv);
    assert.notEqual(a.envelope.ciphertext, b.envelope.ciphertext);
    // ...and both still decrypt, so freshness did not cost correctness.
    assert.deepEqual(decryptSealedPayload(a.envelope, secret), new Uint8Array(payload));
    assert.deepEqual(decryptSealedPayload(b.envelope, secret), new Uint8Array(payload));
  });

  await t.test("the recorded metadata and ciphertext carry no plaintext", () => {
    const { envelope, ciphertextBytes } = encryptSealedPayload(payload, secret);
    const metadata = sealedMetadata(envelope);
    const marker = "TOP-SECRET-MARKER";

    // What a placement records, serialized, must not contain the plaintext —
    // in either the metadata or the committed ciphertext.
    assert.equal(JSON.stringify(metadata).includes(marker), false);
    assert.equal(Buffer.from(ciphertextBytes).toString("utf8").includes(marker), false);
    assert.equal(JSON.stringify(metadata).includes(payload.toString("utf8")), false);
  });

  await t.test("length is NOT hidden, and that bound is stated rather than implied", () => {
    // AES-GCM is a stream cipher: ciphertext length equals plaintext length.
    // The sealed tier hides content, not size — pinned here so the property is
    // a documented bound rather than a surprise.
    for (const size of [0, 1, 15, 1024]) {
      const { ciphertextBytes } = encryptSealedPayload(Buffer.alloc(size, 7), secret);
      assert.equal(ciphertextBytes.length, size);
    }
  });
});
