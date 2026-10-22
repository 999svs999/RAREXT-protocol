import { createHash, createPublicKey, verify } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { JsonWebKey } from "../../../packages/core/src/index.ts";

type NodeJwk = import("node:crypto").JsonWebKey;

function nodeJwk(key: JsonWebKey): NodeJwk {
  return key as unknown as NodeJwk;
}

export function keyId(publicKey: JsonWebKey): string {
  return createHash("sha256").update(canonicalize(publicKey)).digest("hex");
}

export function asPublicKey(value: unknown): JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("publicKey must be a JSON object");
  }

  const key = value as JsonWebKey;

  if (key.kty !== "EC" || key.crv !== "P-256") {
    throw new Error("publicKey must be an EC P-256 key");
  }

  if (typeof key.x !== "string" || typeof key.y !== "string") {
    throw new Error("publicKey is missing coordinates");
  }

  if (key.d !== undefined) {
    throw new Error("publicKey must not contain private key material");
  }

  createPublicKey({ key: nodeJwk(key), format: "jwk" });

  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
}

export function verifyPayload(
  publicKey: JsonWebKey,
  payload: unknown,
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;

  try {
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length !== 64) return false;

    return verify(
      "sha256",
      Buffer.from(canonicalize(payload)),
      { key: createPublicKey({ key: nodeJwk(publicKey), format: "jwk" }), dsaEncoding: "ieee-p1363" },
      bytes,
    );
  } catch {
    return false;
  }
}
