import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANCHOR_DEPLOYMENT_KIND,
  ANCHOR_TESTNET_CONFIRM,
  assertTestnetTarget,
  buildDeploymentRecord,
} from "../scripts/deploy-anchor-testnet.mjs";

const deployment = {
  chainId: "11155111",
  deployer: "0x1000000000000000000000000000000000000001",
  owner: "0x2000000000000000000000000000000000000002",
  publisher: null,
  version: "1.0.0",
  upgradeInterfaceVersion: "5.0.0",
  paused: false,
  anchorCount: "0",
  implementation: "0x3000000000000000000000000000000000000003",
  proxy: "0x4000000000000000000000000000000000000004",
  proxyImplementation: "0x3000000000000000000000000000000000000003",
};

const toolchain = {
  compiler: "0.8.38",
  openzeppelinContracts: "5.0.2",
  openzeppelinContractsUpgradeable: "5.0.2",
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "cancun",
};

describe("anchor testnet deployment guard", () => {
  it("accepts a confirmed testnet chain", () => {
    assert.equal(
      assertTestnetTarget({
        chainId: "11155111",
        expectedChainId: "11155111",
        confirmation: ANCHOR_TESTNET_CONFIRM,
      }),
      "11155111",
    );
  });

  it("refuses a known mainnet before signing anything", () => {
    assert.throws(
      () =>
        assertTestnetTarget({
          chainId: "1",
          expectedChainId: "1",
          confirmation: ANCHOR_TESTNET_CONFIRM,
        }),
      /known mainnet/,
    );
  });

  it("requires an explicit testnet acknowledgement and matching chain id", () => {
    assert.throws(
      () =>
        assertTestnetTarget({
          chainId: "11155111",
          expectedChainId: "11155111",
          confirmation: "yes",
        }),
      /ANCHOR_TESTNET_CONFIRM/,
    );
    assert.throws(
      () =>
        assertTestnetTarget({
          chainId: "11155111",
          expectedChainId: "84532",
          confirmation: ANCHOR_TESTNET_CONFIRM,
        }),
      /expected 84532/,
    );
    assert.throws(
      () =>
        assertTestnetTarget({
          chainId: "sepolia",
          expectedChainId: "sepolia",
          confirmation: ANCHOR_TESTNET_CONFIRM,
        }),
      /decimal chain id/,
    );
  });

  it("records the deployment as unaudited and blocks live deployment", () => {
    const record = buildDeploymentRecord({
      deployment,
      gitCommit: "a".repeat(40),
      sourceSha256: "b".repeat(64),
      deployedAt: "2026-10-23T12:00:00.000Z",
      toolchain,
    });

    assert.equal(record.kind, ANCHOR_DEPLOYMENT_KIND);
    assert.equal(record.version, 1);
    assert.equal(record.networkClass, "testnet");
    assert.equal(record.source.sha256, "b".repeat(64));
    assert.equal(record.audit.status, "not-performed");
    assert.equal(record.audit.externalReviewNeeded, true);
    assert.equal(record.audit.liveDeploymentBlocked, true);
    assert.deepEqual(record.deployment, deployment);
  });

  it("refuses an incomplete deployment or source digest", () => {
    assert.throws(
      () =>
        buildDeploymentRecord({
          deployment: { chainId: "11155111" },
          gitCommit: "a".repeat(40),
          sourceSha256: "b".repeat(64),
          deployedAt: "2026-10-23T12:00:00.000Z",
          toolchain,
        }),
      /missing a required address/,
    );
    assert.throws(
      () =>
        buildDeploymentRecord({
          deployment,
          gitCommit: "a".repeat(40),
          sourceSha256: "not-a-digest",
          deployedAt: "2026-10-23T12:00:00.000Z",
          toolchain,
        }),
      /lowercase SHA-256/,
    );
  });
});
