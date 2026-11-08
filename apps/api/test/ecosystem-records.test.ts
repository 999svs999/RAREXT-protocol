// The builders must produce records that the REGISTERED verifiers actually accept.
// A record that cannot pass its own verifier is worthless, and it would only be
// discovered at ship time — against a real origin, with real pages — so the check
// belongs here, offline, with the network injected.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ECOSYSTEM_BRANDS,
  buildEcosystemRecords,
  siteRecordBody,
  nameRecordBody,
  pagesFrom,
  targetsFor,
  sha256Hex,
  pageDrift,
  isLiveDataPage,
} from "../../../scripts/ecosystem-records.mjs";
import { ecosystemSiteVerifiers, ECOSYSTEM_SITE_CONFIGS } from "../src/site-records.ts";
import { rarextNameVerifier } from "../src/rarext-name.ts";

const IDS = { apesdaily: "a".repeat(64), bapeclub: "b".repeat(64), rarext: "c".repeat(64), saikougoods: "d".repeat(64) };
const fakeFetch = async (url: string) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => Buffer.from(`body of ${url}`),
});

test("every brand yields a site record its own verifier accepts", async () => {
  const records = await buildEcosystemRecords({ identities: IDS, fetchImpl: fakeFetch as never });
  assert.equal(records.length, ECOSYSTEM_BRANDS.length);
  for (const r of records) {
    const v = ecosystemSiteVerifiers().find((x) => x.id === r.app);
    assert.ok(v, `${r.app} must have a registered verifier`);
    const att = await v!.verify(
      { app: r.app, kind: r.kind, version: 1, body: r.site } as never,
      { id: `${r.app}-published`, app: r.app } as never,
    );
    assert.equal(att.correct, true, `${r.brand} site record must attest`);
  }
});

test("every brand yields a name binding the name verifier accepts", async () => {
  const records = await buildEcosystemRecords({ identities: IDS, fetchImpl: fakeFetch as never });
  const v = rarextNameVerifier();
  for (const r of records) {
    const att = await v.verify(
      { app: "rarext-name", kind: "rarext.name.v1", version: 1, body: r.name } as never,
      { id: "rarext-name-published", app: "rarext-name" } as never,
    );
    assert.equal(att.correct, true, `${r.brand} name binding must attest`);
  }
});

test("a name binds to ITS brand's identity, not a shared one", async () => {
  const records = await buildEcosystemRecords({ identities: IDS, fetchImpl: fakeFetch as never });
  for (const r of records) {
    assert.equal(r.name.identityKey, IDS[r.brand as keyof typeof IDS]);
  }
  assert.equal(new Set(records.map((r) => r.name.identityKey)).size, records.length);
});

test("digests come from the bytes, so the same input reproduces the record", async () => {
  const a = await buildEcosystemRecords({ identities: IDS, fetchImpl: fakeFetch as never, publishedAt: "2026-11-05T00:00:00.000Z" });
  const b = await buildEcosystemRecords({ identities: IDS, fetchImpl: fakeFetch as never, publishedAt: "2026-11-05T00:00:00.000Z" });
  assert.deepEqual(a, b, "building twice from the same bytes must be identical");
  // the digest is of the bytes that origin actually served for "/"
  const home = a[0].site as { pages: { path: string; sha256: string }[] };
  assert.equal(home.pages[0].sha256, sha256Hex(Buffer.from("body of https://apesdaily.com/")));
});

test("the builders refuse input that would not verify", () => {
  assert.throws(() => siteRecordBody({ origin: "http://x/", title: "t", generator: "g", pages: [{ path: "/", sha256: "a".repeat(64), bytes: 1 }] }), /https/);
  assert.throws(() => siteRecordBody({ origin: "https://x/", title: "t", generator: "g", pages: [] }), /at least one page/);
  assert.throws(() => nameRecordBody({ name: "Bad Name", identityKey: "a".repeat(64), targets: [] }), /lowercase/);
  assert.throws(() => nameRecordBody({ name: "rr", identityKey: "nope", targets: [] }), /64 lowercase hex/);
  assert.throws(() => nameRecordBody({ name: "rr", identityKey: "a".repeat(64), targets: [] }), /at least one target/);
  assert.throws(() => nameRecordBody({ name: "rr", identityKey: "a".repeat(64), targets: [{ kind: "site", url: "https://x/" }], note: "x".repeat(281) }), /280/);
  // two-character names are legal on the protocol ("rr.xx" is a form FUTURISTIC uses)
  assert.ok(nameRecordBody({ name: "rr", identityKey: "a".repeat(64), targets: [{ kind: "site", url: "https://x/" }] }));
  assert.throws(() => pagesFrom([{ path: "/", sha256: "nothex", bytes: 1 }]), /sha256/);
});

test("every target kind is one the verifier allows", () => {
  const allowed = new Set(["site", "registry", "mirror", "gallery"]);
  for (const b of ECOSYSTEM_BRANDS) {
    for (const t of targetsFor(b)) {
      assert.ok(allowed.has(t.kind), `${b.handle}: ${t.kind} is not an allowed kind`);
      assert.ok(t.url.startsWith("https://"), `${b.handle}: ${t.kind} must be https`);
    }
  }
});

test("BAPECLUB's record claims the club, never the frozen storefront", () => {
  const bape = ECOSYSTEM_BRANDS.find((b) => b.handle === "bapeclub")!;
  assert.ok(!bape.origin.includes("bapeclub.co"), "the frozen Shopify store must not be claimed");
  assert.match(bape.note!, /not claimed|separate/i);
  const cfg = ECOSYSTEM_SITE_CONFIGS.find((c) => c.app === "bapeclub-site")!;
  assert.match(cfg.description, /NOT covered/);
});

// The jam failure mode: on 2026-11-04 22:45 one ledger record whose model was not
// anchorable threw inside the publish loop and blocked the ENTIRE ship — every
// record, the site record, the name binding. The fix was to skip structurally
// rejected records. The ecosystem block was written without that lesson and would
// have repeated it: one brand's site blip (a 5xx, a changed page) would have
// thrown and blocked FUTURISTIC's records too. These tests pin the classification
// so "one brand's blip" stays skippable and "the machinery is wrong" stays fatal.
import { isSkippableEcosystemError, buildBrandRecords } from "../../../scripts/ecosystem-records.mjs";

test("structural rejections are skippable — the exact message that jammed the 22:45 ship", () => {
  assert.equal(
    isSkippableEcosystemError(
      new Error("futuristic.video.v1 record failed structural checks: model must be an agnes-video-* model id"),
    ),
    true,
  );
});

test("a brand's unreadable live site is skippable", () => {
  assert.equal(isSkippableEcosystemError(new Error("apesdaily-site: live site unreadable (HTTP 404)")), true);
  assert.equal(isSkippableEcosystemError(new Error("https://apesdaily.com/ -> HTTP 503")), true);
  assert.equal(isSkippableEcosystemError(new Error("fetch failed")), true);
});

test("machinery failures are NOT skippable — they must abort the pass", () => {
  assert.equal(isSkippableEcosystemError(new Error("signature must be a base64 string")), false);
  assert.equal(isSkippableEcosystemError(new Error("apesdaily site record did not attest")), false);
  assert.equal(isSkippableEcosystemError(new Error("no identity for apesdaily")), false);
});

test("buildBrandRecords surfaces a dead origin as a skippable error, never a partial record", async () => {
  const brand = ECOSYSTEM_BRANDS.find((b) => b.handle === "apesdaily")!;
  const dead = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    buildBrandRecords(brand, IDS.apesdaily, { fetchImpl: dead as never }),
    (e: unknown) => isSkippableEcosystemError(e),
    "a 503 origin must classify as skippable",
  );
});

test("a live data page is anchored but never a drift signal", () => {
  const brand = ECOSYSTEM_BRANDS.find((b) => b.handle === "apesdaily")!;
  // It must stay IN the record: dropping it would silently stop covering the venue.
  assert.ok(brand.pages.includes("/launchpad"));
  assert.equal(isLiveDataPage(brand, "/launchpad"), true);
  const pinned = [{ path: "/launchpad", sha256: "0".repeat(64), bytes: 1 }];
  const live = { path: "/launchpad", body: Buffer.from("freshly rebuilt snapshot") };
  assert.equal(pageDrift(brand, pinned, live), null);
  // An unanchored live page is still a real failure — the record must claim it.
  assert.match(pageDrift(brand, [], live) ?? "", /not anchored/);
});

test("a stable page still reports drift when its bytes move", () => {
  const brand = ECOSYSTEM_BRANDS.find((b) => b.handle === "apesdaily")!;
  const live = { path: "/robots.txt", body: Buffer.from("Disallow: /secret\n") };
  const pinned = [{ path: "/robots.txt", sha256: sha256Hex(Buffer.from("Disallow:\n")), bytes: 11 }];
  assert.match(pageDrift(brand, pinned, live) ?? "", /bytes differ/);
  const same = [{ path: "/robots.txt", sha256: sha256Hex(live.body), bytes: live.body.length }];
  assert.equal(pageDrift(brand, same, live), null);
});
