import { readBundleResponseBytes } from "./bundle.ts";
import type { BundleSeed } from "./bundle.ts";
import type { Identity, JsonWebKey, KeyRotation, SignatureSuite } from "./types.ts";

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
 * `publicKey` is optional and carries no authority. The key a record is
 * believed under is the one the named handle's KEY HISTORY resolves (see
 * `AnnouncementIdentity`); when a document does carry a key beside the record,
 * it must be that very key, so an envelope cannot mint its own authority. The
 * RFC's record shape has no `publicKey` at all, and a record without one
 * verifies exactly like a record with the resolved key written beside it.
 */
export interface SignedAnnouncement {
  announcement: MirrorAnnouncementPayload;
  signature: string;
  publicKey?: JsonWebKey;
}

/**
 * What the identity layer publishes as "do not trust this key": one revocation
 * record whose TARGET is the key id. The kinds it serves are the revocation
 * list's own (`capability`, `verifier`, `artifact`), and a target naming a key
 * id is already how the API reads a revoked steward — the announcement rule
 * reads a served revocation the same way instead of inventing a registry.
 */
export interface AnnouncementRevocation {
  id: string;
  kind: string;
  target: string;
  reason: string;
}

/**
 * A handle's key history as the identity layer serves it: the identity record
 * the handle CURRENTLY vouches for, plus the rotation records that chain every
 * key it has rotated FROM back to that one — the shape `GET
 * /v1/identities/:handle` and `GET /v1/identities/:handle/rotations` answer
 * with, and the shape `store.getIdentity`/`store.rotationsFor` hold.
 */
export interface AnnouncementKeyHistory {
  identity: Identity;
  rotations: KeyRotation[];
}

/**
 * The identity half of the injected port: where a handle's key history and its
 * published revocations come from. Core owns every rule that reads them; the
 * caller owns only the retrieval — the API answers from its own store, the SDK
 * from whatever identity layer its caller names, and a caller with neither
 * passes `unresolvedIdentity`, which answers "no history" for every handle so
 * that an unverifiable record is refused rather than believed.
 */
export interface AnnouncementIdentity {
  /** The key history of a handle, or null when it cannot be resolved. */
  resolveKeys(
    handle: string,
  ): AnnouncementKeyHistory | null | Promise<AnnouncementKeyHistory | null>;
  /** The identity layer's published revocation naming this key id, or null. */
  revokedKey(
    keyId: string,
  ): AnnouncementRevocation | null | Promise<AnnouncementRevocation | null>;
}

/**
 * The signature machinery a verifier injects, so this module stays pure: the
 * key id and the suite are DERIVED from the key (never claimed by the record's
 * caller), the signature is checked over the canonical payload, and the
 * announcing key itself is RESOLVED through the handle's key history rather
 * than read out of the announcement document.
 */
export interface AnnouncementVerifier extends AnnouncementIdentity {
  keyIdOf(publicKey: JsonWebKey): string;
  suiteOf(publicKey: JsonWebKey): SignatureSuite | null;
  verify(
    publicKey: JsonWebKey,
    payload: unknown,
    signature: string,
    suite?: SignatureSuite,
  ): boolean;
}

/**
 * The identity port of a caller that has no identity layer: no handle resolves
 * and no key is revoked, so every announcement is refused with "no key history"
 * instead of being verified against whatever the document carried. Unverifiable
 * must not degrade to believed, and this is that rule as a value.
 */
export const unresolvedIdentity: AnnouncementIdentity = {
  resolveKeys: () => null,
  revokedKey: () => null,
};

/** What verifying one record returns: a seed-shaped entry, or the reason it is refused. */
export type AnnouncementVerdict =
  | { ok: true; seed: BundleSeed }
  | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** One key the handle's history resolves, and the window it was the handle's key. */
interface AnnouncingKey {
  handle: string;
  keyId: string;
  publicKey: JsonWebKey;
  /** When the key became the handle's own (inclusive). */
  introducedAt: number;
  /** When a rotation retired the key; null while it is the current key. */
  retiredAt: number | null;
}

type Resolution = { ok: true; key: AnnouncingKey } | { ok: false; reason: string };

/**
 * One rotation record, checked the way `verifyKeyRotation` checks the record it
 * accepts at write time: it names this handle, its `fromKeyId`/`toKeyId` are
 * DERIVED from the keys it carries, and its signature verifies against the key
 * being retired (rotation is signed by the retiring key, so a stolen new key
 * cannot perform it alone). The timestamp it carries is the instant the
 * retirement and the introduction happened. Null means the record does not
 * count, and the chain stops where it stands.
 */
function soundRotation(
  rotation: KeyRotation,
  handle: string,
  verifier: AnnouncementVerifier,
): number | null {
  if (rotation.handle !== handle) return null;
  if (rotation.fromKeyId === rotation.toKeyId) return null;
  if (verifier.keyIdOf(rotation.fromPublicKey) !== rotation.fromKeyId) return null;
  if (verifier.keyIdOf(rotation.toPublicKey) !== rotation.toKeyId) return null;

  const fromSuite = verifier.suiteOf(rotation.fromPublicKey);
  const toSuite = verifier.suiteOf(rotation.toPublicKey);
  if (!fromSuite || !toSuite) return null;
  if (fromSuite !== rotation.fromAlgorithm || toSuite !== rotation.toAlgorithm) return null;

  const { signature, ...payload } = rotation;
  if (!verifier.verify(rotation.fromPublicKey, payload, signature, fromSuite)) return null;

  const at = Date.parse(rotation.createdAt);
  return Number.isNaN(at) ? null : at;
}

/**
 * Walk a handle's key history back from the key it currently vouches for,
 * keeping every key whose chain of rotations reaches that one.
 *
 * The walk starts at the identity record's own key — the current key needs no
 * rotation to be authoritative, it is the handle's by definition — and each
 * step descends through ONE rotation record, the one that introduces the key
 * it is standing on and retires the next. A rotation that does not verify, that
 * does not derive its own key ids, or that names another handle stops the walk
 * there: the keys behind an unsound link are simply not in the history, so a
 * record they signed is refused instead of believed on an unverified chain.
 *
 * A key with no rotation introducing it is the origin: the handle's first key,
 * born when the identity record says the handle was created. A key the walk
 * reached carries the instant it was retired, which is the instant its
 * successor took over.
 */
function announcingKeyChain(
  history: AnnouncementKeyHistory,
  verifier: AnnouncementVerifier,
): { ok: true; entries: AnnouncingKey[] } | { ok: false; reason: string } {
  const handle = history.identity.handle;
  const origin = Date.parse(history.identity.createdAt);
  if (Number.isNaN(origin)) {
    return { ok: false, reason: `the key history served for ${handle} has no usable createdAt` };
  }
  if (verifier.keyIdOf(history.identity.publicKey) !== history.identity.keyId) {
    return {
      ok: false,
      reason: `the key history served for ${handle} does not derive its own current key id`,
    };
  }

  // Only rotations that verify and that are the SINGLE record introducing their
  // successor are usable links; an ambiguous or unsound one is absent, which is
  // what stops the walk rather than letting it pick a side.
  const introducing = new Map<string, { rotation: KeyRotation; at: number }>();
  const ambiguous = new Set<string>();
  for (const rotation of history.rotations) {
    if (rotation.handle !== handle) continue;
    if (ambiguous.has(rotation.toKeyId)) continue;
    if (introducing.has(rotation.toKeyId)) {
      introducing.delete(rotation.toKeyId);
      ambiguous.add(rotation.toKeyId);
      continue;
    }
    const at = soundRotation(rotation, handle, verifier);
    if (at === null) continue;
    introducing.set(rotation.toKeyId, { rotation, at });
  }

  const entries: AnnouncingKey[] = [];
  const seen = new Set<string>();
  let keyId = history.identity.keyId;
  let publicKey = history.identity.publicKey;
  let introducedAt = origin;
  let retiredAt: number | null = null;
  let current = true;

  for (;;) {
    if (seen.has(keyId)) {
      return { ok: false, reason: `the key history served for ${handle} loops at ${keyId}` };
    }
    seen.add(keyId);

    const link = introducing.get(keyId);
    entries.push({
      handle,
      keyId,
      publicKey,
      introducedAt: link?.at ?? introducedAt,
      retiredAt,
    });

    if (!link) break; // the origin: no rotation introduced this key

    // Descend to the key this rotation retired, carrying the instant it retired.
    keyId = link.rotation.fromKeyId;
    publicKey = link.rotation.fromPublicKey;
    retiredAt = link.at;
    introducedAt = origin;
    current = false;
  }

  return { ok: true, entries };
}

/**
 * The resolution step: the record's key must be one the NAMED handle's history
 * vouches for. Nothing here reads key material out of the announcement
 * document — the handle is looked up, its history is walked, and the entry
 * whose derived key id is the record's claimed `keyId` is the key the record
 * may be verified under. A handle that cannot be resolved, a key that history
 * has never held, and a history whose own key ids do not derive are all the
 * same outcome: refused, with the reason named.
 */
function resolveAnnouncingKey(input: {
  history: AnnouncementKeyHistory | null;
  handle: string;
  keyId: string;
  verifier: AnnouncementVerifier;
}): Resolution {
  if (!input.history) {
    return {
      ok: false,
      reason: `no key history for handle ${input.handle}, so the announcing key cannot be resolved`,
    };
  }
  if (input.history.identity.handle !== input.handle) {
    return {
      ok: false,
      reason: `the key history served for ${input.history.identity.handle} does not answer for ${input.handle}`,
    };
  }

  const chain = announcingKeyChain(input.history, input.verifier);
  if (!chain.ok) return chain;

  const key = chain.entries.find((entry) => entry.keyId === input.keyId);
  if (!key) {
    const currentKeyId = input.history.identity.keyId;
    return {
      ok: false,
      reason: `handle ${input.handle} does not vouch for the record's key id ${input.keyId} (its current key is ${currentKeyId})`,
    };
  }
  if (key.handle !== input.handle) {
    return {
      ok: false,
      reason: `the resolved key ${key.keyId} belongs to ${key.handle}, not to ${input.handle}`,
    };
  }
  return { ok: true, key };
}

/**
 * Verify ONE signed announcement record and convert it into the seed shape the
 * union already reads — the announced `bundle` as the primary URL, the
 * announced `bundleRoot` and `bundleCid` as its pins, the announced `mirror`
 * as a candidate, and `url` set to the announcement document so a
 * disagreement is attributed to the document that made the claim.
 *
 * No new rule and no second canonical form: the payload is checked as it
 * stands (`kind` and `version` fixed by the RFC — an unknown kind or version
 * is refused, not ignored), the signature is checked by the injected verifier
 * over the payload as-is, and a record whose current time falls outside
 * `[issuedAt, expiresAt]` is refused — an expired or not-yet-valid
 * announcement is discarded here, before it can affect anything. The signature
 * covers the pins, so a replay re-proposes the same location and cannot swap
 * in a different root.
 *
 * Then, before the signature is believed at all, the ANNOUNCING KEY is
 * resolved rather than trusted:
 *
 * 1. **Resolve, don't trust the envelope.** The caller passes the key history
 *    it resolved for the record's handle (`input.history`). No history means
 *    no verification: the record is refused with that reason, because a record
 *    whose key cannot be resolved is not verifiable. A key the history has
 *    never held is refused the same way, so a document that carries its own
 *    key material cannot mint authority under someone else's handle.
 * 2. **The handle binding holds.** The key is looked up under the handle the
 *    record names, and the resolved key must carry that same handle.
 * 3. **Rotation is first-class.** A key the handle CURRENTLY vouches for is
 *    acceptable as it stands. A key it rotated FROM is acceptable only when
 *    the rotation records chain it back to the current key and the record's
 *    `issuedAt` falls inside that key's window — from its introduction to the
 *    instant it was retired.
 * 4. **Revocation wins.** A key the identity layer reports revoked is refused
 *    even when it is the right key and the window is valid, named with the
 *    revocation that says so.
 * 5. **The signature verifies against the RESOLVED key**, never against key
 *    material copied out of the announcement document. A document that carries
 *    a key beside the record must carry that resolved key or be refused.
 *
 * The caller injects `now`; production callers pass the current time, and a
 * test can freeze a clock. The resolution and the revocation lookup are the
 * caller's identity layer (`input.history`, `input.revoked`), resolved by
 * `foldAnnouncements` through the injected port, so the rules above live here
 * and nowhere else.
 */
export function verifyAnnouncement(
  record: unknown,
  input: {
    /** The announcement document's URL, for attribution in a disagreement. */
    url: string;
    verifier: AnnouncementVerifier;
    /** The key history resolved for the record's handle, or null if none. */
    history: AnnouncementKeyHistory | null;
    /** The identity layer's revocation naming the record's key, or null. */
    revoked: AnnouncementRevocation | null;
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
  if (typeof record.signature !== "string" || record.signature.length === 0) {
    return { ok: false, reason: "the record carries no signature" };
  }

  for (const field of [
    "handle",
    "bundle",
    "mirror",
    "bundleRoot",
    "keyId",
    "issuedAt",
    "expiresAt",
    "nonce",
  ] as const) {
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

  // The resolution step: whose key signed this, according to the handle it names.
  const resolution = resolveAnnouncingKey({
    history: input.history,
    handle: payload.handle as string,
    keyId: payload.keyId as string,
    verifier: input.verifier,
  });
  if (!resolution.ok) return resolution;
  const key = resolution.key;

  // Revocation wins over everything below: the right key, a valid window, a
  // signature that verifies — none of it matters once the key is revoked.
  if (input.revoked) {
    const named = input.revoked.reason
      ? `${input.revoked.id}: ${input.revoked.reason}`
      : input.revoked.id;
    return {
      ok: false,
      reason: `the announcing key ${key.keyId} is revoked (${named})`,
    };
  }

  // Rotation is first-class: a key the handle rotated FROM is believed only
  // while the record was issued inside the window that key was its own.
  if (key.retiredAt !== null) {
    const within =
      issuedAt.getTime() >= key.introducedAt && issuedAt.getTime() < key.retiredAt;
    if (!within) {
      return {
        ok: false,
        reason:
          `the record was issued at ${payload.issuedAt}, outside the window the handle ` +
          `vouched for key ${key.keyId} (${new Date(key.introducedAt).toISOString()} to ` +
          `${new Date(key.retiredAt).toISOString()})`,
      };
    }
  }

  const derivedSuite = input.verifier.suiteOf(key.publicKey);
  if (!derivedSuite) {
    return { ok: false, reason: "the resolved announcing key's suite could not be derived" };
  }
  if (payload.algorithm !== derivedSuite) {
    return {
      ok: false,
      reason: `the record claims algorithm ${payload.algorithm}, but the resolved key's suite is ${derivedSuite}`,
    };
  }

  // A document may carry the key beside the record, but it may carry THE key:
  // whatever it carries must be the one the handle's history resolved.
  if (record.publicKey !== undefined) {
    if (!isObject(record.publicKey)) {
      return { ok: false, reason: "the record's public key is not a JSON object" };
    }
    const carriedSuite = input.verifier.suiteOf(record.publicKey as JsonWebKey);
    if (!carriedSuite) {
      return { ok: false, reason: "the announcing key carried by the document has no suite" };
    }
    const carriedKeyId = input.verifier.keyIdOf(record.publicKey as JsonWebKey);
    if (carriedKeyId !== key.keyId) {
      return {
        ok: false,
        reason:
          `the announcement document carries key id ${carriedKeyId}, which is not the key ` +
          `handle ${key.handle} vouches for (${key.keyId})`,
      };
    }
  }

  const verified = input.verifier.verify(
    key.publicKey,
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

/** What folding a seed's announcements reports: one event per record or document. */
export type AnnouncementEvent =
  | { url: string; status: "accepted"; mirror: string }
  | { url: string; status: "skipped"; reason: string };

/**
 * RFC 0019 step 1: THE announcement fold — fetch every announcement document
 * the seeds name, verify every record with the injected verifier, and return
 * the seeds pooled with the verified survivors, so the caller plans
 * `planSeedUnion` over the pool.
 *
 * It is one implementation because it used to be one caller's loop: the SDK
 * path (`findVerifiedBundleFromSeeds`) and the API path (`bundleFromSeeds`)
 * both delegate here, exactly as both delegate to `verifyCandidates` for the
 * candidate sequence. The order is the invariant: fetch the document through
 * the same capped reader a bundle gets, parse it (a document that is not a
 * JSON array of signed records skips as a whole), resolve the signing key of
 * each record through the handle's key history and through the identity
 * layer's published revocations, verify the record — the window, the handle
 * binding, the rotation chain, the revocation, the signature over the
 * canonical payload — pool each survivor, and report every refusal with its
 * reason through `onAnnouncement`. A refusal is never fatal while another
 * location verifies; a VERIFIED record that contradicts the pins is the
 * union's stop, which happens after this returns, in `planSeedUnion`.
 *
 * The resolution itself is the caller's identity port (`verifier.resolveKeys`
 * and `verifier.revokedKey`), awaited here and cached per handle and per key
 * for the length of the fold: a handle resolves at most once per document set,
 * and a resolution that throws or returns nothing is recorded as "no history",
 * which `verifyAnnouncement` refuses. This module holds no registry and picks
 * no trust root — a caller that has no identity layer passes
 * `unresolvedIdentity` and every record is reported and skipped.
 *
 * A seed with no `announcements` contributes nothing: the URL set is empty,
 * no fetch is made, and the returned pool is the seeds, byte for byte — which
 * is why the callers can pass it unconditionally and stay additive.
 *
 * I/O and cryptography are injected: `fetch` and `timeoutMs` are the caller's
 * (node fetch in both twins today), and `verifier` is the caller's identity
 * primitives. Core stays pure, and a caller cannot reimplement the sequence
 * without visibly not calling this.
 */
export async function foldAnnouncements(
  seeds: BundleSeed[],
  input: {
    verifier: AnnouncementVerifier;
    fetch: typeof fetch;
    timeoutMs?: number;
    onAnnouncement?: (event: AnnouncementEvent) => void;
  },
): Promise<BundleSeed[]> {
  const request = input.fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;

  const histories = new Map<string, AnnouncementKeyHistory | null>();
  const revocations = new Map<string, AnnouncementRevocation | null>();
  const resolveKeys = async (handle: string): Promise<AnnouncementKeyHistory | null> => {
    if (!histories.has(handle)) {
      let history: AnnouncementKeyHistory | null = null;
      try {
        history = (await input.verifier.resolveKeys(handle)) ?? null;
      } catch {
        history = null;
      }
      histories.set(handle, history);
    }
    return histories.get(handle) ?? null;
  };
  const revokedKey = async (keyId: string): Promise<AnnouncementRevocation | null> => {
    if (!revocations.has(keyId)) {
      let revocation: AnnouncementRevocation | null = null;
      try {
        revocation = (await input.verifier.revokedKey(keyId)) ?? null;
      } catch {
        revocation = null;
      }
      revocations.set(keyId, revocation);
    }
    return revocations.get(keyId) ?? null;
  };

  const pool: BundleSeed[] = [...seeds];
  // Which seeds listed which document: the vouching question is "did a seed that
  // pins this registry name this handle as ITS announcer", so the listing seed
  // has to travel with the URL rather than being flattened away.
  const listingSeeds = new Map<string, BundleSeed[]>();
  for (const seed of seeds) {
    for (const url of seed.announcements ?? []) {
      const listed = listingSeeds.get(url) ?? [];
      listed.push(seed);
      listingSeeds.set(url, listed);
    }
  }
  const announcementUrls = [...listingSeeds.keys()];
  for (const url of announcementUrls) {
    let document: unknown;
    try {
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await readBundleResponseBytes(response);
      document = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      input.onAnnouncement?.({
        url,
        status: "skipped",
        reason: error instanceof Error ? error.message : "the announcement document could not be fetched",
      });
      continue;
    }
    if (!Array.isArray(document)) {
      input.onAnnouncement?.({
        url,
        status: "skipped",
        reason: "the announcement document is not a JSON array of signed records",
      });
      continue;
    }
    for (const [index, record] of document.entries()) {
      // The resolution reads only the two fields the lookup is keyed by; every
      // rule that judges them lives in `verifyAnnouncement`.
      const payload =
        isObject(record) && isObject(record.announcement) ? record.announcement : null;
      const handle = payload && isNonEmptyString(payload.handle) ? payload.handle : null;
      const keyId = payload && isNonEmptyString(payload.keyId) ? payload.keyId : null;
      const history = handle ? await resolveKeys(handle) : null;
      const revoked = history && keyId ? await revokedKey(keyId) : null;

      const verdict = verifyAnnouncement(record, {
        url,
        verifier: input.verifier,
        history,
        revoked,
      });
      if (verdict.ok) {
        // RFC 0019's open question, answered mechanically: a location is open to
        // any resolvable handle, a FACT is not. The record's claim is a fact, so
        // an unvouched handle may only restate what the seeds already pin: a
        // location for a pinned registry, agreeing with its pins. Anything else
        // — a registry the seeds do not pin, or pins that differ — is refused
        // HERE, which is also what closes the denial-of-service the RFC warns
        // about: an unvouched contradiction can no longer reach the union's
        // loud stop, because it never enters the union at all.
        const vouched = (listingSeeds.get(url) ?? []).some((seed) =>
          (seed.announcers ?? []).includes(handle as string),
        );
        if (!vouched) {
          const means = (entry: BundleSeed): boolean =>
            entry.bundleRoot === verdict.seed.bundleRoot &&
            (entry.bundleCid === undefined ||
              verdict.seed.bundleCid === undefined ||
              entry.bundleCid === verdict.seed.bundleCid);
          const forSameRegistry = pool.filter((entry) => entry.bundle === verdict.seed.bundle);
          if (forSameRegistry.length === 0) {
            input.onAnnouncement?.({
              url,
              status: "skipped",
              reason:
                `record ${index}: handle ${handle} is not named among this seed's announcers, ` +
                `so it may mirror a registry the seed pins, not introduce one`,
            });
            continue;
          }
          if (!forSameRegistry.some(means)) {
            input.onAnnouncement?.({
              url,
              status: "skipped",
              reason:
                `record ${index}: handle ${handle} is not named among this seed's announcers, ` +
                `so it may mirror the seed's pins, not contradict them`,
            });
            continue;
          }
        }
        pool.push(verdict.seed);
        input.onAnnouncement?.({
          url,
          status: "accepted",
          mirror: verdict.seed.mirrors?.[0]?.bundle ?? "",
        });
      } else {
        input.onAnnouncement?.({
          url,
          status: "skipped",
          reason: `record ${index}: ${verdict.reason}`,
        });
      }
    }
  }
  return pool;
}
