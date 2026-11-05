// Characterization tests for the brand-site record verifier.
//
// These pin the behaviour BEFORE it is generalised so another brand's site can be
// anchored too (the whole ecosystem is meant to live on RAREXT, not just
// FUTURISTIC). Anchored records are permanent and signed, so the FUTURISTIC
// attestation — algorithm string, semanticsId, trace — must not shift by even a
// byte when the verifier is refactored into a factory. Without these tests that
// refactor would be unguarded: nothing in the suite touched this file.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  verifyFuturisticSiteRecord,
  futuristicSiteVerifier,
  FUTURISTIC_SITE_APP_EXPORT,
  FUTURISTIC_SITE_KIND_EXPORT,
} from "../src/futuristic-site.ts";
import { canonicalize } from "../../../packages/core/src/index.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function goodBody(over: Record<string, unknown> = {}) {
  return {
    site: "https://futuristiclive.pages.dev/",
    title: "FUTURISTIC — we film the tomorrows we want to live in",
    published_at: "2026-11-05T10:48:00.000Z",
    generator: "build_site.py",
    pages: [
      { path: "/", sha256: sha("home"), bytes: 14759 },
      { path: "/styles.css", sha256: sha("css"), bytes: 16342 },
    ],
    media: [{ url: "https://pub-92ddc04234bf4deeaca0423ff9e69bed.r2.dev/site/hero.mp4", sha256: sha("hero"), bytes: 3812775 }],
    ...over,
  };
}

test("a well-formed site record holds", () => {
  const v = verifyFuturisticSiteRecord(goodBody());
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.ok(v.checks.includes("site-origin"));
    assert.ok(v.checks.includes("pages:2"));
    assert.ok(v.checks.includes("media:1"));
  }
});

test("a record with no pages is refused", () => {
  const v = verifyFuturisticSiteRecord(goodBody({ pages: [] }));
  assert.equal(v.ok, false);
});

test("a non-https origin is refused", () => {
  const v = verifyFuturisticSiteRecord(goodBody({ site: "http://futuristiclive.pages.dev/" }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.some((e) => /https/.test(e)));
});

test("a non-digest page hash is refused", () => {
  const v = verifyFuturisticSiteRecord(goodBody({ pages: [{ path: "/", sha256: "not-a-digest", bytes: 1 }] }));
  assert.equal(v.ok, false);
});

test("page path traversal is refused", () => {
  const v = verifyFuturisticSiteRecord(goodBody({ pages: [{ path: "/../etc/passwd", sha256: sha("x"), bytes: 1 }] }));
  assert.equal(v.ok, false);
});

test("a non-object body is refused rather than thrown on", () => {
  assert.equal(verifyFuturisticSiteRecord(null).ok, false);
  assert.equal(verifyFuturisticSiteRecord("nope").ok, false);
});

test("the verifier declares the FUTURISTIC app and kind", () => {
  const v = futuristicSiteVerifier();
  assert.equal(v.id, "futuristic-site");
  assert.deepEqual(v.artifactKinds, ["futuristic.site.v1"]);
  assert.equal(v.verifier, "builtin");
  assert.equal(FUTURISTIC_SITE_APP_EXPORT, "futuristic-site");
  assert.equal(FUTURISTIC_SITE_KIND_EXPORT, "futuristic.site.v1");
});

test("supports() matches only this app AND kind", () => {
  const v = futuristicSiteVerifier();
  assert.equal(v.supports({ app: "futuristic-site", kind: "futuristic.site.v1" } as never, {} as never), true);
  assert.equal(v.supports({ app: "apesdaily-site", kind: "futuristic.site.v1" } as never, {} as never), false);
  assert.equal(v.supports({ app: "futuristic-site", kind: "something.else" } as never, {} as never), false);
});

test("the attestation keeps the algorithm, semanticsId and trace shape stable", async () => {
  // Anchored records reference these; changing them would invalidate history.
  const v = futuristicSiteVerifier();
  const artifact = {
    app: "futuristic-site",
    kind: "futuristic.site.v1",
    version: 1,
    mediaType: "application/json",
    body: goodBody(),
  };
  const challenge = { id: "futuristic-site-published", app: "futuristic-site" };
  const att = await v.verify(artifact as never, challenge as never);
  assert.equal(att.verifier, "structural-site-record-check");
  assert.equal(att.app, "futuristic-site");
  assert.equal(att.semanticsId, "futuristic-site/futuristic-site-published");
  assert.equal(att.gateCount, 2);
  assert.equal(att.correct, true);
  assert.equal(att.representation, "exact");
  // The verifier hash commits to its manifest — {app, version, algorithm,
  // representation} — so it is reproducible from those four fields alone.
  const expected = sha(canonicalize({
    app: "futuristic-site", version: 1,
    algorithm: "structural-site-record-check", representation: "exact",
  }));
  assert.equal(att.verifierHash, expected);
});

test("a malformed record throws rather than attesting a false pass", async () => {
  const v = futuristicSiteVerifier();
  await assert.rejects(
    v.verify(
      { app: "futuristic-site", kind: "futuristic.site.v1", version: 1, body: { site: "nope" } } as never,
      { id: "x", app: "futuristic-site" } as never,
    ),
    /failed structural checks/,
  );
});
