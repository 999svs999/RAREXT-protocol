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

/**
 * Fetch a URL only if the policy allows it, and only to where the policy allows —
 * checking every HOP.
 *
 * The address policy alone was walkable-around: a public URL could answer 302 with
 * a private `Location`, and `fetch` would follow it to the instance metadata
 * service without ever asking. So the request is made with `redirect: "manual"`,
 * each 3xx target is resolved against the current URL and re-checked against the
 * same policy, and the chain is capped. A registry that legitimately moved still
 * works — one or two hops are followed — while a redirect INTO a private address
 * is refused at the hop, by name, before anything is requested from it.
 *
 * This lives in core for the reason the policy does: the API and the SDK must not
 * be able to disagree about what a hop is.
 */
/**
 * The code a REFUSAL carries.
 *
 * A policy refusal is a decision this client made; an unreachable host is a failure the
 * network made. Callers that must report which one they hit — an operator reading "this site
 * published nothing" needs to know it was not "my client refused to look" — compare this code
 * rather than the message, because prose drifts and a checker cannot hold it.
 */
export const URL_POLICY_REFUSAL_CODE = "url-policy";

function policyRefusal(message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = URL_POLICY_REFUSAL_CODE;
  return error;
}

export async function fetchWithUrlPolicy(
  url: string,
  init: RequestInit,
  options: { fetch: typeof fetch; allowPrivate?: boolean; maxRedirects?: number },
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 2;
  let target = url;

  for (let hop = 0; ; hop += 1) {
    const allowed = canFetchRegistryUrl(target, {
      ...(options.allowPrivate === undefined ? {} : { allowPrivate: options.allowPrivate }),
    });
    if (!allowed.ok) {
      // Tagged, because "the client declined to look" and "the site could not be reached" are
      // different findings and a caller that has to tell them apart by reading the message text
      // will get it wrong the first time the wording changes — which is exactly what happened
      // when a binding reader matched /private address/ against "private or link-local address".
      throw policyRefusal(
        hop === 0 ? allowed.reason : `${allowed.reason} (reached by ${hop} redirect${hop === 1 ? "" : "s"} from ${url})`,
      );
    }

    const response = await options.fetch(target, { ...init, redirect: "manual" });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`${target} answered ${response.status} without a Location`);
    }
    if (hop >= maxRedirects) {
      throw policyRefusal(`${url} redirected more than ${maxRedirects} times — a chain this long is not a registry moving`);
    }
    target = new URL(location, target).href;
  }
}
