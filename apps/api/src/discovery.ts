import type { AnnouncementEvent } from "../../../packages/core/src/index.ts";
import { MAX_BUNDLE_RESPONSE_BYTES } from "../../../packages/core/src/bundle.ts";
import { announcementIdentityForStore } from "./announcement-identity.ts";
import { bundleFromSeeds, type SeedDocument, type VerifiedBundleFromSeeds } from "./bundle.ts";
import type { RarextStore } from "./store.ts";

/**
 * The seeds this server discovers from, and the report it serves about them.
 *
 * The route that calls this takes NO location from the caller. A server that
 * fetches a URL a client chose is an SSRF surface, and a verification report
 * paid for by reaching into someone else's private network is not a report. The
 * seeds are therefore the operator's, configured up front; a caller can ask
 * what the network says, never where the server should look.
 */

/** The published seed, used when the operator configures none. */
export const DEFAULT_DISCOVERY_SEED =
  "https://999svs999.github.io/RAREXT-protocol/registry/seed.json";

/** How long any one discovery fetch may take. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;

export function discoverySeeds(env: { RAREXT_DISCOVERY_SEEDS?: string } = process.env): string[] {
  const configured = (env.RAREXT_DISCOVERY_SEEDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [DEFAULT_DISCOVERY_SEED];
}

/** What the route serves: which location answered, and whose keys said so. */
export interface DiscoveryReport {
  seeds: string[];
  /** The location that served the verified copy. */
  source: string;
  root: string;
  candidates: number;
  announcements: AnnouncementEvent[];
}

export class DiscoveryError extends Error {
  // Declared and assigned rather than a constructor parameter property: this
  // repo runs TypeScript in node's strip-only mode, which rejects that syntax
  // outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly refusals: string[];

  constructor(message: string, refusals: string[]) {
    super(message);
    this.name = "DiscoveryError";
    this.refusals = refusals;
  }
}

/** A seed document, read from its URL. Bounded like every other fetch path. */
async function loadSeed(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<SeedDocument> {
  const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BUNDLE_RESPONSE_BYTES) {
    throw new Error(`${url}: the seed document exceeds ${MAX_BUNDLE_RESPONSE_BYTES} bytes`);
  }
  const parsed = JSON.parse(text) as SeedDocument;
  if (!parsed || typeof parsed.bundle !== "string" || typeof parsed.bundleRoot !== "string") {
    throw new Error(`${url}: not a seed document (needs bundle and bundleRoot)`);
  }
  return { ...parsed, url };
}

export interface DiscoveryInput {
  seeds: string[];
  store: RarextStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onAnnouncement?: (event: AnnouncementEvent) => void;
}

/**
 * Fold the configured seeds through the store's own identities and return what
 * verified. A seed that cannot be read is REPORTED, not swallowed: discovery
 * that hides a dead seed reports a network smaller than the real one.
 */
export async function discoverPublishedBundle(input: DiscoveryInput): Promise<DiscoveryReport> {
  const doFetch = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const refusals: string[] = [];

  const loaded: SeedDocument[] = [];
  for (const url of input.seeds) {
    try {
      loaded.push(await loadSeed(url, doFetch, timeoutMs));
    } catch (error) {
      refusals.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (loaded.length === 0) {
    throw new DiscoveryError(
      refusals.length > 0 ? "no configured seed could be read" : "no seeds are configured",
      refusals,
    );
  }

  const announcements: AnnouncementEvent[] = [];
  try {
    const found: VerifiedBundleFromSeeds = await bundleFromSeeds(loaded, {
      fetch: doFetch,
      timeoutMs,
      identity: announcementIdentityForStore(input.store),
      onAnnouncement: (event) => {
        announcements.push(event);
        input.onAnnouncement?.(event);
      },
    });

    return {
      seeds: input.seeds,
      source: found.source,
      root: found.root,
      candidates: found.candidates,
      announcements,
    };
  } catch (error) {
    // The refusals the fold collected are the report: every candidate, and why
    // it did not answer. A 502 without them is a shrug.
    throw new DiscoveryError(
      error instanceof Error ? error.message : String(error),
      announcements
        .filter((event) => event.status !== "accepted")
        .map((event) => `${event.url}: ${event.reason ?? event.status}`)
        .concat(refusals),
    );
  }
}
