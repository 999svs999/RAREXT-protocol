import type {
  AnnouncementDocumentCache,
  AnnouncementDocumentCacheEntry,
} from "../../core/src/index.ts";

/**
 * RFC 0019's question 5, on the SDK side: an in-memory cache a resident can
 * inject into `findVerifiedBundleFromSeeds`.
 *
 * It caches the DOCUMENT, never the VERDICT: an entry holds the parsed
 * announcement document and when it was fetched, and every cached document is
 * handed back to core's fold, where it runs the full verification again —
 * the signature, the handle binding, the window, the lifetime cap, and the
 * per-fold revocation lookup — so a record whose key is revoked dies on the
 * second fold exactly as it would have on a fresh fetch.
 *
 * The TTL is the caller's policy and is NOT stored here: the fold receives
 * `cacheMaxAgeMs` beside the cache and treats an entry older than that as a
 * miss.
 *
 * The cache is bounded (`maxEntries`, oldest-insertion eviction) because an
 * unbounded cache in a long-lived resident is a leak. It is in memory only —
 * there is no persistence — because it is an optimisation, never a source of
 * truth: everything persisted today comes from a fetched document.
 */
export interface MemoryAnnouncementCacheOptions {
  /** The largest number of entries held; the least recently SET is evicted. */
  maxEntries?: number;
}

/**
 * Twenty announcement documents is already more URLs than one seed's
 * `announcements[]` names today; a resident folding many registries still
 * holds only what it has actually read.
 */
export const DEFAULT_ANNOUNCEMENT_CACHE_ENTRIES = 20;

export class MemoryAnnouncementCache implements AnnouncementDocumentCache {
  #entries = new Map<string, AnnouncementDocumentCacheEntry>();
  #maxEntries: number;

  constructor(options: MemoryAnnouncementCacheOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_ANNOUNCEMENT_CACHE_ENTRIES);
  }

  async get(url: string): Promise<AnnouncementDocumentCacheEntry | null> {
    return this.#entries.get(url) ?? null;
  }

  async set(entry: AnnouncementDocumentCacheEntry): Promise<void> {
    // Re-setting a URL moves it to the newest slot; the candidate for eviction
    // is therefore always the head of the map's insertion order.
    if (!this.#entries.has(entry.url) && this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.delete(entry.url);
    this.#entries.set(entry.url, entry);
  }
}
