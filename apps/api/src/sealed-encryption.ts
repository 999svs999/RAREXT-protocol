import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Client-side envelope encryption for the sealed tier (RFC 0015).
 *
 * The payload is encrypted before erasure coding, so holders only ever receive
 * ciphertext and every Merkle root in the placement commits to ciphertext. The
 * key is derived with HKDF-SHA256 from the caller's secret and a per-payload
 * 16-byte salt. The envelope carries no ciphertext: it travels beside the
 * erasure-coded payload so a placement can record the key parameters without
 * duplicating the bytes.
 */

export const SEALED_ALGORITHM = "aes-256-gcm" as const;
export const SEALED_KDF = "hkdf-sha256" as const;
const HKDF_INFO = "rarext-sealed-tier-v1";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface SealedEnvelope {
  ciphertext: string; // base64
  iv: string;         // base64
  authTag: string;    // base64
  salt: string;       // base64
}

export interface SealedMetadata {
  algorithm: typeof SEALED_ALGORITHM;
  kdf: typeof SEALED_KDF;
  salt: string;
  iv: string;
  authTag: string;
}

function deriveKey(secret: string, salt: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, Buffer.from(HKDF_INFO, "utf8"), KEY_BYTES),
  );
}

export function encryptSealedPayload(
  payload: Uint8Array,
  secret: string,
): { envelope: SealedEnvelope; ciphertextBytes: Uint8Array } {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(secret, salt);

  const cipher = createCipheriv(SEALED_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    envelope: {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      salt: salt.toString("base64"),
    },
    ciphertextBytes: Uint8Array.from(encrypted),
  };
}

export function decryptSealedPayload(envelope: SealedEnvelope, secret: string): Uint8Array {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.authTag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const key = deriveKey(secret, salt);

  const decipher = createDecipheriv(SEALED_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/** The subset of an envelope a placement can record without storing the bytes. */
export function sealedMetadata(envelope: SealedEnvelope): SealedMetadata {
  return {
    algorithm: SEALED_ALGORITHM,
    kdf: SEALED_KDF,
    salt: envelope.salt,
    iv: envelope.iv,
    authTag: envelope.authTag,
  };
}

/** Rebuild the decryption envelope from placement metadata and decoded ciphertext. */
export function sealedEnvelope(metadata: SealedMetadata, ciphertext: Uint8Array): SealedEnvelope {
  return {
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    iv: metadata.iv,
    authTag: metadata.authTag,
    salt: metadata.salt,
  };
}

export function isSealedMetadata(value: unknown): value is SealedMetadata {
  if (!value || typeof value !== "object") return false;

  const record = value as Partial<SealedMetadata>;

  if (record.algorithm !== SEALED_ALGORITHM || record.kdf !== SEALED_KDF) return false;
  if (typeof record.salt !== "string" || typeof record.iv !== "string" || typeof record.authTag !== "string") {
    return false;
  }

  return (
    Buffer.from(record.salt, "base64").length === SALT_BYTES &&
    Buffer.from(record.iv, "base64").length === IV_BYTES &&
    Buffer.from(record.authTag, "base64").length === 16
  );
}
