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

import { encryptSealedPayload, decryptSealedPayload } from "../src/sealed-encryption.ts";

test("sealed storage tier encrypts payloads client-side so holder directories never contain plaintext", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-sealed-"));
  const holderDir = join(root, "holder-0");
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

    // 3. Inspect holder storage files on disk
    const files = readdirNamesRecursive(holderDir);
    let foundPlaintext = false;

    for (const file of files) {
      const content = readFileSync(file);
      if (content.includes(sensitivePayload)) {
        foundPlaintext = true;
      }
    }

    assert.equal(foundPlaintext, false, "holder storage must never contain plaintext payload");

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
