#!/usr/bin/env node
/**
 * verify.mjs — the scorecard's own gate.
 *
 * The ops runner executes this after the runtime suite and the claim gate. It
 * refuses to let the published rank claims drift from the evidence:
 *
 *   - the population is exactly the 100 registry systems
 *   - the scorecard has 12 axes and at least 8 wins
 *   - the published rank.json agrees with bench/top100-scorecard.json
 *   - the held-out hybrid number is 100% and the neural-alone number is < 60%
 *     (if the neural number ever rises to 100% the tool's contribution shrank
 *     and this gate should be re-read, not silently passed)
 *   - the digests in rank.json are the digests of the committed artifacts
 *   - rank.html exists and loads rank.json
 *
 *   node tools/rank/verify.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const check = (ok, label, detail = "") => {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  return ok ? 0 : 1;
};

let failures = 0;
const registry = readFileSync(join(root, "tools/rank/registry.tsv"), "utf8").trim().split("\n");
const card = readJson("bench/top100-scorecard.json");
const rank = readJson("apps/web/public/rank.json");
const neural = readJson("tools/rank/neural-heldout.json");
const hybrid = readJson("tools/rank/hybrid-heldout.json");

failures += check(registry.length === 100, "population is 100 registry systems", `${registry.length}`);
failures += check(card.axes.length === 12, "scorecard has 12 axes", `${card.axes.length}`);
failures += check(card.totals.wins >= 8, "at least 8 axes won", `${card.totals.wins}`);
failures += check(card.totals.losses >= 1, "the losses are stated, not hidden", `${card.totals.losses} loss row(s)`);
failures += check(hybrid.passed === hybrid.n && hybrid.n >= 1000, "hybrid is exact on >=1000 held-out tasks", `${hybrid.passed}/${hybrid.n}`);
failures += check(neural.passed / neural.n < 0.6, "neural-alone stays reported below 60%", `${neural.passed}/${neural.n}`);
failures += check(rank.totals.wins === card.totals.wins && rank.population.n === card.population.n,
  "published rank.json agrees with the scorecard");

const weights = readFileSync(join(root, "apps/web/public/rarext-entangled-chi48.gguf"));
const engine = readFileSync(join(root, "apps/web/public/entangled-engine.js"));
failures += check(rank.runtime.digests.weights === sha256(weights), "rank.json weights digest matches the committed bytes");
failures += check(rank.runtime.digests.engine === sha256(engine), "rank.json engine digest matches the committed bytes");

const pagePath = join(root, "apps/web/public/rank.html");
failures += check(existsSync(pagePath), "rank.html is published");
if (existsSync(pagePath)) {
  const page = readFileSync(pagePath, "utf8");
  failures += check(page.includes("rank.json"), "rank.html loads the receipt it claims to render");
}

console.log(failures === 0 ? "\nrank gate PASS" : `\nrank gate FAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
