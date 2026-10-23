/**
 * Runnable Trac identity example: start a local API, register a RAREXT agent,
 * link it to a RESET Trac address, and read the link back.
 *
 *   node --experimental-strip-types examples/trac-identity/main.ts
 *
 * Everything is in-memory and removed on exit. The Trac address here is a fresh
 * local Ed25519 key standing in for Trac-Systems/reset's signer; the flow is the
 * same one a real RESET MCP signer performs.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { createApp } from "../../apps/api/src/app.ts";
import { hexToTrac } from "../../apps/api/src/adapters/trac-address.ts";
import { RarextStore } from "../../apps/api/src/store.ts";
import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
  identityLinkBinding,
} from "../../packages/agent-sdk/src/index.ts";
import type { ResetLoginChallenge } from "../../packages/agent-sdk/src/index.ts";

const MAX_CHALLENGE_TTL_MS = 120_000;

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

const store = new RarextStore();
const server = createApp({ store });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

try {
  const client = new RarextClient({ baseUrl: base });
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  await client.registerAgent(signer, "trac-demo");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const address = Buffer.from(jwk.x, "base64url").toString("hex");
  const display = hexToTrac(address);
  assert.ok(display, "trac1 encoding failed");

  const payload = signer.identityLinkPayload({
    handle: "trac-demo",
    network: "trac",
    externalId: display,
    proofUrl: `https://reset.openmayhem.ai/v1/account/${display}`,
  });

  const issuedAt = Date.now();
  const challenge: ResetLoginChallenge = {
    v: 1,
    domain: "reset-mcp-login",
    audience: base,
    address,
    nonce: identityLinkBinding(payload),
    issued_at: issuedAt,
    expires_at: issuedAt + MAX_CHALLENGE_TTL_MS,
  };
  const message = `RESET MCP LOGIN\n${stableStringify(challenge)}`;
  const challengeSignature = signBytes(null, Buffer.from(message), privateKey).toString("hex");

  const link = await client.linkIdentity(payload, signer.sign(payload), {
    kind: "trac",
    challenge,
    signature: challengeSignature,
  });
  const links = await client.identityLinks("trac-demo");

  assert.equal(link.verified, true);
  assert.equal(link.externalId, address);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.id, link.id);

  console.log(`handle: trac-demo (key ${signer.keyId.slice(0, 12)}…)`);
  console.log(`trac1 address: ${display}`);
  console.log(`externalId: ${link.externalId}`);
  console.log(`verified: ${link.verified}`);
  console.log(`links: ${links.length}`);
  console.log("OK: a RAREXT handle linked to a RESET Trac identity.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
