#!/usr/bin/env node
/**
 * claim-gate.mjs — the ops gate for `claim:check` at its recorded baseline.
 *
 * claim:check exits 1 whenever ANY published claim drifts from the code; the
 * repository carries a standing set of known mismatches (documented, tracked),
 * so the ops gate is "no worse than the recorded baseline", not "zero". The
 * baseline lives in projects.json and is a number someone had to write down —
 * silently raising it would be visible in the manifest diff.
 *
 * Prints the count and the verdict; exits 0 only at or under baseline.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(new URL("../..", import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(join(root, "tools/ops/projects.json"), "utf8"));
const baseline = manifest.claimBaseline?.mismatches;
if (typeof baseline !== "number") throw new Error("projects.json has no claimBaseline.mismatches");

let out = "";
try {
  out = execFileSync("npm", ["run", "claim:check"], { cwd: root, encoding: "utf8", timeout: 600000 });
} catch (error) {
  out = String(error.stdout ?? "") + String(error.stderr ?? "");
}
const match = /(\d+) mismatch\(es\)/.exec(out);
const count = match ? Number(match[1]) : -1;
const ok = count >= 0 && count <= baseline;
console.log(`claim:check ${count} mismatch(es) vs recorded baseline ${baseline} → ${ok ? "PASS (no regression)" : "FAIL (regression)"}`);
if (!ok) {
  for (const line of out.split("\n")) if (line.startsWith("  MISMATCH")) console.log(" " + line);
}
process.exit(ok ? 0 : 1);
