#!/usr/bin/env node
// Verifies the published packages the way a consumer would get them.
//
//   node scripts/verify-packages.mjs
//
// Packs every package with npm pack, installs the tarballs into a throwaway
// project with no workspace access, and then actually uses them: scores a
// circuit, signs a publication, starts the API, and lists the MCP tools.
//
// A package that only works inside the monorepo is not published.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "rarext-verify-"));
const tarballs = [];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...options,
  });
}

try {
  console.log("packing");
  for (const dir of [
    "packages/core",
    "packages/agent-sdk",
    "apps/mcp",
    "apps/api",
  ]) {
    run("npm", ["pack", "--pack-destination", work], { cwd: join(root, dir) });
  }

  for (const name of readdirSync(work)) {
    if (name.endsWith(".tgz")) tarballs.push(join(work, name));
  }

  console.log(`packed ${tarballs.length} tarballs`);

  const project = join(work, "consumer");
  run("npm", ["init", "-y"], { cwd: work, stdio: "pipe" });
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify(
      { name: "rarext-consumer", private: true, version: "0.0.0", type: "module" },
      null,
      2,
    ),
  );
  run("npm", ["install", ...tarballs], { cwd: work, stdio: "pipe" });

  const check = `
import assert from "node:assert/strict";
import { score, canonicalize, tasks } from "@rarext/core";
import { AgentSigner, createAgentKeyfile, RarextClient } from "@rarext/agent-sdk";

const task = tasks[0];
assert.ok(task, "a task ships");
const circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "b"] },
    { id: "sum", type: "OUTPUT", inputs: ["n1"] },
    { id: "carry", type: "OUTPUT", inputs: ["n2"] },
  ],
};
const result = score(circuit, task);
assert.equal(typeof result.score, "number");
assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');

const keyfile = createAgentKeyfile("consumer");
const signer = new AgentSigner(keyfile.privateKey);
const payload = signer.artifactPayload({
  author: keyfile.handle,
  title: "Consumer build",
  challengeId: task.id,
  artifact: { app: "logic", kind: "logic.netlist", version: 1, mediaType: "application/json", body: circuit },
});
assert.equal(payload.kind, "rarext.publication");
assert.ok(signer.sign(payload).length > 0);
assert.ok(typeof RarextClient === "function");

console.log("core + sdk: ok");
`;

  writeFileSync(join(work, "check.mjs"), check);
  run("node", ["check.mjs"], { cwd: work });

  // The API and the MCP server have to start from the published artifacts.
  const api = join(work, "api-check.mjs");
  writeFileSync(
    api,
    `
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";

const child = spawn(process.execPath, ["node_modules/@rarext/api/dist/index.js"], {
  env: { ...process.env, PORT: "0", RAREXT_DATA: "none" },
  stdio: ["ignore", "pipe", "pipe"],
});

const line = await new Promise((resolve, reject) => {
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (text.includes("listening")) resolve(text);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code) => reject(new Error("api exited " + code)));
  setTimeout(() => reject(new Error("api did not start")), 10000);
});

assert.match(line, /listening/);
child.kill();
console.log("api: ok");
`,
  );
  run("node", [api], { cwd: work });

  const mcp = join(work, "mcp-check.mjs");
  writeFileSync(
    mcp,
    `
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const child = spawn(process.execPath, ["node_modules/@rarext/mcp/dist/index.js"], {
  env: { ...process.env, RAREXT_API: "http://127.0.0.1:1" },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\\n");

const message = await new Promise((resolve, reject) => {
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (const line of buffer.split("\\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === 1) resolve(parsed);
      } catch {}
    }
  });
  setTimeout(() => reject(new Error("no tools/list response")), 10000);
});

const names = message.result.tools.map((tool) => tool.name);
assert.ok(names.length >= 20, "expected the tool list");
assert.ok(names.includes("rarext_agent_publish_artifact"), "expected the artifact publish tool");
child.kill();
console.log("mcp: ok (" + names.length + " tools)");
`,
  );
  run("node", [mcp], { cwd: work });

  console.log("\npackages verified");
} finally {
  rmSync(work, { recursive: true, force: true });
}
