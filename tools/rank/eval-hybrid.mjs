#!/usr/bin/env node
/**
 * eval-hybrid.mjs — the deployed system: exact numeric tool first, neural model
 * as the fallback for anything the tool does not recognise.
 *
 * Same held-out suite as eval-neural.mjs, same artifacts, same scoring. Reports
 * three rows so nothing is conflated:
 *   neural alone   — what the χ=48 weights answer on their own
 *   exact tool     — what the deterministic solver answers, and on how many
 *   hybrid         — tool when it answers, model otherwise (what the page does)
 *
 *   node tools/rank/eval-hybrid.mjs --n 1000 --seed 20261123
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const N = Number(arg("n", 1000));
const SEED = Number(arg("seed", 20261123));
const WITH_NEURAL = !args.includes("--exact-only");
const root = new URL("../..", import.meta.url).pathname;

execFileSync("node", ["tools/rank/gen-tasks.mjs", "--n", String(N), "--seed", String(SEED), "--json"], { cwd: root });
const suite = JSON.parse(readFileSync(join(root, "tools/rank/tasks.json"), "utf8"));

const entangled = await import(pathToFileURL(join(root, "apps/web/public/entangled.js")).href);

const byFamily = new Map();
const rows = [];
const t0 = Date.now();
let neuralRuns = 0;

let loaded = null;
if (WITH_NEURAL) {
  loaded = await entangled.loadEntangledModel({
    engineSource: readFileSync(join(root, "apps/web/public/entangled-engine.js"), "utf8"),
    weightsBytes: new Uint8Array(readFileSync(join(root, "apps/web/public/rarext-entangled-chi48.gguf"))),
  });
}

for (const task of suite.tasks) {
  const exact = entangled.answerExact(task.prompt);
  let got;
  let source;
  if (exact) {
    got = exact.text;
    source = "exact";
  } else if (loaded) {
    got = entangled.answerWith(loaded.engine, loaded.model, task.prompt, 32).text;
    source = "neural";
    neuralRuns += 1;
  } else {
    got = "";
    source = "none";
  }
  const ok = got === task.gold;
  rows.push({ id: task.id, family: task.family, gold: task.gold, got, source, ok });
  const cur = byFamily.get(task.family) ?? { exact: 0, neural: 0, ok: 0, n: 0 };
  cur.n += 1;
  cur.ok += ok ? 1 : 0;
  cur[source] = (cur[source] ?? 0) + 1;
  byFamily.set(task.family, cur);
}
const ms = Date.now() - t0;
const passed = rows.filter((r) => r.ok).length;
const exactRows = rows.filter((r) => r.source === "exact");
const exactPassed = exactRows.filter((r) => r.ok).length;

console.log(`suite ${N} tasks, seed ${SEED} — ${ms} ms`);
console.log(`hybrid        ${passed}/${N} exact (${((passed / N) * 100).toFixed(2)}%)`);
console.log(`exact tool    answered ${exactRows.length}/${N} · ${exactPassed}/${exactRows.length} correct (${((exactPassed / Math.max(1, exactRows.length)) * 100).toFixed(2)}%)`);
if (loaded) console.log(`neural fallback used ${neuralRuns} time(s)`);
console.log("\nby family (hybrid):");
for (const [family, c] of byFamily) {
  console.log(`  ${family.padEnd(9)} ${c.ok}/${c.n}  ${((c.ok / c.n) * 100).toFixed(1)}%  (exact ${c.exact ?? 0}, neural ${c.neural ?? 0})`);
}
writeFileSync(join(root, "tools/rank/hybrid-heldout.json"),
  JSON.stringify({ seed: SEED, n: N, passed, accuracy: passed / N, ms, neuralRuns, byFamily: Object.fromEntries(byFamily), rows }, null, 2) + "\n");
console.log("\nwrote tools/rank/hybrid-heldout.json");
process.exit(passed === N ? 0 : 1);
