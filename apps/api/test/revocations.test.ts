import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalize } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import type { JsonWebKey } from "../../../packages/core/src/index.ts";
import {
  REVOCATION_KINDS,
  isRevoked,
  isRevocationKind,
  loadRevocations,
  verifyRevocation,
  type Revocation,
} from "../src/revocations.ts";
import { post, start, stop } from "./helpers.ts";

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

test("a revocation signed with a post-quantum key verifies", () => {
  const keypair = generateAgentKeypair("ml-dsa-44");
  const signer = new AgentSigner(keypair.privateKey);

  assert.equal(
    verifyRevocation(keypair.publicKey as unknown as JsonWebKey, {
      revocation,
      signature: signer.sign(revocation),
    }),
    true,
  );
});

test("a post-quantum revocation signature over other content does not verify", () => {
  const keypair = generateAgentKeypair("ml-dsa-44");
  const signer = new AgentSigner(keypair.privateKey);

  assert.equal(
    verifyRevocation(keypair.publicKey as unknown as JsonWebKey, {
      revocation,
      signature: signer.sign({ ...revocation, target: "b".repeat(64) }),
    }),
    false,
  );
});

test("`key` is a revocation kind, and only known kinds are", () => {
  assert.ok(REVOCATION_KINDS.includes("key"), "a key can be revoked AS a key (RFC 0019 Q4)");
  for (const kind of REVOCATION_KINDS) {
    assert.equal(isRevocationKind(kind), true, `${kind} is a kind`);
  }
  for (const value of ["nonsense", "", 7, null, undefined, {}]) {
    assert.equal(isRevocationKind(value), false, `${String(value)} is not a kind`);
  }
});

test("a key revocation loads from the published list, and junk is dropped", () => {
  const original = process.env.RAREXT_REVOCATIONS;
  delete process.env.RAREXT_REVOCATIONS;
  try {
    assert.deepEqual(loadRevocations(), [], "nothing configured is an empty list, not an error");

    process.env.RAREXT_REVOCATIONS = JSON.stringify({
      revocations: [
        { id: "rev-key-1", kind: "key", target: "key-abc", reason: "do not trust this key" },
        { id: "broken" },
        { id: "rev-bad-kind", kind: "whatever", target: "x" },
      ],
    });

    const list = loadRevocations();
    assert.equal(list.length, 1, `malformed entries are dropped: ${JSON.stringify(list)}`);
    assert.equal(list[0].kind, "key");
    assert.equal(list[0].target, "key-abc");
    assert.equal(list[0].reason, "do not trust this key");
  } finally {
    if (original === undefined) delete process.env.RAREXT_REVOCATIONS;
    else process.env.RAREXT_REVOCATIONS = original;
  }
});

test("the route publishes a signed key revocation and refuses an unknown kind", async () => {
  const app = await start();
  try {
    // The route asks for a REGISTERED issuer and a SIGNED revocation, so the
    // test does exactly that rather than posting an anonymous body and calling
    // the 401 a pass.
    const signer = new AgentSigner(generateAgentKeypair().privateKey);
    const registered = await post(app.base, "/v1/identities", {
      handle: "revoker",
      publicKey: signer.publicKey as unknown as JsonWebKey,
    });
    assert.ok(registered.status < 400, await registered.text());

    const keyRevocation = {
      id: "rev-key-route",
      kind: "key" as const,
      target: "key-abc",
      reason: "do not trust this key",
      issuer: "revoker",
      issuedAt: new Date().toISOString(),
    };
    const accepted = await post(app.base, "/v1/revocations", {
      revocation: keyRevocation,
      signature: signer.sign(keyRevocation),
    });
    assert.equal(accepted.status, 201, await accepted.text());

    const served = await fetch(`${app.base}/v1/revocations`);
    const list = (await served.json()) as { kind: string; target: string }[];
    assert.ok(
      list.some((entry) => entry.kind === "key" && entry.target === "key-abc"),
      `the revocation is served back: ${JSON.stringify(list)}`,
    );

    const refused = await post(app.base, "/v1/revocations", {
      revocation: { ...keyRevocation, id: "rev-x", kind: "nonsense" },
      signature: signer.sign({ ...keyRevocation, id: "rev-x", kind: "nonsense" }),
    });
    assert.equal(refused.status, 400, "an unknown kind is refused at the door, even signed");
  } finally {
    await stop(app.server);
  }
});
