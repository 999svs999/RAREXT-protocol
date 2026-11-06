import { createHash } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/canonical.ts";

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The digest of a value under RAREXT's canonical JSON — the same bytes everywhere. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** UTF-8 byte length of the canonical JSON of a value. */
export function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalize(value), "utf8");
}

/** Address one deployment by its manifest digest. */
export function shortDigest(digest: string, length = 16): string {
  return digest.slice(0, length);
}
