// The live-byte step the structural verifier names but cannot do itself.
//
// These tests use a fake fetch, so the judgement is exercised offline and the
// checker can never quietly depend on a reachable origin to be testable.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  parseRecord,
  pageUrl,
  checkSiteRecord,
  recordExitCode,
  formatReport,
} from "../../../scripts/check-site-record.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

function record(over = {}) {
  return {
    site: "https://brand.example/",
    title: "a brand",
    published_at: "2026-11-05T10:00:00.000Z",
    generator: "test",
    pages: [
      { path: "/", sha256: sha("home bytes"), bytes: 10 },
      { path: "/styles.css", sha256: sha("css bytes"), bytes: 9 },
    ],
    ...over,
  };
}

function fakeFetch(map, { finalUrl } = {}) {
  return async (url) => {
    const entry = map[url];
    if (!entry) {
      return { ok: false, status: 404, url, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (entry.error) throw new Error(entry.error);
    const buf = new TextEncoder().encode(entry.body);
    return {
      ok: true,
      status: 200,
      url: finalUrl ? finalUrl(url) : url,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
}

const live = {
  "https://brand.example/": { body: "home bytes" },
  "https://brand.example/styles.css": { body: "css bytes" },
};

test("a record whose live bytes match passes every page", async () => {
  const results = await checkSiteRecord(record(), { fetchImpl: fakeFetch(live) });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === "ok"));
  assert.equal(recordExitCode(results), 0);
  assert.match(formatReport(results), /2\/2 match/);
});

test("one altered page is a mismatch, and the report names it", async () => {
  const changed = { ...live, "https://brand.example/": { body: "tampered!!!" } };
  const results = await checkSiteRecord(record(), { fetchImpl: fakeFetch(changed) });
  const bad = results.find((r) => r.target === "/");
  assert.equal(bad.status, "mismatch");
  assert.notEqual(bad.actual.sha256, bad.expected.sha256);
  assert.equal(recordExitCode(results), 1);
  assert.match(formatReport(results), /MISMATCH\s+page:\//);
});

test("a 404 is an http failure, not a mismatch", async () => {
  const missing = { "https://brand.example/": live["https://brand.example/"] };
  const results = await checkSiteRecord(record(), { fetchImpl: fakeFetch(missing) });
  const bad = results.find((r) => r.target === "/styles.css");
  assert.equal(bad.status, "http");
  assert.match(bad.error, /HTTP 404/);
  assert.equal(recordExitCode(results), 1);
});

test("a redirect off the canonical origin is refused even when the bytes match", async () => {
  const fetchImpl = fakeFetch(live, {
    finalUrl: (url) => url.replace("https://brand.example/", "https://cdn.other.example/"),
  });
  const results = await checkSiteRecord(record(), { fetchImpl });
  assert.ok(results.every((r) => r.status === "off-origin"));
  assert.equal(recordExitCode(results), 1);
});

test("a network error is reported, not thrown", async () => {
  const fetchImpl = fakeFetch({ "https://brand.example/": { error: "ECONNRESET" } });
  const results = await checkSiteRecord(record(), { fetchImpl });
  const bad = results.find((r) => r.target === "/");
  assert.equal(bad.status, "error");
  assert.match(bad.error, /ECONNRESET/);
});

test("a network-path reference cannot escape the canonical origin", () => {
  assert.throws(() => pageUrl(record(), "//evil.example/x"), /network-path/);
  for (const path of ["/", "/styles.css", "/a/b?c=1"]) {
    assert.equal(new URL(pageUrl(record(), path)).origin, "https://brand.example");
  }
});

test("media is checked when present and skippable with --no-media", async () => {
  const withMedia = record({
    media: [{ url: "https://media.example/hero.mp4", sha256: sha("film"), bytes: 4 }],
  });
  const map = { ...live, "https://media.example/hero.mp4": { body: "film" } };
  const all = await checkSiteRecord(withMedia, { fetchImpl: fakeFetch(map) });
  assert.equal(all.length, 3);
  assert.equal(recordExitCode(all), 0);

  const noMedia = await checkSiteRecord(withMedia, { fetchImpl: fakeFetch(map), includeMedia: false });
  assert.equal(noMedia.length, 2);
});

test("the record may be wrapped in an artifact or a publication envelope", () => {
  const bare = record();
  assert.deepEqual(parseRecord(JSON.stringify(bare)).pages, bare.pages);
  assert.deepEqual(parseRecord({ body: bare }).pages, bare.pages);
  assert.deepEqual(parseRecord({ artifact: { body: bare } }).pages, bare.pages);
});

test("a registry bundle picks its brand's site record, and refuses ambiguity", () => {
  const other = record({ site: "https://apes.example/" });
  const bundle = {
    publications: [
      { artifact: { app: "futuristic-site", body: record() } },
      { artifact: { app: "apesdaily-site", body: other } },
      { artifact: { app: "futuristic-video", body: { run_id: "not-a-site" } } },
    ],
  };
  assert.equal(parseRecord(bundle, "futuristic-site").site, "https://brand.example/");
  assert.equal(parseRecord(bundle, "apesdaily-site").site, "https://apes.example/");
  assert.throws(() => parseRecord(bundle), /pass --app/);
  assert.throws(() => parseRecord(bundle, "bapeclub-site"), /0 site records/);
});

test("a record that is not an https origin is refused before any fetch", () => {
  assert.throws(() => parseRecord({ ...record(), site: "http://brand.example/" }), /https origin/);
  assert.throws(() => parseRecord({ ...record(), pages: [] }), /non-empty/);
  assert.throws(
    () => parseRecord({ ...record(), pages: [{ path: "/", sha256: "nope", bytes: 1 }] }),
    /64 lowercase hex/,
  );
});
