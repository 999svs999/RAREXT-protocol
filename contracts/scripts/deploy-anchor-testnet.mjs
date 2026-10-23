#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT } from "../lib/compile.mjs";

export const ANCHOR_TESTNET_CONFIRM = "deploy-testnet";
export const ANCHOR_DEPLOYMENT_KIND = "rarext.anchor-deployment";
export const ANCHOR_DEPLOYMENT_VERSION = 1;

export const MAINNET_CHAIN_IDS = new Set([
  "1",
  "10",
  "25",
  "56",
  "100",
  "137",
  "250",
  "324",
  "5000",
  "8453",
  "42161",
  "43114",
  "59144",
  "534352",
  "81457",
]);

function required(name, value) {
  if (!value || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function readPackageVersion(path) {
  return JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8")).version;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isDeployment(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const deployment = value;
  return (
    typeof deployment.chainId === "string" &&
    typeof deployment.implementation === "string" &&
    typeof deployment.proxy === "string" &&
    typeof deployment.proxyImplementation === "string" &&
    typeof deployment.owner === "string"
  );
}

export function assertTestnetTarget({
  chainId,
  expectedChainId,
  confirmation,
  mainnetChainIds = MAINNET_CHAIN_IDS,
}) {
  const expected = String(expectedChainId ?? "").trim();
  const actual = String(chainId ?? "").trim();

  if (!/^\d+$/.test(expected)) {
    throw new Error("ANCHOR_EXPECTED_CHAIN_ID must be a decimal chain id");
  }

  if (!/^\d+$/.test(actual)) {
    throw new Error("deployment returned an invalid chain id");
  }

  if (actual !== expected) {
    throw new Error(`RPC is chain ${actual}, expected ${expected}; refusing to deploy`);
  }

  if (mainnetChainIds.has(actual)) {
    throw new Error(
      `chain ${actual} is a known mainnet; live deployment is blocked until the external audit is complete`,
    );
  }

  if (confirmation !== ANCHOR_TESTNET_CONFIRM) {
    throw new Error(
      `set ANCHOR_TESTNET_CONFIRM=${ANCHOR_TESTNET_CONFIRM} to acknowledge a testnet-only deployment`,
    );
  }

  return actual;
}

export function buildDeploymentRecord({
  deployment,
  gitCommit,
  sourceSha256,
  deployedAt,
  toolchain,
}) {
  if (!isDeployment(deployment)) {
    throw new Error("deployment output is missing a required address or chain id");
  }

  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new Error("sourceSha256 must be a lowercase SHA-256 digest");
  }

  return {
    kind: ANCHOR_DEPLOYMENT_KIND,
    version: ANCHOR_DEPLOYMENT_VERSION,
    networkClass: "testnet",
    deployedAt,
    gitCommit,
    source: {
      path: "contracts/RarextAnchor.sol",
      sha256: sourceSha256,
    },
    toolchain,
    audit: {
      document: "contracts/AUDIT.md",
      status: "not-performed",
      externalReviewNeeded: true,
      liveDeploymentBlocked: true,
    },
    deployment,
  };
}

function main() {
  const expectedChainId = required(
    "ANCHOR_EXPECTED_CHAIN_ID",
    process.env.ANCHOR_EXPECTED_CHAIN_ID,
  );
  assertTestnetTarget({
    chainId: expectedChainId,
    expectedChainId,
    confirmation: process.env.ANCHOR_TESTNET_CONFIRM,
  });

  const recordPath = resolve(
    required("ANCHOR_DEPLOYMENT_RECORD", process.env.ANCHOR_DEPLOYMENT_RECORD),
  );

  if (existsSync(recordPath)) {
    throw new Error(`deployment record already exists: ${recordPath}`);
  }

  mkdirSync(dirname(recordPath), { recursive: true });

  const deployScript = join(ROOT, "contracts/scripts/deploy-anchor.mjs");
  const child = spawnSync(process.execPath, [deployScript], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
  });

  if (child.status !== 0) {
    throw new Error(
      `deploy-anchor failed: ${(child.stderr || child.stdout || "no output").trim()}`,
    );
  }

  let deployment;
  try {
    deployment = JSON.parse(child.stdout);
  } catch {
    throw new Error("deploy-anchor did not return a JSON deployment record");
  }

  assertTestnetTarget({
    chainId: deployment.chainId,
    expectedChainId,
    confirmation: process.env.ANCHOR_TESTNET_CONFIRM,
  });

  const deployedAt = new Date().toISOString();
  const record = buildDeploymentRecord({
    deployment,
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    sourceSha256: sha256File(join(ROOT, "contracts/RarextAnchor.sol")),
    deployedAt,
    toolchain: {
      compiler: readPackageVersion("node_modules/solc"),
      openzeppelinContracts: readPackageVersion(
        "node_modules/@openzeppelin/contracts",
      ),
      openzeppelinContractsUpgradeable: readPackageVersion(
        "node_modules/@openzeppelin/contracts-upgradeable",
      ),
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  });

  const temporary = `${recordPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, recordPath);

  console.log(JSON.stringify(record, null, 2));
  console.error(`testnet deployment record ${recordPath}`);
  console.error("external audit: not performed; live deployment: blocked");
}

const invoked =
  process.argv[1] !== undefined ? resolve(process.argv[1]) : "";

if (invoked === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `deploy-anchor-testnet: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
