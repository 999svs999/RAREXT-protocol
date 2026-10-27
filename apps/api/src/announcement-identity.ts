import type {
  AnnouncementIdentity,
  AnnouncementKeyHistory,
  AnnouncementRevocation,
} from "../../../packages/core/src/index.ts";
import type { RarextStore } from "./store.ts";

/**
 * The API's own identity store, answering the two questions core's fold asks.
 *
 * This is a PORT ADAPTER, nothing more: it retrieves, core decides. The key
 * history walk, the rotation windows, the handle binding, the revocation rule —
 * all of it lives in `packages/core/src/announcements.ts`, and the checker's
 * guards fail if this file starts comparing `issuedAt`/`expiresAt` or encoding
 * a revocation rule of its own. That is the third fork the guards exist to
 * prevent.
 *
 * Before this, the API's bundle reader passed core's `unresolvedIdentity`: the
 * server owned the identities, the rotations and the revocations, and its own
 * discovery path could not see them.
 */

/**
 * The revocation kinds this store serves that can name a key id. Core asks one
 * question — "is there a published revocation naming this key" — and the store
 * keys revocations by (kind, target), so every kind is consulted in a fixed
 * order and the first hit answers. The order is part of the answer, so it is
 * written down rather than left to map iteration.
 */
const KEY_REVOCATION_KINDS = ["capability", "verifier", "artifact"] as const;

export function announcementIdentityForStore(store: RarextStore): AnnouncementIdentity {
  return {
    resolveKeys(handle: string): AnnouncementKeyHistory | null {
      const identity = store.getIdentity(handle);
      // An unknown handle answers NULL, never an empty history: a history with
      // no identity would read as "this handle exists and vouches for nothing",
      // which is a different — and wrong — statement.
      if (!identity) return null;
      return { identity, rotations: store.rotationsFor(handle) };
    },

    revokedKey(keyId: string): AnnouncementRevocation | null {
      for (const kind of KEY_REVOCATION_KINDS) {
        const revocation = store.isRevoked(kind, keyId);
        if (revocation) {
          return {
            id: revocation.id,
            kind: revocation.kind,
            target: revocation.target,
            reason: revocation.reason,
          };
        }
      }
      return null;
    },
  };
}
