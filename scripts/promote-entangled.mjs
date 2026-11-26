#!/usr/bin/env node
/**
 * promote-entangled.mjs — put a retrained χ=48 checkpoint into service.
 *
 * A new weight file is not shipped by copying bytes: the page refuses to run
 * when a digest does not match its pin, and several receipts carry the same
 * digest. This script does the whole swap in one place — and it tests the swap
 * the way the page does, by importing the repinned loader and letting it verify
 * the installed bytes. If the candidate does not load as 56 factor pairs at
 * context 192, or a deployed skill regresses, every file is restored.
 *
 *   node scripts/promote-entangled.mjs --candidate tools/entangle/entangled-chi48-diff.gguf --check
 *   node scripts/promote-entangled.mjs --candidate tools/entangle/entangled-chi48-diff.gguf
 *
 * --check performs the identical install-and-verify, then restores.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = new URL("..", import.meta.url).pathname;
const CHECK = args.includes("--check");
const CANDIDATE = arg("candidate", "tools/entangle/entangled-chi48-diff.gguf");
const SHIPPED = "apps/web/public/rarext-entangled-chi48.gguf";
const TARGETS = [SHIPPED, "site/registry/mirror/rarext-entangled-chi48.gguf",
  "tools/entangle/entangled-factored.gguf"];
const PINNED = ["apps/web/public/entangled.js", "site/registry/mirror/entangled.js",
  "bench/ai-capability.json", "docs/AI-BRAND-PARITY.md",
  "docs/quantum-entanglement-rebuild.md", ".ai-proof/web4-model/receipt.json"];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const read = (p) => readFileSync(join(root, p));
const write = (p, b) => writeFileSync(join(root, p), b);
const SKIP_EVAL = args.includes("--skip-eval");

// The published neural number is the thing a promotion must not damage. The
// 2026-11-24 v3 checkpoint passed every set gate and the 14 page prompts and
// still cost the suite 4 items (cheapest 94.1% → 85.3%) — so the gate now
// measures the suite itself and reverts on any regression.
const baselinePath = "tools/rank/neural-heldout.json";
const baseline = existsSync(join(root, baselinePath))
  ? JSON.parse(read(baselinePath).toString("utf8"))
  : null;

if (!existsSync(join(root, CANDIDATE))) {
  console.error(`no candidate at ${CANDIDATE}`);
  process.exit(2);
}
const newBytes = read(CANDIDATE);
const oldDigest = sha256(read(SHIPPED));
const newDigest = sha256(newBytes);
console.log(`candidate ${CANDIDATE} — ${newBytes.length.toLocaleString()} bytes sha256:${newDigest}`);
console.log(`shipped   ${SHIPPED} — ${read(SHIPPED).length.toLocaleString()} bytes sha256:${oldDigest}`);

// snapshot everything this script may touch, so a failed check restores byte-for-byte
const snapshot = new Map();
for (const p of [...TARGETS, ...PINNED]) if (existsSync(join(root, p))) snapshot.set(p, read(p));
const restore = () => {
  for (const [p, bytes] of snapshot) write(p, bytes);
  console.log("restored every touched file");
};
const fail = (message) => { console.error(`REFUSED: ${message}`); restore(); process.exit(1); };

// ── install ─────────────────────────────────────────────────────────────────
for (const target of TARGETS) write(target, newBytes);
for (const file of PINNED) {
  if (!existsSync(join(root, file))) continue;
  const before = read(file).toString("utf8");
  if (!before.includes(oldDigest)) continue;
  write(file, before.split(oldDigest).join(newDigest));
}

// ── verify the way the page does: the repinned loader must accept the bytes ──
const fresh = await import(pathToFileURL(join(root, "apps/web/public/entangled.js")).href + `?v=${Date.now()}`);
let loaded;
try {
  loaded = await fresh.loadEntangledModel({
    engineSource: read("apps/web/public/entangled-engine.js").toString("utf8"),
    weightsBytes: new Uint8Array(newBytes),
  });
} catch (error) {
  fail(`the page would refuse these bytes: ${error instanceof Error ? error.message : error}`);
}
const factors = loaded.factors;
const ctx = Number(loaded.parsed.kv["qwen2.context_length"] ?? 0);
const name = loaded.parsed.kv["general.name"];
console.log(`loads: ${factors} MPO factor pairs · context ${ctx} · ${name}`);
if (factors !== 56 || ctx !== 192) fail(`expected 56 factor pairs at context 192, got ${factors} / ${ctx}`);

const results = fresh.skillSelfTest(loaded.engine, loaded.model);
const failed = results.filter((r) => !r.ok);
console.log(`skill self-test: ${results.length - failed.length}/${results.length}`);
for (const f of failed) console.log(`  FAIL ${f.skill}: want ${JSON.stringify(f.want)}, got ${JSON.stringify(f.got)}`);

if (CHECK) {
  restore();
  console.log(`\n--check: ${failed.length ? "WOULD FAIL" : "verified"}, nothing kept`);
  process.exit(failed.length ? 1 : 0);
}
if (failed.length) fail("a deployed skill regressed on the candidate");

// ── the suite itself: the published number must not regress ─────────────────
if (!SKIP_EVAL && baseline) {
  console.log(`\nscoring the candidate on the held-out suite (baseline ${baseline.passed}/${baseline.n})…`);
  execFileSync("node", ["tools/rank/eval-neural.mjs", "--n", "200", "--seed", "20261123",
    "--out", "tools/rank/neural-promote-candidate.json"], { cwd: root, stdio: "inherit" });
  const cand = JSON.parse(read("tools/rank/neural-promote-candidate.json").toString("utf8"));
  console.log(`candidate ${cand.passed}/${cand.n} vs baseline ${baseline.passed}/${baseline.n}`);
  if (cand.passed < baseline.passed) {
    fail(`the candidate scores ${baseline.passed - cand.passed} item(s) WORSE on the published suite`);
  }
  // per-family floors: a candidate may not buy one family by selling another
  for (const fam of Object.keys(baseline.byFamily ?? {})) {
    const b = baseline.byFamily[fam], c = cand.byFamily[fam] ?? [0, b?.[1] ?? 0];
    if ((c?.[0] ?? 0) < (b?.[0] ?? 0)) {
      fail(`family ${fam} regressed: ${c?.[0]}/${c?.[1]} vs baseline ${b?.[0]}/${b?.[1]}`);
    }
  }
  // the candidate is better or equal: its suite record becomes the published one
  copyFileSync(join(root, "tools/rank/neural-promote-candidate.json"), join(root, baselinePath));
  console.log(`neural-heldout.json updated to the promoted artifact's record`);
}

console.log(`\npromoted ${newDigest}`);
console.log("next: node tools/rank/scorecard.mjs && npm run test:runtime && npm run claim:check");
