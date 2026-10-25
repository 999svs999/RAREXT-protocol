import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeBaseline } from "../scripts/audit-baseline.mjs";
import {
  AUDIT_PACKAGE_KIND,
  AUDIT_PACKAGE_VERSION,
  buildAuditPackage,
  SOURCE_REL,
  verifyAuditPackage,
} from "../scripts/audit-package.mjs";
import { sourceSha256At } from "../scripts/verify-deployment-record.mjs";

function temporaryPackage() {
  return mkdtempSync(join(tmpdir(), "rarext-audit-package-"));
}

function testnetRecord() {
  const implementation = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  return {
    kind: "rarext.anchor-deployment",
    version: 1,
    networkClass: "testnet",
    deployedAt: "2026-10-25T00:00:00.000Z",
    gitCommit: "0".repeat(40),
    source: { path: SOURCE_REL, sha256: sourceSha256At() },
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
      implementation,
      proxy: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      proxyImplementation: implementation,
      owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      publisher: null,
      transactions: {
        implementation: { hash: `0x${"a".repeat(64)}`, blockNumber: 1 },
        proxy: { hash: `0x${"b".repeat(64)}`, blockNumber: 2 },
        publisher: null,
      },
    },
  };
}

test("builds a complete, hash-verified audit package", () => {
  const outDir = temporaryPackage();

  try {
    const built = buildAuditPackage({ outDir });
    const manifest = built.manifest;
    const baseline = computeBaseline();

    assert.equal(manifest.kind, AUDIT_PACKAGE_KIND);
    assert.equal(manifest.version, AUDIT_PACKAGE_VERSION);
    assert.equal(manifest.audit.status, "not-performed");
    assert.equal(manifest.audit.externalReviewNeeded, true);
    assert.equal(manifest.audit.liveDeploymentBlocked, true);
    assert.equal(manifest.audit.mainnetDeployment, "blocked");
    assert.equal(manifest.contract.source, SOURCE_REL);
    assert.equal(manifest.contract.sourceSha256, baseline.sourceSha256);
    assert.equal(manifest.artifacts.abiSha256, baseline.abiSha256);
    assert.equal(
      manifest.artifacts.runtimeBytecodeSha256,
      baseline.runtimeBytecodeSha256,
    );
    assert.match(manifest.artifacts.storageLayoutSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.checks.baselineMatches, true);
    assert.equal(manifest.checks.sourceMatchesBaseline, true);
    assert.equal(typeof manifest.git.dirty, "boolean");

    const source = manifest.files.find((entry) => entry.source === SOURCE_REL);
    assert.equal(source.sha256, baseline.sourceSha256);
    assert.ok(
      manifest.files.some(
        (entry) => entry.source === "contracts/test/anchor.test.mjs",
      ),
    );
    assert.ok(
      manifest.files.some(
        (entry) => entry.source === "apps/api/src/chains/relay.ts",
      ),
    );

    const readme = readFileSync(join(outDir, "README.md"), "utf8");
    assert.match(readme, /External audit: NOT PERFORMED/);
    assert.match(readme, /Live deployment: BLOCKED/);
    assert.match(readme, /npm run audit:package:verify/);

    const artifact = JSON.parse(
      readFileSync(join(outDir, "artifacts/RarextAnchor.json"), "utf8"),
    );
    assert.equal(artifact.contract, "RarextAnchor");
    assert.ok(artifact.abi.length > 0);
    assert.ok(artifact.creationBytecode.length > 0);
    assert.ok(artifact.runtimeBytecode.length > 0);
    assert.ok(artifact.storageLayout.storage.length > 0);

    const sums = readFileSync(join(outDir, "SHA256SUMS"), "utf8");
    assert.match(sums, /manifest\.json$/m);
    assert.match(sums, /README\.md$/m);
    assert.match(sums, /artifacts\/RarextAnchor\.json$/m);

    const verified = verifyAuditPackage(outDir);
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.ok, true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("refuses a package whose source or manifest was changed", () => {
  const outDir = temporaryPackage();

  try {
    buildAuditPackage({ outDir });
    appendFileSync(join(outDir, `files/${SOURCE_REL}`), "\n");

    const changed = verifyAuditPackage(outDir);
    assert.equal(changed.ok, false);
    assert.match(changed.problems.join("; "), /checksum mismatch/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("is deterministic for the same source and inputs", () => {
  const base = temporaryPackage();

  try {
    const first = buildAuditPackage({ outDir: join(base, "first") });
    const second = buildAuditPackage({ outDir: join(base, "second") });

    assert.equal(first.sha256Sums, second.sha256Sums);
    assert.deepEqual(first.manifest, second.manifest);
    assert.deepEqual(
      readFileSync(join(base, "first", "SHA256SUMS"), "utf8"),
      readFileSync(join(base, "second", "SHA256SUMS"), "utf8"),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("bundles and verifies a testnet deployment record", () => {
  const base = temporaryPackage();
  const outDir = join(base, "package");
  const recordPath = join(base, "anchor-testnet.json");

  try {
    const record = testnetRecord();
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const built = buildAuditPackage({ outDir, deploymentPath: recordPath });

    assert.equal(built.manifest.deployment.path, "deployment/record.json");
    assert.equal(built.manifest.deployment.chainId, record.deployment.chainId);
    assert.equal(built.manifest.deployment.proxy, record.deployment.proxy);

    const readme = readFileSync(join(outDir, "README.md"), "utf8");
    assert.match(readme, /deployment\/record\.json/);

    const verified = verifyAuditPackage(outDir);
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.ok, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
