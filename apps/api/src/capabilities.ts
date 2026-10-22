import type { CapabilityGrant, JsonWebKey } from "../../../packages/core/src/index.ts";

import { verifyPayload } from "./identity.ts";

export interface CapabilityToken {
  grant: CapabilityGrant;
  signature: string;
}

export function encodeCapability(token: CapabilityToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

export function decodeCapability(value: string): CapabilityToken | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as CapabilityToken;

    if (
      typeof parsed?.grant?.artifactId !== "string" ||
      typeof parsed?.signature !== "string"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export interface CapabilityCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * A capability is signed by the author of the publication it opens. The author
 * is the party with something to protect, so the grant is theirs to make; the
 * registry only checks that the signature is real, that the grant names this
 * artifact, and that it has not expired.
 */
export function verifyCapability(
  publicKey: JsonWebKey,
  token: string,
  artifactId: string,
  now = Date.now(),
): CapabilityCheck {
  const decoded = decodeCapability(token);

  if (!decoded) {
    return { ok: false, reason: "the capability is malformed" };
  }

  if (decoded.grant.artifactId !== artifactId) {
    return { ok: false, reason: "the capability names a different artifact" };
  }

  if (decoded.grant.expiresAt) {
    const expiry = Date.parse(decoded.grant.expiresAt);

    if (!Number.isFinite(expiry) || expiry < now) {
      return { ok: false, reason: "the capability has expired" };
    }
  }

  try {
    if (!verifyPayload(publicKey, decoded.grant, decoded.signature)) {
      return { ok: false, reason: "the capability signature is not valid" };
    }
  } catch {
    return { ok: false, reason: "the capability signature could not be checked" };
  }

  return { ok: true, reason: null };
}
