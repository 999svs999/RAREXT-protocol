#!/usr/bin/env node
/**
 * Reproduce the audit baseline: hash the source, compile with the pinned
 * settings, and hash the creation bytecode, runtime bytecode, and ABI. The
 * values in `contracts/AUDIT.md` must match, so a silent source or toolchain
 * change is caught before an auditor reviews the wrong bytecode.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileContracts, ROOT } from "../lib/compile.mjs";

export const AUDIT_PATH = join(ROOT, "contracts/AUDIT.md");
export const SOURCE_PATH = join(ROOT, "contracts/RarextAnchor.sol");

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Git's blob id, so the baseline can be tied to a committed object. */
export function gitBlobHash(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function packageVersion(path) {
  return JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8")).version;
}

let cachedArtifacts = null;

export function anchorArtifacts() {
  cachedArtifacts ??= compileContracts({ includeTestFixture: false });
  return cachedArtifacts;
}

export function computeBaseline() {
  const sourceBytes = readFileSync(SOURCE_PATH);
  const artifacts = anchorArtifacts();
  const creation = artifacts.anchor.evm.bytecode.object;
  const runtime = artifacts.anchor.evm.deployedBytecode.object;

  if (!creation) throw new Error("compiler produced no creation bytecode");
  if (!runtime) throw new Error("compiler produced no runtime bytecode");

  return {
    contract: "contracts/RarextAnchor.sol",
    sourceSha256: sha256Hex(sourceBytes),
    gitBlob: gitBlobHash(sourceBytes),
    creationBytecodeSha256: sha256Hex(Buffer.from(creation, "hex")),
    runtimeBytecodeSha256: sha256Hex(Buffer.from(runtime, "hex")),
    abiSha256: sha256Hex(JSON.stringify(artifacts.anchor.abi)),
    toolchain: {
      solc: packageVersion("node_modules/solc"),
      openzeppelinContracts: packageVersion("node_modules/@openzeppelin/contracts"),
      openzeppelinContractsUpgradeable: packageVersion(
        "node_modules/@openzeppelin/contracts-upgradeable",
      ),
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  };
}

const FIELDS = {
  "Current source SHA-256": "sourceSha256",
  "Git blob": "gitBlob",
  "Creation bytecode SHA-256": "creationBytecodeSha256",
  "Runtime bytecode SHA-256": "runtimeBytecodeSha256",
  "ABI SHA-256": "abiSha256",
};

/** Read the recorded baseline out of the markdown table. */
export function recordedBaseline(markdown) {
  const recorded = {};

  for (const [label, field] of Object.entries(FIELDS)) {
    const pattern = new RegExp(`\\|\\s*${label}\\s*\\|\\s*\`?([0-9a-f]{40,64})\`?\\s*\\|`);
    const match = pattern.exec(markdown);
    if (match) recorded[field] = match[1];
  }

  return recorded;
}

export function compareBaseline(actual, recorded) {
  const problems = [];

  for (const [label, field] of Object.entries(FIELDS)) {
    if (!recorded[field]) {
      problems.push(`${label} is missing from contracts/AUDIT.md`);
      continue;
    }
    if (recorded[field] !== actual[field]) {
      problems.push(`${label}: got ${actual[field]}, AUDIT.md records ${recorded[field]}`);
    }
  }

  return problems;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  const actual = computeBaseline();
  const recorded = recordedBaseline(readFileSync(AUDIT_PATH, "utf8"));
  const problems = compareBaseline(actual, recorded);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...actual, commit: gitCommit(), recorded, problems }, null, 2));
  } else {
    console.log(`contract        ${actual.contract}`);
    console.log(`source sha256   ${actual.sourceSha256}`);
    console.log(`git blob        ${actual.gitBlob}`);
    console.log(`creation sha256 ${actual.creationBytecodeSha256}`);
    console.log(`runtime sha256  ${actual.runtimeBytecodeSha256}`);
    console.log(`abi sha256      ${actual.abiSha256}`);
    console.log(`solc            ${actual.toolchain.solc}`);
    console.log(
      `openzeppelin    ${actual.toolchain.openzeppelinContracts} ` +
        `(upgradeable ${actual.toolchain.openzeppelinContractsUpgradeable})`,
    );
  }

  if (problems.length > 0) {
    console.error("\naudit baseline does not match contracts/AUDIT.md:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else if (!process.argv.includes("--json")) {
    console.log("\naudit baseline matches contracts/AUDIT.md");
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";

if (invoked === fileURLToPath(import.meta.url)) main();
