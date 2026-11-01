#!/usr/bin/env node
// The operator's one command: is THIS node a full node?
//
//   node scripts/node-journey.mjs <origin> --root <64-hex> [--registry <id>] [--allow-private] [--json]
//
// Four rails, each with a structural verdict and the evidence for it:
//
//   binding     the node's /.well-known/rarext.json, verified against the pinned root
//               (verifySiteBinding — a statement about itself is not evidence about itself)
//   registry    the bundle the node serves at /v1/bundles/latest, recomputed through
//               verifyBundle — its manifest root must equal the pinned root
//   ledger      the work rail's commitment (GET /v1/work/ledger) — live, well-shaped,
//               a 64-hex root over whatever the node has earned
//   governance  the 民主 rail answers (GET /v1/governance/proposals)
//
// The first two rails VERIFY content; the last two verify the economy's rails are live
// and shaped — labeled as exactly that, because reachability is not verification and
// this refuses to blur them. Exit 0 only when every rail holds. --json prints the
// journey document for a robot; the human output says the same thing in words.
//
// Plain `node`, no install. The verification functions are the project's own — this
// adds no second implementation of any rule.

import { verifyBundle } from "../packages/agent-sdk/src/index.ts";
import { readSiteBinding } from "../packages/agent-sdk/src/index.ts";
import { verifySiteBinding } from "../packages/core/src/index.ts";

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

const origin = positional[0].replace(/\/+$/, "");

const rails = [];

// ── Rail 1: binding ──────────────────────────────────────────────────────────
// The transition question, asked properly: the statement is read from the node,
// and the verdict comes from the root the CALLER pinned — never from the node.
{
  const rail = { rail: "binding", ok: false, evidence: [] };
  if (root === "") {
    rail.evidence.push("no --root given: a binding cannot certify itself, so this rail is INDETERMINATE, not passed");
  } else {
    try {
      const read = await readSiteBinding(origin, { allowPrivate });
      rail.evidence.push(`file carrier: ${read.file}${read.file === "served" ? "" : ` (${read.notes.join("; ")})`}`);
      if (read.file === "served" && read.parse.ok) {
        const verdict = verifySiteBinding(read.parse.binding, {
          pinnedRoot: root,
          ...(registry !== "" ? { expectedRegistry: registry } : {}),
        });
        rail.ok = verdict.ok;
        rail.evidence.push(
          verdict.ok
            ? `JOINED: the node answers for ${read.parse.binding.registry} at the pinned root`
            : (verdict.reason ?? "the binding does not verify"),
        );
      } else if (read.file === "served") {
        rail.evidence.push(read.parse.ok ? "" : (read.parse.reason ?? "the binding does not parse"));
      } else if (read.parse.ok === false && read.parse.reason) {
        rail.evidence.push(read.parse.reason);
      }
    } catch (error) {
      rail.evidence.push(`the binding could not be read: ${(error && error.message) || error}`);
    }
  }
  rails.push(rail);
}

// ── Rail 2: registry ─────────────────────────────────────────────────────────
// The node serves a registry copy, and the copy's bytes rebuild the pinned root.
{
  const rail = { rail: "registry", ok: false, evidence: [] };
  try {
    const response = await fetch(`${origin}/v1/bundles/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      rail.evidence.push(`the node answered HTTP ${response.status} for its latest bundle`);
    } else {
      const bundle = await response.json();
      const verification = await verifyBundle(bundle, undefined, root === "" ? undefined : root);
      rail.ok = verification.valid === true && (root === "" || verification.root === root);
      if (rail.ok) {
        rail.evidence.push(`the served bundle rebuilds ${verification.root.slice(0, 16)}… (${verification.publications} publication(s))`);
      } else if (verification.reason) {
        rail.evidence.push(`the served bundle does not verify: ${verification.reason.slice(0, 140)}`);
      } else if (verification.computedRoot) {
        // The verifier names no reason for a pin mismatch — the RECOMPUTED root is the evidence,
        // and it is what the operator needs: what the node actually serves, against what was asked.
        rail.evidence.push(
          `the served bundle rebuilds ${verification.computedRoot.slice(0, 16)}…, not the pinned ${(root || "").slice(0, 16)}…`,
        );
      } else {
        rail.evidence.push("the served bundle does not verify, and the verifier gave no recomputed root");
      }
    }
  } catch (error) {
    rail.evidence.push(`the bundle could not be read: ${(error && error.message) || error}`);
  }
  rails.push(rail);
}

// ── Rail 3: ledger ───────────────────────────────────────────────────────────
// The money rail is live. Reachability and shape, labeled as that: a full
// recompute of the commitment needs the receipts, which are the earner's to
// pull by key.
{
  const rail = { rail: "ledger", ok: false, evidence: [] };
  try {
    const response = await fetch(`${origin}/v1/work/ledger`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      rail.evidence.push(`the work rail answered HTTP ${response.status}`);
    } else {
      const ledger = await response.json();
      const shapeOk =
        typeof ledger.root === "string" && HEX64.test(ledger.root) && Number.isInteger(ledger.count) && ledger.count >= 0;
      rail.ok = shapeOk;
      rail.evidence.push(
        shapeOk
          ? `the work rail is live: commitment ${ledger.root.slice(0, 16)}… over ${ledger.count} receipt(s)`
          : "the work rail answered but its commitment is not shaped like a ledger root",
      );
    }
  } catch (error) {
    rail.evidence.push(`the work rail could not be read: ${(error && error.message) || error}`);
  }
  rails.push(rail);
}

// ── Rail 4: governance ───────────────────────────────────────────────────────
// The 民主 rail is reachable and shaped like a proposal list.
{
  const rail = { rail: "governance", ok: false, evidence: [] };
  try {
    const response = await fetch(`${origin}/v1/governance/proposals`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      rail.evidence.push(`the governance rail answered HTTP ${response.status}`);
    } else {
      const proposals = await response.json();
      const shapeOk = Array.isArray(proposals);
      rail.ok = shapeOk;
      rail.evidence.push(
        shapeOk
          ? `the governance rail is live: ${proposals.length} proposal(s) on record`
          : "the governance rail answered but its body is not a proposal list",
      );
    }
  } catch (error) {
    rail.evidence.push(`the governance rail could not be read: ${(error && error.message) || error}`);
  }
  rails.push(rail);
}

const journey = { origin, root: root || null, registry: registry || null, ok: rails.every((rail) => rail.ok), rails };

if (asJson) {
  console.log(JSON.stringify(journey, null, 2));
  process.exit(journey.ok ? 0 : 1);
}

console.log(`node journey — ${origin}${root ? ` against pinned root ${root.slice(0, 16)}…` : ""}`);
for (const rail of rails) {
  const mark = rail.ok ? "PASS" : rail.rail === "binding" && root === "" ? "----" : "FAIL";
  console.log(`  [${mark}] ${rail.rail}`);
  for (const line of rail.evidence) if (line) console.log(`         ${line}`);
}
if (!journey.ok) {
  console.error(
    "\nNOT A FULL NODE: " +
      rails.filter((rail) => !rail.ok).map((rail) => rail.rail).join(", ") +
      " did not hold. The evidence above says what each rail answered.",
  );
  process.exit(1);
}
console.log("\nFULL NODE: the binding verifies, the served registry rebuilds the pinned root, and both economy rails answer. The evidence above is the receipt.");
process.exit(0);
