#!/usr/bin/env node
/**
 * become-a-node: the ONE command from "I have a server" to "I am a full node with a join
 * request in hand".
 *
 * The pieces have existed separately since the journey iteration — boot, publish, anchor,
 * journey-verify — and the admission document has existed since the 民主 rail grew the
 * federation. But an operator following the docs runs five commands across three files and
 * two processes, and every place a human assembles steps by hand is a place a step gets
 * skipped silently. This script composes the WHOLE path and prints every step's evidence:
 *
 *   [boot]      the node answers /health (or an --origin already running)
 *   [publish]   a publication lands (a seeded challenge's half-adder, composed of NANDs)
 *   [anchor]    the anchor root — the node's first Merkle commitment
 *   [archive]   the state archive frozen at that anchor — the ledger's history begins
 *   [journey]   the four-rail full-node check (binding, registry, ledger, governance)
 *   [join]      the admission document, ready to attach to a proposal on a registry
 *               that is ALREADY in the federation — the 民主 rail does the rest
 *
 * The script never files the join request itself: an admission is a proposal's attachment,
 * and a proposal is a decision the community makes — an operator ASKS to join, the tally
 * APPLIES the join. Exit 0 only when every step held; a failed step names itself and stops.
 *
 * Usage:
 *   node scripts/become-a-node.mjs                    # boots its own node on a free port
 *   node scripts/become-a-node.mjs --origin <url>     # verifies an ALREADY-running node
 *   both: [--registry <id>] [--operator <name>] [--url <public-url>] [--json]
 *
 * --registry names the federation registry whose seed this node wants to JOIN (default
 * "rarext"). --url is the node's PUBLIC origin (what the admission proposes; defaults to
 * the local origin, right for a demo, wrong for a real deployment — the script says so).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(scriptRoot, "apps", "api", "src", "server.ts");

const argv = process.argv.slice(2);
let origin = "";
let registryId = "rarext";
let operator = "";
let publicUrl = "";
let asJson = false;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--origin") origin = (argv[++index] ?? "").trim();
  else if (arg === "--registry") registryId = (argv[++index] ?? "").trim();
  else if (arg === "--operator") operator = (argv[++index] ?? "").trim();
  else if (arg === "--url") publicUrl = (argv[++index] ?? "").trim();
  else if (arg === "--json") asJson = true;
  else if (arg === "--help" || arg === "-h") {
    console.log("usage: node scripts/become-a-node.mjs [--origin <url>] [--registry <id>] [--operator <name>] [--url <public-url>] [--json]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const GENESIS = "0".repeat(64);

const events = [];
const emit = (step, verdict, detail) => {
  events.push({ step, verdict, detail });
  if (!asJson) {
    const mark = verdict === "ok" ? "ok" : verdict === "fail" ? "FAIL" : "…";
    console.log(`[${mark}] ${step}: ${detail}`);
  }
};

async function fetchJson(url, init) {
  const response = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(10_000), ...init });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

/** The half-adder in NANDs: the seeded challenge the node can verify and anchor. */
const halfAdder = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "n1"] },
    { id: "n3", type: "NAND", inputs: ["b", "n1"] },
    { id: "xor", type: "NAND", inputs: ["n2", "n3"] },
    { id: "n5", type: "NAND", inputs: ["n1", "n1"] },
    { id: "sum", type: "OUTPUT", inputs: ["xor"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

let child = null;
let dataDir = null;

function stopChild() {
  if (child) {
    child.kill("SIGTERM");
    child = null;
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* the evidence is printed; a temp dir that will not die is not a failed journey */
    }
    dataDir = null;
  }
}

process.on("exit", stopChild);
process.on("SIGINT", () => {
  stopChild();
  process.exit(130);
});

async function bootOwnNode() {
  dataDir = mkdtempSync(join(tmpdir(), "rarext-become-"));
  // PORT=0 asks the OS for a free port; the server's ready line names the one it got.
  child = spawn(process.execPath, ["--experimental-strip-types", serverEntry], {
    env: { ...process.env, PORT: "0", RAREXT_DATA_DIR: dataDir, RAREXT_REGISTRY_ID: registryId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the node did not report its port within 15s")), 15_000);
    child.stdout.on("data", (chunk) => {
      const match = /listening on (http:\/\/\S+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => reject(new Error(`the node exited during boot (code ${code})`)));
    child.on("error", reject);
  });
  return ready;
}

async function run() {
  if (!origin) {
    origin = await bootOwnNode();
    emit("boot", "ok", `a fresh node at ${origin} (temp data dir, registry ${registryId})`);
  } else {
    emit("boot", "ok", `an already-running node at ${origin}`);
  }

  let health;
  try {
    health = await fetchJson(`${origin}/health`);
  } catch (healthError) {
    const cause = healthError instanceof Error && healthError.cause ? String(healthError.cause.code ?? healthError.cause) : "unreachable";
    emit("health", "fail", `the node did not answer at /health (${cause})`);
    return finish(1);
  }
  if (health.status !== 200) {
    emit("health", "fail", `the node answered HTTP ${health.status} at /health`);
    return finish(1);
  }
  emit("health", "ok", `registry ${health.body?.registry ?? "(unnamed)"}, ${health.body?.publications ?? 0} publication(s) on file`);

  const publish = await fetchJson(`${origin}/v1/publications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author: operator || "operator",
      title: "the operator's first publication",
      taskId: "half-adder",
      circuit: halfAdder,
    }),
  });
  if (publish.status !== 201) {
    emit("publish", "fail", `the node refused the publication (HTTP ${publish.status}): ${JSON.stringify(publish.body).slice(0, 160)}`);
    return finish(1);
  }
  emit("publish", "ok", `publication ${String(publish.body?.id ?? "?").slice(0, 8)}… — the node verified a half-adder of NANDs`);

  const anchor = await fetchJson(`${origin}/v1/anchors`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (anchor.status !== 201) {
    emit("anchor", "fail", `nothing to anchor (HTTP ${anchor.status}): ${JSON.stringify(anchor.body).slice(0, 160)}`);
    return finish(1);
  }
  const anchorRoot = String(anchor.body?.root ?? "");
  emit("anchor", "ok", `anchor root ${anchorRoot.slice(0, 16)}… — the publications are committed`);

  const archive = await fetchJson(`${origin}/v1/history/${anchorRoot}`);
  if (archive.status !== 200 || archive.body?.stateRoot === undefined) {
    emit("archive", "fail", `no state archive frozen at the anchor (HTTP ${archive.status})`);
    return finish(1);
  }
  emit("archive", "ok", `state root ${String(archive.body?.stateRoot ?? "").slice(0, 16)}… — the ledger's history has begun`);

  const journey = spawn(process.execPath, [
    "--experimental-strip-types",
    join(scriptRoot, "scripts", "node-journey.mjs"),
    origin,
    "--registry", registryId,
    "--root", anchorRoot,
    "--allow-private",
    "--json",
  ]);
  const journeyOutput = await new Promise((resolve) => {
    let out = "";
    journey.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    journey.on("close", () => resolve(out));
  });
  let journeyVerdict = null;
  try {
    journeyVerdict = JSON.parse(journeyOutput);
  } catch {
    journeyVerdict = null;
  }
  const rails = journeyVerdict && Array.isArray(journeyVerdict.rails) ? journeyVerdict.rails : [];
  const failedRails = rails.filter((rail) => rail.ok !== true);
  if (failedRails.length > 0) {
    emit(
      "journey",
      "fail",
      `not a full node yet: ${failedRails.map((rail) => rail.rail).join(", ")} — ${failedRails
        .map((rail) => (Array.isArray(rail.evidence) ? rail.evidence.join("; ") : ""))
        .join(" | ")
        .slice(0, 220)}`,
    );
    return finish(1);
  }
  emit("journey", "ok", `FULL NODE: ${rails.map((rail) => rail.rail).join(", ")} all verified`);

  const joinUrl = publicUrl || origin;
  const admission = {
    kind: "rarext.registry-admission.v1",
    registry: {
      id: `node-${sha256(joinUrl).slice(0, 8)}`,
      url: joinUrl,
      operator: operator || "operator",
      chains: ["rarex"],
      note: `a full node (anchor ${anchorRoot.slice(0, 16)}…) asking to join ${registryId}`,
    },
    issuedAt: new Date().toISOString(),
    payOn: "admit",
  };
  emit("join", "ok", `the admission document is ready — attach it to a proposal on a registry already in the federation; the tally applies it`);
  if (publicUrl === "") {
    emit("join", "note", `the document proposes THIS machine (${origin}) — pass --url <public-origin> when the node is reachable from the network`);
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, origin, anchorRoot, stateRoot: archive.body?.stateRoot, admission, events }, null, 2));
  } else {
    console.log("\n--- join request (attach to a governance proposal) ---");
    console.log(JSON.stringify(admission, null, 2));
  }
  return finish(0);
}

function finish(code) {
  stopChild();
  if (asJson && code !== 0) {
    console.log(JSON.stringify({ ok: false, events }, null, 2));
  }
  process.exit(code);
}

run().catch((error) => {
  emit("become-a-node", "fail", error instanceof Error ? error.message : String(error));
  finish(1);
});
