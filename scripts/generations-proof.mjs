#!/usr/bin/env node
/**
 * generations-proof.mjs — the FUTURISTIC generations ladder as a commitment.
 *
 * The protocol names its network web4. This prints what "and the generations
 * after it" means — the network ladder (5G→8G), the model-size ladder
 * (6G→8G), the web ladder (web4→web8), and the protocol-leaf ladder
 * (gen-4→gen-8) — as ONE canonical object with ONE sha256, recomputed here
 * from core so the printed digest is the object's own and not a copy.
 *
 *   npm run demo:generations            # human summary + a plan
 *   npm run demo:generations -- --json  # { kind, digest, generations } for a machine
 *
 * It contacts nothing and writes nothing. Exit is non-zero if the ladder the
 * module ships is malformed, so a green run is a checked run.
 */
import { createHash } from "node:crypto";
import os from "node:os";

const root = new URL("..", import.meta.url).pathname;
const core = await import(root + "packages/core/src/index.ts");
const {
  GENERATIONS,
  GENERATIONS_KIND,
  axisLadder,
  generationsDigest,
  generationsProblems,
  networkMeets,
  nextGeneration,
  planModelShards,
  shippedGeneration,
} = core;

const nodeSha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = generationsDigest(nodeSha256);
const problems = generationsProblems(GENERATIONS);

if (problems.length > 0) {
  console.error("the shipped generations ladder is malformed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (process.argv.slice(2).includes("--json")) {
  console.log(JSON.stringify({ kind: GENERATIONS_KIND, digest, generations: GENERATIONS }, null, 2));
  process.exit(0);
}

const mark = (axis, id) => `${id}${id === shippedGeneration(axis) ? "*" : ""}`;
const ladder = (axis) =>
  (GENERATIONS[axis]).map((entry) => mark(axis, entry.id)).join(" → ");

console.log("RAREXT generations — the futuristic ladder\n");
console.log(`  commitment  ${GENERATIONS_KIND}`);
console.log(`  digest      sha256:${digest}`);
console.log(`  status      ${GENERATIONS.status} (* = shipped today; the rest are declared targets)\n`);

console.log(`  web         ${ladder("web")}`);
console.log(`  network     ${ladder("network")}`);
console.log(`  model       ${ladder("model")}`);
console.log(`  protocol    ${ladder("protocol")}\n`);

console.log("  today");
console.log(`    web=${shippedGeneration("web")}  network=${shippedGeneration("network")}  protocol=${shippedGeneration("protocol")}  model=${shippedGeneration("model") ?? "(none shipped)"}`);

const shardPlan = planModelShards("8G");
console.log("\n  a plan over the ladder");
console.log(`    network  8G meets a 1 ms / 10 Gbps / edge budget: ${networkMeets("8G", { maxLatencyMsP50: 1, downlinkMbps: 10000, edge: true })}`);
console.log(`    network  5G meets a 1 ms budget: ${networkMeets("5G", { maxLatencyMsP50: 1 })} (it does not promise one)`);
console.log(`    model    8G class  ${shardPlan.sizeBytes} B = ${shardPlan.shards} × ${shardPlan.shardBytes} B shards`);
console.log(`    next     after web4 → ${nextGeneration("web", "web4")} · after network 6G → ${nextGeneration("network", "6G")} · after model 6G → ${nextGeneration("model", "6G")} · after protocol gen-4 → ${nextGeneration("protocol", "gen-4")}`);

const totalMemoryBytes = os.totalmem();
console.log("\n  can THIS host serve a model class? (weights ×2 floor vs total memory)");
for (const entry of GENERATIONS.model) {
  const fits = totalMemoryBytes >= entry.minMemoryBytes;
  console.log(
    `    ${entry.id.padEnd(3)} ${String(entry.sizeBytes).padStart(12)} B  floor ${String(entry.minMemoryBytes).padStart(12)} B  ${fits ? "fits" : "too large for this host"}${entry.shipped ? "  (shipped)" : ""}`,
  );
}

console.log("\nThe ladder is declared, not measured: one canonical object, one digest, recomputed here.");
