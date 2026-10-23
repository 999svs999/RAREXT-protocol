#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildGameStateMigrationBundle,
  buildGameStateMigrationPlan,
} from "../apps/api/src/game-state-migration.ts";

function parse(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = "true";
      continue;
    }

    if (arg === "--execute" || arg === "--cutover") {
      options.execute = "true";
      continue;
    }

    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);

    const [name, inline] = arg.slice(2).split("=");
    const value = inline ?? argv[index + 1];

    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new Error(`--${name} needs a value`);
    }

    if (inline === undefined) index += 1;

    options[name] = value;
  }

  return options;
}

function usage() {
  console.error(`usage:
  plan-game-state-migration.mjs --source <rarext.json> [--challenges <file>]
    [--out <plan.json>] [--bundle <bundle.json>] [--now <ISO timestamp>]

The plan is always status "deferred" and mode "no-op". It never writes to the
source snapshot. --bundle additionally writes the exact migrated snapshot and
challenge records for a future target; it is a preservation artifact, not a
cutover.`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const options = parse(process.argv.slice(2));

  if (options.help) {
    usage();
    return;
  }

  if (options.execute) {
    throw new Error(
      "cutover execution is not implemented: RFC 0016 defers the appchain and RFC 0017 defines this as a no-op preservation plan",
    );
  }

  if (!options.source) throw new Error("--source is required");

  const source = resolve(options.source);
  const output = options.out ? resolve(options.out) : null;
  const bundleOutput = options.bundle ? resolve(options.bundle) : null;

  if (output === source || bundleOutput === source) {
    throw new Error("refusing to overwrite the source snapshot");
  }

  if (output && bundleOutput && output === bundleOutput) {
    throw new Error("--out and --bundle must be different files");
  }

  const snapshot = readJson(source);
  const challenges = options.challenges ? readJson(resolve(options.challenges)) : undefined;
  const migrationOptions = {
    source,
    generatedAt: options.now,
    challenges,
    challengeSource: options.challenges ? resolve(options.challenges) : null,
  };
  const plan = buildGameStateMigrationPlan(snapshot, migrationOptions);

  if (output) writeJson(output, plan);
  else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  if (bundleOutput) {
    const bundle = buildGameStateMigrationBundle(snapshot, migrationOptions);
    writeJson(bundleOutput, bundle);
  }

  if (output || bundleOutput) {
    console.error(
      `status ${plan.status}; ${plan.collections.reduce((total, item) => total + item.count, 0)} durable record(s); source unchanged`,
    );
    if (output) console.error(`plan ${output}`);
    if (bundleOutput) console.error(`bundle ${bundleOutput}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
