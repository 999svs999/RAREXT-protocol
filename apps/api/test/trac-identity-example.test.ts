import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const example = fileURLToPath(new URL("../../../examples/trac-identity/main.ts", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

test("a RAREXT handle links to a RESET Trac identity", { timeout: 60_000 }, async () => {
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

  assert.equal(code, 0, `Trac identity example failed:\n${stderr}\n${stdout}`);
  assert.match(stdout, /^handle: trac-demo \(key [0-9a-f]{12}…\)$/m);
  assert.match(stdout, /^trac1 address: trac1[0-9a-z]+$/m);
  assert.match(stdout, /^externalId: [0-9a-f]{64}$/m);
  assert.match(stdout, /^verified: true$/m);
  assert.match(stdout, /^links: 1$/m);
  assert.match(stdout, /OK: a RAREXT handle linked to a RESET Trac identity\./);
});
