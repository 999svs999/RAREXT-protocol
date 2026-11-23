#!/usr/bin/env node
/**
 * eval-neural.mjs — measure the deployed χ=48 model ALONE on held-out tasks.
 *
 * Loads the same digest-pinned artifacts the browser loads, runs the same
 * `answerWith`, and scores exact-match against gold computed by gen-tasks.mjs.
 * This is the honest number: the 14 in-page prompts are the trained set; these
 * are generated fresh from the same grammar.
 *
 *   node tools/rank/eval-neural.mjs --n 200 --seed 20261123
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
const N = Number(arg("n", 200));
const SEED = Number(arg("seed", 20261123));
const root = new URL("../..", import.meta.url).pathname;

execFileSync("node", ["tools/rank/gen-tasks.mjs", "--n", String(N), "--seed", String(SEED), "--json"], { cwd: root });
const suite = JSON.parse(readFileSync(join(root, "tools/rank/tasks.json"), "utf8"));

const entangled = await import(pathToFileURL(join(root, "apps/web/public/entangled.js")).href);
const loaded = await entangled.loadEntangledModel({
  engineSource: readFileSync(join(root, "apps/web/public/entangled-engine.js"), "utf8"),
  weightsBytes: new Uint8Array(readFileSync(join(root, "apps/web/public/rarext-entangled-chi48.gguf"))),
});

const byFamily = new Map();
const rows = [];
const t0 = Date.now();
for (const task of suite.tasks) {
  const got = entangled.answerWith(loaded.engine, loaded.model, task.prompt, 32).text;
  const ok = got === task.gold;
  rows.push({ id: task.id, family: task.family, gold: task.gold, got, ok });
  const cur = byFamily.get(task.family) ?? [0, 0];
  byFamily.set(task.family, [cur[0] + (ok ? 1 : 0), cur[1] + 1]);
}
const ms = Date.now() - t0;
const passed = rows.filter((r) => r.ok).length;

console.log(`neural model alone — ${passed}/${rows.length} exact (${((passed / rows.length) * 100).toFixed(1)}%), ${ms} ms`);
for (const [family, [ok, n]] of byFamily) {
  console.log(`  ${family.padEnd(9)} ${ok}/${n}  ${((ok / n) * 100).toFixed(1)}%`);
}
writeFileSync(join(root, "tools/rank/neural-heldout.json"),
  JSON.stringify({ seed: SEED, n: rows.length, passed, accuracy: passed / rows.length, ms, byFamily: Object.fromEntries(byFamily), rows }, null, 2) + "\n");
console.log("wrote tools/rank/neural-heldout.json");
