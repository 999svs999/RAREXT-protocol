#!/usr/bin/env node
// Writes one version into every workspace package so the published packages can
// never drift from each other.
//
//   node scripts/sync-version.mjs            # show the current version
//   node scripts/sync-version.mjs 0.2.0      # set it everywhere
//   node scripts/sync-version.mjs --check    # fail if they differ

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const workspaces = ["packages", "apps"];

function packageFiles() {
  const files = [];

  for (const group of workspaces) {
    const dir = join(root, group);
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      try {
        const meta = JSON.parse(
          readFileSync(join(dir, entry, "package.json"), "utf8"),
        );
        if (meta.name) files.push({ path: join(dir, entry, "package.json"), meta });
      } catch {
        continue;
      }
    }
  }

  return files;
}

const packages = packageFiles();
const versions = new Set(packages.map((entry) => entry.meta.version));

if (versions.size > 1) {
  console.error(`versions differ: ${[...versions].join(", ")}`);
  process.exit(1);
}

const current = [...versions][0];
const requested = process.argv[2];

if (!requested) {
  console.log(current);
  process.exit(0);
}

if (requested === "--check") {
  console.log(current);
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(requested)) {
  console.error(`not a valid version: ${requested}`);
  process.exit(1);
}

for (const entry of packages) {
  const meta = JSON.parse(readFileSync(entry.path, "utf8"));
  if (meta.version === requested) continue;

  meta.version = requested;
  const body = `${JSON.stringify(meta, null, 2)}\n`;
  writeFileSync(entry.path, body);
  console.log(`${meta.name} -> ${requested}`);
}

const rootMeta = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
rootMeta.version = requested;
writeFileSync(
  join(root, "package.json"),
  `${JSON.stringify(rootMeta, null, 2)}\n`,
);
console.log(`(root) -> ${requested}`);
