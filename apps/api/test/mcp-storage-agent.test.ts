import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const example = fileURLToPath(new URL("../../../examples/mcp-storage/main.ts", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

test("an external MCP client drives put, get, challenge, audit, and pin", { timeout: 120_000 }, async () => {
  const child = spawn(process.execPath, [example], {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(code, 0, `MCP storage example failed:\n${stderr}\n${stdout}`);
  assert.match(stdout, /payload: \d+ bytes, code 4\+2, 6 token-protected holders/);
  assert.match(stdout, /^put: [0-9a-f]{64}$/m);
  assert.match(stdout, /^get: 4 shards read, 0 errors, bytes match$/m);
  assert.match(stdout, /^challenge: 6\/6 live, 6 required$/m);
  assert.match(stdout, /^audit: ok \(challenged=true\)$/m);
  assert.match(stdout, /^pin: pin:[A-Za-z0-9]+$/m);
  assert.match(stdout, /OK: an MCP client stored, read, challenged, audited, and pinned content\./);
});
