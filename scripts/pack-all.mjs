#!/usr/bin/env node
// Packs every publishable package into ./release, in dependency order.
//
//   node scripts/pack-all.mjs
//
// The order matters for publishing: @rarext/core has to reach the registry
// before the SDK and the MCP server that depend on it.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "release");

mkdirSync(out, { recursive: true });

for (const dir of [
  "packages/core",
  "packages/agent-sdk",
  "apps/mcp",
  "apps/api",
]) {
  const output = execFileSync(
    "npm",
    ["pack", "--pack-destination", out],
    { cwd: join(root, dir), encoding: "utf8" },
  ).trim();

  console.log(output.split("\n").pop());
}
