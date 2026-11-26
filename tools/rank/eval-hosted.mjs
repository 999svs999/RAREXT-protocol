#!/usr/bin/env node
/**
 * eval-hosted.mjs — the same held-out numeric suite, asked of a live hosted
 * model through an OpenAI-compatible endpoint, scored two ways:
 *
 *   semantic — the correct number (or, for cheapest/priciest, the correct item)
 *              appears in the answer
 *   exact    — byte-identical to RAREXT's answer convention (the stricter bar)
 *
 * RAREXT's hybrid is exact by construction; this measures whether a frontier
 * model is. The point is not that RAREXT "thinks better" — it is that on this
 * task class an exact tool is exact and a sampled model is not.
 *
 *   set -a; source ~/.hermes/.env; set +a
 *   node tools/rank/eval-hosted.mjs --n 100 --base "$NVIDIA_BASE_URL" \
 *        --key "$NVIDIA_API_KEY" --model agnes-3.0-pro
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const N = Number(arg("n", 100));
const SEED = Number(arg("seed", 20261123));
const MODEL = arg("model", "agnes-3.0-pro");
const BASE = (arg("base", process.env.NVIDIA_BASE_URL ?? "")).replace(/\/+$/, "");
const KEY = arg("key", process.env.NVIDIA_API_KEY ?? "");
const CONCURRENCY = Number(arg("concurrency", 3));
const OUT = arg("out", "tools/rank/hosted-heldout.json");
if (!BASE || !KEY) {
  console.error("need --base and --key (or NVIDIA_BASE_URL / NVIDIA_API_KEY)");
  process.exit(2);
}
const root = new URL("../..", import.meta.url).pathname;
execFileSync("node", ["tools/rank/gen-tasks.mjs", "--n", String(N), "--seed", String(SEED), "--json"], { cwd: root });
const suite = JSON.parse(readFileSync(join(root, "tools/rank/tasks.json"), "utf8"));

const goldValue = (gold) => {
  const m = /\$([\d.]+)/.exec(gold);
  return m ? Number(m[1]) : NaN;
};
const goldItem = (task) => {
  if (task.family !== "cheapest" && task.family !== "priciest") return null;
  const rows = [];
  for (const line of task.prompt.replace(/^\s*rows:\s*/i, "").split("\n")) {
    const m = /^-\s*(.+?)\s*\|\s*\$(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m) rows.push({ name: m[1], price: Number(m[2]) });
  }
  if (!rows.length) return null;
  const pick = task.family === "cheapest"
    ? rows.reduce((a, b) => (b.price < a.price ? b : a))
    : rows.reduce((a, b) => (b.price > a.price ? b : a));
  return pick.name.toLowerCase();
};
const semanticOk = (got, task) => {
  const want = goldValue(task.gold);
  // thousand separators are formatting, not a wrong answer: strip them first
  const text = String(got).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const nums = [...text.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
  if (nums.some((n) => Math.abs(n - want) < 1e-9)) return true;
  const item = goldItem(task);
  return !!item && text.toLowerCase().includes(item);
};

async function ask(prompt) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 2048,
      }),
    });
    if (res.ok) {
      const d = await res.json();
      const choice = d.choices?.[0] ?? {};
      return { text: choice.message?.content ?? "", usage: d.usage ?? null, finish: choice.finish_reason };
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("exhausted retries");
}

const rows = [];
const byFamily = new Map();
let promptTokens = 0;
let outputTokens = 0;
const t0 = Date.now();
const queue = [...suite.tasks];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const task = queue.shift();
    let text = "";
    try {
      const r = await ask(task.prompt);
      text = String(r.text ?? "").trim();
      promptTokens += r.usage?.prompt_tokens ?? 0;
      outputTokens += r.usage?.completion_tokens ?? 0;
    } catch (error) {
      text = `__error__: ${error instanceof Error ? error.message : String(error)}`;
    }
    const exact = text === task.gold;
    const semantic = semanticOk(text, task);
    rows.push({ id: task.id, family: task.family, gold: task.gold, got: text, exact, semantic });
    const cur = byFamily.get(task.family) ?? { exact: 0, semantic: 0, n: 0 };
    cur.n += 1;
    cur.exact += exact ? 1 : 0;
    cur.semantic += semantic ? 1 : 0;
    byFamily.set(task.family, cur);
  }
}));
const ms = Date.now() - t0;
const exact = rows.filter((r) => r.exact).length;
const semantic = rows.filter((r) => r.semantic).length;

console.log(`${MODEL} on ${N} held-out tasks (seed ${SEED}) — ${(ms / 1000).toFixed(1)} s`);
console.log(`semantic  ${semantic}/${N} (${((semantic / N) * 100).toFixed(1)}%)`);
console.log(`exact     ${exact}/${N} (${((exact / N) * 100).toFixed(1)}%)`);
console.log(`tokens    ${promptTokens} in / ${outputTokens} out`);
console.log("\nby family (semantic / exact):");
for (const [family, c] of byFamily) {
  console.log(`  ${family.padEnd(9)} ${c.semantic}/${c.n} / ${c.exact}/${c.n}`);
}
writeFileSync((isAbsolute(OUT) ? OUT : resolve(root, OUT)),
  JSON.stringify({ model: MODEL, seed: SEED, n: N, exact, semantic, ms, promptTokens, outputTokens, byFamily: Object.fromEntries(byFamily), rows }, null, 2) + "\n");
console.log(`\nwrote ${OUT}`);
