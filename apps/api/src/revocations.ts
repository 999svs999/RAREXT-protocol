import { existsSync, readFileSync } from "node:fs";

import type { JsonWebKey } from "../../../packages/core/src/index.ts";

import { verifyPayload } from "./identity.ts";

export type RevocationKind = "capability" | "verifier" | "artifact";

export interface Revocation {
  id: string;
  kind: RevocationKind;
  /** A capability nonce, a verifier hash, or an artifact id. */
  target: string;
  reason: string;
  issuer: string;
  issuedAt: string;
}

export interface SignedRevocation {
  revocation: Revocation;
  signature: string;
}

/**
 * A revocation is a published "do not trust this any more".
 *
 * It exists because two of the protocol's trust assumptions are revocable in
 * principle and were not revocable in practice: a capability that leaks, and a
 * verifier that turns out to be compromised. A revocation says which, why, and
 * who said so, and it is signed so the list can be published and anchored like
 * anything else.
 */
export function verifyRevocation(
  publicKey: JsonWebKey,
  signed: SignedRevocation,
): boolean {
  try {
    return verifyPayload(publicKey, signed.revocation, signed.signature);
  } catch {
    return false;
  }
}

export function isRevoked(
  revocations: Revocation[],
  kind: RevocationKind,
  target: string,
): Revocation | null {
  return (
    revocations.find(
      (revocation) => revocation.kind === kind && revocation.target === target,
    ) ?? null
  );
}

function asRevocation(value: unknown): Revocation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<Revocation>;

  if (
    typeof record.id !== "string" ||
    typeof record.target !== "string" ||
    !["capability", "verifier", "artifact"].includes(String(record.kind))
  ) {
    return null;
  }

  return {
    id: record.id,
    kind: record.kind as RevocationKind,
    target: record.target,
    reason: typeof record.reason === "string" ? record.reason : "",
    issuer: typeof record.issuer === "string" ? record.issuer : "",
    issuedAt:
      typeof record.issuedAt === "string" ? record.issuedAt : new Date().toISOString(),
  };
}

export function loadRevocations(): Revocation[] {
  const source = process.env.RAREXT_REVOCATIONS?.trim();
  if (!source) return [];

  let text = source;

  if (!source.startsWith("[") && !source.startsWith("{")) {
    if (!existsSync(source)) {
      throw new Error(`RAREXT_REVOCATIONS file not found: ${source}`);
    }
    text = readFileSync(source, "utf8");
  }

  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "revocations" in parsed
      ? (parsed as { revocations: unknown }).revocations
      : null;

  if (!Array.isArray(list)) {
    throw new Error("RAREXT_REVOCATIONS must be an array or { revocations: [] }");
  }

  return list
    .map(asRevocation)
    .filter((revocation): revocation is Revocation => revocation !== null);
}
