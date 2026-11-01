import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const script = join(repoRoot, "scripts", "become-a-node.mjs");

function runScript(args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
    operator: { handle: string; keyId: string };
    anchorReceipt: { action: string; bounty: number; artifactHash: string; root: string } | null;
    admission: { kind: string; registry: { id: string; operator: string } };
  };
  assert.equal(report.ok, true);
  const steps = report.events.map((event) => event.step);
  for (const step of ["boot", "health", "publish", "anchor", "archive", "identity", "receipt", "journey", "join"]) {
    assert.ok(steps.includes(step), `the report never names the ${step} step`);
  }
  // The operator's side of the roles is real from the first run: a registered identity and a
  // zero-bounty anchor receipt for the root this node just anchored.
  assert.match(report.operator.keyId, /^[0-9a-f]{64}$/, "the operator key is a real identity");
  assert.ok(report.operator.handle.length >= 1 && report.operator.handle.length <= 32);
  assert.ok(report.anchorReceipt, "the one command produced the operator's first work receipt");
  assert.equal(report.anchorReceipt?.action, "anchor");
  assert.equal(report.anchorReceipt?.bounty, 0, "ZERO is the design: the protocol never mints");
  assert.equal(report.anchorReceipt?.artifactHash, report.anchorRoot, "the receipt is FOR the anchored root");
  assert.match(report.anchorReceipt?.root ?? "", /^[0-9a-f]{64}$/);
  assert.equal(report.admission.registry.operator, report.operator.handle, "the join request rides the operator's real handle");
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

test("become-a-node --announce files the join request as a live proposal on the federation's rail", async () => {
  // The federation node whose 民主 rail decides: a real node, in-process.
  const { start, stop } = await import("./helpers.ts");
  const { server, base } = await start();
  try {
    const { code, out } = await runScript([
      "--json",
      "--operator",
      "announcing-operator",
      "--url",
      "https://announcing.example.com",
      "--announce",
      base,
    ]);
    assert.equal(code, 0, `the announcing run failed: ${out.slice(0, 400)}`);
    const report = JSON.parse(out.slice(out.indexOf("{"))) as {
      events: Array<{ step: string; verdict: string; detail: string }>;
      announcement: { target: string; proposalRoot: string; closesAt: string } | null;
    };
    const announced = report.events.find((event) => event.step === "announce");
    assert.equal(announced?.verdict, "ok", `announce did not succeed: ${announced?.detail}`);
    assert.ok(report.announcement, "the run reports where the request was filed");
    assert.match(report.announcement!.proposalRoot, /^[0-9a-f]{64}$/);

    // The proposal exists on the target AND the voter can see WHAT it would admit.
    const view = (await (await fetch(`${base}/v1/governance/proposals/${report.announcement!.proposalRoot}`)).json()) as {
      proposal: { choices: string[] };
      admission: { registry: { url: string; operator: string } } | null;
      budget: unknown | null;
    };
    assert.deepEqual(view.proposal.choices, ["admit", "reject"]);
    assert.ok(view.admission, "the attached admission is visible — a voter decides on what they can read");
    assert.equal(view.admission?.registry.url, "https://announcing.example.com");
    // The handle is the operator's own name when free, salted with the key when the node already
    // holds that name — the script asks and salts rather than failing, so assert the identity the
    // run actually reported, not the name it was asked for.
    const reported = JSON.parse(out.slice(out.indexOf("{"))) as { operator: { handle: string } };
    assert.ok(reported.operator.handle.startsWith("announcing-operator"), reported.operator.handle);
    assert.equal(view.admission?.registry.operator, reported.operator.handle);
    assert.equal(view.budget, null, "no money is attached to a join request");
  } finally {
    await stop(server);
  }
});
