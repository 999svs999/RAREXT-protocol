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
import { fetchWithRetry } from "./lib/fetch-retry.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The registry's vetted-generator rule, read from the SAME file the verifier
// reads (apps/api/src/futuristic.ts) so drift detection can never disagree with
// what the registry will actually accept.
const VETTED_MODEL_RES = JSON.parse(
  readFileSync(join(ROOT, "apps/api/src/vetted-models.json"), "utf8"),
).providers.map((p) => new RegExp(p.pattern));
const LEDGER = "/Users/r/FUTURISTIC/state/ledger.jsonl";
const MEDIA_ROOT = "/Users/r/FUTURISTIC/state/media";
const SITE_ORIGIN = "https://futuristiclive.pages.dev/";
const ORIGIN_BUNDLE = "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json";
const NAME_TARGET_SITE = "https://futuristiclive.pages.dev/";

const FORCE = process.argv.includes("--force");
// --check-only answers "has reality drifted?" without the ability to act on the
// answer. Testing drift detection by provoking the real ship mixes "did it
// notice?" with "what did it then do?" — and the second question has consequences
// in a public registry.
const CHECK_ONLY = process.argv.includes("--check-only");
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
  // Retracted runs (takedowns) are never drift, for the same reason the
  // publisher never anchors them — see scripts/publish-futuristic.mjs.
  const retracted = new Set();
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.stage === "retracted" && d.run_id) retracted.add(d.run_id);
    } catch { /* malformed line */ }
  }
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
    if (retracted.has(d.run_id)) continue;
    // Mirror the registry verifier's model rule: a run whose model is not on the
    // vetted list is structurally unanchorable — the publisher skips it, so it
    // must NOT count as ledger drift, or the watchdog churns forever on a record
    // it can never anchor. (Absent model = publisher's agnes-video-v2.0 default
    // = anchorable.) Keep this identical to apps/api/src/futuristic.ts.
    const model = d.media?.model;
    if (typeof model === "string" && !VETTED_MODEL_RES.some((re) => re.test(model))) continue;
    ids.push(d.run_id);
  }
  return ids;
}

// ---- reality 2: the live brand site ----------------------------------------
async function liveSiteDigests() {
  const res = await fetchWithRetry(SITE_ORIGIN, { redirect: "follow" });
  if (!res.ok) throw new Error(`site origin HTTP ${res.status}`);
  const html = await res.text();
  const paths = ["/", "/styles.css", "/app.js", "/favicon.svg", "/og.svg"];
  const out = {};
  for (const path of paths) {
    const r = await fetchWithRetry(SITE_ORIGIN.replace(/\/$/, "") + path, { redirect: "follow" });
    if (!r.ok) throw new Error(`site ${path} HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    out[path] = { sha256: sha256(buf), bytes: buf.length };
  }
  return { html, pages: out };
}

// ---- ecosystem drift --------------------------------------------------------
// The registry carries the whole ecosystem, so drift must be measured across it.
// Without this the check could only ever see FUTURISTIC: the ecosystem's records
// were absent from the anchored bundle and the ship reported "in sync", because
// an unanchored brand simply was not something it looked for.
const { ECOSYSTEM_BRANDS, fetchBrandPages, sha256Hex, targetsFor } = await import(
  new URL("./ecosystem-records.mjs", import.meta.url).href
);

async function ecosystemDrift(pubs) {
  const out = [];
  for (const brand of ECOSYSTEM_BRANDS) {
    const rec = pubs.find((p) => p.artifact?.app === brand.app);
    if (!rec) {
      out.push(`${brand.app}: not anchored`);
    } else {
      const pinned = rec.artifact?.body?.pages ?? [];
      try {
        for (const live of await fetchBrandPages(brand)) {
          const digest = sha256Hex(live.body);
          const was = pinned.find((x) => x.path === live.path);
          if (!was) out.push(`${brand.app}${live.path}: not anchored`);
          else if (was.sha256 !== digest || was.bytes !== live.body.length) {
            out.push(`${brand.app}${live.path}: bytes differ from the pinned record`);
          }
        }
      } catch (err) {
        out.push(`${brand.app}: live site unreadable (${err?.message ?? err})`);
      }
    }
    // A brand's name binding is part of it being ON the protocol, not a detail —
    // and so are its TARGETS. Existence alone is not enough: a binding that still
    // resolves to a page which no longer exists passes an existence check while
    // asserting something false. That shipped once (SaiKou_Goods inherited
    // APESDAILY's /launchpad and anchored a 404); this is what would have caught
    // it. Compared as a set, so ordering is not meaning.
    const nameRec = pubs.find(
      (p) => p.artifact?.app === "rarext-name" && p.artifact?.body?.name === brand.name,
    );
    if (!nameRec) {
      out.push(`name ${brand.name}: not anchored`);
    } else {
      const key = (t) => `${t.kind} ${t.url}`;
      const have = new Set((nameRec.artifact?.body?.targets ?? []).map(key));
      const want = new Set(targetsFor(brand).map(key));
      for (const w of want) if (!have.has(w)) out.push(`name ${brand.name}: missing target ${w}`);
      for (const h of have) if (!want.has(h)) out.push(`name ${brand.name}: stale target ${h}`);
    }
  }
  return out;
}

// ---- anchored state ---------------------------------------------------------
async function anchored() {
  const res = await fetchWithRetry(ORIGIN_BUNDLE, { cache: "no-store" });
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

  const ecosystem = await ecosystemDrift(pubs).catch((e) => [`ecosystem check failed: ${e?.message ?? e}`]);

  outcome.drifted = { missing_ledger_runs: missing, site: siteDrift, ecosystem };
  // Reported even when in sync: "in sync" must be a measured claim, and a check
  // that never says what it examined cannot be distinguished from one that ran on
  // nothing.
  outcome.ecosystem_checked = ECOSYSTEM_BRANDS.map((b) => b.app);
  const drifted = missing.length > 0 || siteDrift.length > 0 || ecosystem.length > 0;
  if (CHECK_ONLY) {
    // Measure only. Exit 1 on drift so a monitor can tell, and never ship.
    console.log(JSON.stringify({ ...outcome, check_only: true }, null, 2));
    process.exit(drifted ? 1 : 0);
  }
  if (!drifted && !FORCE) {
    if (AS_JSON) console.log(JSON.stringify({ ...outcome, note: "in sync" }, null, 2));
    process.exit(0); // healthy: print NOTHING, the watchdog stays silent
  }
  outcome.reason = FORCE
    ? "forced"
    : `${missing.length} new run(s), ${siteDrift.length} futuristic site item(s), ${ecosystem.length} ecosystem item(s)`;
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
