#!/usr/bin/env node
// The operator's one command: is THIS node a full node?
//
//   node scripts/node-journey.mjs <origin> --root <64-hex> [--registry <id>] [--allow-private] [--json]
//
// The five rails — binding, registry, ledger, governance, federation — live in the SDK
// (packages/agent-sdk/src/journey.ts, runNodeJourney), because an AI agent asks the same
// question through RarextClient.journey() and the two surfaces must not drift. This file is
// the CLI's argument parsing and the human formatting over the document the SDK returns;
// the verification is the SDK's, one implementation.
//
// Plain `node`, no install. Exit 0 when every rail holds, 1 otherwise, 2 for a usage error.

import { runNodeJourney } from "../packages/agent-sdk/src/index.ts";

const argv = process.argv.slice(2);
const positional = [];
let root = "";
let registry = "";
let allowPrivate = false;
let asJson = false;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--root") root = (argv[++index] ?? "").trim();
  else if (arg === "--registry") registry = (argv[++index] ?? "").trim();
  else if (arg === "--allow-private") allowPrivate = true;
  else if (arg === "--json") asJson = true;
  else if (arg.startsWith("--")) {
    console.error(`unknown option ${arg}`);
    process.exit(2);
  } else positional.push(arg);
}

const HEX64 = /^[0-9a-f]{64}$/;
if (positional.length !== 1 || positional[0] === "") {
  console.error("usage: node scripts/node-journey.mjs <origin> --root <64-hex> [--registry <id>] [--allow-private] [--json]");
  process.exit(2);
}
if (root !== "" && !HEX64.test(root)) {
  console.error(`--root must be 64 hex characters, got ${root.slice(0, 24)}…`);
  process.exit(2);
}

const journey = await runNodeJourney(positional[0], { root, registry, allowPrivate });

if (asJson) {
  console.log(JSON.stringify(journey, null, 2));
  process.exit(journey.ok ? 0 : 1);
}

console.log(`node journey — ${journey.origin}${journey.root ? ` against pinned root ${journey.root.slice(0, 16)}…` : ""}`);
for (const rail of journey.rails) {
  const mark = rail.ok ? "PASS" : rail.rail === "binding" && !journey.root ? "----" : "FAIL";
  console.log(`  [${mark}] ${rail.rail}`);
  for (const line of rail.evidence) if (line) console.log(`         ${line}`);
}
if (!journey.ok) {
  console.error(
    "\nNOT A FULL NODE: " +
      journey.rails.filter((rail) => !rail.ok).map((rail) => rail.rail).join(", ") +
      " did not hold. The evidence above says what each rail answered.",
  );
  process.exit(1);
}
console.log("\nFULL NODE: the binding verifies, the served registry rebuilds the pinned root, and both economy rails answer. The evidence above is the receipt.");
process.exit(0);
