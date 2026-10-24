import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DurabilityLedger,
  directoryHolder,
} from "../src/durability.ts";
import { encodeBytes, decodeBytes } from "../src/erasure.ts";

import {
  SealedKeyring,
  decryptSealedPayload,
  encryptSealedPayload,
  isSealedMetadata,
  sealedMetadata,
  type SealedEnvelope,
  type SealedMetadata,
} from "../src/sealed-encryption.ts";

test("sealed storage tier encrypts payloads client-side so holder directories never contain plaintext", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-sealed-"));
  const holders = [
    directoryHolder("h-0", join(root, "h-0")),
    directoryHolder("h-1", join(root, "h-1")),
  ];

  try {
    const secret = "super-secret-user-master-key";
    const sensitivePayload = Buffer.from("CONFIDENTIAL_PROJECT_TOP_SECRET_PAYLOAD_12345");

    // 1. Encrypt client-side
    const { envelope, ciphertextBytes } = encryptSealedPayload(sensitivePayload, secret);

    // 2. Erasure encode the ciphertext bytes (not the plaintext)
    const encoded = encodeBytes(ciphertextBytes, 1, 1);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(encoded, holders, "pinned");

    // 3. Inspect both holder directories on disk
    const files = [join(root, "h-0"), join(root, "h-1")].flatMap(readdirNamesRecursive);
    assert.ok(files.length > 0, "the holder directories must actually contain shard files");

    let foundPlaintext = false;
    let foundSecret = false;

    for (const file of files) {
      const content = readFileSync(file);
      if (content.includes(sensitivePayload)) foundPlaintext = true;
      if (content.includes(secret)) foundSecret = true;
    }

    assert.equal(foundPlaintext, false, "holder storage must never contain plaintext payload");
    assert.equal(foundSecret, false, "holder storage must never contain the sealing secret");

    // 4. Retrieve shards, decode ciphertext, decrypt client-side
    const shardRecord = placement.shards[0]!;
    const storedShardBytes = await holders[0]!.get(shardRecord.storedAs);
    assert.ok(storedShardBytes);

    const decodedCiphertext = decodeBytes([encoded[0]!]);

    const decrypted = decryptSealedPayload(envelope, secret);
    assert.deepEqual(Buffer.from(decrypted), sensitivePayload);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readdirNamesRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...readdirNamesRecursive(full));
      } else {
        results.push(full);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

test("sealed keyring rotates active keys while old blobs remain readable by key id", () => {
  const payload = Buffer.from("ROTATED_SEALED_PAYLOAD_MARKER");
  const firstSecret = "sealed-keyring-first-secret";
  const secondSecret = "sealed-keyring-second-secret";
  const first = new SealedKeyring({ active: "k1", keys: { k1: firstSecret } });
  const one = first.seal(payload);
  const second = new SealedKeyring({
    active: "k2",
    keys: { k1: firstSecret, k2: secondSecret },
  });
  const two = second.seal(payload);

  assert.equal(second.active, "k2");
  assert.equal(one.envelope.keyId, "k1");
  assert.equal(two.envelope.keyId, "k2");
  assert.deepEqual(Buffer.from(second.open(sealedMetadata(one.envelope), one.ciphertextBytes)), payload);
  assert.deepEqual(Buffer.from(second.open(sealedMetadata(two.envelope), two.ciphertextBytes)), payload);
  assert.notEqual(
    Buffer.from(one.ciphertextBytes).toString("hex"),
    Buffer.from(two.ciphertextBytes).toString("hex"),
  );

  const revoked = new SealedKeyring({
    active: "k2",
    keys: { k1: firstSecret, k2: secondSecret },
    revoked: ["k1"],
  });
  assert.throws(() => revoked.open(sealedMetadata(one.envelope), one.ciphertextBytes), /k1 is revoked/);

  const unknown = new SealedKeyring({ active: "k2", keys: { k2: secondSecret } });
  assert.throws(
    () => unknown.open(sealedMetadata(one.envelope), one.ciphertextBytes),
    /unknown sealed key id: k1/,
  );
  assert.throws(
    () =>
      new SealedKeyring({
        active: "k2",
        keys: { k1: firstSecret, k2: secondSecret },
        revoked: ["k2"],
      }),
    /active sealed key id is revoked/,
  );
});

test("sealed keyring opens legacy blobs without a key id through a configured legacy key", () => {
  const payload = Buffer.from("LEGACY_SEALED_PAYLOAD_MARKER");
  const legacySecret = "sealed-keyring-legacy-secret";
  const { envelope, ciphertextBytes } = encryptSealedPayload(payload, legacySecret);

  assert.equal(envelope.keyId, undefined);
  assert.equal(isSealedMetadata(sealedMetadata(envelope)), true);

  const migrated = new SealedKeyring({
    active: "k2",
    keys: { legacy: legacySecret, k2: "sealed-keyring-new-secret" },
  });

  assert.deepEqual(Buffer.from(migrated.open(sealedMetadata(envelope), ciphertextBytes)), payload);

  const ambiguous = new SealedKeyring({
    active: "k2",
    keys: { k1: legacySecret, k2: "sealed-keyring-new-secret" },
  });
  assert.throws(
    () => ambiguous.open(sealedMetadata(envelope), ciphertextBytes),
    /does not name a key id/,
  );
});

test("a mismatched sealed key id fails the whole blob without partial plaintext", () => {
  const payload = Buffer.from("MISMATCHED_KEY_ID_PLAINTEXT_MARKER");
  const firstSecret = "sealed-keyring-mismatch-first";
  const secondSecret = "sealed-keyring-mismatch-second";
  const { envelope, ciphertextBytes } = encryptSealedPayload(payload, firstSecret, "k1");
  const wrong: SealedMetadata = { ...sealedMetadata(envelope), keyId: "k2" };
  const keyring = new SealedKeyring({
    active: "k2",
    keys: { k1: firstSecret, k2: secondSecret },
  });

  assert.throws(
    () => keyring.open(wrong, ciphertextBytes),
    /authentication failed/,
  );
  assert.deepEqual(Buffer.from(keyring.open(sealedMetadata(envelope), ciphertextBytes)), payload);
});

test("sealed validation rejects malformed keys and metadata without leaking material", () => {
  const payload = Buffer.from("SEALED_LEAK_TEST_PLAINTEXT_MARKER");
  const secret = "sealed-leak-test-secret-at-least-16";
  const { envelope, ciphertextBytes } = encryptSealedPayload(payload, secret, "k1");
  const metadata = sealedMetadata(envelope);

  assert.throws(() => encryptSealedPayload(payload, "too-short"), /at least 16 bytes/);
  assert.throws(
    () => encryptSealedPayload(payload, "a".repeat(1025)),
    /at most 1024 bytes/,
  );
  assert.throws(
    () => encryptSealedPayload(payload, "\ud800".repeat(8)),
    /valid UTF-8/,
  );
  assert.throws(
    () => encryptSealedPayload(payload, secret, "bad key id"),
    /sealed key id/,
  );
  assert.throws(
    () => new SealedKeyring({ active: "k1", keys: { k1: "too-short" } }),
    /at least 16 bytes/,
  );
  assert.throws(
    () => new SealedKeyring({ active: "bad id", keys: { k1: secret } }),
    /active sealed key id/,
  );

  assert.equal(isSealedMetadata(metadata), true);
  assert.equal(isSealedMetadata({ ...metadata, keyId: 123 }), false);
  assert.equal(isSealedMetadata({ ...metadata, salt: "not base64" }), false);
  assert.equal(isSealedMetadata({ ...metadata, iv: "a".repeat(24) + "=" }), false);

  const markerIv = Buffer.from("0123456789ab").toString("base64");
  const tampered: SealedEnvelope = { ...envelope, iv: markerIv };
  const errors: Error[] = [];

  try {
    decryptSealedPayload(tampered, secret);
  } catch (error) {
    errors.push(error as Error);
  }

  try {
    decryptSealedPayload({ ...envelope, iv: "not base64!!!!" }, secret);
  } catch (error) {
    errors.push(error as Error);
  }

  const revoked = new SealedKeyring({
    active: "k2",
    keys: { k1: secret, k2: "sealed-leak-test-second-key" },
    revoked: ["k1"],
  });

  try {
    revoked.open(metadata, ciphertextBytes);
  } catch (error) {
    errors.push(error as Error);
  }

  assert.equal(errors.length, 3);

  for (const error of errors) {
    const text = `${error.message}\n${String(error)}\n${JSON.stringify(error)}`;
    for (const forbidden of [
      secret,
      payload.toString("utf8"),
      envelope.salt,
      envelope.authTag,
      envelope.ciphertext,
      markerIv,
    ]) {
      assert.equal(text.includes(forbidden), false, "sealed errors must not leak material");
    }
  }

  assert.match(errors[0]!.message, /authentication failed/);
});
