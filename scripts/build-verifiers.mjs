#!/usr/bin/env node
// Builds the portable verifier modules.
//
//   node scripts/build-verifiers.mjs
//
// A portable verifier is a self-contained ES module with a declared hash. The
// hash is the contract: the registry serves the module by hash, the browser
// imports the same bytes, and an attestation names the module hash. One
// implementation, one hash, one verdict — on the server and in a phone.
//
// The manifest is written with the hash of the built bytes, so it can never
// drift from what is served.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const verifiersDir = join(root, "apps/verifiers");

if (!existsSync(verifiersDir)) {
  console.log("no portable verifiers yet");
  process.exit(0);
}

for (const id of readdirSync(verifiersDir)) {
  const dir = join(verifiersDir, id);
  const entry = join(dir, `${id}.ts`);
  const manifestPath = join(dir, "manifest.json");

  if (!existsSync(entry) || !existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const outfile = join(dir, "dist", `${id}.mjs`);

  mkdirSync(join(dir, "dist"), { recursive: true });

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    logLevel: "warning",
  });

  const bytes = readFileSync(outfile);
  const hash = createHash("sha256").update(bytes).digest("hex");

  const next = {
    ...manifest,
    hash,
    bytes: bytes.length,
  };

  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);

  console.log(`built ${manifest.id ?? id} ${hash.slice(0, 12)} (${bytes.length} bytes)`);
}
