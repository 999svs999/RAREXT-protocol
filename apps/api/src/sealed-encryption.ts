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
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 1024;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface SealedEnvelope {
  ciphertext: string; // base64
  iv: string;         // base64
  authTag: string;    // base64
  salt: string;       // base64
  keyId?: string;
}

export interface SealedMetadata {
  algorithm: typeof SEALED_ALGORITHM;
  kdf: typeof SEALED_KDF;
  salt: string;
  iv: string;
  authTag: string;
  keyId?: string;
}

export interface SealedKeyringOptions {
  active: string;
  keys: Record<string, string>;
  revoked?: readonly string[];
}

function assertKeyId(value: unknown, name = "sealed key id"): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw new Error(`${name} must be 1-64 letters, digits, dots, colons, underscores, or hyphens`);
  }

  return value;
}

function assertSecret(secret: unknown): string {
  if (typeof secret !== "string") throw new Error("sealed secret must be a string");

  const bytes = Buffer.from(secret, "utf8");

  if (bytes.toString("utf8") !== secret) throw new Error("sealed secret must be valid UTF-8");
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new Error(`sealed secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (bytes.length > MAX_SECRET_BYTES) {
    throw new Error(`sealed secret must be at most ${MAX_SECRET_BYTES} bytes`);
  }

  return secret;
}

function base64(value: unknown, name: string, length?: number): Buffer {
  if (typeof value !== "string" || !BASE64.test(value) || value.length % 4 !== 0) {
    throw new Error(`${name} must be base64`);
  }

  const bytes = Buffer.from(value, "base64");

  if (bytes.toString("base64") !== value) throw new Error(`${name} must be canonical base64`);
  if (length !== undefined && bytes.length !== length) {
    throw new Error(`${name} must be ${length} bytes`);
  }

  return bytes;
}

function deriveKey(secret: string, salt: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, Buffer.from(HKDF_INFO, "utf8"), KEY_BYTES),
  );
}

export function encryptSealedPayload(
  payload: Uint8Array,
  secret: string,
  keyId?: string,
): { envelope: SealedEnvelope; ciphertextBytes: Uint8Array } {
  assertSecret(secret);
  if (keyId !== undefined) assertKeyId(keyId);

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(secret, salt);

  try {
    const cipher = createCipheriv(SEALED_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      envelope: {
        ciphertext: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        salt: salt.toString("base64"),
        ...(keyId === undefined ? {} : { keyId }),
      },
      ciphertextBytes: Uint8Array.from(encrypted),
    };
  } finally {
    key.fill(0);
  }
}

export function decryptSealedPayload(envelope: SealedEnvelope, secret: string): Uint8Array {
  assertSecret(secret);

  const salt = base64(envelope.salt, "salt", SALT_BYTES);
  const iv = base64(envelope.iv, "iv", IV_BYTES);
  const authTag = base64(envelope.authTag, "authTag", 16);
  const ciphertext = base64(envelope.ciphertext, "ciphertext");
  const key = deriveKey(secret, salt);

  try {
    const decipher = createDecipheriv(SEALED_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new Error("sealed payload could not be decrypted: authentication failed");
  } finally {
    key.fill(0);
  }
}

/** The subset of an envelope a placement can record without storing the bytes. */
export function sealedMetadata(envelope: SealedEnvelope): SealedMetadata {
  return {
    algorithm: SEALED_ALGORITHM,
    kdf: SEALED_KDF,
    salt: envelope.salt,
    iv: envelope.iv,
    authTag: envelope.authTag,
    ...(envelope.keyId === undefined ? {} : { keyId: envelope.keyId }),
  };
}

/** Rebuild the decryption envelope from placement metadata and decoded ciphertext. */
export function sealedEnvelope(metadata: SealedMetadata, ciphertext: Uint8Array): SealedEnvelope {
  return {
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    iv: metadata.iv,
    authTag: metadata.authTag,
    salt: metadata.salt,
    ...(metadata.keyId === undefined ? {} : { keyId: metadata.keyId }),
  };
}

export function isSealedMetadata(value: unknown): value is SealedMetadata {
  if (!value || typeof value !== "object") return false;

  const record = value as Partial<SealedMetadata>;

  if (record.algorithm !== SEALED_ALGORITHM || record.kdf !== SEALED_KDF) return false;
  if (
    record.keyId !== undefined &&
    (typeof record.keyId !== "string" || !KEY_ID.test(record.keyId))
  ) {
    return false;
  }
  if (typeof record.salt !== "string" || typeof record.iv !== "string" || typeof record.authTag !== "string") {
    return false;
  }

  try {
    base64(record.salt, "salt", SALT_BYTES);
    base64(record.iv, "iv", IV_BYTES);
    base64(record.authTag, "authTag", 16);
  } catch {
    return false;
  }

  return true;
}

export class SealedKeyring {
  readonly active: string;
  private readonly keys: Map<string, string>;
  private readonly revoked: Set<string>;

  constructor(options: SealedKeyringOptions) {
    const active = assertKeyId(options.active, "active sealed key id");
    const entries = Object.entries(options.keys ?? {});

    if (entries.length === 0) throw new Error("sealed keyring must contain at least one key");

    this.keys = new Map();

    for (const [id, secret] of entries) {
      assertKeyId(id);
      assertSecret(secret);
      this.keys.set(id, secret);
    }

    if (!this.keys.has(active)) throw new Error(`active sealed key id ${active} is not configured`);

    this.revoked = new Set();

    for (const id of options.revoked ?? []) {
      this.revoked.add(assertKeyId(id, "revoked sealed key id"));
    }

    if (this.revoked.has(active)) throw new Error("the active sealed key id is revoked");
    this.active = active;
  }

  seal(payload: Uint8Array): { envelope: SealedEnvelope; ciphertextBytes: Uint8Array } {
    return encryptSealedPayload(payload, this.keys.get(this.active)!, this.active);
  }

  open(metadata: SealedMetadata, ciphertext: Uint8Array): Uint8Array {
    const keyId = metadata.keyId ?? this.legacyKeyId();

    if (!keyId) {
      throw new Error("sealed metadata does not name a key id and no legacy key is configured");
    }

    assertKeyId(keyId, "sealed metadata key id");

    if (this.revoked.has(keyId)) throw new Error(`sealed key ${keyId} is revoked`);

    const secret = this.keys.get(keyId);

    if (!secret) throw new Error(`unknown sealed key id: ${keyId}`);

    return decryptSealedPayload(sealedEnvelope(metadata, ciphertext), secret);
  }

  private legacyKeyId(): string | null {
    if (this.keys.has("legacy")) return "legacy";
    if (this.keys.size === 1) return this.keys.keys().next().value ?? null;

    return null;
  }
}
