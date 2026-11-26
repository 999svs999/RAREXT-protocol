#!/usr/bin/env node
/**
 * eval-head-to-head.mjs — a live, fresh-task comparison between the deployed
 * RAREXT answer path and a top-tier hosted model, on the exact same prompts.
 *
 * Why this exists: the scorecard compares RAREXT against the current top-100
 * population, but most of that comparison is structural (no network, no meter,
 * deterministic bytes). This script answers the narrower, harder question the
 * demo has to show: on a NEW sample drawn from the published grammar — not the
 * trained set, not the earlier eval seed — does the deployed system answer
 * exactly, and does the hosted model?
 *
 * Three answer paths are scored on every task:
 *
 *   rarext.hybrid  the page's deployed path: `answerExact` first, neural fallback
 *   rarext.neural  the χ=48 weights alone (the honest model-only number)
 *   hosted         a live OpenAI-compatible model (default agnes-3.0-pro)
 *
 * Two bars, because they are different claims:
 *
 *   exact     byte-identical to the answer contract (`The price is $432 delivered.`)
 *   semantic  the correct number (or cheapest/priciest item) appears at all
 *
 * Credentials: --base/--key, else NVIDIA_BASE_URL/NVIDIA_API_KEY, else the same
 * keys from ~/.hermes/.env. If none are available the script still scores
 * RAREXT and records `hosted: null` — a demo can then say it could not verify
 * the live comparison rather than pretend it did.
 *
 *   node tools/rank/eval-head-to-head.mjs --n 18 --seed 20261127
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const N = Number(arg("n", 18));
const SEED = Number(arg("seed", 20261127));
const MODEL = arg("model", "agnes-3.0-pro");
const CONCURRENCY = Number(arg("concurrency", 3));
const OUT = arg("out", "tools/rank/head-to-head.json");
const root = new URL("../..", import.meta.url).pathname;

/** Read a KEY=VALUE file without a shell, keeping the caller's env first. */
function envFromFile(name) {
  const p = join(homedir(), ".hermes", ".env");
  if (!existsSync(p)) return "";
  const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "";
}
const BASE = (arg("base", process.env.NVIDIA_BASE_URL || envFromFile("NVIDIA_BASE_URL"))).replace(/\/+$/, "");
const KEY = arg("key", process.env.NVIDIA_API_KEY || envFromFile("NVIDIA_API_KEY"));

// ── the same suite the other evals use, at a seed none of them used ─────────
// gen-tasks writes tools/rank/tasks.json; keep whatever was there so a demo run
// cannot change what another script reads.
const tasksPath = join(root, "tools/rank/tasks.json");
const previousTasks = existsSync(tasksPath) ? readFileSync(tasksPath, "utf8") : null;
try {
  execFileSync("node", ["tools/rank/gen-tasks.mjs", "--n", String(N), "--seed", String(SEED), "--json"],
    { cwd: root, stdio: "pipe" });
  const suite = JSON.parse(readFileSync(tasksPath, "utf8"));

  // ── scoring: identical to eval-hosted.mjs, kept here so this stays one file ─
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
    const text = String(got ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1");
    const nums = [...text.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
    if (nums.some((n) => Math.abs(n - want) < 1e-9)) return true;
    const item = goldItem(task);
    return !!item && text.toLowerCase().includes(item);
  };

  // ── the deployed RAREXT path, in-process, from the shipped bytes ───────────
  const entangled = await import(pathToFileURL(join(root, "apps/web/public/entangled.js")).href);
  const engineSource = readFileSync(join(root, "apps/web/public/entangled-engine.js"), "utf8");
  const weightsBytes = new Uint8Array(readFileSync(join(root, "apps/web/public/rarext-entangled-chi48.gguf")));
  const loaded = await entangled.loadEntangledModel({ engineSource, weightsBytes });
  const weightsDigest = createHash("sha256").update(weightsBytes).digest("hex");

  // ── the hosted model, live ────────────────────────────────────────────────
  async function askHosted(prompt) {
    let lastError = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            max_tokens: 2048,
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
          lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`;
        } else {
          const body = await res.json();
          return { text: body.choices?.[0]?.message?.content ?? "", ms: null };
        }
      } catch (error) {
        lastError = String(error).slice(0, 160);
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    return { text: "", error: lastError };
  }

  const hostedResults = new Array(suite.tasks.length);
  const canCallHosted = !!BASE && !!KEY;
  if (canCallHosted) {
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, suite.tasks.length) }, async () => {
      while (next < suite.tasks.length) {
        const i = next;
        next += 1;
        const t0 = Date.now();
        const r = await askHosted(suite.tasks[i].prompt);
        hostedResults[i] = { ...r, ms: Date.now() - t0 };
      }
    });
    await Promise.all(workers);
  }

  // ── score every path ──────────────────────────────────────────────────────
  const rows = [];
  const tally = (key, ok) => (tallies[key][ok ? "ok" : "bad"] += 1);
  const tallies = {
    "rarext.hybrid": { ok: 0, bad: 0 },
    "rarext.neural": { ok: 0, bad: 0 },
    hosted: { ok: 0, bad: 0 },
  };
  const semantic = {
    "rarext.hybrid": { ok: 0, bad: 0 },
    "rarext.neural": { ok: 0, bad: 0 },
    hosted: { ok: 0, bad: 0 },
  };

  const t0 = Date.now();
  for (let i = 0; i < suite.tasks.length; i += 1) {
    const task = suite.tasks[i];
    const exact = entangled.answerExact(task.prompt);
    const hybrid = exact ? exact.text : entangled.answerWith(loaded.engine, loaded.model, task.prompt, 32).text;
    const neural = entangled.answerWith(loaded.engine, loaded.model, task.prompt, 32).text;
    const hosted = canCallHosted ? hostedResults[i] : null;

    const row = {
      id: task.id,
      family: task.family,
      prompt: task.prompt,
      gold: task.gold,
      rarext: { hybrid, neural, hybridSource: exact ? "exact" : "neural" },
      hosted: hosted ? { text: hosted.text, ms: hosted.ms, error: hosted.error ?? null } : null,
      exact: { hybrid: hybrid === task.gold, neural: neural === task.gold, hosted: hosted ? hosted.text === task.gold : null },
      semantic: {
        hybrid: semanticOk(hybrid, task),
        neural: semanticOk(neural, task),
        hosted: hosted ? semanticOk(hosted.text, task) : null,
      },
    };
    rows.push(row);

    tally("rarext.hybrid", row.exact.hybrid);
    tally("rarext.neural", row.exact.neural);
    if (hosted) tally("hosted", row.exact.hosted);
    // row.semantic is keyed hybrid/neural/hosted, the tallies are keyed
    // rarext.hybrid/rarext.neural/hosted — map, don't reuse the string
    semantic["rarext.hybrid"][row.semantic.hybrid ? "ok" : "bad"] += 1;
    semantic["rarext.neural"][row.semantic.neural ? "ok" : "bad"] += 1;
    if (hosted) semantic.hosted[row.semantic.hosted ? "ok" : "bad"] += 1;
  }
  const ms = Date.now() - t0;

  const summary = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    n: suite.tasks.length,
    hostedModel: canCallHosted ? MODEL : null,
    hostedBase: canCallHosted ? BASE : null,
    hostedError: hostedResults.find((r) => r?.error)?.error ?? null,
    weights: { path: "apps/web/public/rarext-entangled-chi48.gguf", digest: weightsDigest },
    rarext: {
      hybrid: { exact: tallies["rarext.hybrid"].ok, semantic: semantic["rarext.hybrid"].ok },
      neural: { exact: tallies["rarext.neural"].ok, semantic: semantic["rarext.neural"].ok },
    },
    hosted: canCallHosted
      ? { exact: tallies.hosted.ok, semantic: semantic.hosted.ok }
      : null,
    ms,
    rows,
  };

  const outPath = isAbsolute(OUT) ? OUT : resolve(root, OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");

  console.log(`head-to-head — ${suite.tasks.length} fresh tasks, seed ${SEED}`);
  console.log(`  rarext hybrid  exact ${summary.rarext.hybrid.exact}/${N} · semantic ${summary.rarext.hybrid.semantic}/${N}`);
  console.log(`  rarext neural  exact ${summary.rarext.neural.exact}/${N} · semantic ${summary.rarext.neural.semantic}/${N}`);
  if (summary.hosted) {
    console.log(`  ${MODEL.padEnd(14).trim()} exact ${summary.hosted.exact}/${N} · semantic ${summary.hosted.semantic}/${N}`);
    if (summary.hostedError) console.log(`  hosted errors: ${summary.hostedError}`);
  } else {
    console.log(`  hosted         SKIPPED — no NVIDIA_BASE_URL/NVIDIA_API_KEY (or ~/.hermes/.env)`);
  }
  console.log(`wrote ${OUT}`);
} finally {
  if (previousTasks !== null) writeFileSync(tasksPath, previousTasks);
}
