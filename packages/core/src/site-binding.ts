/**
 * A DNS host that answers for a RAREXT registry.
 *
 * The web4 network does not ask anyone to leave the web they already have. A site that
 * answers on a hostname — any hostname, any certificate, any of today's servers, including
 * a serverless deployment that has nothing but a routing table and a static tree — can
 * declare that it serves a specific registry's copy of the record. The declaration is
 * checked the way every other claim in this protocol is checked: by comparison against the
 * root the REGISTRY pins, never against the site's own word for itself.
 *
 * Two carriers, because a site controls different things at different layers and the
 * transition has to be possible from either one:
 *
 *   /.well-known/rarext.json        a file, for any site that can serve bytes
 *   _rarext.<host>  TXT "…"         a record, for a site that controls its name, not its tree
 *
 * They parse into ONE shape, and when both are present they must AGREE. A site whose file
 * and whose name record name different roots is reported as disagreeing rather than
 * averaged: the only honest reading of two contradictory statements is that one is wrong.
 *
 * What this is not. It is not a name service and it does not replace DNS — the hostname is
 * still resolved by DNS, the bytes are still fetched over HTTPS, and nothing here changes
 * that. And the statement buys a site nothing: `verifySiteBinding` refuses to certify
 * anything without the registry's own pinned root to compare against, so a binding can
 * propose a LOCATION (exactly as an announcement does) and never a fact.
 */

/** Where a site that can serve a file declares itself. */
export const RAREXT_SITE_BINDING_PATH = "/.well-known/rarext.json";

/** The label a site that controls its name uses, queried as `_rarext.<host> TXT`. */
export const RAREXT_SITE_BINDING_TXT_PREFIX = "_rarext";

const HEX64 = /^[0-9a-f]{64}$/;

export interface SiteBinding {
  /** The registry id this site claims to serve a copy of. */
  registry: string;
  /** The bundle root (64-hex Merkle root) the site claims its copy rebuilds to. */
  root: string;
  /** Optional: where the site's copy of the bundle lives, when it is not this host. */
  bundle?: string;
  /** Optional: the content address of the bundle, when the site pins one. */
  cid?: string;
  /** Optional: when the site made the statement. */
  issuedAt?: string;
  /** Which carrier this statement was read from — reported so a disagreement can name both. */
  carrier: "well-known" | "dns-txt";
  /** The host the statement was read from, when the caller knows it. */
  host?: string;
}

export type SiteBindingParse = { ok: true; binding: SiteBinding } | { ok: false; reason: string };

export type SiteBindingVerdict =
  | { ok: true; registry: string; root: string; host?: string | undefined }
  | { ok: false; reason: string };

/** The URL a file-carrying site is asked for, resolved against its own origin. */
export function siteBindingUrl(origin: string): string {
  return new URL(RAREXT_SITE_BINDING_PATH, origin).href;
}

/** The name a DNS-carrying site is asked about, resolved against its own hostname. */
export function siteBindingTxtName(host: string): string {
  return `${RAREXT_SITE_BINDING_TXT_PREFIX}.${host}`;
}

/**
 * The TXT record's body, parsed into the same shape the file parses into.
 *
 * `registry=…; root=…; [bundle=…; cid=…; issuedAt=…]` — a semicolon-separated statement,
 * because that is all a TXT record is good for and pretending otherwise would make the
 * transition unavailable to exactly the sites that control only their name. Keys are
 * case-insensitive; surrounding quotes are stripped, because DNS servers hand them back
 * inconsistently; unknown keys are refused rather than ignored, so a statement written
 * against a different convention fails loudly here instead of silently binding nothing.
 */
export function parseSiteBindingTxt(text: string, options: { host?: string } = {}): SiteBindingParse {
  const fields = new Map<string, string>();
  // A DNS server hands a TXT record back wrapped in quotes as often as not, and which one a
  // particular resolver does is not something a site can control. One wrapping pair around
  // the whole record is therefore stripped before the fields are read — otherwise the first
  // field's key would parse as `"registry`, and the transition would work on some resolvers
  // and silently fail on others.
  const parts = stripQuotes(text.trim()).split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      return { ok: false, reason: `site binding record has a field without a value: ${JSON.stringify(trimmed)}` };
    }
    const key = trimmed.slice(0, equals).trim().toLowerCase();
    const value = stripQuotes(trimmed.slice(equals + 1).trim());
    const known = ["registry", "root", "bundle", "cid", "issuedat"];
    if (!known.includes(key)) {
      return { ok: false, reason: `site binding record names an unknown field ${JSON.stringify(key)}` };
    }
    if (fields.has(key)) {
      return { ok: false, reason: `site binding record repeats the field ${JSON.stringify(key)}` };
    }
    fields.set(key, value);
  }

  return bindingFromFields(fields, "dns-txt", options.host);
}

/**
 * The file's body, parsed into the same shape.
 *
 * A JSON object with the same fields as the record. Anything that is not an object, or
 * that names a field this convention does not define, is refused: a document written
 * against a different convention must fail here rather than bind a site to nothing.
 */
export function parseSiteBindingDocument(text: string, options: { host?: string } = {}): SiteBindingParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `site binding document is not JSON (${(error as Error).message})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "site binding document must be a JSON object" };
  }

  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    const known = ["registry", "root", "bundle", "cid", "issuedat"];
    if (!known.includes(lower)) {
      return { ok: false, reason: `site binding document names an unknown field ${JSON.stringify(key)}` };
    }
    if (typeof value !== "string") {
      return { ok: false, reason: `site binding field ${JSON.stringify(key)} must be a string` };
    }
    fields.set(lower, value.trim());
  }

  return bindingFromFields(fields, "well-known", options.host);
}

/**
 * Both carriers at once, which is the question a real transition asks.
 *
 * `json` and `txt` are whatever the site actually served; either may be absent (a site
 * needs only one), but when both are present they must name the same registry and the same
 * root. Two statements that disagree are reported by carrier, because "this site's file and
 * its name record disagree" is a different finding from "this site is serving the wrong
 * copy", and an operator needs to know which one they have.
 */
export function parseSiteBinding(
  input: { json?: string | undefined; txt?: string | string[] | undefined; host?: string | undefined },
): SiteBindingParse {
  const host = input.host;
  const parsedJson = typeof input.json === "string" ? parseSiteBindingDocument(input.json, { host }) : undefined;

  const txtRecords = typeof input.txt === "string" ? [input.txt] : Array.isArray(input.txt) ? input.txt : [];
  const parsedTxt =
    txtRecords.length === 0
      ? undefined
      : txtRecords.length > 1
        ? { ok: false as const, reason: `the name carries ${txtRecords.length} site binding records; one host states one binding` }
        : parseSiteBindingTxt(txtRecords[0] as string, { host });

  if (parsedJson && !parsedJson.ok) return parsedJson;
  if (parsedTxt && !parsedTxt.ok) return parsedTxt;
  if (!parsedJson && !parsedTxt) {
    return { ok: false, reason: `no site binding was served at ${RAREXT_SITE_BINDING_PATH} or at ${siteBindingTxtName(host ?? "<host>")}` };
  }
  if (parsedJson && parsedTxt && parsedJson.ok && parsedTxt.ok) {
    const a = parsedJson.binding;
    const b = parsedTxt.binding;
    if (a.registry !== b.registry || a.root !== b.root) {
      return {
        ok: false,
        reason: `the site's file and its name record disagree: file says ${a.registry}@${a.root.slice(0, 16)}…, record says ${b.registry}@${b.root.slice(0, 16)}…`,
      };
    }
    const merged: SiteBinding = { ...a };
    if (merged.bundle === undefined && b.bundle !== undefined) merged.bundle = b.bundle;
    if (merged.cid === undefined && b.cid !== undefined) merged.cid = b.cid;
    if (merged.issuedAt === undefined && b.issuedAt !== undefined) merged.issuedAt = b.issuedAt;
    merged.carrier = "well-known";
    return { ok: true, binding: merged };
  }
  return parsedJson?.ok ? parsedJson : (parsedTxt as { ok: true; binding: SiteBinding });
}

/**
 * The verdict, and the reason this function exists.
 *
 * A site's statement about itself is not evidence about itself. `pinnedRoot` is the root
 * the REGISTRY pins — from its seed, its anchor, or the bundle a client already verified —
 * and the binding is checked against it:
 *
 *   - no pinned root to compare against       refused: a binding cannot certify itself
 *   - the binding names another registry      `registry-mismatch`
 *   - the binding names a different root      `root-mismatch` — the site is serving a copy
 *                                             that is not the one its registry pins (a stale
 *                                             mirror, or someone else's copy under this name)
 *
 * A site that declares the root its registry pins is exactly what a transition looks like:
 * the site keeps its hostname, its certificate and its deployment, and the network can now
 * say of its bytes what it says of every other copy — this is the registry's record, at the
 * pinned root, or it is not.
 */
export function verifySiteBinding(
  binding: SiteBinding,
  options: { pinnedRoot?: string | undefined; expectedRegistry?: string | undefined },
): SiteBindingVerdict {
  const pinnedRoot = options.pinnedRoot;
  if (typeof pinnedRoot !== "string" || !HEX64.test(pinnedRoot)) {
    return {
      ok: false,
      reason: "a site binding cannot certify itself: pass the registry's pinned root to compare against",
    };
  }
  if (typeof options.expectedRegistry === "string" && options.expectedRegistry.length > 0 && binding.registry !== options.expectedRegistry) {
    return {
      ok: false,
      reason: `registry-mismatch: the site answers for ${binding.registry}, this registry is ${options.expectedRegistry}`,
    };
  }
  if (binding.root !== pinnedRoot) {
    return {
      ok: false,
      reason: `root-mismatch: the site claims ${binding.root}, the registry pins ${pinnedRoot}`,
    };
  }
  return { ok: true, registry: binding.registry, root: binding.root, host: binding.host };
}

function bindingFromFields(
  fields: Map<string, string>,
  carrier: SiteBinding["carrier"],
  host: string | undefined,
): SiteBindingParse {
  const registry = fields.get("registry") ?? "";
  const root = fields.get("root") ?? "";

  if (registry.length === 0) {
    return { ok: false, reason: "site binding names no registry" };
  }
  if (!HEX64.test(root)) {
    return { ok: false, reason: `site binding root must be a 64-hex bundle root, got ${JSON.stringify(root)}` };
  }

  const binding: SiteBinding = { registry, root, carrier };
  const bundle = fields.get("bundle");
  const cid = fields.get("cid");
  const issuedAt = fields.get("issuedat");
  if (bundle !== undefined) binding.bundle = bundle;
  if (cid !== undefined) binding.cid = cid;
  if (issuedAt !== undefined) binding.issuedAt = issuedAt;
  if (host !== undefined) binding.host = host;
  return { ok: true, binding };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}
