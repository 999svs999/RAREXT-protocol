import {
  parseRegistrySeedList,
  registrySeedUrl,
  resolveRegistryUrl,
  readBundleResponseBytes,
} from "@rarext/core";
import type { RegistrySeedEntry } from "@rarext/core";

import { findVerifiedBundle, type SeedDocument, type VerifiedBundleSource } from "./index.ts";

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
export async function registriesFromPublishedList(
  listUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<RegistrySeedEntry[]> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  const parsed = await readJson(listUrl, doFetch, timeoutMs);
  return parseRegistrySeedList(parsed);
}

/** Ask every registry on the list for a copy that rebuilds the root IT pins. */
export async function findVerifiedBundlesFromRegistryList(
  listUrl: string,
  options: RegistryListOptions = {},
): Promise<RegistryListResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;

  const entries = await registriesFromPublishedList(listUrl, { fetch: doFetch, timeoutMs });
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
