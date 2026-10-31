import assert from "node:assert/strict";
import test from "node:test";

import {
  RAREXT_URI_SCHEME,
  formatRarextUri,
  parseRarextUri,
  rarextUriForRoot,
  sameRarextObject,
} from "../src/index.ts";
import type { RarextUri } from "../src/index.ts";

const ROOT = "7ebdf81a1660f395d294040d378f7d76c0efa5d6d8b5b6d70954f54089a27de8";
const OTHER = "b".repeat(64);

function parsed(text: string): RarextUri {
  const result = parseRarextUri(text);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return (result as { ok: true; uri: RarextUri }).uri;
}

test("a bare root is a complete reference: the root IS the address", () => {
  const uri = parsed(`rarext:${ROOT}`);
  assert.equal(uri.root, ROOT);
  assert.equal(uri.authority, undefined);
  assert.equal(uri.path, undefined);
  assert.equal(formatRarextUri(uri), `rarext:${ROOT}`);
});

test("a location plus a pin parses into a hint and a commitment", () => {
  const uri = parsed(`rarext:999svs999.github.io/RAREXT-protocol/registry/bundle.json@${ROOT}`);
  assert.equal(uri.authority, "999svs999.github.io");
  assert.deepEqual(uri.path, ["RAREXT-protocol", "registry", "bundle.json"]);
  assert.equal(uri.root, ROOT);
  // The authority is a hint. It is never authority over what is true.
  assert.equal(formatRarextUri(uri), `rarext:999svs999.github.io/RAREXT-protocol/registry/bundle.json@${ROOT}`);

  // A registry id works the same way, and a query is carried verbatim.
  const byId = parsed(`rarext:rarext/objects/42@${ROOT}?since=2026-01-01`);
  assert.equal(byId.authority, "rarext");
  assert.deepEqual(byId.path, ["objects", "42"]);
  assert.equal(byId.query, "since=2026-01-01");
  assert.equal(formatRarextUri(byId), `rarext:rarext/objects/42@${ROOT}?since=2026-01-01`);
});

test("the ONE rule: a reference without a root is refused, and says why", () => {
  const noRoot = parseRarextUri("rarext:example.com/registry/bundle.json");
  assert.equal(noRoot.ok, false);
  if (!noRoot.ok) assert.match(noRoot.reason, /carries the root it commits to/);
  if (!noRoot.ok) assert.match(noRoot.reason, /a name you have to trust/);

  const shortRoot = parseRarextUri("rarext:example.com/x@7ebdf81a");
  assert.equal(shortRoot.ok, false);
  if (!shortRoot.ok) assert.match(shortRoot.reason, /64-hex/);
});

test("a reference to a different scheme is refused by name, never coerced", () => {
  const https = parseRarextUri("https://example.com/registry/bundle.json");
  assert.equal(https.ok, false);
  if (!https.ok) assert.match(https.reason, /is not a RAREXT reference/);

  const noScheme = parseRarextUri(ROOT);
  assert.equal(noScheme.ok, false);
  if (!noScheme.ok) assert.match(noScheme.reason, /has no scheme/);

  assert.equal(RAREXT_URI_SCHEME, "rarext");
});

test("a path that points somewhere else is refused, not normalised", () => {
  for (const path of ["a/../b", "a//b", "a/./b"]) {
    const result = parseRarextUri(`rarext:example.com/${path}@${ROOT}`);
    assert.equal(result.ok, false, `${path} must be refused`);
  }
  // A trailing slash is an empty segment, and it is refused for the same reason.
  assert.equal(parseRarextUri(`rarext:example.com/a/@${ROOT}`).ok, false);
});

test("one canonical spelling: two writers produce the same bytes", () => {
  const forms = [
    `RAREXT:${ROOT.toUpperCase()}`,
    `rarext://${ROOT}`,
    `rarext:${ROOT}`,
  ];
  const canonical = forms.map((form) => formatRarextUri(parsed(form)));
  assert.deepEqual(new Set(canonical), new Set([`rarext:${ROOT}`]), "case, the // habit and spacing must collapse to one spelling");

  const host = parsed(`rarext:EXAMPLE.com./Registry/Bundle.json@${ROOT.toUpperCase()}`);
  assert.equal(formatRarextUri(host), `rarext:example.com/Registry/Bundle.json@${ROOT}`, "the authority lowercases; the path keeps its case, because a server may be case-sensitive");
});

test("the ROOT decides identity: two locations, one object", () => {
  const here = parsed(`rarext:127.0.0.1/bundle.json@${ROOT}`);
  const there = parsed(`rarext:example.com/mirror/bundle.json@${ROOT}`);
  const elsewhere = parsed(`rarext:example.com/mirror/bundle.json@${OTHER}`);
  const byRoot = parsed(rarextUriForRoot(ROOT));

  assert.equal(sameRarextObject(here, there), true, "mirrors of one root name one object");
  assert.equal(sameRarextObject(here, byRoot), true);
  assert.equal(sameRarextObject(here, elsewhere), false, "a different root is a different object, wherever it lives");

  // And the reference a caller writes when it holds only a root is the bare form.
  assert.equal(rarextUriForRoot(ROOT.toUpperCase()), `rarext:${ROOT}`);
});

test("surrounding structure is not invented: an empty body, a bare authority, and a scheme-only string all fail", () => {
  for (const text of ["rarext:", "rarext://", "rarext:?x=1", "rarext:example.com@", "rarext:@x"]) {
    const result = parseRarextUri(text);
    assert.equal(result.ok, false, `${text} must be refused`);
  }
});
