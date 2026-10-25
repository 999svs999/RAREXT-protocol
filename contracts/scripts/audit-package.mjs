#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT } from "../lib/compile.mjs";
import {
  anchorArtifacts,
  AUDIT_PATH,
  compareBaseline,
  computeBaseline,
  recordedBaseline,
} from "./audit-baseline.mjs";
import { verifyDeploymentRecord } from "./verify-deployment-record.mjs";

export const AUDIT_PACKAGE_KIND = "rarext.anchor-audit-package";
export const AUDIT_PACKAGE_VERSION = 1;
export const DEFAULT_AUDIT_PACKAGE_DIR = join(
  ROOT,
  "dist/audit/rarext-anchor",
);
export const SOURCE_REL = "contracts/RarextAnchor.sol";

const INPUTS = [
  { path: ".nvmrc", role: "build" },
  { path: "apps/api/src/chains/relay.ts", role: "integration" },
  { path: "contracts/AUDIT.md", role: "audit" },
  { path: "contracts/README.md", role: "runbook" },
  { path: "contracts/RarextAnchor.sol", role: "contract" },
  { path: "contracts/lib/compile.mjs", role: "build" },
  { path: "contracts/scripts/audit-baseline.mjs", role: "build" },
  { path: "contracts/scripts/audit-package.mjs", role: "build" },
  { path: "contracts/scripts/deploy-anchor-testnet.mjs", role: "deployment" },
  { path: "contracts/scripts/deploy-anchor.mjs", role: "deployment" },
  { path: "contracts/scripts/verify-deployment-record.mjs", role: "deployment" },
  { path: "contracts/test/RarextAnchorV2.sol", role: "test-fixture" },
  { path: "contracts/test/anchor-deploy.test.mjs", role: "test" },
  { path: "contracts/test/anchor.test.mjs", role: "test" },
  { path: "contracts/test/audit-baseline.test.mjs", role: "test" },
  { path: "contracts/test/audit-package.test.mjs", role: "test" },
  { path: "contracts/test/helpers.mjs", role: "test" },
  { path: "contracts/test/verify-deployment-record.test.mjs", role: "test" },
  { path: "docs/CHAINS.md", role: "docs" },
  { path: "package-lock.json", role: "build" },
  { path: "package.json", role: "build" },
  { path: "scripts/ci.sh", role: "build" },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function posix(path) {
  return path.split(sep).join("/");
}

function packagePath(outDir, rel) {
  const target = resolve(outDir, rel);

  if (target !== outDir && !target.startsWith(`${outDir}${sep}`)) {
    throw new Error(`package path escapes the output directory: ${rel}`);
  }

  return target;
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function writeFile(outDir, rel, contents) {
  const target = packagePath(outDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function walkFiles(directory, prefix = "") {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);

    if (entry.isDirectory()) files.push(...walkFiles(path, rel));
    else if (entry.isFile()) files.push(rel);
  }

  return files.sort();
}

function inputEntries() {
  return INPUTS.map(({ path, role }) => {
    const bytes = readFileSync(join(ROOT, path));

    return {
      source: path,
      path: `files/${path}`,
      role,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function buildArtifact() {
  const artifacts = anchorArtifacts();
  const creation = artifacts.anchor.evm.bytecode.object;
  const runtime = artifacts.anchor.evm.deployedBytecode.object;
  const storageLayout = artifacts.anchor.storageLayout;

  if (!creation) throw new Error("compiler produced no creation bytecode");
  if (!runtime) throw new Error("compiler produced no runtime bytecode");
  if (!storageLayout) throw new Error("compiler produced no storage layout");

  const artifact = {
    contract: "RarextAnchor",
    source: SOURCE_REL,
    abi: artifacts.anchor.abi,
    creationBytecode: creation,
    runtimeBytecode: runtime,
    storageLayout,
  };

  return {
    artifact,
    hashes: {
      abiSha256: sha256(JSON.stringify(artifact.abi)),
      creationBytecodeSha256: sha256(Buffer.from(creation, "hex")),
      runtimeBytecodeSha256: sha256(Buffer.from(runtime, "hex")),
      storageLayoutSha256: sha256(JSON.stringify(storageLayout)),
    },
  };
}

function deploymentEntry(path, sourceSha256) {
  if (!path) return null;

  const record = JSON.parse(readFileSync(resolve(path), "utf8"));
  const result = verifyDeploymentRecord(record, { sourceSha256 });

  if (!result.ok) {
    throw new Error(
      `deployment record is not valid: ${result.problems.join("; ")}`,
    );
  }

  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);

  return {
    source: resolve(path),
    path: "deployment/record.json",
    bytes: bytes.length,
    sha256: sha256(bytes),
    record,
  };
}

function renderReadme(manifest) {
  const dirty =
    manifest.git.dirty === null
      ? "unknown"
      : manifest.git.dirty
        ? "**yes — this is an internal preview, not an external audit package**"
        : "no";
  const deployment = manifest.deployment
    ? `\`${manifest.deployment.path}\` (SHA-256 \`${manifest.deployment.sha256}\`)`
    : "none bundled";

  return `# RAREXT EVM anchor audit package

> **External audit: NOT PERFORMED.**
>
> **Auditor review: REQUIRED.**
>
> **Live deployment: BLOCKED.**

This is an audit input package, not an audit report. No external firm has
reviewed this contract, and no contract from this repository is live.

## Baseline

| Item | Value |
| --- | --- |
| Commit | \`${manifest.git.commit ?? "unknown"}\` |
| Working tree dirty | ${dirty} |
| Source | \`${manifest.contract.source}\` |
| Source SHA-256 | \`${manifest.contract.sourceSha256}\` |
| Git blob | \`${manifest.contract.gitBlob}\` |
| Creation bytecode SHA-256 | \`${manifest.contract.creationBytecodeSha256}\` |
| Runtime bytecode SHA-256 | \`${manifest.contract.runtimeBytecodeSha256}\` |
| ABI SHA-256 | \`${manifest.contract.abiSha256}\` |
| Storage layout SHA-256 | \`${manifest.artifacts.storageLayoutSha256}\` |
| Compiler | solc ${manifest.contract.toolchain.solc} |
| Optimizer | enabled, runs 200 |
| EVM target | ${manifest.contract.toolchain.evmVersion} |
| OpenZeppelin Contracts | ${manifest.contract.toolchain.openzeppelinContracts} |
| OpenZeppelin Upgradeable | ${manifest.contract.toolchain.openzeppelinContractsUpgradeable} |
| Deployment record | ${deployment} |

## Contents

- \`manifest.json\` — machine-readable hashes, toolchain, scope inputs, and status.
- \`README.md\` — this file.
- \`artifacts/RarextAnchor.json\` — ABI, creation/runtime bytecode, and storage layout.
- \`files/\` — the exact source, tests, scripts, runbooks, and relay file reviewed.
- \`deployment/record.json\` — only when a valid testnet record was supplied.
- \`SHA256SUMS\` — SHA-256 for every other file in the package.

The package uses an explicit input list. It does not copy environment files,
keys, deployment credentials, node_modules, or generated site data.

## Verify the package

From the repository checkout:

\`\`\`bash
npm run audit:package:verify -- path/to/rarext-anchor
\`\`\`

The verifier checks the manifest status flags, every file checksum, the source
hash, the compiled ABI/bytecode/storage-layout hashes, and that no extra files
were added. Record the SHA-256 of \`SHA256SUMS\` out of band when the package is
handed to an auditor.

## Reproduce the baseline

\`\`\`bash
npm ci
npm run audit:baseline
npm run test:contracts
\`\`\`

The baseline command recompiles with the checked-in settings and compares the
source, creation bytecode, runtime bytecode, and ABI against
\`files/contracts/AUDIT.md\`. The test suite runs the pinned contract tests and
the package verifier tests.

## Review inputs

Start with \`files/contracts/AUDIT.md\` for the scope, contract model, internal
findings, residual risks, manual checklist, deployment gate, and sign-off table.
The deploy and upgrade runbooks are in \`files/contracts/README.md\`. The EVM relay
read shape is in \`files/apps/api/src/chains/relay.ts\`.

## Limits

- A clean package is reproducible evidence of the included bytes, not approval.
- A dirty working tree cannot be tied to a reviewed commit; regenerate from a
  clean commit before an external review.
- A testnet deployment record is evidence of what was deployed, not evidence of
  an audit.
- This package does not authorize a mainnet deployment.
`;
}

export function buildAuditPackage({
  outDir = DEFAULT_AUDIT_PACKAGE_DIR,
  deploymentPath = null,
} = {}) {
  const output = resolve(outDir);
  const root = resolve(ROOT);

  if (output === root || root.startsWith(`${output}${sep}`) || output === resolve("/")) {
    throw new Error("refusing to replace the repository root or one of its parents");
  }

  if (existsSync(output)) {
    const entries = readdirSync(output);

    if (entries.length > 0 && !existsSync(join(output, "manifest.json"))) {
      throw new Error(
        `refusing to replace a non-package directory: ${output}`,
      );
    }

    rmSync(output, { recursive: true, force: true });
  }

  mkdirSync(output, { recursive: true });

  const baseline = computeBaseline();
  const recorded = recordedBaseline(readFileSync(AUDIT_PATH, "utf8"));
  const problems = compareBaseline(baseline, recorded);

  if (problems.length > 0) {
    throw new Error(
      `audit baseline does not match contracts/AUDIT.md: ${problems.join("; ")}`,
    );
  }

  const { artifact, hashes } = buildArtifact();
  const files = inputEntries();
  const source = files.find((entry) => entry.source === SOURCE_REL);

  if (!source) throw new Error(`missing input ${SOURCE_REL}`);
  if (source.sha256 !== baseline.sourceSha256) {
    throw new Error("packaged source does not match the recorded baseline");
  }

  const deployment = deploymentEntry(deploymentPath, baseline.sourceSha256);
  const commit = git(["rev-parse", "HEAD"]);
  const commitTime = git(["show", "-s", "--format=%cI", "HEAD"]);
  const status = git(["status", "--porcelain"]);

  const { contract: _contractName, ...baselineFields } = baseline;

  const manifest = {
    kind: AUDIT_PACKAGE_KIND,
    version: AUDIT_PACKAGE_VERSION,
    git: {
      commit,
      commitTime,
      dirty: status === null ? null : status.length > 0,
    },
    audit: {
      document: "contracts/AUDIT.md",
      status: "not-performed",
      externalReviewNeeded: true,
      liveDeploymentBlocked: true,
      mainnetDeployment: "blocked",
    },
    contract: {
      source: SOURCE_REL,
      ...baselineFields,
    },
    artifacts: {
      path: "artifacts/RarextAnchor.json",
      ...hashes,
    },
    files,
    deployment: deployment
      ? {
          path: deployment.path,
          bytes: deployment.bytes,
          sha256: deployment.sha256,
          chainId: deployment.record.deployment.chainId,
          proxy: deployment.record.deployment.proxy,
        }
      : null,
    checks: {
      baselineMatches: true,
      sourceMatchesBaseline: true,
    },
    reproduce: [
      "npm ci",
      "npm run audit:baseline",
      "npm run test:contracts",
      "npm run audit:package",
      "npm run audit:package:verify -- dist/audit/rarext-anchor",
    ],
  };

  for (const entry of files) {
    writeFile(output, entry.path, readFileSync(join(ROOT, entry.source)));
  }

  if (deployment) {
    writeFile(output, deployment.path, `${JSON.stringify(deployment.record, null, 2)}\n`);
  }

  writeFile(
    output,
    "artifacts/RarextAnchor.json",
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  writeFile(output, "README.md", renderReadme(manifest));
  writeFile(output, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const sums = walkFiles(output)
    .filter((rel) => rel !== "SHA256SUMS")
    .map((rel) => `${hashFile(join(output, rel))}  ${rel}`)
    .join("\n");

  writeFile(output, "SHA256SUMS", `${sums}\n`);

  return {
    outDir: output,
    manifest,
    sha256Sums: hashFile(join(output, "SHA256SUMS")),
  };
}

function readManifest(outDir) {
  return JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
}

function verifySums(outDir, problems) {
  const sumsPath = join(outDir, "SHA256SUMS");

  if (!existsSync(sumsPath)) {
    problems.push("SHA256SUMS is missing");
    return;
  }

  const listed = new Map();
  const lines = readFileSync(sumsPath, "utf8").trim().split("\n");

  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);

    if (!match) {
      problems.push(`invalid SHA256SUMS line: ${line}`);
      continue;
    }

    const [, hash, rel] = match;

    if (listed.has(rel)) {
      problems.push(`duplicate SHA256SUMS entry: ${rel}`);
      continue;
    }

    listed.set(rel, hash);
  }

  const actual = new Set(walkFiles(outDir));

  for (const rel of listed.keys()) {
    if (rel === "SHA256SUMS" || rel.includes("..")) {
      problems.push(`invalid SHA256SUMS path: ${rel}`);
      continue;
    }

    if (!actual.has(rel)) {
      problems.push(`SHA256SUMS lists a missing file: ${rel}`);
      continue;
    }

    const hash = hashFile(join(outDir, rel));

    if (hash !== listed.get(rel)) {
      problems.push(`checksum mismatch: ${rel}`);
    }
  }

  for (const rel of actual) {
    if (rel !== "SHA256SUMS" && !listed.has(rel)) {
      problems.push(`file is not covered by SHA256SUMS: ${rel}`);
    }
  }

  for (const required of ["manifest.json", "README.md", "artifacts/RarextAnchor.json"]) {
    if (!listed.has(required)) problems.push(`SHA256SUMS is missing ${required}`);
  }
}

function verifyDeployment(outDir, manifest, problems) {
  if (manifest.deployment === null) return;

  const entry = manifest.deployment;

  if (
    typeof entry !== "object" ||
    typeof entry.path !== "string" ||
    typeof entry.sha256 !== "string" ||
    typeof entry.chainId !== "string" ||
    typeof entry.proxy !== "string"
  ) {
    problems.push("manifest.deployment is malformed");
    return;
  }

  if (!entry.path.startsWith("deployment/") || entry.path.includes("..")) {
    problems.push(`invalid deployment path: ${entry.path}`);
    return;
  }

  const path = packagePath(outDir, entry.path);

  if (!existsSync(path)) {
    problems.push(`deployment record is missing: ${entry.path}`);
    return;
  }

  const bytes = readFileSync(path);

  if (sha256(bytes) !== entry.sha256) {
    problems.push("deployment record checksum mismatch");
    return;
  }

  let record;

  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    problems.push("deployment record is not valid JSON");
    return;
  }

  const result = verifyDeploymentRecord(record, {
    sourceSha256: manifest.contract?.sourceSha256,
  });

  for (const problem of result.problems) {
    problems.push(`deployment record: ${problem}`);
  }

  if (record.deployment?.chainId !== entry.chainId) {
    problems.push("manifest.deployment.chainId does not match the record");
  }
  if (record.deployment?.proxy !== entry.proxy) {
    problems.push("manifest.deployment.proxy does not match the record");
  }
}

function verifyArtifact(outDir, manifest, problems) {
  const artifactPath = join(outDir, "artifacts/RarextAnchor.json");

  if (!existsSync(artifactPath)) {
    problems.push("artifacts/RarextAnchor.json is missing");
    return;
  }

  let artifact;

  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    problems.push("artifacts/RarextAnchor.json is not valid JSON");
    return;
  }

  const recorded = manifest.artifacts ?? {};
  const actual = {
    abiSha256: sha256(JSON.stringify(artifact.abi)),
    creationBytecodeSha256: sha256(
      Buffer.from(String(artifact.creationBytecode ?? ""), "hex"),
    ),
    runtimeBytecodeSha256: sha256(
      Buffer.from(String(artifact.runtimeBytecode ?? ""), "hex"),
    ),
    storageLayoutSha256: sha256(JSON.stringify(artifact.storageLayout)),
  };

  for (const [field, value] of Object.entries(actual)) {
    if (recorded[field] !== value) {
      problems.push(
        `${field}: manifest records ${recorded[field]}, artifact has ${value}`,
      );
    }
  }
}

export function verifyAuditPackage(outDir = DEFAULT_AUDIT_PACKAGE_DIR) {
  const output = resolve(outDir);
  const problems = [];
  let manifest;

  if (!existsSync(output)) {
    return { ok: false, problems: [`package directory is missing: ${output}`] };
  }

  try {
    manifest = readManifest(output);
  } catch {
    return { ok: false, problems: ["manifest.json is missing or invalid JSON"] };
  }

  if (manifest.kind !== AUDIT_PACKAGE_KIND) {
    problems.push(`kind must be ${AUDIT_PACKAGE_KIND}`);
  }
  if (manifest.version !== AUDIT_PACKAGE_VERSION) {
    problems.push(`version must be ${AUDIT_PACKAGE_VERSION}`);
  }
  if (manifest.audit?.status !== "not-performed") {
    problems.push("audit.status must be not-performed");
  }
  if (manifest.audit?.externalReviewNeeded !== true) {
    problems.push("audit.externalReviewNeeded must be true");
  }
  if (manifest.audit?.liveDeploymentBlocked !== true) {
    problems.push("audit.liveDeploymentBlocked must be true");
  }
  if (manifest.audit?.mainnetDeployment !== "blocked") {
    problems.push("audit.mainnetDeployment must be blocked");
  }
  if (manifest.checks?.baselineMatches !== true) {
    problems.push("checks.baselineMatches must be true");
  }
  if (manifest.checks?.sourceMatchesBaseline !== true) {
    problems.push("checks.sourceMatchesBaseline must be true");
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const seen = new Set();

  if (files.length === 0) problems.push("manifest.files must not be empty");

  for (const entry of files) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      typeof entry.source !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      problems.push("manifest.files contains a malformed entry");
      continue;
    }

    if (!entry.path.startsWith("files/") || entry.path.includes("..")) {
      problems.push(`invalid packaged file path: ${entry.path}`);
      continue;
    }

    if (seen.has(entry.path)) {
      problems.push(`duplicate packaged file path: ${entry.path}`);
      continue;
    }

    seen.add(entry.path);

    const path = packagePath(output, entry.path);

    if (!existsSync(path)) {
      problems.push(`packaged file is missing: ${entry.path}`);
      continue;
    }

    const bytes = readFileSync(path);

    if (bytes.length !== entry.bytes) {
      problems.push(`byte length mismatch: ${entry.path}`);
    }
    if (sha256(bytes) !== entry.sha256) {
      problems.push(`checksum mismatch: ${entry.path}`);
    }
  }

  const source = files.find((entry) => entry.source === SOURCE_REL);

  if (!source) {
    problems.push(`manifest.files must include ${SOURCE_REL}`);
  } else if (source.sha256 !== manifest.contract?.sourceSha256) {
    problems.push("packaged source does not match contract.sourceSha256");
  }

  for (const field of [
    "sourceSha256",
    "creationBytecodeSha256",
    "runtimeBytecodeSha256",
    "abiSha256",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(String(manifest.contract?.[field] ?? ""))) {
      problems.push(`contract.${field} must be a lowercase SHA-256 digest`);
    }
  }

  if (!/^[0-9a-f]{40}$/.test(String(manifest.contract?.gitBlob ?? ""))) {
    problems.push("contract.gitBlob must be a lowercase Git blob id");
  }

  if (!/^[0-9a-f]{64}$/.test(String(manifest.artifacts?.storageLayoutSha256 ?? ""))) {
    problems.push("artifacts.storageLayoutSha256 must be a lowercase SHA-256 digest");
  }

  verifyArtifact(output, manifest, problems);
  verifyDeployment(output, manifest, problems);
  verifySums(output, problems);

  return { ok: problems.length === 0, problems, manifest };
}

function usage() {
  return `usage:
  node contracts/scripts/audit-package.mjs [--out <directory>] [--deployment <record.json>]
  node contracts/scripts/audit-package.mjs --verify [<directory>]

The default output is ${DEFAULT_AUDIT_PACKAGE_DIR}`;
}

function parseArgs(argv) {
  let outDir = DEFAULT_AUDIT_PACKAGE_DIR;
  let deploymentPath = null;
  let verify = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--verify") {
      verify = true;

      if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
        outDir = argv[index + 1];
        index += 1;
      }
    } else if (arg === "--out") {
      outDir = argv[index + 1];
      if (!outDir) throw new Error("--out requires a directory");
      index += 1;
    } else if (arg === "--deployment") {
      deploymentPath = argv[index + 1];
      if (!deploymentPath) throw new Error("--deployment requires a record path");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { outDir, deploymentPath, verify };
}

function main() {
  const { outDir, deploymentPath, verify } = parseArgs(process.argv.slice(2));

  if (verify) {
    const result = verifyAuditPackage(outDir);

    if (!result.ok) {
      console.error("audit package is not valid:");
      for (const problem of result.problems) console.error(`- ${problem}`);
      process.exitCode = 1;
      return;
    }

    console.log(`audit package verified: ${resolve(outDir)}`);
    console.log(`commit: ${result.manifest.git.commit ?? "unknown"}`);
    console.log(`source: ${result.manifest.contract.sourceSha256}`);
    console.log("audit: not performed; live deployment: blocked");
    return;
  }

  const result = buildAuditPackage({ outDir, deploymentPath });

  console.log(`audit package: ${result.outDir}`);
  console.log(`commit: ${result.manifest.git.commit ?? "unknown"}`);
  console.log(
    `working tree dirty: ${
      result.manifest.git.dirty === null
        ? "unknown"
        : result.manifest.git.dirty
          ? "yes (internal preview)"
          : "no"
    }`,
  );
  console.log(`source: ${result.manifest.contract.sourceSha256}`);
  console.log(`runtime bytecode: ${result.manifest.artifacts.runtimeBytecodeSha256}`);
  console.log(`SHA256SUMS: ${result.sha256Sums}`);
  console.log("audit: not performed; live deployment: blocked");
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";

if (invoked === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `audit-package: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
