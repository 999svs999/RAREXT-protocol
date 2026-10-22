#!/usr/bin/env node
// Builds the publishable packages.
//
//   node scripts/build-packages.mjs
//
// Each package becomes two artifacts in its own dist directory:
//   dist/index.js    an ESM bundle, produced by esbuild
//   dist/index.d.ts  type declarations, produced by tsc and then rewritten so the
//                    relative specifiers point at the emitted files
//
// The published packages must not ship raw TypeScript: Node does not strip types
// inside node_modules, so a consumer would get syntax errors instead of a library.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const typesRoot = join(root, ".types");

const packages = [
  {
    name: "@rarext/core",
    dir: "packages/core",
    entry: "packages/core/src/index.ts",
    types: "packages/core/src/index.d.ts",
    bin: null,
  },
  {
    name: "@rarext/agent-sdk",
    dir: "packages/agent-sdk",
    entry: "packages/agent-sdk/src/index.ts",
    types: "packages/agent-sdk/src/index.d.ts",
    bin: null,
  },
  {
    name: "@rarext/mcp",
    dir: "apps/mcp",
    entry: "apps/mcp/src/server.ts",
    types: "apps/mcp/src/server.d.ts",
    bin: { "rarext-mcp": "dist/index.js" },
  },
  {
    name: "@rarext/api",
    dir: "apps/api",
    entry: "apps/api/src/server.ts",
    types: "apps/api/src/server.d.ts",
    bin: { "rarext-api": "dist/index.js" },
  },
];

rmSync(typesRoot, { recursive: true, force: true });

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

for (const pkg of packages) {
  const dist = join(root, pkg.dir, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const banner = pkg.bin ? "#!/usr/bin/env node\n" : "";

  await build({
    entryPoints: [join(root, pkg.entry)],
    outfile: join(dist, "index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    banner: banner ? { js: banner } : undefined,
    external: ["@rarext/core", "@rarext/agent-sdk", "node:*"],
    logLevel: "warning",
  });

  // The declarations are emitted once for the whole workspace, laid out like the
  // repository. Each package takes its own subtree and flattens it next to the
  // bundle so the relative specifiers still resolve.
  const emitted = join(typesRoot, dirname(pkg.types));
  const source = join(typesRoot, pkg.types);

  if (!existsSync(source)) {
    throw new Error(`no declarations produced for ${pkg.types}`);
  }

  cpSync(emitted, dist, { recursive: true });

  const declaration = readFileSync(source, "utf8").replace(
    /(from\s+["'])(\.[^"']+)\.ts(["'])/g,
    "$1$2.js$3",
  );

  const emittedName = pkg.types.split("/").pop();
  writeFileSync(join(dist, "index.d.ts"), declaration);

  if (emittedName !== "index.d.ts") {
    rmSync(join(dist, emittedName), { force: true });
  }

  console.log(`built ${pkg.name}`);
}

rmSync(typesRoot, { recursive: true, force: true });
