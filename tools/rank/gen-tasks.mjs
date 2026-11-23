#!/usr/bin/env node
/**
 * gen-tasks.mjs — deterministic held-out task suite for the RAREXT skills.
 *
 * The 14 prompts in the page are the ones the model was evolved on. This file
 * generates NEW tasks from the same grammar with a fixed seed, and computes the
 * gold answer with exact integer arithmetic. Nothing here touches the model:
 * it is the measuring stick, so it must be independent of what is measured.
 *
 *   node tools/rank/gen-tasks.mjs --n 200 --seed 20261123 [--json]
 *
 * Task families (all answerable from the rows alone):
 *   lookup   — price of a named item
 *   cheapest — min over n rows
 *   priciest — max over n rows
 *   diff     — price(a) − price(b)
 *   total    — sum over a named subset
 *   pct      — price after a percentage discount
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const N = Number(arg("n", 200));
const SEED = Number(arg("seed", 20261123));
const JSON_OUT = args.includes("--json");

// mulberry32 — small, fast, deterministic
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
const rand = rng(SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const WORDS = ["tee", "cap", "jacket", "shorts", "pants", "hoodie", "vest", "bag",
  "belt", "socks", "coat", "crew", "shark", "tiger", "college", "camo", "city",
  "mega", "mini", "classic", "high", "low", "big", "white", "black", "navy",
  "grey", "red", "green", "store", "baby", "gift", "down", "shirt", "chain"];
const name = () => {
  const n = int(2, 3);
  const parts = new Set();
  while (parts.size < n) parts.add(pick(WORDS));
  const style = rand();
  const joined = [...parts].join(" ");
  if (style < 0.34) return joined.toUpperCase();
  if (style < 0.67) return joined;
  return joined.replace(/\b\w/g, (c) => c.toUpperCase());
};
const uniqueNames = (k) => {
  const out = [];
  while (out.length < k) {
    const n = name();
    if (!out.includes(n)) out.push(n);
  }
  return out;
};
const price = () => int(5, 9999);

function makeRows(names, prices) {
  return names.map((n, i) => `-${n}|$${prices[i]}`).join("\n");
}

const families = {
  lookup() {
    const names = uniqueNames(1);
    const prices = [price()];
    return {
      family: "lookup",
      prompt: `rows: ${makeRows(names, prices)}\nq: how much is the ${names[0]}?\na: `,
      gold: `The price is $${prices[0]} delivered.`,
      check: (text) => text === `The price is $${prices[0]} delivered.`,
    };
  },
  cheapest() {
    const k = int(2, 4);
    const names = uniqueNames(k);
    const prices = names.map(price);
    const min = Math.min(...prices);
    return {
      family: "cheapest",
      prompt: `rows: ${makeRows(names, prices)}\nq: which is cheapest?\na: `,
      gold: `The price is $${min} delivered.`,
      check: (text) => text === `The price is $${min} delivered.`,
    };
  },
  priciest() {
    const k = int(2, 4);
    const names = uniqueNames(k);
    const prices = names.map(price);
    const max = Math.max(...prices);
    return {
      family: "priciest",
      prompt: `rows: ${makeRows(names, prices)}\nq: which is most expensive?\na: `,
      gold: `The price is $${max} delivered.`,
      check: (text) => text === `The price is $${max} delivered.`,
    };
  },
  diff() {
    const names = uniqueNames(2);
    let [a, b] = [price(), price()];
    if (a === b) b = a > 5 ? a - 1 : a + 1;
    const d = Math.abs(a - b);
    return {
      family: "diff",
      prompt: `rows: ${makeRows(names, [a, b])}\nq: how much more is the ${a >= b ? names[0] : names[1]} than the ${a >= b ? names[1] : names[0]}?\na: `,
      gold: `$${d} more`,
      check: (text) => text === `$${d} more`,
    };
  },
  total() {
    const k = int(2, 3);
    const names = uniqueNames(k);
    const prices = names.map(price);
    const sum = prices.reduce((x, y) => x + y, 0);
    return {
      family: "total",
      prompt: `rows: ${makeRows(names, prices)}\nq: what is the total of all items?\na: `,
      gold: `The total is $${sum} delivered.`,
      check: (text) => text === `The total is $${sum} delivered.`,
    };
  },
  pct() {
    const names = uniqueNames(1);
    const p = price();
    const off = pick([10, 15, 20, 25, 30, 40, 50]);
    const after = Math.round(p * (100 - off)) / 100;
    return {
      family: "pct",
      prompt: `rows: ${makeRows(names, [p])}\nq: what is the price after ${off}% off?\na: `,
      gold: `The price is $${after} delivered.`,
      check: (text) => text === `The price is $${after} delivered.`,
    };
  },
};

const names = Object.keys(families);
const tasks = Array.from({ length: N }, (_, i) => {
  const t = families[names[i % names.length]]();
  return { id: i, ...t };
});

if (JSON_OUT) {
  writeFileSync(new URL("./tasks.json", import.meta.url),
    JSON.stringify({ seed: SEED, n: N, tasks }, null, 2) + "\n");
  console.log(`wrote ${N} tasks to tools/rank/tasks.json (seed ${SEED})`);
} else {
  const byFamily = {};
  for (const t of tasks) byFamily[t.family] = (byFamily[t.family] ?? 0) + 1;
  console.log(`generated ${N} tasks, seed ${SEED}`);
  console.log(Object.entries(byFamily).map(([k, v]) => `${k}=${v}`).join(" "));
  console.log("\nexample:");
  console.log(tasks[0].prompt.replace(/\n/g, "\\n"));
  console.log(`gold: ${tasks[0].gold}`);
}
