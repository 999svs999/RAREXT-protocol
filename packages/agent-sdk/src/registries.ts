import {
  parseRegistrySeedList,
  registryListDigest,
  registrySeedUrl,
  resolveRegistryUrl,
  readBundleResponseBytes,
} from "@rarext/core";
import { createHash } from "node:crypto";
import type { RegistrySeedEntry } from "@rarext/core";

import { findVerifiedBundle, findVerifiedBundleFromSeeds, type SeedDocument, type VerifiedBundleSource } from "./index.ts";
import { identityFromPublishedOrigin } from "./published-identity.ts";

/**
 * The federation query: read a published seed list, and ask every registry on it
 * for a copy of ITS bundle.
 *
 * A mirror is only useful if it can be found, and a resident that has to be
 * handed one URL at a time is not on a network. This reads the list an operator
 * publishes (`GET /v1/registries`, or the same JSON in a file) and verifies each
 * registry's own seed — so "which registries exist, and can I hold their copies?"
 * is one call.
 *
 * A registry that does not answer is REPORTED, never fatal. Federation means the
 * others still work: one dead host must not blind a resident to the rest, which
 * is the same rule discovery already follows for a dead mirror.
 */

export const DEFAULT_REGISTRY_TIMEOUT_MS = 15_000;

export interface RegistryListOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * The digest the list's entries must match, when the caller has one from
   * somewhere it trusts more than the URL (an anchor, say). Absent means the
   * location is the trust.
   */
  expectDigest?: string;
  /** Called for every registry, in order, before any bundle is verified. */
  onRegistry?: (event: RegistryOutcome) => void;
}

export type RegistryOutcome =
  | { id: string; url: string; status: "verified"; source: string; root: string }
  | { id: string; url: string; status: "unreachable"; reason: string }
  | { id: string; url: string; status: "refused"; reason: string };

export interface RegistryListResult {
  /** The list's own location, as passed in. */
  list: string;
  /** The registry seeds the list named, after normalisation. */
  entries: RegistrySeedEntry[];
  verified: Array<{ id: string; url: string; bundle: VerifiedBundleSource }>;
  failures: Array<{ id: string; url: string; reason: string }>;
}

async function readJson(url: string, doFetch: typeof fetch, timeoutMs: number): Promise<unknown> {
  const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readBundleResponseBytes(response);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Read and normalise a published seed list. The parsing is core's — the server
 * that serves this list uses the same function, so a client and a server cannot
 * disagree about what the list says.
 */
/** sha256 over the entries, bound to node's crypto — the SDK's side of core's injected hash. */
export function registryListDigestOf(entries: RegistrySeedEntry[]): string {
  return registryListDigest(entries, (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()));
}

/**
 * Read and normalise a published seed list. The parsing is core's — the server
 * that serves this list uses the same function, so a client and a server cannot
 * disagree about what the list says.
 *
 * `expectDigest` is how a caller stops trusting the URL and starts checking the
 * CONTENT: the digest covers the entries, so a list that grew an extra registry
 * — or lost one, or had a URL swapped — does not match. Without it, the caller is
 * trusting whoever controls the location, which is stated rather than implied.
 */
export async function registriesFromPublishedList(
  listUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; expectDigest?: string } = {},
): Promise<RegistrySeedEntry[]> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  const parsed = await readJson(listUrl, doFetch, timeoutMs);
  const entries = parseRegistrySeedList(parsed);

  if (options.expectDigest !== undefined) {
    const actual = registryListDigestOf(entries);
    if (actual !== options.expectDigest) {
      throw new Error(
        `the seed list at ${listUrl} does not match the expected digest: ` +
          `expected ${options.expectDigest}, computed ${actual}`,
      );
    }
  }

  return entries;
}

/** Ask every registry on the list for a copy that rebuilds the root IT pins. */
export async function findVerifiedBundlesFromRegistryList(
  listUrl: string,
  options: RegistryListOptions = {},
): Promise<RegistryListResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;

  const entries = await registriesFromPublishedList(listUrl, {
    fetch: doFetch,
    timeoutMs,
    ...(options.expectDigest === undefined ? {} : { expectDigest: options.expectDigest }),
  });
  const verified: RegistryListResult["verified"] = [];
  const failures: RegistryListResult["failures"] = [];

  for (const entry of entries) {
    const seedUrl = resolveRegistryUrl(registrySeedUrl(entry), listUrl);
    try {
      const seed = (await readJson(seedUrl, doFetch, timeoutMs)) as SeedDocument;
      if (!seed || typeof seed.bundle !== "string" || typeof seed.bundleRoot !== "string") {
        const reason = `${seedUrl}: not a seed document`;
        failures.push({ id: entry.id, url: entry.url, reason });
        options.onRegistry?.({ id: entry.id, url: entry.url, status: "unreachable", reason });
        continue;
      }
      const found = await findVerifiedBundle({ ...seed, url: seedUrl }, { fetch: doFetch, timeoutMs });
      verified.push({ id: entry.id, url: entry.url, bundle: found });
      options.onRegistry?.({
        id: entry.id,
        url: entry.url,
        status: "verified",
        source: found.source,
        root: found.root,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ id: entry.id, url: entry.url, reason });
      options.onRegistry?.({ id: entry.id, url: entry.url, status: "refused", reason });
    }
  }

  return { list: listUrl, entries, verified, failures };
}

/**
 * Join the network in one call: every registry on a published list, its copy
 * verified against its own root, and its announcements believed only under keys
 * resolved from THAT registry's own published documents.
 *
 * This is the composition the last several units were built for. A resident with
 * nothing but a list URL now discovers the federation, verifies each member's
 * bundle, and refuses an announcement from a key its registry does not vouch
 * for — with every failure attributed to the registry it came from, so an
 * operator reading the report knows which host to talk to.
 */
export interface NetworkJoinResult {
  list: string;
  entries: RegistrySeedEntry[];
  registries: Array<
    | { id: string; url: string; status: "verified"; source: string; root: string }
    | { id: string; url: string; status: "refused"; reason: string }
    | { id: string; url: string; status: "unreachable"; reason: string }
  >;
  verified: Array<{ id: string; url: string; bundle: VerifiedBundleSource }>;
  /** Every announcement event, attributed to the registry whose seed listed it. */
  announcements: Array<{ registry: string; url: string; status: string; reason?: string; mirror?: string }>;
}

export interface NetworkJoinOptions extends RegistryListOptions {
  /** Called for every announcement event, already attributed to its registry. */
  onAnnouncement?: (event: NetworkJoinResult["announcements"][number]) => void;
}

export async function joinRegistryNetwork(
  listUrl: string,
  options: NetworkJoinOptions = {},
): Promise<NetworkJoinResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;

  const entries = await registriesFromPublishedList(listUrl, {
    fetch: doFetch,
    timeoutMs,
    ...(options.expectDigest === undefined ? {} : { expectDigest: options.expectDigest }),
  });
  const result: NetworkJoinResult = { list: listUrl, entries, registries: [], verified: [], announcements: [] };

  for (const entry of entries) {
    const seedUrl = resolveRegistryUrl(registrySeedUrl(entry), listUrl);
    const failure = (status: "refused" | "unreachable", reason: string): void => {
      result.registries.push({ id: entry.id, url: entry.url, status, reason });
      options.onRegistry?.({ id: entry.id, url: entry.url, status, reason });
    };

    let seed: SeedDocument;
    try {
      const parsed = (await readJson(seedUrl, doFetch, timeoutMs)) as SeedDocument;
      if (!parsed || typeof parsed.bundle !== "string" || typeof parsed.bundleRoot !== "string") {
        failure("unreachable", `${seedUrl}: not a seed document`);
        continue;
      }
      seed = { ...parsed, url: seedUrl };
    } catch (error) {
      failure("unreachable", error instanceof Error ? error.message : String(error));
      continue;
    }

    // The registry's OWN documents resolve its announcers — the API surface,
    // because a registry in a seed list is a server, not a directory of files.
    const identity = identityFromPublishedOrigin({
      origin: entry.url,
      surface: "api",
      ...(options.fetch ? { fetch: doFetch } : {}),
      timeoutMs,
    });

    try {
      const found = await findVerifiedBundleFromSeeds([seed], {
        fetch: doFetch,
        timeoutMs,
        identity,
        onAnnouncement: (event) => {
          // The event union says what it carries: an accepted record names its
          // mirror, a refused one names its reason. Narrowing rather than
          // spreading optional fields keeps that distinction in the report.
          const attributed =
            event.status === "accepted"
              ? { registry: entry.id, url: event.url, status: event.status, mirror: event.mirror }
              : { registry: entry.id, url: event.url, status: event.status, reason: event.reason };
          result.announcements.push(attributed);
          options.onAnnouncement?.(attributed);
        },
      });
      result.verified.push({ id: entry.id, url: entry.url, bundle: found });
      result.registries.push({
        id: entry.id,
        url: entry.url,
        status: "verified",
        source: found.source,
        root: found.root,
      });
      options.onRegistry?.({
        id: entry.id,
        url: entry.url,
        status: "verified",
        source: found.source,
        root: found.root,
      });
    } catch (error) {
      failure("refused", error instanceof Error ? error.message : String(error));
    }
  }

  return result;
}
