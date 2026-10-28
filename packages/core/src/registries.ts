import { canonicalize } from "./canonical.ts";
import { sha256Hex, type Sha256 } from "./digest.ts";

/**
 * The seed list: the registries a client can look for.
 *
 * A mirror is useless if nobody can find it, so the set of known registries is
 * itself a published, versioned list — served by an API at `GET /v1/registries`
 * and readable by anything that can fetch JSON. This module is the ONE parser of
 * that shape, and it lives in core because two sides need it: the server that
 * serves the list and the client that consumes it. Its first version had the
 * server normalising entries by hand, and a client would have written a second
 * normaliser — which is how a list ends up meaning two different things.
 *
 * Pure: no I/O, no hashing. Whatever holds the bytes (a file, a response body)
 * is the caller's business.
 */


export interface RegistrySeedEntry {
  /** The registry's short id, e.g. "apesdaily". */
  id: string;
  /** The registry's base URL. */
  url: string;
  /** Who runs it, when the list says. */
  operator: string;
  /** The chains it claims to carry. A claim, not a fact: the entry is data. */
  chains: string[];
  /** A human note, when the list carries one. */
  note: string | null;
  /**
   * The URL of the registry's SEED document, when the list names one.
   * `registrySeedUrl` supplies the convention when it does not.
   */
  seed: string | null;
}

/**
 * Parse a published seed list. Accepts the bare array or an object with a
 * `registries` field, because the served response wraps it and a file need not.
 * Entries missing an `id` or a `url` are DROPPED rather than repaired: a list
 * entry that does not say where to look is not something to guess about.
 */
export function parseRegistrySeedList(value: unknown): RegistrySeedEntry[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "registries" in value
      ? (value as { registries: unknown }).registries
      : null;

  if (!Array.isArray(list)) return [];

  return list
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const record = entry as Partial<RegistrySeedEntry>;
      if (typeof record.id !== "string" || typeof record.url !== "string") return null;
      return {
        id: record.id,
        url: record.url,
        operator: typeof record.operator === "string" ? record.operator : "",
        chains: Array.isArray(record.chains)
          ? record.chains.filter((chain): chain is string => typeof chain === "string")
          : [],
        note: typeof record.note === "string" ? record.note : null,
        seed: typeof record.seed === "string" ? record.seed : null,
      };
    })
    .filter((entry): entry is RegistrySeedEntry => entry !== null);
}

/**
 * Where a registry's seed document lives: what the entry names, or the
 * convention `${url}/registry/seed.json`. One function, so a client and a
 * server cannot disagree about where a listed registry keeps its seed.
 */
export function registrySeedUrl(entry: RegistrySeedEntry): string {
  if (entry.seed) return entry.seed;
  return `${entry.url.replace(/\/+$/, "")}/registry/seed.json`;
}

/** Resolve a possibly relative URL against a base — the list's own location. */
export function resolveRegistryUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/**
 * What a digest of the seed list covers: the ENTRIES, in order, each reduced to
 * its documented fields.
 *
 * Not the whole served document, and that is the point. `GET /v1/registries`
 * answers `{ self: { url, chain }, registries: [...] }` — the server describing
 * itself — and a digest that covered `self` would change every time the server
 * was reached at a different hostname or picked up a new chain, without a single
 * registry changing. A client believes things about REGISTRIES, so that is what
 * is committed to. `canonicalize` makes field order inside an entry irrelevant.
 */
export function registryListDigestSource(entries: RegistrySeedEntry[]): string {
  return canonicalize(
    entries.map((entry) => ({
      id: entry.id,
      url: entry.url,
      operator: entry.operator,
      chains: entry.chains,
      note: entry.note,
      seed: entry.seed,
    })),
  );
}

/**
 * The list's digest, with the hash INJECTED: core owns no hashing dependency,
 * so the caller supplies sha256 (node's, in the SDK).
 */
export function registryListDigest(entries: RegistrySeedEntry[], sha256: Sha256): string {
  return sha256Hex(sha256, registryListDigestSource(entries));
}
