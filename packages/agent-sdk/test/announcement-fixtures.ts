import { AgentSigner, createAgentKeyfile } from "../src/index.ts";
import type { AnnouncementIdentity, AnnouncementKeyHistory } from "../src/index.ts";

/**
 * Signed RFC 0019 fixtures, shared by the SDK suite and the API suite.
 *
 * Both callers of core's `foldAnnouncements` must be exercised against records
 * built by the repo's OWN signing helpers — `createAgentKeyfile` for the key
 * and `AgentSigner.sign` for the signature — so neither suite can pass against
 * hand-rolled crypto, and neither one keeps a private copy of what a record
 * looks like. The field names are written out rather than imported from core
 * on purpose: a fixture that follows the code's constants cannot catch the
 * code changing them.
 */

export const ANNOUNCER = "operator-alice";

/** One day in milliseconds, for windows relative to the run's own clock. */
export const DAY = 24 * 60 * 60 * 1000;

export const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/**
 * The announcer's signer. CACHED on purpose: `createAgentKeyfile` mints a fresh
 * random key every call, so two calls produced two different keys — and then an
 * identity port vouching for one of them could never vouch for what the other
 * had signed. That mismatch made every resolution test refuse for the wrong
 * reason ("the handle does not vouch for the record's key id"), which is a
 * fixture bug wearing the costume of a real refusal.
 *
 * A test that needs a DIFFERENT key says so with `otherSigner()`.
 */
let cachedAnnouncer: AgentSigner | null = null;

export function announcementSigner(): AgentSigner {
  cachedAnnouncer ??= new AgentSigner(createAgentKeyfile(ANNOUNCER).privateKey);
  return cachedAnnouncer;
}

/** A signer the announcer's handle does NOT vouch for — the envelope attack. */
export function otherSigner(): AgentSigner {
  return new AgentSigner(createAgentKeyfile(`${ANNOUNCER}-impostor`).privateKey);
}

/** A signed announcement record, built the way an operator would build one. */
export function signedAnnouncement(
  signer: AgentSigner,
  claims: {
    /** The handle the record names. Defaults to the announcer's; a second
     *  handle is how a test produces an announcer a seed did NOT name. */
    handle?: string;
    bundle: string;
    mirror: string;
    bundleRoot: string;
    bundleCid?: string;
    issuedAt?: string;
    expiresAt?: string;
    nonce?: string;
  },
) {
  const payload = {
    kind: "rarext.mirror-announcement",
    version: 1,
    handle: claims.handle ?? ANNOUNCER,
    bundle: claims.bundle,
    mirror: claims.mirror,
    bundleRoot: claims.bundleRoot,
    ...(claims.bundleCid === undefined ? {} : { bundleCid: claims.bundleCid }),
    keyId: signer.keyId,
    algorithm: signer.suite,
    issuedAt: claims.issuedAt ?? iso(-DAY),
    expiresAt: claims.expiresAt ?? iso(30 * DAY),
    nonce: claims.nonce ?? "announce-mirror-1",
  };
  return { announcement: payload, signature: signer.sign(payload), publicKey: signer.publicKey };
}

/**
 * The identity port a resolving client would supply: the announcer's handle
 * resolves to the key the fixture signs with, and nothing is revoked. Passing
 * this into a fold is what makes an announcement BELIEVED; without it, core's
 * `unresolvedIdentity` applies and every record is refused as unresolvable —
 * which is the state an agent with no key history is honestly in.
 *
 * `overrides` exists for the attack the rule is for: a record whose envelope
 * carries a DIFFERENT key than the one the handle's history vouches for.
 */
export function announcerIdentity(
  overrides: { key?: AgentSigner["publicKey"]; keyId?: string } = {},
): AnnouncementIdentity {
  const signer = announcementSigner();
  const publicKey = overrides.key ?? signer.publicKey;
  const keyId = overrides.keyId ?? signer.keyId;
  return {
    resolveKeys: async (handle: string): Promise<AnnouncementKeyHistory | null> =>
      handle === ANNOUNCER
        ? {
            identity: {
              handle: ANNOUNCER,
              keyId,
              // The SDK's and core's JsonWebKey types differ only in their
              // index signatures; the key travelling between them is the same
              // object, and the cast records that boundary rather than hiding it.
              publicKey: publicKey as unknown as AnnouncementKeyHistory["identity"]["publicKey"],
              algorithm: signer.suite,
              createdAt: iso(-365 * DAY),
            },
            rotations: [],
          }
        : null,
    revokedKey: async () => null,
  };
}
