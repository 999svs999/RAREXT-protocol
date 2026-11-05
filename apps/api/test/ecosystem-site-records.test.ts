// Every project lives on RAREXT so the ecosystem evolves together — each brand's
// public presence is anchored, verifiable, and separately identified. These tests
// pin that they share one check without sharing an identity, and that adding them
// could not have disturbed FUTURISTIC's already-anchored records.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { ECOSYSTEM_SITE_CONFIGS, ecosystemSiteVerifiers } from "../src/site-records.ts";
import { futuristicSiteVerifier, FUTURISTIC_SITE_CONFIG } from "../src/futuristic-site.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function body(site: string) {
  return {
    site,
    title: "a brand",
    published_at: "2026-11-05T10:00:00.000Z",
    generator: "brand-site-record",
    pages: [{ path: "/", sha256: sha("home"), bytes: 100 }],
  };
}

test("every ecosystem brand has a site verifier", () => {
  const apps = ecosystemSiteVerifiers().map((v) => v.id).sort();
  assert.deepEqual(apps, ["apesdaily-site", "bapeclub-site", "rarext-site", "saikougoods-site"]);
});

test("each brand's verifier supports its own app and kind only", () => {
  for (const v of ecosystemSiteVerifiers()) {
    const cfg = ECOSYSTEM_SITE_CONFIGS.find((c) => c.app === v.id)!;
    with_(v.supports({ app: cfg.app, kind: cfg.kind } as never, {} as never), true);
    with_(v.supports({ app: cfg.app, kind: "futuristic.site.v1" } as never, {} as never), false);
    with_(v.supports({ app: "futuristic-site", kind: cfg.kind } as never, {} as never), false);
  }
  function with_(actual: unknown, expected: boolean) {
    assert.equal(actual, expected);
  }
});

test("each brand attests a well-formed record, labelled as itself", async () => {
  for (const v of ecosystemSiteVerifiers()) {
    const cfg = ECOSYSTEM_SITE_CONFIGS.find((c) => c.app === v.id)!;
    const att = await v.verify(
      { app: cfg.app, kind: cfg.kind, version: 1, body: body("https://example.com/") } as never,
      { id: `${cfg.app}-published`, app: cfg.app } as never,
    );
    assert.equal(att.correct, true, `${cfg.app} should attest`);
    assert.equal(att.app, cfg.app);
    assert.equal(att.verifier, "structural-site-record-check");
    assert.equal(att.semanticsId, `${cfg.app}/${cfg.app}-published`);
  }
});

test("brands share the check but NOT a verifier identity", () => {
  const hashes = new Set<string>();
  for (const cfg of ECOSYSTEM_SITE_CONFIGS) {
    hashes.add(sha(JSON.stringify(cfg.manifest)));
  }
  assert.equal(hashes.size, ECOSYSTEM_SITE_CONFIGS.length, "each brand's manifest must be its own");
});

test("FUTURISTIC's verifier is untouched and still separate", () => {
  const fut = futuristicSiteVerifier();
  assert.equal(fut.id, "futuristic-site");
  assert.equal(fut.artifactKinds[0], "futuristic.site.v1");
  assert.equal(FUTURISTIC_SITE_CONFIG.app, "futuristic-site");
  assert.ok(
    !ECOSYSTEM_SITE_CONFIGS.some((c) => c.app === "futuristic-site"),
    "FUTURISTIC keeps its original config so its anchored records are unaffected",
  );
});

test("a non-https origin is refused for every brand", async () => {
  for (const v of ecosystemSiteVerifiers()) {
    const cfg = ECOSYSTEM_SITE_CONFIGS.find((c) => c.app === v.id)!;
    await assert.rejects(
      v.verify(
        { app: cfg.app, kind: cfg.kind, version: 1, body: body("http://insecure.example/") } as never,
        { id: "x", app: cfg.app } as never,
      ),
      /failed structural checks/,
    );
  }
});
