import { AgentSigner, createAgentKeyfile } from "../src/index.ts";

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

export function announcementSigner(): AgentSigner {
  const keyfile = createAgentKeyfile(ANNOUNCER);
  return new AgentSigner(keyfile.privateKey);
}

/** A signed announcement record, built the way an operator would build one. */
export function signedAnnouncement(
  signer: AgentSigner,
  claims: {
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
    handle: ANNOUNCER,
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
