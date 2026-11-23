#!/usr/bin/env node
/**
 * eval-gemini.mjs — the same held-out numeric suite, asked of a live top-tier
 * model, scored two ways so the comparison is fair:
 *
 *   semantic — the correct number appears in the answer (what a user cares about)
 *   exact    — byte-identical to RAREXT's answer convention (the stricter bar)
 *
 * RAREXT's hybrid is exact by construction; this measures whether a frontier
 * model is. The point is not that RAREXT "thinks better" — it is that on this
 * task class an exact tool is exact and a sampled model is not.
 *
 *   set -a; source ~/.hermes/.env; set +a
 *   node tools/rank/eval-gemini.mjs --n 100 --model gemini-3-flash-preview
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const N = Number(arg("n", 100));
const SEED = Number(arg("seed", 20261123));
const MODEL = arg("model", "gemini-3-flash-preview");
const KEY = process.env.GOOGLE_API_KEY;
if (!KEY) {
  console.error("GOOGLE_API_KEY is not set — source ~/.hermes/.env first");
  process.exit(2);
}
const root = new URL("../..", import.meta.url).pathname;
execFileSync("node", ["tools/rank/gen-tasks.mjs", "--n", String(N), "--seed", String(SEED), "--json"], { cwd: root });
const suite = JSON.parse(readFileSync(join(root, "tools/rank/tasks.json"), "utf8"));

// The number the answer must contain. Gold is RAREXT's convention; the value
// is what a user actually asked for.
const goldValue = (gold) => {
  const m = /\$([\d.]+)/.exec(gold);
  return m ? Number(m[1]) : NaN;
};
// For "which is cheapest/most expensive" the item NAME is a correct answer,
// so semantic scoring accepts either the right price or the right item name.
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
  const text = String(got);
  const nums = [...text.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
  if (nums.some((n) => Math.abs(n - want) < 1e-9)) return true;
  const item = goldItem(task);
  return !!item && text.toLowerCase().includes(item);
};

async function ask(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048 },
      }),
    });
    if (res.ok) {
      const d = await res.json();
      const text = (d.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return { text, usage: d.usageMetadata ?? null };
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 2000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("rate-limited after 8 attempts");
}

const rows = [];
const byFamily = new Map();
let promptTokens = 0;
let outputTokens = 0;
const t0 = Date.now();

// small worker pool: 4 in flight, keeps us inside the free tier
const queue = [...suite.tasks];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) {
    const task = queue.shift();
    let text = "";
    try {
      const r = await ask(task.prompt);
      text = r.text;
      promptTokens += r.usage?.promptTokenCount ?? 0;
      outputTokens += (r.usage?.candidatesTokenCount ?? 0) + (r.usage?.thoughtsTokenCount ?? 0);
    } catch (error) {
      text = `__error__: ${error instanceof Error ? error.message : String(error)}`;
    }
    const exact = text === task.gold;
    const semantic = semanticOk(text, task);
    rows.push({ id: task.id, family: task.family, gold: task.gold, got: text.trim(), exact, semantic });
    const cur = byFamily.get(task.family) ?? { exact: 0, semantic: 0, n: 0 };
    cur.n += 1;
    cur.exact += exact ? 1 : 0;
    cur.semantic += semantic ? 1 : 0;
    byFamily.set(task.family, cur);
    await new Promise((r) => setTimeout(r, 400));
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
writeFileSync(join(root, "tools/rank/gemini-heldout.json"),
  JSON.stringify({ model: MODEL, seed: SEED, n: N, exact, semantic, ms, promptTokens, outputTokens, byFamily: Object.fromEntries(byFamily), rows }, null, 2) + "\n");
console.log("\nwrote tools/rank/gemini-heldout.json");
