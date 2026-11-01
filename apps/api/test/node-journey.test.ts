import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { post, start, stop } from "./helpers.ts";

const JOURNEY = new URL("../../../scripts/node-journey.mjs", import.meta.url).pathname;

/** The committed seed's root: the fixture is the real deployment's root, not a typed literal. */
const seed = JSON.parse(
  readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8"),
) as { bundleRoot: string };

function runJourney(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [JOURNEY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("a node that binds, serves and earns passes all four rails", { timeout: 60_000 }, async () => {
  // The registry id is read at request time, so setting it here is how an
  // operator configures their node — the same variable the docs name.
  process.env.RAREXT_REGISTRY_ID = "rarext";
  const { server, base } = await start();
  try {
    // One publication, then the anchor: this is what gives the node a root to state.
    const publish = await post(base, "/v1/publications", {
      author: "operator-alice",
      title: "the node's first record",
      taskId: "half-adder",
      circuit: { components: [ { id: "a", type: "INPUT" }, { id: "b", type: "INPUT" }, { id: "n1", type: "NAND", inputs: ["a", "b"] }, { id: "n2", type: "NAND", inputs: ["a", "n1"] }, { id: "n3", type: "NAND", inputs: ["b", "n1"] }, { id: "xor", type: "NAND", inputs: ["n2", "n3"] }, { id: "n5", type: "NAND", inputs: ["n1", "n1"] }, { id: "sum", type: "OUTPUT", inputs: ["xor"] }, { id: "carry", type: "OUTPUT", inputs: ["n5"] } ] },
    });
    {
      const publishText = await publish.text();
      assert.equal(publish.status, 201, publishText);
    }
    const anchor = await post(base, "/v1/anchors", {});
    const anchorText = await anchor.text();
    assert.equal(anchor.status, 201, anchorText);
    const anchorBody = JSON.parse(anchorText) as { root: string };

    const run = await runJourney([base, "--registry", "rarext", "--root", anchorBody.root, "--allow-private"]);
    assert.equal(run.code, 0, `the journey refused a healthy node:\n${run.stdout}\n${run.stderr}`);
    for (const rail of ["binding", "registry", "ledger", "governance", "federation"]) {
      assert.match(run.stdout, new RegExp(`\\[PASS\\] ${rail}`), `the ${rail} rail must pass`);
    }
    assert.match(run.stdout, /FULL NODE/, "the journey says what a passing journey is");

    // The machine contract: the same journey, as a document.
    const asJson = await runJourney([base, "--registry", "rarext", "--root", anchorBody.root, "--allow-private", "--json"]);
    assert.equal(asJson.code, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout) as { ok: boolean; rails: Array<{ rail: string; ok: boolean }> };
    assert.equal(parsed.ok, true);
    assert.deepEqual(
      parsed.rails.map((rail) => rail.rail),
      ["binding", "registry", "ledger", "governance", "federation"],
      "the rails are the journey's own order, and all five are present",
    );
  } finally {
    delete process.env.RAREXT_REGISTRY_ID;
    await stop(server);
  }
});

test("a node that anchored nothing fails loudly, naming the rail that is missing", { timeout: 60_000 }, async () => {
  process.env.RAREXT_REGISTRY_ID = "rarext";
  const { server, base } = await start();
  try {
    // No publication, no anchor: the node can state no root, and the journey
    // must say WHICH rail is missing rather than a bare "invalid".
    const run = await runJourney([base, "--registry", "rarext", "--root", seed.bundleRoot, "--allow-private"]);
    assert.notEqual(run.code, 0, "an empty node must not pass");
    assert.match(run.stdout, /\[FAIL\] binding/, "the binding rail is the one that cannot hold");
    assert.match(run.stderr, /NOT A FULL NODE/, "the failure names itself");
  } finally {
    delete process.env.RAREXT_REGISTRY_ID;
    await stop(server);
  }
});

test("a wrong root is a refusal with evidence, not a shrug", { timeout: 60_000 }, async () => {
  process.env.RAREXT_REGISTRY_ID = "rarext";
  const { server, base } = await start();
  try {
    const publish = await post(base, "/v1/publications", {
      author: "operator-alice",
      title: "a real record",
      taskId: "half-adder",
      circuit: { components: [ { id: "a", type: "INPUT" }, { id: "b", type: "INPUT" }, { id: "n1", type: "NAND", inputs: ["a", "b"] }, { id: "n2", type: "NAND", inputs: ["a", "n1"] }, { id: "n3", type: "NAND", inputs: ["b", "n1"] }, { id: "xor", type: "NAND", inputs: ["n2", "n3"] }, { id: "n5", type: "NAND", inputs: ["n1", "n1"] }, { id: "sum", type: "OUTPUT", inputs: ["xor"] }, { id: "carry", type: "OUTPUT", inputs: ["n5"] } ] },
    });
    {
      const publishText = await publish.text();
      assert.equal(publish.status, 201, publishText);
    }
    const anchor = await post(base, "/v1/anchors", {});
    const anchorText = await anchor.text();
    assert.equal(anchor.status, 201, anchorText);
    const anchorBody = JSON.parse(anchorText) as { root: string };

    const wrongRoot = "1".repeat(64);
    const run = await runJourney([base, "--registry", "rarext", "--root", wrongRoot, "--allow-private"]);
    assert.notEqual(run.code, 0, "a wrong root must not pass");
    assert.match(run.stdout, /\[FAIL\] binding/, "the binding names a root the caller does not pin");
    assert.match(run.stdout, /\[FAIL\] registry/, "the served bundle rebuilds a different root");
    assert.match(
      run.stdout,
      new RegExp(anchorBody.root.slice(0, 8)),
      "the evidence names the root the node ACTUALLY serves — the operator can see what to fix",
    );
  } finally {
    delete process.env.RAREXT_REGISTRY_ID;
    await stop(server);
  }
});

test("without --root the binding rail is indeterminate, not passed", { timeout: 60_000 }, async () => {
  process.env.RAREXT_REGISTRY_ID = "rarext";
  const { server, base } = await start();
  try {
    const publish = await post(base, "/v1/publications", {
      author: "operator-alice",
      title: "a real record",
      taskId: "half-adder",
      circuit: { components: [ { id: "a", type: "INPUT" }, { id: "b", type: "INPUT" }, { id: "n1", type: "NAND", inputs: ["a", "b"] }, { id: "n2", type: "NAND", inputs: ["a", "n1"] }, { id: "n3", type: "NAND", inputs: ["b", "n1"] }, { id: "xor", type: "NAND", inputs: ["n2", "n3"] }, { id: "n5", type: "NAND", inputs: ["n1", "n1"] }, { id: "sum", type: "OUTPUT", inputs: ["xor"] }, { id: "carry", type: "OUTPUT", inputs: ["n5"] } ] },
    });
    {
      const publishText = await publish.text();
      assert.equal(publish.status, 201, publishText);
    }
    await post(base, "/v1/anchors", {});

    const run = await runJourney([base, "--allow-private"]);
    assert.notEqual(run.code, 0, "an indeterminate binding rail is not a passing journey");
    assert.match(run.stdout, /\[----\] binding/, "the rail is marked indeterminate, not failed and not passed");
    assert.match(
      run.stdout,
      /a binding cannot certify itself/,
      "the reason is the rule's own words: the caller owes the pinned root",
    );
  } finally {
    delete process.env.RAREXT_REGISTRY_ID;
    await stop(server);
  }
});
