import assert from "node:assert/strict";
import test from "node:test";

import {
  RAREXT_SITE_BINDING_PATH,
  parseSiteBinding,
  parseSiteBindingDocument,
  parseSiteBindingTxt,
  siteBindingTxtName,
  siteBindingUrl,
  verifySiteBinding,
} from "../src/index.ts";

const ROOT = "7ebdf81a1660f395d294040d378f7d76c0efa5d6d8b5b6d70954f54089a27de8";
const OTHER = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("a file-carrying site's statement parses into a binding", () => {
  const parsed = parseSiteBindingDocument(
    JSON.stringify({ registry: "rarext", root: ROOT, bundle: "https://example.com/rarext/bundle.json" }),
    { host: "example.com" },
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.binding.registry, "rarext");
  assert.equal(parsed.binding.root, ROOT);
  assert.equal(parsed.binding.carrier, "well-known");
  assert.equal(parsed.binding.host, "example.com");
});

test("a DNS-carrying site's statement parses into the SAME shape — one binding, two carriers", () => {
  const fromFile = parseSiteBindingDocument(JSON.stringify({ registry: "rarext", root: ROOT }), { host: "example.com" });
  const fromRecord = parseSiteBindingTxt(`"registry=rarext; root=${ROOT}"`, { host: "example.com" });
  assert.equal(fromFile.ok, true);
  assert.equal(fromRecord.ok, true);
  if (!fromFile.ok || !fromRecord.ok) return;
  assert.equal(fromRecord.binding.root, fromFile.binding.root);
  assert.equal(fromRecord.binding.registry, fromFile.binding.registry);
  // The carrier is the only difference, and it is recorded rather than hidden.
  assert.equal(fromFile.binding.carrier, "well-known");
  assert.equal(fromRecord.binding.carrier, "dns-txt");
});

test("the two carriers must AGREE — a site serving two different statements is reported, not averaged", () => {
  const parsed = parseSiteBinding({
    json: JSON.stringify({ registry: "rarext", root: ROOT }),
    txt: `registry=rarext; root=${OTHER}`,
    host: "example.com",
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.reason, /file and its name record disagree/);
  // both statements are named, so an operator can tell which carrier to go fix
  assert.match(parsed.reason, /file says rarext@7ebdf81a/);
  assert.match(parsed.reason, /record says rarext@0123456789abcdef/);
});

test("agreeing carriers merge into one binding", () => {
  const parsed = parseSiteBinding({
    json: JSON.stringify({ registry: "rarext", root: ROOT, bundle: "https://example.com/b.json" }),
    txt: `registry=rarext; root=${ROOT}; cid=bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`,
    host: "example.com",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.binding.root, ROOT);
  assert.equal(parsed.binding.bundle, "https://example.com/b.json");
  assert.match(String(parsed.binding.cid), /^bafy/);
});

test("a site needs only ONE carrier, and a site with neither is reported by name", () => {
  const onlyRecord = parseSiteBinding({ txt: `registry=rarext; root=${ROOT}` });
  assert.equal(onlyRecord.ok, true);

  const neither = parseSiteBinding({ host: "example.com" });
  assert.equal(neither.ok, false);
  if (neither.ok) return;
  assert.match(neither.reason, new RegExp(RAREXT_SITE_BINDING_PATH.replace(/[/.]/g, "\\$&")));
  assert.match(neither.reason, /_rarext\.example\.com/);
});

test("two records on one name are refused: one host states one binding", () => {
  const parsed = parseSiteBinding({ txt: [`registry=rarext; root=${ROOT}`, `registry=rarext; root=${OTHER}`] });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.reason, /one host states one binding/);
});

test("malformed statements fail closed, in both carriers", () => {
  const noRegistry = parseSiteBindingDocument(JSON.stringify({ root: ROOT }));
  assert.equal(noRegistry.ok, false);

  const shortRoot = parseSiteBindingDocument(JSON.stringify({ registry: "rarext", root: "7ebdf81a" }));
  assert.equal(shortRoot.ok, false);
  if (!shortRoot.ok) assert.match(shortRoot.reason, /64-hex/);

  const unknownField = parseSiteBindingDocument(JSON.stringify({ registry: "rarext", root: ROOT, trust: "me" }));
  assert.equal(unknownField.ok, false);
  if (!unknownField.ok) assert.match(unknownField.reason, /unknown field/);

  const notJson = parseSiteBindingDocument("registry=rarext");
  assert.equal(notJson.ok, false);

  const fieldWithoutValue = parseSiteBindingTxt("registry=rarext; root");
  assert.equal(fieldWithoutValue.ok, false);

  const unknownTxt = parseSiteBindingTxt(`registry=rarext; root=${ROOT}; trust=me`);
  assert.equal(unknownTxt.ok, false);
  if (!unknownTxt.ok) assert.match(unknownTxt.reason, /unknown field/);

  const repeated = parseSiteBindingTxt(`registry=rarext; root=${ROOT}; root=${OTHER}`);
  assert.equal(repeated.ok, false);
  if (!repeated.ok) assert.match(repeated.reason, /repeats the field/);
});

test("a binding NEVER certifies itself: without the registry's pinned root there is no verdict", () => {
  const parsed = parseSiteBindingDocument(JSON.stringify({ registry: "rarext", root: ROOT }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const noPin = verifySiteBinding(parsed.binding, {});
  assert.equal(noPin.ok, false);
  if (noPin.ok) return;
  assert.match(noPin.reason, /cannot certify itself/);

  // and a pinned root that is itself malformed is not a pin
  const badPin = verifySiteBinding(parsed.binding, { pinnedRoot: "not-a-root" });
  assert.equal(badPin.ok, false);
});

test("the verdict distinguishes a stale copy from someone else's registry", () => {
  const parsed = parseSiteBindingDocument(JSON.stringify({ registry: "rarext", root: OTHER }), { host: "example.com" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const staleCopy = verifySiteBinding(parsed.binding, { pinnedRoot: ROOT });
  assert.equal(staleCopy.ok, false);
  if (!staleCopy.ok) {
    assert.match(staleCopy.reason, /root-mismatch/);
    assert.match(staleCopy.reason, /the site claims/);
  }

  const wrongRegistry = verifySiteBinding(parsed.binding, { pinnedRoot: OTHER, expectedRegistry: "someone-else" });
  assert.equal(wrongRegistry.ok, false);
  if (!wrongRegistry.ok) assert.match(wrongRegistry.reason, /registry-mismatch/);

  // The transition, stated exactly: the site declares the root its registry pins.
  const transitioned = verifySiteBinding(parsed.binding, { pinnedRoot: OTHER, expectedRegistry: "rarext" });
  assert.equal(transitioned.ok, true);
  if (!transitioned.ok) return;
  assert.equal(transitioned.root, OTHER);
  assert.equal(transitioned.host, "example.com");
});

test("a real site's live statement is checkable — the convention is in code, not in prose", () => {
  assert.equal(siteBindingUrl("https://example.com"), `https://example.com${RAREXT_SITE_BINDING_PATH}`);
  assert.equal(siteBindingUrl("https://example.com/some/page?x=1"), `https://example.com${RAREXT_SITE_BINDING_PATH}`);
  assert.equal(siteBindingTxtName("example.com"), "_rarext.example.com");
});
