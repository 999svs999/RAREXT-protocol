import { createHash, createPublicKey, verify } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  CryptoProfile,
  JsonWebKey,
  SignatureSuite,
  SignatureSuiteInfo,
} from "../../../packages/core/src/index.ts";

type NodeJwk = import("node:crypto").JsonWebKey;

function nodeJwk(key: JsonWebKey): NodeJwk {
  return key as unknown as NodeJwk;
}

export function keyId(publicKey: JsonWebKey): string {
  return createHash("sha256").update(canonicalize(publicKey)).digest("hex");
}

/**
 * Which suite a key belongs to.
 *
 * The suite is derived from the key itself rather than trusted from the request,
 * so a caller cannot claim a post-quantum key for a classical one.
 */
export function suiteFor(publicKey: JsonWebKey): SignatureSuite | null {
  const key = publicKey as unknown as Record<string, unknown>;

  if (key.kty === "EC" && key.crv === "P-256") return "ecdsa-p256";
  if (key.kty === "AKP" && key.alg === "ML-DSA-44") return "ml-dsa-44";
  if (key.kty === "AKP" && key.alg === "ML-DSA-65") return "ml-dsa-65";

  return null;
}

export function profileFor(suite: SignatureSuite): CryptoProfile {
  return suite === "ecdsa-p256" ? "classical" : "post-quantum";
}

export function quantumSafe(suite: SignatureSuite): boolean {
  return profileFor(suite) === "post-quantum";
}

export function asPublicKey(value: unknown): JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("publicKey must be a JSON object");
  }

  const key = value as JsonWebKey;
  const suite = suiteFor(key);

  if (!suite) {
    throw new Error(
      "publicKey must be an EC P-256 key or an ML-DSA-44/ML-DSA-65 key",
    );
  }

  if (key.d !== undefined) {
    throw new Error("publicKey must not contain private key material");
  }

  if (suite === "ecdsa-p256") {
    if (typeof key.x !== "string" || typeof key.y !== "string") {
      throw new Error("publicKey is missing coordinates");
    }

    createPublicKey({ key: nodeJwk(key), format: "jwk" });

    return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
  }

  const raw = (key as unknown as Record<string, unknown>).pub;

  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("publicKey is missing its public value");
  }

  createPublicKey({ key: nodeJwk(key), format: "jwk" });

  return { kty: key.kty, alg: key.alg, pub: raw } as JsonWebKey;
}

/**
 * Verify a signature over a payload.
 *
 * The suite decides the verification: ECDSA signs a SHA-256 digest in the
 * P1363 encoding, ML-DSA signs the message itself. Both are checked against
 * the *canonical* payload bytes, so a signature covers exactly what a reader
 * would reconstruct.
 */
export function verifyPayload(
  publicKey: JsonWebKey,
  payload: unknown,
  signature: string,
  suite?: SignatureSuite,
): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;

  const resolved = suite ?? suiteFor(publicKey);
  if (!resolved) return false;

  try {
    const bytes = Buffer.from(signature, "base64");
    const message = Buffer.from(canonicalize(payload));
    const key = createPublicKey({ key: nodeJwk(publicKey), format: "jwk" });

    if (resolved === "ecdsa-p256") {
      if (bytes.length !== 64) return false;

      return verify(
        "sha256",
        message,
        { key, dsaEncoding: "ieee-p1363" },
        bytes,
      );
    }

    return verify(null, message, key, bytes);
  } catch {
    return false;
  }
}

export const SUPPORTED_SUITES: SignatureSuiteInfo[] = [
  {
    suite: "ecdsa-p256",
    profile: "classical",
    quantumSafe: false,
    available: true,
    note: "What a browser can do today. Broken by a cryptographically relevant quantum computer, so treat it as a transitional suite.",
  },
  {
    suite: "ml-dsa-44",
    profile: "post-quantum",
    quantumSafe: true,
    available: true,
    note: "Post-quantum, 128-bit classical security, ~2.4 KB signatures. Needs OpenSSL 3.5, so agents and servers yes, browsers not yet.",
  },
  {
    suite: "ml-dsa-65",
    profile: "post-quantum",
    quantumSafe: true,
    available: true,
    note: "Post-quantum, 192-bit classical security, ~3.3 KB signatures. For keys that need a longer horizon.",
  },
];

export function cryptoPolicy(): {
  suites: SignatureSuiteInfo[];
  defaultSuite: SignatureSuite;
  commitmentHash: string;
  note: string;
} {
  return {
    suites: SUPPORTED_SUITES,
    defaultSuite: "ecdsa-p256",
    commitmentHash: "sha256",
    note: "Content commitments are hash based and stay sound under Grover; the signature suite is the part a quantum computer breaks, and every claim records which one signed it.",
  };
}
