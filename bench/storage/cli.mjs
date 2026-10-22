#!/usr/bin/env node
// npm run bench:storage -- [options]
//
//   --corpus <dir>       measure an existing corpus instead of generating one
//   --scale <n>          scale the generated corpus (default 1 ≈ 100 MB)
//   --out <path>         Markdown output (default bench/storage/RESULTS.md)
//   --only <ids>         comma-separated runner ids
//   --max-minutes <n>    budget check (default 15)
//   --keep               keep the temporary work directory
//   --update-lock        rewrite corpus.lock.json for the generated corpus
//   --allow-over-budget  exit 0 even when the budget is exceeded

import { resolve } from "node:path";

import { allRunners } from "./methods.mjs";
import { ensureCorpus } from "./corpus.mjs";
import { runBenchmark, writeResults } from "./run.mjs";

function parse(argv) {
  const options = {
    out: "bench/storage/RESULTS.md",
    scale: 1,
    maxMinutes: 15,
    keep: false,
    updateLock: false,
    allowOverBudget: false,
    only: null,
    corpus: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--keep") {
      options.keep = true;
      continue;
    }

    if (arg === "--update-lock") {
      options.updateLock = true;
      continue;
    }

    if (arg === "--allow-over-budget") {
      options.allowOverBudget = true;
      continue;
    }

    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);

    const [name, inline] = arg.slice(2).split("=");
    const value = inline ?? argv[++index];

    if (value === undefined) throw new Error(`--${name} needs a value`);

    if (name === "out") options.out = value;
    else if (name === "scale") options.scale = Number(value);
    else if (name === "max-minutes") options.maxMinutes = Number(value);
    else if (name === "only") options.only = value.split(",").filter(Boolean);
    else if (name === "corpus") options.corpus = resolve(value);
    else throw new Error(`unknown option --${name}`);
  }

  if (!Number.isFinite(options.scale) || options.scale <= 0) throw new Error("--scale must be positive");
  if (!Number.isFinite(options.maxMinutes) || options.maxMinutes <= 0) throw new Error("--max-minutes must be positive");

  return options;
}

const options = parse(process.argv.slice(2));
const { root, manifest } = ensureCorpus({
  scale: options.scale,
  updateLock: options.updateLock,
  external: options.corpus,
});
const runners = options.only
  ? allRunners().filter((runner) => options.only.includes(runner.id))
  : allRunners();

if (runners.length === 0) throw new Error("no runners selected");

const { report, markdown } = await runBenchmark({
  root,
  manifest,
  runners,
  keep: options.keep,
  maxMinutes: options.maxMinutes,
});
const written = writeResults({ report, markdown }, options.out);

console.log(markdown);
console.log(`wrote ${written.markdownPath} and ${written.jsonPath}`);

if (!report.budget.passed && !options.allowOverBudget) {
  console.error(
    `benchmark exceeded the ${options.maxMinutes}-minute budget (${(report.budget.elapsedMs / 1000).toFixed(1)} s)`,
  );
  process.exitCode = 1;
}
