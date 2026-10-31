import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { RAREXT_SITE_BINDING_PATH } from "../../core/src/index.ts";

const committedSeed = JSON.parse(readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8")) as {
  bundleRoot: string;
};
const ROOT = committedSeed.bundleRoot;
const CLI = new URL("../../../scripts/site-binding.mjs", import.meta.url).pathname;

async function site(body: string | null) {
  const server = createServer((request, response) => {
    if (body !== null && request.url === RAREXT_SITE_BINDING_PATH) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: new URL("../../..", import.meta.url).pathname });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("one command joins a site: the CLI reports the verdict against the registry's pinned root", async () => {
  const server = await site(JSON.stringify({ registry: "rarext", root: ROOT }));
  try {
    const ok = await runCli([server.origin, "--registry", "rarext", "--root", ROOT, "--allow-private", "--json"]);
    assert.equal(ok.code, 0, ok.stderr);
    const outcome = JSON.parse(ok.stdout) as { verdict: { ok: boolean; root: string } | null; file: string; verdictError: string | null };
    assert.equal(outcome.file, "served");
    assert.equal(outcome.verdictError, null);
    assert.equal(outcome.verdict?.ok, true);
    assert.equal(outcome.verdict?.root, ROOT);

    const wrong = await runCli([server.origin, "--root", "b".repeat(64), "--allow-private", "--json"]);
    assert.equal(wrong.code, 1);
    const failed = JSON.parse(wrong.stdout) as { verdictError: string | null };
    assert.match(String(failed.verdictError), /root-mismatch/);
  } finally {
    await server.close();
  }
});

test("with no pinned root the CLI refuses to invent a verdict, and says why", async () => {
  const server = await site(JSON.stringify({ registry: "rarext", root: ROOT }));
  try {
    const readOnly = await runCli([server.origin, "--allow-private"]);
    assert.equal(readOnly.code, 0);
    assert.match(readOnly.stdout, /statement: registry rarext/);
    assert.match(readOnly.stdout, /no --root given, so there is no verdict/);
    assert.doesNotMatch(readOnly.stdout, /JOINED/);
  } finally {
    await server.close();
  }
});

test("a site that published nothing fails loudly rather than quietly", async () => {
  const server = await site(null);
  try {
    const nothing = await runCli([server.origin, "--root", ROOT, "--allow-private"]);
    assert.equal(nothing.code, 1);
    assert.match(nothing.stderr, /NOT A RAREXT BINDING/);
    assert.match(nothing.stdout, /404/);
  } finally {
    await server.close();
  }
});
