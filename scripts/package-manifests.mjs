#!/usr/bin/env node
// Writes the publishable metadata into every package manifest.
//
//   node scripts/package-manifests.mjs
//
// One place, so the four packages cannot drift: the same fields, the same
// repository, the same engines, the same keywords, and dependency ranges pinned
// to the exact workspace version so a published package pulls the version it was
// built against.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const rootMeta = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = rootMeta.version;

const shared = {
  license: "Apache-2.0",
  type: "module",
  engines: { node: ">=22.18" },
  publishConfig: { access: "public" },
  repository: {
    type: "git",
    url: "git+https://github.com/999svs999/RAREXT-protocol.git",
    directory: ".",
  },
  bugs: { url: "https://github.com/999svs999/RAREXT-protocol/issues" },
  homepage: "https://github.com/999svs999/RAREXT-protocol#readme",
};

const manifests = [
  {
    path: "packages/core/package.json",
    fields: {
      name: "@rarext/core",
      version,
      description:
        "Artifact, challenge, claim, and semantics types with a deterministic NAND/LATCH simulator and scorer.",
      keywords: ["artifacts", "attestations", "provenance", "verifier", "protocol"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      files: ["dist", "README.md"],
      sideEffects: false,
      scripts: {
        build: "node ../../scripts/build-packages.mjs",
        test: "node --test test/*.test.ts",
      },
    },
  },
  {
    path: "packages/agent-sdk/package.json",
    fields: {
      name: "@rarext/agent-sdk",
      version,
      description:
        "Typed client for agents: signed publications, artifact publishing, app and semantics discovery, lineage, and leaderboards.",
      keywords: ["agents", "sdk", "attestations", "provenance", "signing"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      files: ["dist", "README.md"],
      sideEffects: false,
      dependencies: { "@rarext/core": version },
      scripts: {
        build: "node ../../scripts/build-packages.mjs",
        test: "node --test test/*.test.ts",
      },
    },
  },
  {
    path: "apps/mcp/package.json",
    fields: {
      name: "@rarext/mcp",
      version,
      description:
        "Model Context Protocol server exposing the RAREXT registry to agent frameworks.",
      keywords: ["mcp", "agents", "model-context-protocol", "registry"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      bin: { "rarext-mcp": "dist/index.js" },
      files: ["dist", "README.md"],
      sideEffects: false,
      dependencies: { "@rarext/agent-sdk": version },
      scripts: {
        build: "node ../../scripts/build-packages.mjs",
        dev: "node src/server.ts",
      },
    },
  },
  {
    path: "apps/api/package.json",
    fields: {
      name: "@rarext/api",
      version,
      description:
        "The RAREXT registry: artifact protocol, signed identities, feed, lineage, Merkle anchoring, and storage.",
      keywords: ["registry", "api", "attestations", "anchoring", "storage"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      bin: { "rarext-api": "dist/index.js" },
      files: ["dist", "README.md"],
      sideEffects: false,
      dependencies: { "@rarext/core": version },
      scripts: {
        build: "node ../../scripts/build-packages.mjs",
        dev: "node src/server.ts",
        start: "node src/server.ts",
      },
    },
  },
];

for (const manifest of manifests) {
  const path = join(root, manifest.path);
  const current = JSON.parse(readFileSync(path, "utf8"));

  const next = {
    ...current,
    ...shared,
    ...manifest.fields,
  };

  delete next.private;

  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${manifest.fields.name} ${version}`);
}
