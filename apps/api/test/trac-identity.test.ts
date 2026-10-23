import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { Identity, IdentityLink, IdentityLinkPayload } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function binding(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function tracKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };

  return {
    address: Buffer.from(jwk.x, "base64url").toString("hex"),
    privateKey,
  };
}

function challenge(
  audience: string,
  address: string,
  nonce: string,
  issuedAt = Date.now(),
) {
  return {
    v: 1,
    domain: "reset-mcp-login",
    audience,
    address,
    nonce,
    issued_at: issuedAt,
    expires_at: issuedAt + 60_000,
  };
}

function signChallenge(
  value: Record<string, unknown>,
  privateKey: ReturnType<typeof tracKeypair>["privateKey"],
): string {
  const message = `RESET MCP LOGIN\n${stableStringify(value)}`;

  return sign(null, Buffer.from(message), privateKey).toString("hex");
}

test("links a RAREXT handle to a RESET Ed25519 challenge signature", async () => {
  const { server, base } = await start();

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const trac = tracKeypair();

    const register = await post(base, "/v1/identities", {
      handle: "alice",
      publicKey: publicKey.export({ format: "jwk" }),
    });
    assert.equal(register.status, 201);
    const identity = (await register.json()) as Identity;

    const payload: IdentityLinkPayload = {
      kind: "rarext.identity-link",
      version: 1,
      handle: "alice",
      keyId: identity.keyId,
      network: "trac",
      externalId: trac.address,
      proofUrl: `https://reset.openmayhem.ai/v1/account/${trac.address}`,
      createdAt: new Date().toISOString(),
      nonce: randomBytes(12).toString("hex"),
    };
    const signature = sign("sha256", Buffer.from(canonicalize(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");

    const value = challenge(base, trac.address, binding(payload));
    const linked = await post(base, "/v1/identity-links", {
      payload,
      signature,
      externalProof: {
        kind: "trac",
        challenge: value,
        signature: signChallenge(value, trac.privateKey),
      },
    });

    assert.equal(linked.status, 201);
    const link = (await linked.json()) as IdentityLink;
    assert.equal(link.verified, true);
    assert.equal(link.network, "trac");
    assert.equal(link.externalId, trac.address);

    const listed = (await (
      await fetch(`${base}/v1/identity-links/alice`)
    ).json()) as IdentityLink[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, link.id);

    const adapters = (await (
      await fetch(`${base}/v1/adapters/trac`)
    ).json()) as { details: { nativeIdentity: boolean } };
    assert.equal(adapters.details.nativeIdentity, true);
  } finally {
    await stop(server);
  }
});

test("rejects a Trac challenge that does not bind the RAREXT payload", async () => {
  const { server, base } = await start();

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const trac = tracKeypair();

    const register = await post(base, "/v1/identities", {
      handle: "alice",
      publicKey: publicKey.export({ format: "jwk" }),
    });
    const identity = (await register.json()) as Identity;

    const payload: IdentityLinkPayload = {
      kind: "rarext.identity-link",
      version: 1,
      handle: "alice",
      keyId: identity.keyId,
      network: "trac",
      externalId: trac.address,
      proofUrl: `https://reset.openmayhem.ai/v1/account/${trac.address}`,
      createdAt: new Date().toISOString(),
      nonce: randomBytes(12).toString("hex"),
    };
    const signature = sign("sha256", Buffer.from(canonicalize(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");

    const value = challenge(base, trac.address, binding(payload));
    const tampered: IdentityLinkPayload = { ...payload, nonce: `${payload.nonce}ff` };
    const tamperedSignature = sign("sha256", Buffer.from(canonicalize(tampered)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");

    const rejected = await post(base, "/v1/identity-links", {
      payload: tampered,
      signature: tamperedSignature,
      externalProof: {
        kind: "trac",
        challenge: value,
        signature: signChallenge(value, trac.privateKey),
      },
    });

    assert.equal(rejected.status, 422);
  } finally {
    await stop(server);
  }
});

test("rejects a Trac challenge from a different address", async () => {
  const { server, base } = await start();

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const trac = tracKeypair();
    const other = tracKeypair();

    const register = await post(base, "/v1/identities", {
      handle: "alice",
      publicKey: publicKey.export({ format: "jwk" }),
    });
    const identity = (await register.json()) as Identity;

    const payload: IdentityLinkPayload = {
      kind: "rarext.identity-link",
      version: 1,
      handle: "alice",
      keyId: identity.keyId,
      network: "trac",
      externalId: trac.address,
      proofUrl: `https://reset.openmayhem.ai/v1/account/${trac.address}`,
      createdAt: new Date().toISOString(),
      nonce: randomBytes(12).toString("hex"),
    };
    const signature = sign("sha256", Buffer.from(canonicalize(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");

    const value = challenge(base, other.address, binding(payload));

    const rejected = await post(base, "/v1/identity-links", {
      payload,
      signature,
      externalProof: {
        kind: "trac",
        challenge: value,
        signature: signChallenge(value, other.privateKey),
      },
    });

    assert.equal(rejected.status, 422);
  } finally {
    await stop(server);
  }
});
