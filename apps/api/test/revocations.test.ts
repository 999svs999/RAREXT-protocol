import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { JsonWebKey } from "../../../packages/core/src/index.ts";
import {
  isRevoked,
  verifyRevocation,
  type Revocation,
} from "../src/revocations.ts";

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;

const revocation: Revocation = {
  id: "rev-1",
  kind: "verifier",
  target: "a".repeat(64),
  reason: "the verifier was found to accept unsettled circuits",
  issuer: "operator",
  issuedAt: "2026-10-22T00:00:00.000Z",
};

function signRevocation(value: Revocation): string {
  return sign(
    "sha256",
    Buffer.from(canonicalize(value), "utf8"),
    { key: pair.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64");
}

test("a signed revocation verifies", () => {
  assert.equal(
    verifyRevocation(jwk, { revocation, signature: signRevocation(revocation) }),
    true,
  );
});

test("a tampered revocation does not verify", () => {
  const signature = signRevocation(revocation);
  const tampered = { ...revocation, target: "b".repeat(64) };

  assert.equal(verifyRevocation(jwk, { revocation: tampered, signature }), false);
});

test("a revocation signed by somebody else does not verify", () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signature = sign(
    "sha256",
    Buffer.from(canonicalize(revocation), "utf8"),
    { key: other.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64");

  assert.equal(verifyRevocation(jwk, { revocation, signature }), false);
});

test("a revocation is found by kind and target", () => {
  const list = [revocation];

  assert.equal(isRevoked(list, "verifier", "a".repeat(64))?.id, "rev-1");
  assert.equal(isRevoked(list, "capability", "a".repeat(64)), null);
  assert.equal(isRevoked(list, "verifier", "b".repeat(64)), null);
});
