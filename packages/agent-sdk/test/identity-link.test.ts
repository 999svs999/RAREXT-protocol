import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalize } from "@rarext/core";
import type { IdentityLink, IdentityLinkPayload } from "@rarext/core";
import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
  identityLinkBinding,
} from "../src/index.ts";
import type { TracIdentityProof } from "../src/index.ts";

const ADDRESS = "fe947e14ea4d8a1ebc6084a9d9f7d59a39d69391def69e539d2c10c808d4c1ef";

function payload(signer: AgentSigner): IdentityLinkPayload {
  return signer.identityLinkPayload({
    handle: "alice",
    network: "trac",
    externalId: ADDRESS,
    proofUrl: `https://reset.openmayhem.ai/v1/account/${ADDRESS}`,
    createdAt: "2026-10-23T12:00:00.000Z",
    nonce: "0123456789abcdef",
  });
}

test("identityLinkBinding is sha256 over the canonical payload", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const value = payload(signer);

  const expected = createHash("sha256").update(canonicalize(value)).digest("hex");

  assert.equal(identityLinkBinding(value), expected);
  assert.equal(identityLinkBinding(value).length, 64);
  assert.notEqual(identityLinkBinding({ ...value, nonce: "other-nonce" }), expected);
});

test("linkIdentity forwards a Trac external proof in the request body", async () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const value = payload(signer);
  const proof: TracIdentityProof = {
    kind: "trac",
    challenge: {
      v: 1,
      domain: "reset-mcp-login",
      audience: "http://127.0.0.1:8787",
      address: ADDRESS,
      nonce: identityLinkBinding(value),
      issued_at: 1_760_000_000_000,
      expires_at: 1_760_000_060_000,
    },
    signature: "ab".repeat(64),
  };

  let captured: Record<string, unknown> | undefined;
  const link: IdentityLink = {
    id: "link-1",
    handle: "alice",
    network: "trac",
    externalId: ADDRESS,
    proofUrl: value.proofUrl,
    verified: true,
    createdAt: "2026-10-23T12:00:01.000Z",
  };
  const client = new RarextClient({
    baseUrl: "http://example.test",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(link), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const created = await client.linkIdentity(value, "signature", proof);

  assert.equal(created.id, "link-1");
  assert.deepEqual(captured?.payload, value);
  assert.deepEqual(captured?.externalProof, proof);
});

test("linkIdentity omits externalProof when none is supplied", async () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const value = payload(signer);

  let captured: Record<string, unknown> | undefined;
  const client = new RarextClient({
    baseUrl: "http://example.test",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({}), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await client.linkIdentity(value, "signature");

  assert.equal("externalProof" in (captured ?? {}), false);
});
