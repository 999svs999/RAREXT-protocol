/**
 * Can an agent fetch this URL? — the SCHEME and ADDRESS policies for URLs an
 * agent did not choose.
 *
 * These live in core because BOTH callers of the same walk must answer
 * identically: the SDK's `findVerifiedBundleFromSeeds` and the API's
 * `bundleFromSeeds` are held to byte-identical behaviour by their own tests, and
 * a guard on one side only is exactly how the two halves of a shared rule drift.
 *
 * The scheme is always enforced: a `file:` URL in a published document would have
 * an agent read its own disk and hand the contents back as a "registry". The
 * address is enforced by default: an agent in a cloud VM that follows a public
 * document to the instance metadata service is being robbed of credentials, not
 * federated. This is a literal-address policy — no DNS here — and says so.
 */

/** The scheme policy: a registry is http or https, never anything else. */
export function canFetchRegistryScheme(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `${url} is not a URL` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `${parsed.protocol}// is not fetchable: a registry must be http or https` };
  }

  return { ok: true };
}

/**
 * The address policy, separate from the scheme ON PURPOSE: "not fetchable at
 * all" and "not fetchable without an allowance" are different answers, and
 * conflating them is how a `file://` list got treated as a local environment and
 * its scheme check skipped.
 */
export function canFetchRegistryHost(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `${url} is not a URL` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: `${host} is a local host` };
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const private4 =
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    if (private4) return { ok: false, reason: `${host} is a private or link-local address` };
  }

  const v6 = host.includes(":");
  if (v6) {
    if (host === "::" || host === "::1") return { ok: false, reason: `${host} is a local address` };
    const head = parseInt(host.split(":")[0] || "0", 16);
    if ((head & 0xfe00) === 0xfe00) return { ok: false, reason: `${host} is a link-local address` };
    if ((head & 0xfe00) === 0xfc00) return { ok: false, reason: `${host} is a unique-local address` };
  }

  return { ok: true };
}

export function canFetchRegistryUrl(url: string, options: { allowPrivate?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
  const scheme = canFetchRegistryScheme(url);
  if (!scheme.ok) return scheme;
  if (options.allowPrivate) return { ok: true };
  return canFetchRegistryHost(url);
}

/**
 * Does a seed describe a LOCAL environment? Asked of the URL the seed itself
 * points at — its own location, or failing that its primary bundle — never of its
 * mirrors, because those are what the policy is about. A local tree earns the
 * allowance; a public document naming a private mirror does not.
 */
export function allowPrivateFromSeeds(seeds: Array<{ url?: string | undefined; bundle?: string | undefined }>): boolean {
  return seeds.some((seed) => {
    const primary = seed.url ?? seed.bundle;
    return typeof primary === "string" && !canFetchRegistryHost(primary).ok;
  });
}
