import { createPublicKey, verify as verifySignature } from "node:crypto";

import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { statusFor } from "./types.ts";
import type { IdentityLinkProof, RarextAdapter } from "./types.ts";
import {
  NATIVE_TRANSPORT_SHORT_BLOCKER,
  createTracAnchorTransport,
} from "./trac-transport.ts";
import type { TracAnchorTransport } from "./trac-transport.ts";

const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
const LOGIN_DOMAIN = "reset-mcp-login";
const LOGIN_PREFIX = "RESET MCP LOGIN\n";
const MAX_CHALLENGE_TTL_MS = 120_000;

function endpoint(): string | null {
  return process.env.TRAC_ANCHOR_URL ?? null;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function text(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  if (typeof value !== "string") {
    throw new Error(`Trac challenge field ${field} must be a string`);
  }

  return value;
}

function integer(record: Record<string, unknown>, field: string): number {
  const value = record[field];

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Trac challenge field ${field} must be an integer`);
  }

  return value;
}

function origin(value: string, field: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Trac challenge field ${field} must be a URL origin`);
  }

  if (parsed.origin !== value) {
    throw new Error(`Trac challenge field ${field} must be a URL origin`);
  }

  return value;
}

/**
 * Verify a RESET (`Trac-Systems/reset`) identity proof.
 *
 * The proof is a signed `reset-mcp-login` challenge. Its `nonce` is the
 * sha256 of the RAREXT link payload, so the signature commits to the exact
 * handle and key being linked, not just to control of the Trac address.
 */
function verifyChallenge(proof: IdentityLinkProof): void {
  if (!HEX32.test(proof.externalId)) {
    throw new Error("externalId must be a 64-character lowercase hex Trac address");
  }

  const external = proof.externalProof;

  if (!external || external.kind !== "trac") {
    throw new Error("a Trac challenge signature is required");
  }

  if (!HEX64.test(external.signature)) {
    throw new Error("externalProof.signature must be a 128-character hex Ed25519 signature");
  }

  if (!proof.audience || !proof.binding) {
    throw new Error("Trac identity link is missing its audience or payload binding");
  }

  if (!HEX32.test(proof.binding)) {
    throw new Error("Trac identity link binding must be a 64-character hex digest");
  }

  const challenge = external.challenge;

  if (challenge.v !== 1 || challenge.domain !== LOGIN_DOMAIN) {
    throw new Error("Trac challenge must be a reset-mcp-login v1 challenge");
  }

  if (text(challenge, "address") !== proof.externalId) {
    throw new Error("Trac challenge address does not match externalId");
  }

  if (text(challenge, "audience") !== origin(proof.audience, "audience")) {
    throw new Error("Trac challenge audience does not match the RAREXT origin");
  }

  if (text(challenge, "nonce") !== proof.binding) {
    throw new Error("Trac challenge nonce does not bind the RAREXT link payload");
  }

  const issued = integer(challenge, "issued_at");
  const expires = integer(challenge, "expires_at");
  const now = Date.now();

  if (
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > MAX_CHALLENGE_TTL_MS
  ) {
    throw new Error("Trac challenge is stale or has an invalid lifetime");
  }

  const message = `${LOGIN_PREFIX}${stableStringify(challenge)}`;
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from(ED25519_SPKI_PREFIX, "hex"),
      Buffer.from(proof.externalId, "hex"),
    ]),
    format: "der",
    type: "spki",
  });

  if (!verifySignature(null, Buffer.from(message), key, Buffer.from(external.signature, "hex"))) {
    throw new Error("Trac challenge signature does not verify");
  }
}

export class TracAnchorAdapter implements RarextAdapter {
  private readonly injectedTransport?: TracAnchorTransport;

  constructor(transport?: TracAnchorTransport) {
    this.injectedTransport = transport;
  }

  private transport(): TracAnchorTransport {
    return this.injectedTransport ?? createTracAnchorTransport(endpoint());
  }

  info(): AdapterInfo {
    const transport = this.transport();

    return {
      id: "trac",
      name: "Trac Network",
      kind: "network",
      capabilities: ["anchor", "identity"],
      configured: transport.configured,
      status: transport.configured ? "ready" : "unconfigured",
      description:
        "Agent-first coordination and portable anchor announcements. Native identity verifies a RESET Ed25519 challenge.",
      url: transport.endpoint,
    };
  }

  async status(): Promise<AdapterStatus> {
    const transport = this.transport();

    return statusFor(this.info(), {
      transport: transport.kind,
      nativeTransport: "blocked",
      nativeBlocker: NATIVE_TRANSPORT_SHORT_BLOCKER,
      nativeIdentity: true,
      identityProof: "reset-mcp-login",
    });
  }

  async verifyIdentityLink(proof: IdentityLinkProof): Promise<void> {
    if (proof.network !== "trac") {
      throw new Error("the Trac adapter only verifies trac identity links");
    }

    verifyChallenge(proof);
  }

  async anchor(root: string, publicationIds: string[]): Promise<AdapterReceipt> {
    const transport = this.transport();

    if (!transport.configured) {
      return {
        adapter: "trac",
        status: "skipped",
        reference: null,
        error: "TRAC_ANCHOR_URL is not configured",
      };
    }

    try {
      const { reference } = await transport.announce({
        protocol: "rarext.anchor.v1",
        root,
        publicationIds,
      });

      return {
        adapter: "trac",
        status: "ok",
        reference,
      };
    } catch (error) {
      return {
        adapter: "trac",
        status: "error",
        reference: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
