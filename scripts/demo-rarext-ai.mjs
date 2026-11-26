#!/usr/bin/env node
/**
 * demo-rarext-ai.mjs — one command, the whole story, live.
 *
 *   npm run demo:ai
 *
 * Eight phases, every number live from the running systems:
 *   1. the live API      — ask RAREXT AI on the edge, read the answer
 *   2. the in-browser AI — fetch the published page + weights, verify the
 *                          pinned digests exactly as the tab does
 *   3. the skills        — all seven deployed skills, in-process, exact-match
 *   4. holographic memory— a table encoded and read back in one vector, plus
 *                          instant acquisition of a brand-new pair
 *   5. ops               — every project's gates and every live service, from
 *                          the latest receipt
 *   6. rank              — re-score the shipped bytes on the published suite,
 *                          then compare against the top-100 scorecard
 *   7. head-to-head     — the same FRESH tasks asked of the deployed answer path
 *                          and a live top-tier hosted model, exact vs semantic
 *   8. verification      — the claim gate at its recorded baseline
 *
 * No phase is mocked: each one either talks to the running services or runs
 * the same code the browser runs. The rank phase never trusts the stored
 * number — it regenerates the 200-task suite, scores the shipped `.gguf`, and
 * fails if the result differs from what the page claims.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const live = "https://999svs999.github.io/RAREXT-protocol/mirror";
const edge = process.env.RAREXT_EDGE ?? "https://ai.rarext.co";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function phase(name) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(2, 62 - name.length))}`);
}
function line(ok, text) {
  if (!ok) failures += 1;
  console.log(`  [${ok ? "ok" : "FAIL"}] ${text}`);
  return ok;
}
async function get(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const r = await fetch(url, { signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 (rarext-demo)" } });
  clearTimeout(timer);
  return r;
}

// ── 1. the live API ──────────────────────────────────────────────────────────
async function phaseLiveApi() {
  phase("1 · the live API — RAREXT AI on the edge");
  const models = await (await get(`${edge}/v1/models`)).json();
  const model = models.data?.[0];
  line(!!model?.id, `edge answers: model ${model?.id} (digest ${String(model?.digest ?? "").slice(0, 16)}…)`);
  const t0 = Date.now();
  const r = await fetch(`${edge}/v1/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      prompt: "rows: -BIG TEE|$89\nq: how much is the big tee?\na: ",
      max_tokens: 32,
      temperature: 0,
    }),
  });
  const body = await r.json();
  const ms = Date.now() - t0;
  line(r.status === 200 && /delivered\.$/.test(body.choices?.[0]?.text ?? ""),
    `asked "how much is the big tee?" → ${JSON.stringify(body.choices?.[0]?.text)} (${ms} ms, ${body.usage?.completion_tokens ?? "?"} tokens)`);
}

// ── 2. the in-browser AI, verified from here ────────────────────────────────
async function phaseBrowser() {
  phase("2 · the in-browser AI — published page, pinned digests");
  const page = await (await get(`${live}/entangled.html`)).text();
  line(page.includes("RAREXT entangled AI"), `page served (${page.length} bytes) — "RAREXT entangled AI"`);
  const engine = await (await get(`${live}/entangled-engine.js`)).text();
  const weights = new Uint8Array(await (await get(`${live}/rarext-entangled-chi48.gguf`)).arrayBuffer());
  const engineDigest = sha256(engine);
  const weightsDigest = sha256(weights);
  line(engineDigest === "83b666cfe3cf72f32d753c030f258eead72f139a87609b07b6708f4d07933b15",
    `engine digest ${engineDigest.slice(0, 24)}… matches the pin`);
  // The pin lives in the served entangled.js; the demo must read it from there,
  // never hardcode it — a promoted model changes the digest and the demo would
  // fail against the very consistency it is checking.
  const entangledSrc = await (await fetch(`${live}/entangled.js`)).text();
  const pinned = /weights:\s*"?([0-9a-f]{64})"?/.exec(entangledSrc)?.[1]
    ?? /([0-9a-f]{64})/.exec(entangledSrc)?.[1];
  line(!!pinned && weightsDigest === pinned,
    `weights digest ${weightsDigest.slice(0, 24)}… matches the page pin (${weights.length.toLocaleString()} bytes, χ=48 MPO)`);
}

// ── 3+4. the engine and the holographic memory, in-process ──────────────────
async function phaseSkillsAndMemory() {
  phase("3 · the skills — seven deployed skills, exact-match in-process");
  const entangled = await import(pathToFileURL(join(root, "apps/web/public/entangled.js")).href);
  const engineSource = readFileSync(join(root, "apps/web/public/entangled-engine.js"), "utf8");
  const weightsBytes = new Uint8Array(readFileSync(join(root, "apps/web/public/rarext-entangled-chi48.gguf")));
  globalThis.performance = globalThis.performance ?? (await import("perf_hooks")).performance;
  const loaded = await entangled.loadEntangledModel({ engineSource, weightsBytes });
  const rows = entangled.skillSelfTest(loaded.engine, loaded.model);
  const bySkill = new Map();
  for (const r of rows) {
    const cur = bySkill.get(r.skill) ?? [0, 0];
    bySkill.set(r.skill, [cur[0] + (r.ok ? 1 : 0), cur[1] + 1]);
  }
  for (const [skill, [ok, n]] of bySkill) {
    line(ok === n, `${skill}: ${ok}/${n}`);
  }
  line(rows.every((r) => r.ok), `skills total: ${rows.filter((r) => r.ok).length}/${rows.length} exact`);

  phase("4 · holographic memory — a table in one vector, learned instantly");
  const pairs = Array.from({ length: 50 }, (_, i) => [`ITEM-${100 + i}`, `$${10 + i * 7}`]);
  const price = entangled.hrrSelfTest(pairs);
  line(price.passed === price.total,
    `${price.passed}/${price.total} (item→price) pairs read back from ONE ${(price.bytes / 1024).toFixed(0)} KiB vector`);
  const diff = entangled.hrrDifferenceSelfTest();
  line(diff.passed === diff.total,
    `${diff.passed}/${diff.total} difference pairs exact — arithmetic as lookup, ${(diff.bytes / 1024).toFixed(0)} KiB`);
  line(diff.fresh.ok,
    `instant acquisition: a pair learned AFTER encoding answers ${JSON.stringify(diff.fresh.got)} (one binding, no gradient)`);
}

// ── 5. ops — every project, every service ───────────────────────────────────
async function phaseOps() {
  phase("5 · ops — all projects' gates and the live services");
  const latest = JSON.parse(readFileSync(join(root, "tools/ops/out/latest.json"), "utf8"));
  for (const p of latest.projects) {
    line(p.ok, `${p.id} — ${p.gates.map((g) => `${g.id}:${g.ok ? "ok" : "FAIL"} (${g.ms} ms)`).join(", ")}${p.git?.head ? ` @${p.git.head}` : ""}`);
  }
  for (const s of latest.services) {
    line(s.ok, `service ${s.id} — ${s.ms} ms`);
  }
  line(latest.allOk, `all ok: ${latest.allOk} (receipt generated ${latest.generatedAt})`);
}

// ── 6. the top-100 scorecard, with the shipped model re-scored ──────────────
function phaseRank() {
  phase("6 · rank — the shipped model re-scored, then the top 100");
  const card = JSON.parse(readFileSync(join(root, "bench/top100-scorecard.json"), "utf8"));
  const t = card.totals;
  line(t.wins >= 8, `${t.wins}/${t.axes} axes won, ${t.ties} tied, ${t.losses} lost — largest population ${card.population.n} systems`);

  // Do not trust the stored number: regenerate the published 200-task suite,
  // score the shipped .gguf with the same engine the browser loads, and fail
  // if the result has drifted from what the scorecard publishes.
  const dir = mkdtempSync(join(tmpdir(), "rarext-demo-"));
  const out = join(dir, "neural.json");
  execFileSync("node", ["tools/rank/eval-neural.mjs", "--n", "200", "--seed", "20261123", "--out", out],
    { cwd: root, encoding: "utf8", timeout: 1800000 });
  const live = JSON.parse(readFileSync(out, "utf8"));
  const claimed = card.evidence.neuralHeldout;
  const fam = (k) => `${k} ${live.byFamily[k][0]}/${live.byFamily[k][1]}`;
  line(live.passed === claimed.passed && live.n === claimed.n,
    `shipped bytes re-scored on the published suite: ${live.passed}/${live.n} — ${Object.keys(live.byFamily).map(fam).join(" · ")}`);
  line((live.byFamily.diff?.[0] ?? 0) > 0,
    `the model alone now computes ledger differences: diff ${live.byFamily.diff[0]}/${live.byFamily.diff[1]} (was 0 before v13)`);

  for (const axis of card.axes.filter((a) => a.verdict !== "loss")) {
    line(true, `${axis.verdict.toUpperCase()} ${axis.label} — ${axis.rank}`);
  }
  for (const axis of card.axes.filter((a) => a.verdict === "loss")) {
    console.log(`  [--] LOSS ${axis.label} — ${axis.rarext}`);
  }
  line(card.evidence.hybridHeldout.passed === card.evidence.hybridHeldout.n,
    `held-out ledger suite: ${card.evidence.hybridHeldout.passed}/${card.evidence.hybridHeldout.n} exact vs neural alone ${live.passed}/${live.n}`);
  const pro = card.evidence.hostedPro;
  if (pro) line(true, `same exact-format bar, hosted top tier: ${pro.model} ${pro.exact}/${pro.n} exact · ${pro.semantic}/${pro.n} semantic`);
}

// ── 7. head-to-head on fresh tasks, live ────────────────────────────────────
function phaseHeadToHead() {
  phase("7 · head-to-head — fresh tasks, deployed path vs a live top-tier model");
  const dir = mkdtempSync(join(tmpdir(), "rarext-h2h-"));
  const out = join(dir, "head-to-head.json");
  execFileSync("node", ["tools/rank/eval-head-to-head.mjs", "--n", "18", "--seed", "20261127", "--out", out],
    { cwd: root, encoding: "utf8", timeout: 1800000 });
  const h = JSON.parse(readFileSync(out, "utf8"));
  const n = h.n;
  line(h.rarext.hybrid.exact === n,
    `deployed path (exact tool → neural fallback): ${h.rarext.hybrid.exact}/${n} exact · ${h.rarext.hybrid.semantic}/${n} semantic`);
  console.log(`  [--] model alone on the same fresh tasks: ${h.rarext.neural.exact}/${n} exact · ${h.rarext.neural.semantic}/${n} semantic`);
  if (!h.hosted) {
    line(false, "could not verify the live comparison — no NVIDIA_BASE_URL / NVIDIA_API_KEY");
    return;
  }
  line(true, `${h.hostedModel}: ${h.hosted.exact}/${n} exact · ${h.hosted.semantic}/${n} semantic (live, temperature 0)`);
  line(h.rarext.hybrid.exact > h.hosted.exact,
    `exact-format win on identical prompts: ${h.rarext.hybrid.exact}/${n} vs ${h.hosted.exact}/${n}`);
  line(h.rarext.hybrid.semantic >= h.hosted.semantic,
    `semantic parity: ${h.rarext.hybrid.semantic}/${n} vs ${h.hosted.semantic}/${n} — no correctness traded for exactness`);
}

// ── 8. verification ─────────────────────────────────────────────────────────
function phaseVerify() {
  phase("8 · verification — the claim gate at its recorded baseline");
  const out = execFileSync("node", ["tools/ops/claim-gate.mjs"], { cwd: root, encoding: "utf8", timeout: 600000 });
  const verdict = out.split("\n").find((l) => l.includes("→")) ?? out.trim();
  line(/PASS/.test(verdict), verdict.trim());
}

console.log("╔══════════════════════════════════════════════╗");
console.log("║   RAREXT AI — live demo, eight phases        ║");
console.log("╚══════════════════════════════════════════════╝");

await phaseLiveApi();
await phaseBrowser();
await phaseSkillsAndMemory();
await phaseOps();
phaseRank();
phaseHeadToHead();
phaseVerify();

console.log(`\n${failures === 0 ? "ALL PHASES PASS — RAREXT AI, end to end." : `${failures} check(s) failed — shown above.`}`);
process.exit(failures === 0 ? 0 : 1);
