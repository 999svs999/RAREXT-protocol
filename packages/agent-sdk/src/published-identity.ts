import type {
  AnnouncementIdentity,
  AnnouncementKeyHistory,
  AnnouncementRevocation,
  Identity,
  KeyRotation,
} from "@rarext/core";
import { readBundleResponseBytes } from "@rarext/core";

/**
 * A resident's own resolver: the keys of the world it lives in, read from
 * published documents.
 *
 * Until now a caller that wanted announcements believed had to hand the fold a
 * port — which is fine for a server that already owns the identities, and
 * useless for a resident that owns nothing. This builds that port from the
 * documents a publisher serves: the handle's identity, its rotations, and the
 * revocation list. No new surface is needed for it: `GET /v1/identities/<handle>`,
 * `/v1/identities/<handle>/rotations` and `GET /v1/revocations` already exist, so
 * a resident reads exactly what a server would.
 *
 * It answers, and decides nothing. The key-history walk, the rotation windows,
 * the handle binding and the revocation rule all stay in core — this module
 * retrieves, and the checker fails if it starts doing arithmetic of its own.
 */

/** How long any one document fetch may take. */
export const DEFAULT_IDENTITY_TIMEOUT_MS = 15_000;

export interface PublishedIdentityOptions {
  /** Where a handle's identity document lives. */
  identityUrl: (handle: string) => string;
  /**
   * Where its rotations live. Omit when the publisher keeps none: an absent
   * rotations URL and an empty rotations list mean the same thing here, and
   * neither is a fault.
   */
  rotationsUrl?: (handle: string) => string;
  /**
   * Where the revocation list lives. Omit when the publisher publishes none —
   * and note what that means: with no list to read, this resolver answers "no
   * revocation" for every key, so it is a resolver for a world with no
   * revocations rather than a gap.
   */
  revocationsUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function isIdentity(value: unknown): value is Identity {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.handle === "string" &&
    typeof record.keyId === "string" &&
    typeof record.algorithm === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.publicKey === "object" &&
    record.publicKey !== null
  );
}

export function identityFromPublishedDocuments(
  options: PublishedIdentityOptions,
): AnnouncementIdentity {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;

  /**
   * Read one document. `null` means the publisher answered 404 — a real answer,
   * "this is not here". Everything else that goes wrong THROWS: a document that
   * cannot be read is not the same as one that does not exist, and the fold
   * carries a throw as "could not tell" (which refuses the record), so a
   * network failure can never read as an absence.
   */
  const readJson = async (url: string): Promise<unknown | null> => {
    const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = await readBundleResponseBytes(response);
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  // The revocation list is one document for every key, but the fold asks per
  // record, so the in-flight promise is memoised: one fetch per resolver, not
  // one per announcement.
  let revocations: Promise<unknown> | null = null;

  return {
    async resolveKeys(handle: string): Promise<AnnouncementKeyHistory | null> {
      const identity = await readJson(options.identityUrl(handle));
      // An unknown handle answers NULL, never an empty history: a history with
      // no identity would read as "this handle exists and vouches for nothing".
      if (identity === null) return null;
      if (!isIdentity(identity)) {
        // Throwing, not returning null: a corrupted identity document must not
        // be indistinguishable from an absent one.
        throw new Error(`${options.identityUrl(handle)}: not an identity document`);
      }

      let rotations: KeyRotation[] = [];
      if (options.rotationsUrl) {
        const published = await readJson(options.rotationsUrl(handle));
        if (published !== null) {
          if (!Array.isArray(published)) {
            throw new Error(`${options.rotationsUrl(handle)}: not a rotations list`);
          }
          rotations = published as KeyRotation[];
        }
      }
      return { identity, rotations };
    },

    async revokedKey(keyId: string): Promise<AnnouncementRevocation | null> {
      if (!options.revocationsUrl) return null;
      revocations ??= readJson(options.revocationsUrl);
      const list = await revocations;
      if (list === null) return null;
      if (!Array.isArray(list)) throw new Error(`${options.revocationsUrl}: not a revocation list`);
      const revocation = (list as AnnouncementRevocation[]).find((entry) => entry.target === keyId);
      return revocation ?? null;
    },
  };
}

/**
 * Where a publisher's identity documents live, per surface. Two surfaces exist
 * and they are not the same shape: an API serves `/v1/identities/<handle>` (the
 * routes this repository already exposes), while a static tree serves
 * `/identities/<handle>.json`. Both are in ONE place here because the failure
 * mode otherwise is silent: a resident pointed at the wrong surface gets 404s,
 * and a 404 is an honest "this handle is unknown" — so a wrong convention does
 * not error, it just stops believing a publisher that published everything.
 */
export type IdentityDocumentSurface = "api" | "static-tree";

export interface IdentityDocumentUrls {
  identityUrl: (handle: string) => string;
  rotationsUrl: (handle: string) => string;
  revocationsUrl: string;
}

export function identityDocumentUrls(options: {
  origin: string;
  surface?: IdentityDocumentSurface;
}): IdentityDocumentUrls {
  const origin = options.origin.replace(/\/+$/, "");
  if ((options.surface ?? "api") === "static-tree") {
    return {
      identityUrl: (handle) => `${origin}/identities/${encodeURIComponent(handle)}.json`,
      rotationsUrl: (handle) => `${origin}/identities/${encodeURIComponent(handle)}.rotations.json`,
      revocationsUrl: `${origin}/revocations.json`,
    };
  }
  return {
    identityUrl: (handle) => `${origin}/v1/identities/${encodeURIComponent(handle)}`,
    rotationsUrl: (handle) => `${origin}/v1/identities/${encodeURIComponent(handle)}/rotations`,
    revocationsUrl: `${origin}/v1/revocations`,
  };
}

/** The resolver for one publisher's origin, on the surface it actually serves. */
export function identityFromPublishedOrigin(
  options: Omit<PublishedIdentityOptions, "identityUrl" | "rotationsUrl" | "revocationsUrl"> & {
    origin: string;
    surface?: IdentityDocumentSurface;
  },
): AnnouncementIdentity {
  const urls = identityDocumentUrls({ origin: options.origin, ...(options.surface ? { surface: options.surface } : {}) });
  return identityFromPublishedDocuments({ ...urls, ...options });
}
