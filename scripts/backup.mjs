#!/usr/bin/env node
// Back up, verify, or restore a registry data directory.
//
//   npm run backup:create -- --data .data --out backups/registry.json.gz
//   npm run backup:verify -- --file backups/registry.json.gz
//   npm run backup:restore -- --file backups/registry.json.gz --data .data
//
// A backup is a gzipped JSON bundle of every regular file under --data, with a
// SHA-256 per file and one over the manifest. The store, placements, and verifier
// operator registrations are all files under that directory; backing up one and not
// the others restores a registry that cannot prove where its bytes live.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  createBackup,
  readBackup,
  restoreBackup,
  verifyBackup,
  writeBackup,
} from "../apps/api/src/backup.ts";

function parse(argv) {
  const command = argv[0];
  const options = {};

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);

    if (arg === "--force") {
      options.force = "true";
      continue;
    }

    const [name, inline] = arg.slice(2).split("=");
    const value = inline ?? argv[index + 1];

    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new Error(`--${name} needs a value`);
    }

    if (inline === undefined) index += 1;

    options[name] = value;
  }

  return { command, options };
}

function usage() {
  console.error(`usage:
  backup.mjs create  --data <dir> [--out <file.json.gz>] [--label <text>] [--exclude <path>]
  backup.mjs verify  --file <file.json.gz>
  backup.mjs restore --file <file.json.gz> --data <dir> [--force]`);
}

function main() {
  const { command, options } = parse(process.argv.slice(2));

  if (command === "create") {
    const data = options.data ?? ".data";
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const out = options.out ?? join("backups", `rarext-${stamp}.json.gz`);
    const bundle = createBackup(data, {
      label: options.label,
      exclude: options.exclude ? [options.exclude] : [],
    });

    writeBackup(bundle, out);

    console.log(
      `backed up ${bundle.files.length} file(s), ${sum(bundle)} bytes, from ${data} to ${out}`,
    );
    console.log(`manifest digest ${bundle.digest}`);
    return;
  }

  if (command === "verify") {
    if (!options.file) throw new Error("--file is required");

    const checked = verifyBackup(readBackup(options.file));

    if (!checked.valid) {
      console.error(`invalid: ${checked.errors.join("; ")}`);
      process.exitCode = 1;
      return;
    }

    console.log(`valid: ${checked.files} file(s), ${checked.bytes} bytes`);
    return;
  }

  if (command === "restore") {
    if (!options.file || !options.data) throw new Error("--file and --data are required");

    if (!existsSync(options.file)) throw new Error(`backup not found: ${options.file}`);

    const result = restoreBackup(readBackup(options.file), options.data, {
      force: options.force === "true",
    });

    console.log(`restored ${result.restored} file(s), ${result.bytes} bytes to ${options.data}`);
    return;
  }

  usage();
  process.exitCode = 1;
}

function sum(bundle) {
  return bundle.files.reduce((total, file) => total + file.size, 0);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
