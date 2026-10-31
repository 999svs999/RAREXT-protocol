/**
 * Reading a site's own statement, from the site.
 *
 * `@rarext/core` decides what a binding MEANS; this reads one — the file carrier over
 * HTTPS and the record carrier over DNS — and hands the bytes to core's parser. The split
 * is deliberate: a rule in one place, the I/O wherever it belongs, so an agent that reads a
 * binding and a browser that reads a binding cannot disagree about what they read.
 *
 * Everything here is a port: the fetch, the resolver, and the clock are injectable, so a
 * test reads a binding from a loopback server and a stub resolver and never touches the
 * network, while a real reader gets `fetch` and `node:dns` by default. Nothing in this file
 * decides whether a binding is TRUE — that is `verifySiteBinding` in core, against the
 * registry's pinned root, and it is the only thing that can say yes.
 */

import { promises as dns } from "node:dns";

import {
  RAREXT_SITE_BINDING_PATH,
  URL_POLICY_REFUSAL_CODE,
  fetchWithUrlPolicy,
  parseSiteBinding,
  siteBindingTxtName,
  siteBindingUrl,
} from "../../core/src/index.ts";
import type { SiteBindingParse } from "../../core/src/index.ts";

/** How long any one read may take, when the caller does not say. */
export const DEFAULT_SITE_BINDING_TIMEOUT_MS = 15_000;

/** What happened to one carrier. "absent" is an answer; "unreachable" is a failure. */
export type CarrierOutcome = "served" | "absent" | "refused" | "unreachable";

export interface SiteBindingRead {
  host: string;
  /** The file carrier, `/.well-known/rarext.json`. */
  file: CarrierOutcome;
  /** The record carrier, `_rarext.<host> TXT`. */
  txt: CarrierOutcome;
  /** Core's parse of whatever was served — the only thing that decides meaning. */
  parse: SiteBindingParse;
  /** Why a carrier ended up absent, refused, or unreachable, in the policy's own words. */
  notes: string[];
}

export interface SiteBindingReadOptions {
  /** Injectable for tests; defaults to the platform fetch. */
  fetch?: typeof fetch | undefined;
  /** Injectable for tests; defaults to `node:dns` TXT lookups. */
  resolveTxt?: ((name: string) => Promise<string[][]>) | undefined;
  timeoutMs?: number | undefined;
  /**
   * Whether private addresses are allowed. False by default, because a public document
   * that points an agent at a private address is the walk-around the policy exists to stop;
   * a loopback deployment earns it the same way a seed does.
   */
  allowPrivate?: boolean | undefined;
}

/**
 * Read both carriers from `origin` and hand them to core's parser.
 *
 * A site needs only one carrier, so a 404 file and an absent record are both answers, not
 * errors: the read reports what it found and core's parse says whether it is a binding. What
 * is NOT an answer is being told to stop — a policy refusal is reported as `refused` with the
 * policy's reason, so an operator can tell "this site published nothing" apart from "my client
 * refused to look", which are very different problems.
 */
export async function readSiteBinding(origin: string, options: SiteBindingReadOptions = {}): Promise<SiteBindingRead> {
  const url = new URL(origin);
  const host = url.hostname;
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SITE_BINDING_TIMEOUT_MS;
  const allowPrivate = options.allowPrivate ?? false;
  const notes: string[] = [];

  let fileText: string | undefined;
  let file: CarrierOutcome = "absent";
  try {
    const response = await fetchWithUrlPolicy(
      siteBindingUrl(url.href),
      { signal: AbortSignal.timeout(timeoutMs) },
      { fetch: request, allowPrivate },
    );
    if (response.status === 404) {
      notes.push(`${RAREXT_SITE_BINDING_PATH} was not served (404)`);
    } else if (!response.ok) {
      file = "unreachable";
      notes.push(`${RAREXT_SITE_BINDING_PATH} answered HTTP ${response.status}`);
    } else {
      fileText = await response.text();
      file = "served";
    }
  } catch (error) {
    // A refusal by the policy is a decision, not a network failure: reporting it as
    // "unreachable" would send an operator to debug a site that was never contacted. The code
    // is compared, never the wording — prose matching broke the first time the policy's
    // sentence changed, and the failure was silent (a refusal read as a transport error).
    const refusal = (error as { code?: string }).code === URL_POLICY_REFUSAL_CODE;
    file = refusal ? "refused" : "unreachable";
    notes.push(`${RAREXT_SITE_BINDING_PATH}: ${(error as Error).message}`);
  }

  const resolveTxt =
    options.resolveTxt ??
    ((name: string) => dns.resolveTxt(name) as Promise<string[][]>);
  const txtName = siteBindingTxtName(host);
  let txtRecords: string[] | undefined;
  let txt: CarrierOutcome = "absent";
  try {
    const records = await resolveTxt(txtName);
    if (records.length === 0) {
      notes.push(`${txtName} returned no TXT record`);
    } else {
      // A TXT record arrives as chunks that are one string to the site that wrote it.
      // Joining here rather than in core keeps core's parser about statements, and the
      // chunking is a transport fact this layer owns.
      txtRecords = records.map((chunks) => chunks.join(""));
      txt = "served";
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "ESERVFAIL" || code === "NXDOMAIN") {
      notes.push(`${txtName} has no TXT record (${code})`);
    } else {
      txt = "unreachable";
      notes.push(`${txtName}: ${(error as Error).message}`);
    }
  }

  const parse = parseSiteBinding({
    ...(fileText === undefined ? {} : { json: fileText }),
    ...(txtRecords === undefined ? {} : { txt: txtRecords }),
    host,
  });

  return { host, file, txt, parse, notes };
}
