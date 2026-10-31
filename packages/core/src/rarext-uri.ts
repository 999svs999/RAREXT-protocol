/**
 * A RAREXT reference: how an object is NAMED when it is written down.
 *
 * The question this answers is narrow on purpose. RAREXT already has addresses — a registry's
 * origin, a path, and a pinned root — and a way for a site to declare itself
 * (`docs/TRANSITION.md`). What it did not have is a way to WRITE ONE DOWN that cannot be
 * misread: a string in a document, a message, or another artifact that says which object is
 * meant, without saying "trust this name".
 *
 * So the rule is one sentence long:
 *
 *   **A RAREXT reference carries the root it commits to. Without a root it is a name you
 *   have to trust, and this protocol does not have those.**
 *
 * Two forms, and both carry a root:
 *
 *   rarext:<64-hex root>                    an object by its root — nothing to resolve, and
 *                                           nothing to trust: the root IS the address
 *   rarext:<authority>/<path>@<64-hex root> a LOCATION plus the pin the bytes must rebuild to
 *
 * The authority (a registry id or a hostname) and the path are a HINT about where to look. They
 * are never authority over what is true: whoever fetches it still runs the ordinary verification
 * and refuses bytes that do not hash to the root. Two references with the same root and different
 * locations name the SAME object, and that is the point of writing one down.
 *
 * What this is not: it is not a name service, it does not replace DNS, and nothing here resolves
 * anything. It is a syntax with one rule (the root is present and it is the identity), so that a
 * reference is checkable before anything is fetched — which is the difference between an address
 * and a promise.
 */

export const RAREXT_URI_SCHEME = "rarext";

const HEX64 = /^[0-9a-f]{64}$/;

export interface RarextUri {
  /** Where to look: a registry id or a hostname. A hint, never authority. */
  authority?: string;
  /** What to ask for there, as path segments. */
  path?: string[];
  /** The commitment: the 64-hex root the fetched bytes must rebuild to. */
  root: string;
  /** Everything after `?`, kept verbatim: this module does not invent query semantics. */
  query?: string;
}

export type RarextUriParse = { ok: true; uri: RarextUri } | { ok: false; reason: string };

/**
 * Parse a reference, and refuse anything that is not one.
 *
 * The refusals are the design. A reference with no root is refused rather than treated as a
 * location to be trusted; a path with an empty segment or `..` is refused, because that is how a
 * written-down address quietly becomes a different address; and a different scheme is refused by
 * name instead of being coerced into this one.
 */
export function parseRarextUri(text: string): RarextUriParse {
  if (typeof text !== "string") {
    return { ok: false, reason: "a RAREXT reference must be a string" };
  }
  const colon = text.indexOf(":");
  if (colon < 0) {
    return { ok: false, reason: `a RAREXT reference starts with ${RAREXT_URI_SCHEME}: — ${JSON.stringify(text)} has no scheme` };
  }
  const scheme = text.slice(0, colon).toLowerCase();
  if (scheme !== RAREXT_URI_SCHEME) {
    return { ok: false, reason: `${JSON.stringify(scheme)} is not a RAREXT reference (expected ${RAREXT_URI_SCHEME}:)` };
  }

  let body = text.slice(colon + 1);
  // A written reference may pick up the `//` an author's habit supplies. Accepting it is kinder
  // than refusing a document over two slashes; emitting it never happens — `formatRarextUri` has
  // one canonical spelling.
  if (body.startsWith("//")) body = body.slice(2);

  let query: string | undefined;
  const question = body.indexOf("?");
  if (question >= 0) {
    query = body.slice(question + 1);
    body = body.slice(0, question);
  }

  if (body.length === 0) {
    return { ok: false, reason: "a RAREXT reference must name an object or a root" };
  }

  // A bare root: the whole address, and nothing to resolve.
  const bare = body.toLowerCase();
  if (HEX64.test(bare)) {
    return { ok: true, uri: { root: bare, ...(query === undefined ? {} : { query }) } };
  }

  const at = body.lastIndexOf("@");
  if (at < 0) {
    return {
      ok: false,
      reason:
        "a RAREXT reference carries the root it commits to (rarext:<authority>/<path>@<64-hex root>); without one it is a name you have to trust",
    };
  }

  const root = body.slice(at + 1).toLowerCase();
  if (!HEX64.test(root)) {
    return { ok: false, reason: `the root in ${JSON.stringify(body.slice(at))} must be a 64-hex digest` };
  }

  const located = body.slice(0, at);
  const segments = located.split("/");
  const authority = (segments.shift() ?? "").trim().toLowerCase().replace(/\.$/, "");

  const path: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) {
      return { ok: false, reason: `the path in ${JSON.stringify(located)} has an empty segment` };
    }
    if (segment === "." || segment === "..") {
      return { ok: false, reason: `the path in ${JSON.stringify(located)} contains ${JSON.stringify(segment)}, which points somewhere else` };
    }
    path.push(decodeURIComponent(segment));
  }

  if (authority.length === 0 && path.length === 0) {
    return { ok: false, reason: "a reference with no location must be a bare root" };
  }

  return {
    ok: true,
    uri: {
      ...(authority.length === 0 ? {} : { authority }),
      ...(path.length === 0 ? {} : { path }),
      root,
      ...(query === undefined ? {} : { query }),
    },
  };
}

/** The one canonical spelling, so two writers of the same reference produce the same bytes. */
export function formatRarextUri(uri: RarextUri): string {
  const query = uri.query === undefined ? "" : `?${uri.query}`;
  if (uri.authority === undefined && (uri.path === undefined || uri.path.length === 0)) {
    return `${RAREXT_URI_SCHEME}:${uri.root}${query}`;
  }
  const authority = uri.authority ?? "";
  const path = uri.path === undefined || uri.path.length === 0 ? "" : `/${uri.path.map(encodeURIComponent).join("/")}`;
  return `${RAREXT_URI_SCHEME}:${authority}${path}@${uri.root}${query}`;
}

/** The reference to an object whose root you hold, and whose location you do not need to state. */
export function rarextUriForRoot(root: string): string {
  return `${RAREXT_URI_SCHEME}:${root.toLowerCase()}`;
}

/**
 * Do two references name the same object?
 *
 * The ROOT decides, and only the root. Two references that disagree about where to look still name
 * one object when they agree about what its bytes must rebuild to — which is what makes it safe to
 * carry a reference across mirrors, and what makes a reference to "the same document, on my node"
 * recognisably the same document.
 */
export function sameRarextObject(left: RarextUri, right: RarextUri): boolean {
  return left.root === right.root;
}
