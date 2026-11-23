#!/usr/bin/env node
/**
 * eval-ctx.mjs — verify the deployed artifact's context window end to end.
 *
 * A `context_length` kv is a claim, not a capability. This script settles it
 * the way the page would: it generates held-out k-row ledgers at several row
 * depths, feeds each one to the SHIPPED ENGINE (same loader, same answerWith),
 * and scores exact match. The published context number is the largest depth
 * the engine answers exactly, not the kv value.
 *
 *   node tools/rank/eval-ctx.mjs --rows 8,32,64,96 --per-depth 3
 *   node tools/rank/eval-ctx.mjs --weights tools/entangle/entangled-chi48-ctx.gguf
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEPTHS = (arg("rows", "8,32,64,96") || "").split(",").map(Number).filter(Boolean);
const PER_DEPTH = Number(arg("per-depth", 3));
const SEED = Number(arg("seed", 20261124));
const WEIGHTS = arg("weights", "apps/web/public/rarext-entangled-chi48.gguf");
const OUT = arg("out", "tools/rank/ctx-heldout.json");
const root = new URL("../..", import.meta.url).pathname;

// mulberry32 — same generator the task suite uses, so anyone can re-run it
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["tee", "cap", "jacket", "shorts", "pants", "hoodie", "vest", "bag",
  "belt", "socks", "coat", "crew", "shark", "tiger", "college", "camo", "city",
  "mega", "mini", "classic", "high", "low", "big", "white", "black", "navy",
  "grey", "red", "green", "store", "baby", "gift", "down", "shirt", "chain"];
const rand = rng(SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const name = () => {
  const n = int(2, 3);
  const parts = new Set();
  while (parts.size < n) parts.add(pick(WORDS));
  const joined = [...parts].join(" ");
  if (rand() < 0.34) return joined.toUpperCase();
  if (rand() < 0.67) return joined;
  return joined.replace(/\b\w/g, (c) => c.toUpperCase());
};

function ledger(rows) {
  const names = [];
  while (names.length < rows) {
    const n = name();
    if (!names.includes(n)) names.push(n);
  }
  const prices = names.map(() => int(5, 9999));
  const body = names.map((n, i) => `-${n}|$${prices[i]}`).join("\n");
  const roll = rand();
  if (roll < 0.6) {
    const i = int(0, rows - 1);
    return { prompt: `rows: ${body}\nq: how much is the ${names[i]}?\na: `,
             gold: `The price is $${prices[i]} delivered.` };
  }
  if (roll < 0.8) {
    const min = Math.min(...prices);
    return { prompt: `rows: ${body}\nq: which is cheapest?\na: `,
             gold: `The price is $${min} delivered.` };
  }
  const max = Math.max(...prices);
  return { prompt: `rows: ${body}\nq: which is most expensive?\na: `,
           gold: `The price is $${max} delivered.` };
}

const entangled = await import(pathToFileURL(join(root, "apps/web/public/entangled.js")).href);
const loaded = await entangled.loadEntangledModel({
  engineSource: readFileSync(join(root, "apps/web/public/entangled-engine.js"), "utf8"),
  weightsBytes: new Uint8Array(readFileSync(join(root, WEIGHTS))),
});
const ctx = Number(loaded.parsed.kv["qwen2.context_length"] ?? 0);
console.log(`weights ${WEIGHTS}`);
console.log(`declared context_length ${ctx}`);

const results = [];
let allOk = true;
for (const rows of DEPTHS) {
  const depth = [];
  for (let i = 0; i < PER_DEPTH; i += 1) {
    const t = ledger(rows);
    const t0 = Date.now();
    let got = "";
    try {
      got = entangled.answerWith(loaded.engine, loaded.model, t.prompt, 32).text;
    } catch (error) {
      got = `__error__: ${error instanceof Error ? error.message : String(error)}`;
    }
    depth.push({ rows, promptBytes: t.prompt.length, gold: t.gold, got, ok: got === t.gold, ms: Date.now() - t0 });
  }
  const ok = depth.filter((d) => d.ok).length;
  allOk = allOk && ok === PER_DEPTH;
  console.log(`  ${String(rows).padStart(3)} rows · ${String(depth[0].promptBytes).padStart(5)} B · ${ok}/${PER_DEPTH} exact · ${depth.map((d) => d.ms).join("/")}`);
  results.push(...depth);
}

const bytes = results[results.length - 1]?.promptBytes ?? 0;
console.log(allOk
  ? `context VERIFIED: exact at every depth up to ${bytes} bytes`
  : `context NOT verified at the depths listed above`);
writeFileSync(join(root, OUT), JSON.stringify({
  weights: WEIGHTS, declaredContextLength: ctx, seed: SEED, depths: DEPTHS,
  perDepth: PER_DEPTH, allOk, maxVerifiedBytes: allOk ? bytes : 0, results,
}, null, 2) + "\n");
console.log(`wrote ${OUT}`);
process.exit(allOk ? 0 : 1);
