import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

export interface SealedEnvelope {
  ciphertext: string; // base64
  iv: string;         // base64
  authTag: string;    // base64
  salt: string;       // base64
}

export function encryptSealedPayload(
  payload: Uint8Array,
  secret: string,
): { envelope: SealedEnvelope; ciphertextBytes: Uint8Array } {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(secret, salt, 100_000, 32, "sha256");

  const cipher = createCipheriv("aes-256-gcm", key, iv);
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
  const key = pbkdf2Sync(secret, salt, 100_000, 32, "sha256");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}
