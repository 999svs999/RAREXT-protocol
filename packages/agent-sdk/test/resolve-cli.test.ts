import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const committed = readFileSync(new URL("../../../site/registry/bundle.json", import.meta.url), "utf8");
const seed = JSON.parse(readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8")) as {
  bundleRoot: string;
};
const ROOT = seed.bundleRoot;
const CLI = new URL("../../../scripts/resolve.mjs", import.meta.url).pathname;

async function serve(bytes: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/bundle.json`,
    host: `127.0.0.1:${port}`,
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

test("the resolve CLI verifies a reference, and its exit code is the verdict", async () => {
  const origin = await serve(committed);
  try {
    const ok = await runCli([`rarext:${origin.host}/bundle.json@${ROOT}`, "--scheme", "http"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /reference rarext:127\.0\.0\.1:\d+\/bundle\.json@/);
    assert.match(ok.stdout, /VERIFIED: /);
    assert.match(ok.stdout, new RegExp(ROOT));

    const json = await runCli([`rarext:${origin.host}/bundle.json@${ROOT}`, "--scheme", "http", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as { resolved: { root: string; source: string }; error: null; attempts: unknown[] };
    assert.equal(parsed.resolved.root, ROOT);
    assert.equal(parsed.resolved.source, origin.url);
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.attempts, [], "a copy that verified on the first try accumulated no refusals");
  } finally {
    await origin.close();
  }
});

test("a wrong root is refused with BOTH roots named, and a bare root with no candidates says why", async () => {
  const origin = await serve(committed);
  try {
    const wrong = await runCli([
      `rarext:${origin.host}/bundle.json@${"c".repeat(64)}`,
      "--scheme",
      "http",
      "--json",
    ]);
    assert.equal(wrong.code, 1);
    const parsed = JSON.parse(wrong.stdout) as { resolved: null; error: string; attempts: Array<{ url: string; reason: string }> };
    assert.equal(parsed.resolved, null);
    assert.match(parsed.error, /no candidate rebuilt the pinned root/);
    assert.equal(parsed.attempts.length, 1);
    // The evidence says what was rebuilt and what was pinned, so a reader can see the difference.
    assert.match(parsed.attempts[0]!.reason, new RegExp(ROOT));
    assert.match(parsed.attempts[0]!.reason, /c{16}/);
  } finally {
    await origin.close();
  }

  const bare = await runCli([`rarext:${ROOT}`]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /says what to look for, not where/);
});

test("the CLI refuses what is not a reference, and a usage it cannot honour", async () => {
  const notOne = await runCli(["https://example.com/registry/bundle.json"]);
  assert.equal(notOne.code, 1);
  assert.match(notOne.stderr, /NOT A RAREXT REFERENCE/);

  const usage = await runCli([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /usage: node scripts\/resolve\.mjs/);

  const badScheme = await runCli([`rarext:${ROOT}`, "--scheme", "rarext"]);
  assert.equal(badScheme.code, 2);
  assert.match(badScheme.stderr, /a reference resolves over http or https/);
});
