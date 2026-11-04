#!/usr/bin/env node
// Ship the registry: anchor, test, commit, push, deploy, federate — but ONLY
// when reality has drifted from what is already anchored.
//
//   node scripts/ship-registry.mjs            # ship if drifted, else SILENT
//   node scripts/ship-registry.mjs --force    # skip drift detection
//   node scripts/ship-registry.mjs --json     # always print the outcome
//
// Drift is measured against the LIVE deployed bundle (the bytes the public
// actually resolves), in two dimensions:
//   1. ledger drift — published runs in the producer's ledger that the anchored
//      bundle does not carry yet
//   2. site drift   — the brand site's live page bytes no longer match the
//      digests pinned in the anchored site record
//
// Silence is the healthy state: the cron that runs this is a watchdog, and an
// empty stdout delivers nothing. Only a real ship (or a failure) prints.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEDGER = "/Users/r/FUTURISTIC/state/ledger.jsonl";
const MEDIA_ROOT = "/Users/r/FUTURISTIC/state/media";
const SITE_ORIGIN = "https://futuristiclive.pages.dev/";
const ORIGIN_BUNDLE = "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json";
const NAME_TARGET_SITE = "https://futuristiclive.pages.dev/";

const FORCE = process.argv.includes("--force");
const AS_JSON = process.argv.includes("--json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (args, opts = {}) =>
  execFileSync("git", args, { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });

function fail(error, extra = {}) {
  const outcome = { shipped: false, error, ...extra };
  if (AS_JSON) console.log(JSON.stringify(outcome, null, 2));
  else console.error(`✗ registry ship failed: ${error}`);
  process.exit(1);
}

// ---- reality 1: the producer's ledger (same filter as the publisher) --------
function ledgerRunIds() {
  const ids = [];
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const pub = d.publish;
    if (!pub || typeof pub !== "object") continue;
    const has = (v, k) => v && typeof v === "object" && v[k];
    const any = has(pub.youtube, "video_id") || has(pub.instagram, "instagram")
      || has(pub.facebook, "facebook") || has(pub.threads, "threads");
    if (!any || !d.run_id) continue;
    // Mirror the registry verifier's model rule (the LTX watch item): a run from
    // a non-agnes fallback model is structurally unanchorable — the publisher
    // skips it, so it must NOT count as ledger drift, or the watchdog churns
    // forever on a record it can never anchor. (Absent model = publisher's
    // agnes-video-v2.0 default = anchorable.)
    const model = d.media?.model;
    if (typeof model === "string" && !model.startsWith("agnes-video-")) continue;
    ids.push(d.run_id);
  }
  return ids;
}

// ---- reality 2: the live brand site ----------------------------------------
async function liveSiteDigests() {
  const res = await fetch(SITE_ORIGIN, { redirect: "follow" });
  if (!res.ok) throw new Error(`site origin HTTP ${res.status}`);
  const html = await res.text();
  const paths = ["/", "/styles.css", "/app.js", "/favicon.svg", "/og.svg"];
  const out = {};
  for (const path of paths) {
    const r = await fetch(SITE_ORIGIN.replace(/\/$/, "") + path, { redirect: "follow" });
    if (!r.ok) throw new Error(`site ${path} HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    out[path] = { sha256: sha256(buf), bytes: buf.length };
  }
  return { html, pages: out };
}

// ---- anchored state ---------------------------------------------------------
async function anchored() {
  const res = await fetch(ORIGIN_BUNDLE, { cache: "no-store" });
  if (!res.ok) throw new Error(`deployed bundle HTTP ${res.status}`);
  return await res.json();
}

let outcome = { shipped: false, drifted: {}, root: null };

try {
  const [bundle, live, ledgerIds] = await Promise.all([
    anchored(),
    liveSiteDigests().catch((e) => ({ error: String(e?.message ?? e) })),
    Promise.resolve(ledgerRunIds()),
  ]);
  const root = bundle?.manifest?.root ?? null;
  outcome.root = root;

  const pubs = bundle?.publications ?? [];
  const anchoredVideo = new Set(
    pubs.filter((p) => p.artifact?.app === "futuristic-video").map((p) => p.artifact?.body?.run_id),
  );
  const siteRecord = pubs.find((p) => p.artifact?.app === "futuristic-site");
  const anchoredPages = siteRecord?.artifact?.body?.pages ?? [];

  const missing = ledgerIds.filter((id) => !anchoredVideo.has(id));
  const siteDrift = [];
  if (!siteRecord) siteDrift.push("no site record anchored");
  else if (live.error) siteDrift.push(`live site unreadable: ${live.error}`);
  else {
    for (const [path, actual] of Object.entries(live.pages)) {
      const pinned = anchoredPages.find((p) => p.path === path);
      if (!pinned) siteDrift.push(`${path} not anchored`);
      else if (pinned.sha256 !== actual.sha256 || pinned.bytes !== actual.bytes) {
        siteDrift.push(`${path} bytes differ`);
      }
    }
  }

  outcome.drifted = { missing_ledger_runs: missing, site: siteDrift };
  const drifted = missing.length > 0 || siteDrift.length > 0;
  if (!drifted && !FORCE) {
    if (AS_JSON) console.log(JSON.stringify({ ...outcome, note: "in sync" }, null, 2));
    process.exit(0); // healthy: print NOTHING, the watchdog stays silent
  }
  outcome.reason = FORCE
    ? "forced"
    : `${missing.length} new run(s), ${siteDrift.length} site drift item(s)`;
} catch (error) {
  fail(`drift check failed: ${error?.message ?? error}`);
}

// ---- ship -------------------------------------------------------------------
const steps = [];
function step(name, cmd, args, opts = {}) {
  const out = run(cmd, args, opts);
  steps.push({ name, ok: true });
  return out;
}

try {
  const pub = step("publish", "node", ["scripts/publish-futuristic.mjs", "--json"]);
  const summaryStart = pub.indexOf("{");
  outcome.publisher = JSON.parse(pub.slice(summaryStart, pub.lastIndexOf("}") + 1));

  const proof = step("proof", "node", ["scripts/publish-futuristic-proof.mjs"]);
  for (const line of proof.split("\n")) {
    if (line.startsWith("published FUTURISTIC proof ")) outcome.root = line.split(" ").pop().trim();
  }

  step("test", "npm", ["test"]);
  outcome.tests = "green";

  const status = git(["status", "--porcelain"]);
  if (status.trim() !== "") {
    git(["add", "-A"]);
    git(["commit", "-m", `ship: registry artifacts — ${outcome.reason}`]);
    git(["push", "origin", "HEAD:main"]);
    steps.push({ name: "push", ok: true });
  } else {
    steps.push({ name: "push", ok: true, note: "nothing to commit" });
  }

  step("deploy:site", "npm", ["run", "deploy:site"]);
  const peer = step("peer", "node", ["scripts/deploy-mirror-repo.mjs"]);
  outcome.peer = /peer bundle verified/.test(peer) ? "verified" : "unknown";
  outcome.steps = steps.map((s) => s.name);
  outcome.shipped = true;

  if (AS_JSON) console.log(JSON.stringify(outcome, null, 2));
  else {
    console.log(`✓ registry shipped — root ${String(outcome.root).slice(0, 16)}…`);
    console.log(`  reason: ${outcome.reason}`);
    console.log(`  steps : ${outcome.steps.join(" → ")}`);
    console.log(`  peer  : ${outcome.peer}`);
  }
} catch (error) {
  const tail = String(error?.stderr ?? error?.message ?? error).slice(-400);
  fail(`ship failed after [${steps.map((s) => s.name).join(" → ")}]: ${tail}`, { root: outcome.root });
}
