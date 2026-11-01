import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const script = join(repoRoot, "scripts", "become-a-node.mjs");

function runScript(args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, out });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

test("become-a-node: one command from boot to a join request, every step evidenced", async () => {
  const { code, out } = await runScript(["--json", "--operator", "operator-alice"]);
  assert.equal(code, 0, `the one command did not complete: ${out.slice(0, 400)}`);
  const report = JSON.parse(out.slice(out.indexOf("{"))) as {
    ok: boolean;
    events: Array<{ step: string; verdict: string; detail: string }>;
    anchorRoot: string;
    admission: { kind: string; registry: { id: string } };
  };
  assert.equal(report.ok, true);
  const steps = report.events.map((event) => event.step);
  for (const step of ["boot", "health", "publish", "anchor", "archive", "journey", "join"]) {
    assert.ok(steps.includes(step), `the report never names the ${step} step`);
  }
  assert.match(report.admission.kind, /rarext\.registry-admission\.v1/);
  assert.match(report.admission.registry.id, /^node-[0-9a-f]{8}$/);
  assert.ok(/^[0-9a-f]{64}$/.test(report.anchorRoot), "the anchor root is a 64-hex commitment");
  // The journey step says FULL NODE — the four rails plus the federation held.
  const journeyStep = report.events.find((event) => event.step === "journey");
  assert.match(journeyStep?.detail ?? "", /FULL NODE/);
  // A temp data dir, cleaned up: the run leaves nothing behind but the evidence.
  assert.ok(!report.events.some((event) => event.verdict === "fail"), "no step failed");
});

test("become-a-node: a dead origin fails at health, naming the step", async () => {
  // A port the OS is unlikely to have given anyone: the test's own listener, closed.
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen({ port: 0, host: "127.0.0.1" }, () => resolve()));
  const bound = probe.address();
  const deadPort = typeof bound === "object" && bound !== null ? bound.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const { code, out } = await runScript(["--json", "--origin", `http://127.0.0.1:${deadPort}`]);
  assert.equal(code, 1, "a dead origin must not report success");
  const report = JSON.parse(out.slice(out.indexOf("{")));
  assert.equal(report.ok, false);
  const dead = JSON.parse(out.slice(out.indexOf("{"))) as { events: Array<{ step: string; detail: string }> };
  const healthEvent = dead.events.find((event) => event.step === "health");
  assert.ok(healthEvent, "the report names the health step even when the node is dead");
  assert.match(
    healthEvent?.detail ?? "",
    /(did not answer|HTTP)/,
    "the health failure names what happened — an answer, or the lack of one",
  );
});
