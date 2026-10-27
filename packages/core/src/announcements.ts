import type { BundleSeed } from "./bundle.ts";
import type { JsonWebKey, SignatureSuite } from "./types.ts";

/**
 * RFC 0019 (mirror announcements), step 1: the signed record an operator
 * publishes to state where a registry's bundle can be fetched, under which
 * pinned root and content address, when the statement was issued, and when it
 * stops being believed. An announcement proposes LOCATIONS, never facts: it
 * cannot change what is verified, it only widens where a client looks.
 */
export const ANNOUNCEMENT_KIND = "rarext.mirror-announcement";
export const ANNOUNCEMENT_VERSION = 1;

/** The announcement payload a signing key signs, in the RFC 0019 field names. */
export interface MirrorAnnouncementPayload {
  kind: typeof ANNOUNCEMENT_KIND;
  version: typeof ANNOUNCEMENT_VERSION;
  handle: string;
  /** The registry's primary bundle URL — the same URL a seed carries as `bundle`. */
  bundle: string;
  /** The URL the announcer claims to serve. */
  mirror: string;
  /** The pins the announcer claims that mirror rebuilds. */
  bundleRoot: string;
  /** Optional, exactly as on a seed: absence is not a contradiction. */
  bundleCid?: string;
  keyId: string;
  algorithm: SignatureSuite;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

/**
 * One signed record as it travels in an announcement document — the payload
 * plus a `signature` field, the same shape as a signed revocation.
 *
 * `publicKey` is the smaller step-1 choice for an ambiguity the RFC leaves
 * open: the RFC's client resolves the announcing key through the handle's key
 * history, which is a registry-API dependency a resident does not have, so the
 * document carries the signing key beside each record instead. The key is
 * bound to the record by the payload's own `keyId` — a key whose derived id is
 * not the claimed one is refused before the signature is even checked — so
 * carrying it adds no trust the signature does not already provide.
 */
export interface SignedAnnouncement {
  announcement: MirrorAnnouncementPayload;
  signature: string;
  publicKey?: JsonWebKey;
}

/**
 * The signature machinery a verifier injects, so this module stays pure: the
 * key id and the suite are DERIVED from the key (never claimed by the record's
 * caller), and the signature is checked over the canonical payload.
 */
export interface AnnouncementVerifier {
  keyIdOf(publicKey: JsonWebKey): string;
  suiteOf(publicKey: JsonWebKey): SignatureSuite | null;
  verify(
    publicKey: JsonWebKey,
    payload: unknown,
    signature: string,
    suite?: SignatureSuite,
  ): boolean;
}

/** What verifying one record returns: a seed-shaped entry, or the reason it is refused. */
export type AnnouncementVerdict =
  | { ok: true; seed: BundleSeed }
  | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Verify ONE signed announcement record and convert it into the seed shape the
 * union already reads — the announced `bundle` as the primary URL, the
 * announced `bundleRoot` and `bundleCid` as its pins, the announced `mirror`
 * as a candidate, and `url` set to the announcement document so a
 * disagreement is attributed to the document that made the claim.
 *
 * No new rule and no second canonical form: the payload is checked as it
 * stands (`kind` and `version` fixed by the RFC — an unknown kind or version
 * is refused, not ignored), the key id and suite are derived from the carried
 * key and required to match what the payload claims, the signature is checked
 * by the injected verifier over the payload as-is, and a record whose current
 * time falls outside `[issuedAt, expiresAt]` is refused — an expired or
 * not-yet-valid announcement is discarded here, before it can affect
 * anything. The signature covers the pins, so a replay re-proposes the same
 * location and cannot swap in a different root.
 *
 * The caller injects `now`; production callers pass the current time, and a
 * test can freeze a clock.
 */
export function verifyAnnouncement(
  record: unknown,
  input: {
    /** The announcement document's URL, for attribution in a disagreement. */
    url: string;
    verifier: AnnouncementVerifier;
    now?: Date;
  },
): AnnouncementVerdict {
  if (!isObject(record)) {
    return { ok: false, reason: "the record is not a JSON object" };
  }
  const payload = record.announcement;
  if (!isObject(payload)) {
    return { ok: false, reason: "the record carries no announcement payload" };
  }
  if (payload.kind !== ANNOUNCEMENT_KIND) {
    return {
      ok: false,
      reason: `unknown announcement kind ${JSON.stringify(payload.kind)}`,
    };
  }
  if (payload.version !== ANNOUNCEMENT_VERSION) {
    return {
      ok: false,
      reason: `unsupported announcement version ${JSON.stringify(payload.version)}`,
    };
  }

  const publicKey = record.publicKey;
  if (!isObject(publicKey)) {
    return {
      ok: false,
      reason: "the record carries no public key to verify its signature against",
    };
  }
  if (typeof record.signature !== "string" || record.signature.length === 0) {
    return { ok: false, reason: "the record carries no signature" };
  }

  const derivedSuite = input.verifier.suiteOf(publicKey as JsonWebKey);
  if (!derivedSuite) {
    return { ok: false, reason: "the announcing key's suite could not be derived" };
  }
  const derivedKeyId = input.verifier.keyIdOf(publicKey as JsonWebKey);
  if (payload.keyId !== derivedKeyId) {
    return {
      ok: false,
      reason: `the record claims key id ${JSON.stringify(payload.keyId)}, which is not the signing key's ${derivedKeyId}`,
    };
  }
  if (payload.algorithm !== derivedSuite) {
    return {
      ok: false,
      reason: `the record claims algorithm ${JSON.stringify(payload.algorithm)}, but the signing key's suite is ${derivedSuite}`,
    };
  }

  for (const field of ["handle", "bundle", "mirror", "bundleRoot", "issuedAt", "expiresAt", "nonce"] as const) {
    if (!isNonEmptyString(payload[field])) {
      return { ok: false, reason: `the announcement payload has no ${field}` };
    }
  }
  if (payload.bundleCid !== undefined && !isNonEmptyString(payload.bundleCid)) {
    return { ok: false, reason: "the announcement payload's bundleCid is not a string" };
  }

  const issuedAt = new Date(payload.issuedAt as string);
  const expiresAt = new Date(payload.expiresAt as string);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    return { ok: false, reason: "the announcement's issuedAt or expiresAt is not a date" };
  }
  if (expiresAt.getTime() <= issuedAt.getTime()) {
    return { ok: false, reason: "the announcement's expiresAt is not later than its issuedAt" };
  }
  const now = input.now ?? new Date();
  if (now.getTime() < issuedAt.getTime()) {
    return {
      ok: false,
      reason: `the announcement is not yet valid (issuedAt ${payload.issuedAt})`,
    };
  }
  if (now.getTime() > expiresAt.getTime()) {
    return {
      ok: false,
      reason: `the announcement expired at ${payload.expiresAt}`,
    };
  }

  const verified = input.verifier.verify(
    publicKey as JsonWebKey,
    payload,
    record.signature,
    derivedSuite,
  );
  if (!verified) {
    return { ok: false, reason: "the announcement's signature does not verify" };
  }

  const seed: BundleSeed = {
    bundle: payload.bundle as string,
    bundleRoot: payload.bundleRoot as string,
    url: input.url,
    mirrors: [{ bundle: payload.mirror as string, root: payload.bundleRoot as string }],
  };
  if (typeof payload.bundleCid === "string") seed.bundleCid = payload.bundleCid;
  return { ok: true, seed };
}
