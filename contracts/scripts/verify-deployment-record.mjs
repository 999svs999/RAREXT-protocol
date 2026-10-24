#!/usr/bin/env node
/**
 * Validate a recorded deployment before it is quoted to anyone. This is an
 * offline check: it does not contact a chain. It confirms that the record names
 * the current source, that it is a testnet record, and that it still carries
 * the "not audited, live blocked" flags.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress } from "ethers";

import { MAINNET_CHAIN_IDS } from "./deploy-anchor-testnet.mjs";
import { SOURCE_PATH } from "./audit-baseline.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const TRANSACTION = /^0x[0-9a-fA-F]{64}$/;

export function sourceSha256At(path = SOURCE_PATH) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyDeploymentRecord(
  record,
  {
    sourceSha256 = sourceSha256At(),
    mainnetChainIds = MAINNET_CHAIN_IDS,
  } = {},
) {
  const problems = [];

  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { ok: false, problems: ["record is not an object"] };
  }

  if (record.kind !== "rarext.anchor-deployment") {
    problems.push("kind must be rarext.anchor-deployment");
  }
  if (record.version !== 1) problems.push("version must be 1");
  if (record.networkClass !== "testnet") {
    problems.push("networkClass must be testnet; a mainnet record is not authorized");
  }

  if (record.source?.path !== "contracts/RarextAnchor.sol") {
    problems.push("source.path must be contracts/RarextAnchor.sol");
  }
  if (!HASH.test(String(record.source?.sha256 ?? ""))) {
    problems.push("source.sha256 must be a lowercase SHA-256 digest");
  } else if (record.source.sha256 !== sourceSha256) {
    problems.push(
      `source.sha256 ${record.source.sha256} does not match the current source ${sourceSha256}`,
    );
  }

  if (record.audit?.status !== "not-performed") {
    problems.push("audit.status must be not-performed; this record is not an audit report");
  }
  if (record.audit?.externalReviewNeeded !== true) {
    problems.push("audit.externalReviewNeeded must be true");
  }
  if (record.audit?.liveDeploymentBlocked !== true) {
    problems.push("audit.liveDeploymentBlocked must be true");
  }

  const chainId = String(record.deployment?.chainId ?? "");
  if (!/^\d+$/.test(chainId)) {
    problems.push("deployment.chainId must be a decimal string");
  } else if (mainnetChainIds.has(chainId)) {
    problems.push(`deployment.chainId ${chainId} is a known mainnet`);
  }

  for (const field of ["implementation", "proxy", "proxyImplementation", "owner"]) {
    const value = record.deployment?.[field];

    if (typeof value !== "string" || !ADDRESS.test(value)) {
      problems.push(`deployment.${field} must be a 20-byte address`);
      continue;
    }

    try {
      if (getAddress(value) !== value) {
        problems.push(`deployment.${field} is not checksummed`);
      }
    } catch {
      problems.push(`deployment.${field} is not a valid address`);
    }
  }

  if (
    typeof record.deployment?.proxyImplementation === "string" &&
    typeof record.deployment?.implementation === "string" &&
    record.deployment.proxyImplementation.toLowerCase() !==
      record.deployment.implementation.toLowerCase()
  ) {
    problems.push("deployment.proxyImplementation must equal deployment.implementation");
  }

  for (const name of ["implementation", "proxy"]) {
    const hash = record.deployment?.transactions?.[name]?.hash;

    if (!TRANSACTION.test(String(hash ?? ""))) {
      problems.push(`deployment.transactions.${name}.hash must be a transaction hash`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function main() {
  const path = process.argv[2];

  if (!path) {
    console.error("usage: verify-deployment-record.mjs <record.json>");
    process.exitCode = 2;
    return;
  }

  const record = JSON.parse(readFileSync(resolve(path), "utf8"));
  const result = verifyDeploymentRecord(record);

  if (!result.ok) {
    console.error("deployment record is not valid:");
    for (const problem of result.problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `valid testnet record: chain ${record.deployment.chainId}, proxy ${record.deployment.proxy}`,
  );
  console.log("audit: not performed; live deployment: blocked");
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";

if (invoked === fileURLToPath(import.meta.url)) main();
