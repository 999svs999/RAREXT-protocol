import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { CapabilityGrant, JsonWebKey } from "../../../packages/core/src/index.ts";
import {
  decodeCapability,
  encodeCapability,
  verifyCapability,
} from "../src/capabilities.ts";

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    artifactId: "artifact-1",
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    nonce: "nonce-1",
    grantee: null,
    ...overrides,
  };
}

function signGrant(value: CapabilityGrant, privateKey = pair.privateKey): string {
  return sign(
    "sha256",
    Buffer.from(canonicalize(value), "utf8"),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64");
}

test("a capability signed by the author opens the artifact", () => {
  const value = grant();
  const token = encodeCapability({ grant: value, signature: signGrant(value) });

  const check = verifyCapability(jwk, token, "artifact-1");
  assert.equal(check.ok, true);
  assert.equal(check.reason, null);
});

test("a capability for another artifact does not open this one", () => {
  const value = grant({ artifactId: "artifact-2" });
  const token = encodeCapability({ grant: value, signature: signGrant(value) });

  const check = verifyCapability(jwk, token, "artifact-1");
  assert.equal(check.ok, false);
  assert.match(check.reason ?? "", /different artifact/);
});

test("an expired capability does not open anything", () => {
  const value = grant({ expiresAt: "2000-01-01T00:00:00.000Z" });
  const token = encodeCapability({ grant: value, signature: signGrant(value) });

  const check = verifyCapability(jwk, token, "artifact-1");
  assert.equal(check.ok, false);
  assert.match(check.reason ?? "", /expired/);
});

test("a capability signed by somebody else does not open anything", () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const value = grant();
  const token = encodeCapability({
    grant: value,
    signature: signGrant(value, other.privateKey),
  });

  const check = verifyCapability(jwk, token, "artifact-1");
  assert.equal(check.ok, false);
  assert.match(check.reason ?? "", /not valid/);
});

test("a tampered grant does not open anything", () => {
  const value = grant();
  const token = encodeCapability({ grant: value, signature: signGrant(value) });
  const decoded = decodeCapability(token);

  assert.ok(decoded);
  decoded.grant.artifactId = "artifact-2";

  const check = verifyCapability(jwk, encodeCapability(decoded), "artifact-2");
  assert.equal(check.ok, false);
  assert.match(check.reason ?? "", /not valid/);
});

test("a malformed capability is refused rather than crashing", () => {
  assert.equal(verifyCapability(jwk, "not-a-token", "artifact-1").ok, false);
  assert.equal(verifyCapability(jwk, "", "artifact-1").ok, false);
  assert.equal(
    verifyCapability(jwk, Buffer.from("{}").toString("base64url"), "artifact-1").ok,
    false,
  );
});

test("the key id of a public key is stable", () => {
  const id = createHash("sha256").update(canonicalize(jwk)).digest("hex");
  assert.equal(id.length, 64);
  assert.equal(
    id,
    createHash("sha256").update(canonicalize(jwk)).digest("hex"),
  );
});
