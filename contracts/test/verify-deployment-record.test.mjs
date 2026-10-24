import assert from "node:assert/strict";
import test from "node:test";

import {
  sourceSha256At,
  verifyDeploymentRecord,
} from "../scripts/verify-deployment-record.mjs";

function record(overrides = {}) {
  const base = {
    kind: "rarext.anchor-deployment",
    version: 1,
    networkClass: "testnet",
    deployedAt: new Date().toISOString(),
    gitCommit: "0".repeat(40),
    source: { path: "contracts/RarextAnchor.sol", sha256: sourceSha256At() },
    toolchain: {
      compiler: "0.8.38",
      openzeppelinContracts: "5.0.2",
      openzeppelinContractsUpgradeable: "5.0.2",
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
    audit: {
      document: "contracts/AUDIT.md",
      status: "not-performed",
      externalReviewNeeded: true,
      liveDeploymentBlocked: true,
    },
    deployment: {
      chainId: "11155111",
      implementation: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      proxy: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      proxyImplementation: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      implementationTransaction: `0x${"a".repeat(64)}`,
    },
  };

  return { ...base, ...overrides };
}

test("a complete, current testnet record passes", () => {
  const result = verifyDeploymentRecord(record());
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test("a record for different source bytes is refused", () => {
  const result = verifyDeploymentRecord(
    record({ source: { path: "contracts/RarextAnchor.sol", sha256: "0".repeat(64) } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.problems.join("; "), /does not match the current source/);
});

test("a mainnet chain id or a relaxed audit flag is refused", () => {
  const mainnet = record();
  mainnet.deployment.chainId = "1";
  assert.match(verifyDeploymentRecord(mainnet).problems.join("; "), /known mainnet/);

  const relaxed = record();
  relaxed.audit.liveDeploymentBlocked = false;
  assert.match(
    verifyDeploymentRecord(relaxed).problems.join("; "),
    /liveDeploymentBlocked must be true/,
  );

  const claimed = record();
  claimed.audit.status = "audited";
  assert.match(
    verifyDeploymentRecord(claimed).problems.join("; "),
    /audit.status must be not-performed/,
  );
});

test("mismatched proxy implementation and malformed addresses are refused", () => {
  const mismatch = record();
  mismatch.deployment.proxyImplementation = mismatch.deployment.owner;
  assert.match(
    verifyDeploymentRecord(mismatch).problems.join("; "),
    /proxyImplementation must equal/,
  );

  const bad = record();
  bad.deployment.proxy = "0x1234";
  assert.match(verifyDeploymentRecord(bad).problems.join("; "), /deployment.proxy/);
});

test("the source hash helper tracks the current contract file", () => {
  assert.match(sourceSha256At(), /^[0-9a-f]{64}$/);
});
