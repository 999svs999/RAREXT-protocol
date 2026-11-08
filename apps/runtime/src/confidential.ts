import {
  constants,
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/canonical.ts";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const RSA_PADDING = constants.RSA_PKCS1_OAEP_PADDING;

/** A prompt sealed to an enclave: a data key wrapped to it, and the ciphertext. */
export interface SealedRequest {
  /** Base64 RSA-OAEP(data key), openable only by the enclave's private key. */
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
}

/** A response sealed under the caller's data key. */
export interface SealedResponse {
  nonce: string;
  ciphertext: string;
}

function aesSeal(key: Uint8Array, plain: Uint8Array): { nonce: string; ciphertext: string } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("base64"),
    ciphertext: `${body.toString("base64")}.${tag.toString("base64")}`,
  };
}

function aesOpen(key: Uint8Array, nonce: string, ciphertext: string): Buffer {
  const [body, tag] = ciphertext.split(".");
  if (body === undefined || tag === undefined) {
    throw new Error("sealed ciphertext must be body.tag");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]);
}

/**
 * Seal a request to an enclave. The caller keeps the returned `key`; the enclave
 * — and only the enclave — can unwrap it. Everything on the wire is ciphertext,
 * so a forwarding provider, a relay, or a log sees the prompt shape but never its
 * contents.
 */
export function sealRequest(
  enclavePublicKey: KeyObject | string,
  body: unknown,
): { sealed: SealedRequest; key: Buffer } {
  const key = randomBytes(KEY_BYTES);
  const wrappedKey = publicEncrypt(
    { key: enclavePublicKey, padding: RSA_PADDING, oaepHash: "sha256" },
    key,
  ).toString("base64");
  const { nonce, ciphertext } = aesSeal(key, Buffer.from(canonicalize(body), "utf8"));
  return { sealed: { wrappedKey, nonce, ciphertext }, key };
}

/**
 * Open a sealed request inside the enclave. Returns the plaintext body and the
 * data key, which the enclave reuses (with a fresh nonce) to seal the response.
 */
export function openRequest(
  enclavePrivateKey: KeyObject | string,
  sealed: SealedRequest,
): { body: unknown; key: Buffer } {
  if (
    typeof sealed !== "object" ||
    sealed === null ||
    typeof sealed.wrappedKey !== "string" ||
    typeof sealed.nonce !== "string" ||
    typeof sealed.ciphertext !== "string"
  ) {
    throw new Error("a sealed request needs a wrappedKey, a nonce, and ciphertext");
  }
  let key: Buffer;
  try {
    key = privateDecrypt(
      { key: enclavePrivateKey, padding: RSA_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed.wrappedKey, "base64"),
    );
  } catch {
    throw new Error("the enclave key does not unwrap this request");
  }
  if (key.length !== KEY_BYTES) throw new Error("the unwrapped request key is the wrong size");
  return { body: JSON.parse(aesOpen(key, sealed.nonce, sealed.ciphertext).toString("utf8")), key };
}

/** Seal a response under the caller's data key. */
export function sealResponse(key: Uint8Array, body: unknown): SealedResponse {
  return aesSeal(key, Buffer.from(canonicalize(body), "utf8"));
}

/** Open a sealed response with the data key the caller kept. */
export function openResponse(key: Uint8Array, sealed: SealedResponse): unknown {
  return JSON.parse(aesOpen(key, sealed.nonce, sealed.ciphertext).toString("utf8"));
}
