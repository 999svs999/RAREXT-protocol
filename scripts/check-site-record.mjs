#!/usr/bin/env node
// check-site-record.mjs — verify an anchored site record against the LIVE origin.
//
// The registry's site verifier is deliberately structural: it checks the shape
// of the record (canonical origin, per-page digests, media) and never touches
// the network, because a verdict has to be recomputable from the artifact
// alone. That leaves one honest gap, named in the verifier's own description:
// "live-byte checking against the origin is an explicit external step".
//
// This script IS that step. Given a published/anchored site record (a JSON
// file, or a URL that serves one), it fetches every page the record names and
// recomputes its SHA-256 and byte count. The record holds only if every byte
// on the live origin is the byte that was signed.
//
//   node scripts/check-site-record.mjs .futuristic-proof/site-record.json
//   node scripts/check-site-record.mjs .futuristic-proof/bundle.json --app futuristic-site
//   node scripts/check-site-record.mjs https://example.com/site-record.json --json
//   node scripts/check-site-record.mjs record.json --no-media
//
// Exit codes: 0 every page/media byte matches, 1 any mismatch/HTTP/off-origin
// failure, 2 usage or unreadable record.
//
// Deliberately dependency-free and importable: the pure functions below are
// tested with a fake fetch in apps/api/test/site-record-live-check.test.mjs.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Compare bytes the way the verifier compares them: exact, SHA-256. */
export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The record may arrive as the bare body, as an artifact ({body}), as a
 * publication envelope ({artifact:{body}}), or as the registry bundle itself
 * ({publications:[...]}) — the shape the repo actually ships in
 * `.futuristic-proof/bundle.json`. In the bundle case there is one site record
 * per brand, so `app` selects it (and is required when more than one exists).
 */
export function parseRecord(input, app = null) {
  let value = input;
  if (typeof value === "string") value = JSON.parse(value);
  if (value && typeof value === "object" && Array.isArray(value.publications)) {
    const candidates = value.publications.filter(
      (p) => p && typeof p === "object" && typeof p.artifact?.app === "string" && p.artifact.app.endsWith("-site"),
    );
    const chosen = app ? candidates.filter((p) => p.artifact.app === app) : candidates;
    if (app && chosen.length !== 1) {
      throw new Error(`bundle has ${chosen.length} site records for app ${app}, expected exactly 1`);
    }
    if (chosen.length !== 1) {
      throw new Error(
        `bundle has ${candidates.length} site records; pass --app to choose one of: ${candidates
          .map((p) => p.artifact.app)
          .join(", ")}`,
      );
    }
    value = chosen[0].artifact.body;
  }
  if (value && typeof value === "object" && value.artifact && typeof value.artifact === "object") {
    value = value.artifact;
  }
  if (value && typeof value === "object" && value.body && typeof value.body === "object") {
    value = value.body;
  }
  if (!value || typeof value !== "object") {
    throw new Error("record must be a JSON object");
  }
  if (typeof value.site !== "string" || !/^https:\/\/[^\s/]+\/$/.test(value.site)) {
    throw new Error("record.site must be an https origin URL ending in /");
  }
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error("record.pages must be a non-empty array");
  }
  for (const [i, page] of value.pages.entries()) {
    if (!page || typeof page !== "object" || typeof page.path !== "string") {
      throw new Error(`record.pages[${i}] must have a path`);
    }
    if (!page.path.startsWith("/") || page.path.includes("..")) {
      throw new Error(`record.pages[${i}].path must be absolute and not traverse`);
    }
    if (typeof page.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(page.sha256)) {
      throw new Error(`record.pages[${i}].sha256 must be 64 lowercase hex chars`);
    }
  }
  return value;
}

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Resolve a record path against the canonical origin WITHOUT letting the path
 * escape it (`//other-host/x` is a network-path reference and would resolve to
 * another origin). Anything that is not same-origin is refused before a request.
 */
export function pageUrl(record, path) {
  const base = new URL(record.site);
  if (path.startsWith("//")) {
    throw new Error(`${path} is a network-path reference, not a page path`);
  }
  const url = new URL(path, base);
  if (originOf(url.href) !== originOf(base.href)) {
    throw new Error(`${path} resolves off the canonical origin`);
  }
  return url.href;
}

async function fetchBytes(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: { "cache-control": "no-cache" },
    });
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, finalUrl: res.url || url, bytes: null };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { ok: true, httpStatus: res.status, finalUrl: res.url || url, bytes };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      finalUrl: url,
      bytes: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and compare every page (and optional media) in a record. Pure aside
 * from the injected fetch, so the whole judgement is testable offline.
 */
export async function checkSiteRecord(record, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const includeMedia = options.includeMedia !== false;
  const results = [];

  const checkOne = async (kind, target, expected, url, sameOrigin) => {
    const got = await fetchBytes(fetchImpl, url, timeoutMs);
    const base = {
      kind,
      target,
      url,
      expected: { sha256: expected.sha256, bytes: expected.bytes },
      httpStatus: got.httpStatus,
      finalUrl: got.finalUrl,
    };
    if (!got.ok) {
      return {
        ...base,
        status: got.httpStatus === null ? "error" : "http",
        error: got.error ?? `HTTP ${got.httpStatus}`,
        actual: null,
      };
    }
    const actual = { sha256: sha256Bytes(got.bytes), bytes: got.bytes.length };
    // Pages are the canonical origin's own bytes, so a redirect that leaves
    // the origin is a failure even if the bytes happen to match. Media may be
    // served by a CDN: the record pins the URL, and the URL's bytes are what
    // get compared, so a redirect there is not a scope escape.
    const canonical = originOf(record.site);
    if (sameOrigin && originOf(got.finalUrl) !== canonical) {
      return {
        ...base,
        status: "off-origin",
        error: `redirected to ${got.finalUrl}, not ${canonical}`,
        actual,
      };
    }
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      return { ...base, status: "mismatch", actual };
    }
    return { ...base, status: "ok", actual };
  };

  for (const page of record.pages) {
    let url;
    try {
      url = pageUrl(record, page.path);
    } catch (err) {
      results.push({
        kind: "page",
        target: page.path,
        url: null,
        expected: { sha256: page.sha256, bytes: page.bytes },
        httpStatus: null,
        finalUrl: null,
        status: "off-origin",
        error: err instanceof Error ? err.message : String(err),
        actual: null,
      });
      continue;
    }
    results.push(await checkOne("page", page.path, page, url, true));
  }

  if (includeMedia && Array.isArray(record.media)) {
    for (const media of record.media) {
      if (!media || typeof media !== "object" || typeof media.url !== "string") continue;
      if (!/^https:\/\//.test(media.url)) {
        results.push({
          kind: "media",
          target: media.url,
          url: media.url,
          expected: { sha256: media.sha256, bytes: media.bytes },
          httpStatus: null,
          finalUrl: null,
          status: "error",
          error: "media URL is not https",
          actual: null,
        });
        continue;
      }
      results.push(await checkOne("media", media.url, media, media.url, false));
    }
  }

  return results;
}

export function recordExitCode(results) {
  return results.every((r) => r.status === "ok") ? 0 : 1;
}

export function formatReport(results) {
  const lines = [];
  for (const r of results) {
    const label = `${r.kind}:${r.target}`;
    if (r.status === "ok") {
      lines.push(`  OK        ${label}  ${r.actual.sha256.slice(0, 12)}…  ${r.actual.bytes}b`);
      continue;
    }
    const reason =
      r.status === "mismatch"
        ? `expected ${r.expected.sha256.slice(0, 12)}…/${r.expected.bytes}b, got ${r.actual.sha256.slice(0, 12)}…/${r.actual.bytes}b`
        : r.status === "off-origin"
          ? r.error
          : r.status === "http"
            ? r.error
            : r.error;
    lines.push(`  ${r.status.toUpperCase().padEnd(9)} ${label}  ${reason}`);
  }
  const passed = results.filter((r) => r.status === "ok").length;
  lines.push(
    passed === results.length
      ? `\n  ${passed}/${results.length} match the record — the live origin serves the signed bytes.`
      : `\n  ${passed}/${results.length} match — the live origin does NOT match the record.`,
  );
  return lines.join("\n");
}

async function loadRecord(source, fetchImpl, timeoutMs, app) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetchImpl(source, { cache: "no-store" });
    if (!res.ok) throw new Error(`${source} -> HTTP ${res.status}`);
    return parseRecord(await res.json(), app);
  }
  return parseRecord(await readFile(source, "utf8"), app);
}

function parseArgs(args) {
  let app = null;
  let source = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--app") {
      app = args[++i] ?? null;
    } else if (arg.startsWith("--app=")) {
      app = arg.slice("--app=".length);
    } else if (!arg.startsWith("--")) {
      source = arg;
    }
  }
  return { source, app };
}

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const includeMedia = !args.includes("--no-media");
  const { source, app } = parseArgs(args);
  if (!source) {
    console.error(
      "usage: node scripts/check-site-record.mjs <record.json|bundle.json|url> [--app <site-app>] [--json] [--no-media]",
    );
    return 2;
  }
  let record;
  try {
    record = await loadRecord(source, fetch, DEFAULT_TIMEOUT_MS, app);
  } catch (err) {
    console.error(`cannot read site record: ${err instanceof Error ? err.message : err}`);
    return 2;
  }

  const results = await checkSiteRecord(record, { includeMedia });
  if (json) {
    console.log(JSON.stringify({ site: record.site, results, ok: recordExitCode(results) === 0 }, null, 2));
  } else {
    console.log(`\nSITE RECORD — ${record.site}`);
    console.log(`Everything below is recomputed from the live origin, not taken from the record.\n`);
    console.log(formatReport(results));
  }
  return recordExitCode(results);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack : err);
      process.exit(2);
    },
  );
}
