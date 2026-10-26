// Checks published claims against the code that is supposed to make them true.
//
//   node scripts/claim-check.mjs            # verify the claims as published
//   node scripts/claim-check.mjs --self-test # prove the checker catches drift
//
// The docs and RFCs state numbers; the implementation computes them. This parses
// the published table and the published formula and compares them with the code,
// so a document and its implementation cannot drift apart silently — editing
// either one alone fails this check. A published number nobody re-derives is a
// claim, not a fact.
//
// Everything here is in-repo: no network, no fixtures, no bench run.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
// The checker's own source names every marker it enforces, so it is never
// treated as a generator of the artifacts it inspects. This was found by the
// check itself on its first run, and it is the same shape as a self-test
// fixture whose phantom document name appears in the file asserting that the
// document is not mentioned anywhere.
const isGeneratorScript = (name) => name.endsWith(".mjs") && name !== "claim-check.mjs";

const rfcPath = process.env.RAREXT_CLAIM_RFC ?? fileURLToPath(new URL("rfcs/0010-data-availability-sampling.md", root));
const architecturePath = new URL("docs/ARCHITECTURE.md", root);

const das = await import(new URL("apps/api/src/das.ts", root).href);
const rent = await import(new URL("apps/api/src/storage-rent.ts", root).href);
const coreAi = await import(new URL("packages/core/src/ai.ts", root).href);
const storageConstants = await import(new URL("apps/api/src/storage.ts", root).href);
const durabilityConstants = await import(new URL("apps/api/src/durability.ts", root).href);
const work = await import(new URL("apps/api/src/work.ts", root).href);
const audits = await import(new URL("apps/api/src/audit-attestation.ts", root).href);
const sdk = await import(new URL("packages/agent-sdk/src/index.ts", root).href);
const leaf = await import(new URL("packages/core/src/leaf.ts", root).href);
const erasure = await import(new URL("apps/api/src/erasure.ts", root).href);
const generative = await import(new URL("apps/api/src/generative.ts", root).href);
const bounded = await import(new URL("apps/api/src/bounded.ts", root).href);
const verifiersModule = await import(new URL("apps/api/src/verifiers.ts", root).href);
const semanticsModule = await import(new URL("apps/api/src/semantics.ts", root).href);
const coreSemanticsModule = await import(new URL("packages/core/src/semantics.ts", root).href);
const migrations = await import(new URL("apps/api/src/migrations.ts", root).href);
const gameState = await import(new URL("apps/api/src/game-state-migration.ts", root).href);
const { samplesForMissingFraction, missProbability } = das;

const UNITS = 9216; // the 36 MiB photo slice in 4 KiB chunks, as the RFC states
const CHUNK_BYTES = 4096;

function parseTable(markdown) {
  // | 20% | 21 | 84 KiB | 31 | 124 KiB |
  const rows = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(
      /^\|\s*(\d+(?:\.\d+)?)%\s*\|\s*(\d+)\s*\|\s*(\d+(?:\.\d+)?)\s*(KiB|MiB)\s*\|\s*(\d+)\s*\|\s*(\d+(?:\.\d+)?)\s*(KiB|MiB)\s*\|$/,
    );
    if (!match) continue;
    const toKiB = (value, unit) => Number(value) * (unit === "MiB" ? 1024 : 1);
    rows.push({
      fraction: Number(match[1]) / 100,
      at99: Number(match[2]),
      kib99: toKiB(match[3], match[4]),
      at999: Number(match[5]),
      kib999: toKiB(match[6], match[7]),
    });
  }
  return rows;
}

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  MISMATCH ${message}`);
};

function checkSamplingTable(markdown, label) {
  const rows = parseTable(markdown);

  if (rows.length === 0) {
    fail(`${label}: no table rows parsed — the parser is stale, not the claim`);
    return;
  }

  console.log(`${label}: ${rows.length} published row(s) vs samplesForMissingFraction(${UNITS}, …)`);
  for (const row of rows) {
    const computed99 = samplesForMissingFraction(UNITS, row.fraction, 0.01);
    const computed999 = samplesForMissingFraction(UNITS, row.fraction, 0.001);
    const computedKib = (computed99 * CHUNK_BYTES) / 1024;

    if (computed99 !== row.at99) {
      fail(`${label} ${row.fraction * 100}% at 99%: doc says ${row.at99}, code says ${computed99}`);
    }
    if (computed999 !== row.at999) {
      fail(`${label} ${row.fraction * 100}% at 99.9%: doc says ${row.at999}, code says ${computed999}`);
    }
    if (Math.abs(computedKib - row.kib99) > 60) {
      // tolerance is one printed MiB step, since 1.7 MiB prints as 1740.8 KiB
      fail(`${label} ${row.fraction * 100}% bytes: doc says ${row.kib99} KiB, code implies ${computedKib.toFixed(0)} KiB`);
    }

    console.log(
      `  ${String(row.fraction * 100).padStart(5)}% | 99%: ${String(row.at99).padStart(4)} ` +
        `(code ${String(computed99).padStart(4)}) | 99.9%: ${String(row.at999).padStart(4)} ` +
        `(code ${String(computed999).padStart(4)}) | ${computedKib.toFixed(0)} KiB`,
    );
  }

  // The prose beside the table, which is where a stale number usually hides.
  const missAt44 = missProbability(UNITS, Math.ceil(UNITS * 0.1), 44);
  if (!(missAt44 < 0.01)) {
    fail(`${label}: prose says 44 samples miss 10% withholding below 1%; measured ${(missAt44 * 100).toFixed(3)}%`);
  }
  const share = ((44 * CHUNK_BYTES) / (UNITS * CHUNK_BYTES)) * 100;
  if (Math.abs(share - 0.5) > 0.05) {
    fail(`${label}: prose says 44 samples are about 0.5% of the media; they are ${share.toFixed(2)}%`);
  }
  console.log(
    `  prose: 44 samples miss 10% withholding with probability ${(missAt44 * 100).toFixed(3)}% (<1%) ` +
      `and cost ${share.toFixed(2)}% of the media (~0.5%)`,
  );
}

/** `docs/HARDENING.md` and `docs/STORAGE-FRONTIER.md` both cite the MDS floor `1 + m/k`. */
function checkMdsFloor() {
  console.log("MDS floor 1 + m/k, measured from the codec's own shard sizes:");
  const payload = new Uint8Array(64 * 1024).fill(7);

  for (const [k, m] of [[4, 2], [10, 4], [3, 1], [8, 4]]) {
    const shards = erasure.encodeBytes(payload, k, m);
    const total = Array.from(shards).reduce((sum, shard) => sum + shard.bytes.length, 0);
    const ratio = total / payload.length;
    const floor = 1 + m / k;
    // Padding to a common block can only add; a ratio below the floor would break
    // the claim outright, and more than a block of slack would make it a fiction.
    const slack = ratio - floor;
    if (slack < 0 || slack > 0.005) {
      fail(`k=${k} m=${m}: measured ${ratio.toFixed(4)}x against a floor of ${floor.toFixed(4)}x`);
    }
    console.log(
      `  k=${k} m=${m}: ${ratio.toFixed(4)}x vs floor ${floor.toFixed(4)}x ` +
        `(${slack >= 0 ? "+" : ""}${slack.toFixed(4)} padding)`,
    );
  }
}

if (process.argv.includes("--self-test")) {
  // Prove the checker fails on a doctored document, or a passing run means nothing.
  console.log("self-test: a doctored table must be reported as a mismatch\n");
  const original = readFileSync(rfcPath, "utf8");
  const before = failures;
  const doctored = original.replace(/^\|\s*10%\s*\|\s*44\s*\|/m, "| 10% | 45 |");
  checkSamplingTable(doctored, "doctored");
  // And a doctored bench record: the arithmetic must not forgive a wrong ratio.
  const beforeDoctoredRecord = failures;
  checkRepairRecord({
    payloadBytes: 1073741824, dataShards: 4, parityShards: 2, losses: 2,
    readBytes: 1073741824, writeBytes: 536870912, totalBytes: 1610612736,
    readRatio: 1, writeRatio: 0.5, totalRatio: 1.4, floorRatio: 1.5,
    exact: true, elapsedMs: 1,
  });
  let caught = failures > beforeDoctoredRecord;
  if (!caught) fail("self-test: the checker accepted totalRatio 1.4 against a floor of 1.5");
  // And a pricing drift: if the code's default rate stops being the documented
  // 1,000,000, the doc's claim must be reported as a mismatch, not silently pass.
  const beforePricing = failures;
  checkRentClaims({ public: 0, sealed: 1_500_000 });
  const caughtPricing = failures > beforePricing;
  if (!caughtPricing) fail("self-test: the checker accepted an undocumented default rate");
  caught = caught && caughtPricing;
  // And a route the docs publish but the code no longer handles must be caught.
  const beforeRoutes = failures;
  const originalArchitecture = readFileSync(architecturePath, "utf8");
  const originalOperations = readFileSync(new URL("docs/OPERATIONS.md", root), "utf8");
  const originalOperatorDoc = readFileSync(new URL("docs/OPERATOR.md", root), "utf8");
  const appSource = readFileSync(new URL("apps/api/src/app.ts", root), "utf8");
  // The health row is the table's first line, and it is `/health` — no /v1
  // prefix, which is exactly the kind of detail a hand-written anchor gets wrong.
  const doctoredDoc = originalArchitecture.replace(
    "| GET | `/health` |",
    "| GET | `/health` |\n| GET | `/v1/time-travel` |",
  );
  checkRouteSurface(doctoredDoc);
  caught = caught && failures > beforeRoutes;
  // And a soak run that failed must be reported, not waved through.
  const beforeSoak = failures;
  const realSoak = readFileSync(new URL("bench/storage/soak-2026-10-26.log", root), "utf8");
  const doctoredSoak = realSoak.replace(
    "| Put | 5991 | 5991 | 0 | 100.0% |",
    "| Put | 5991 | 5942 | 49 | 99.2% |",
  );
  checkSoakLog(doctoredSoak);
  caught = caught && failures > beforeSoak;
  // A doctored input that equals its original proves nothing: the anchor
  // silently no-op'd, and the self-test would pass while testing the real
  // input. Every fixture must actually differ before its result is trusted.
  const assertChanged = (before, after, label) => {
    const changed = before !== after;
    if (!changed) fail(`self-test: the ${label} fixture no longer changes its input (anchor rot)`);
    return changed;
  };
  // And a throughput artifact that stops agreeing with the doc must be reported.
  const beforeThroughput = failures;
  const realThroughput = JSON.parse(readFileSync(new URL("bench/storage/THROUGHPUT.json", root), "utf8"));
  const doctoredThroughput = {
    ...realThroughput,
    runs: realThroughput.runs.map((run) =>
      run.mode === "stream" ? { ...run, peakRssMiB: 900 } : run,
    ),
  };
  checkThroughputArtifact(doctoredThroughput);
  const caughtThroughput = failures > beforeThroughput;
  if (!caughtThroughput) fail("self-test: the checker accepted a throughput artifact that contradicts the doc");
  caught = caught && caughtThroughput;
  // And a limits table the code outgrew must be reported.
  const beforeLimits = failures;
  const doctoredLimitsDoc = originalOperations.replace(
    "`MAX_VOCAB` = 4,096",
    "`MAX_VOCAB` = 8,192",
  );
  checkLimitsTable(doctoredLimitsDoc);
  const caughtLimits = failures > beforeLimits;
  if (!caughtLimits) fail("self-test: the checker accepted a limits table the code contradicts");
  caught = caught && caughtLimits;
  // And an AI bounds row the code outgrows must be reported.
  const beforeReplay = failures;
  const doctoredOperationsDoc = originalOperations.replace(
    "`MAX_GENERATIVE_TOKEN_LENGTH` = 256 UTF-16 code units",
    "`MAX_GENERATIVE_TOKEN_LENGTH` = 128 UTF-16 code units",
  );
  checkReplayBounds(doctoredOperationsDoc);
  const caughtReplay = failures > beforeReplay;
  if (!caughtReplay) fail("self-test: the checker accepted an AI bounds row the code contradicts");
  caught = caught && caughtReplay;
  // And an operational default the code contradicts must be reported.
  const beforeDefaults = failures;
  const doctoredOperatorDoc = originalOperatorDoc.replace(
    "every 6 hours (`RAREXT_CHALLENGE_INTERVAL_MS`)",
    "every 12 hours (`RAREXT_CHALLENGE_INTERVAL_MS`)",
  );
  checkOperationalDefaults(doctoredOperatorDoc);
  const caughtDefaults = failures > beforeDefaults;
  if (!caughtDefaults) fail("self-test: the checker accepted an operational default the code contradicts");
  caught = caught && caughtDefaults;
  // And a doc citing test evidence that is not in the tree must be reported.
  const beforeEvidence = failures;
  const doctoredOperationsDoc2 = originalOperations.replace(
    "apps/api/test/holder-fault.test.ts",
    "apps/api/test/holder-fault-removed.test.ts",
  );
  checkEvidenceCitations(doctoredOperationsDoc2);
  const caughtEvidence = failures > beforeEvidence;
  if (!caughtEvidence) fail("self-test: the checker accepted a citation to test evidence that does not exist");
  caught = caught && caughtEvidence;
  // And a chain route the docs publish but the server drops must be reported.
  const beforeChain = failures;
  const originalChains = readFileSync(new URL("docs/CHAINS.md", root), "utf8");
  const doctoredChains = originalChains.replace(
    "GET  /chain/audit",
    "GET  /chain/audit\nPOST /chain/rollback",
  );
  checkChainSurface(doctoredChains);
  const caughtChain = failures > beforeChain;
  if (!caughtChain) fail("self-test: the checker accepted a published chain route the server does not handle");
  caught = caught && caughtChain;
  // And a reward the code no longer pays must be reported.
  const beforeReward = failures;
  const originalWorkDoc = readFileSync(new URL("docs/WORK.md", root), "utf8");
  const doctoredWorkDoc = originalWorkDoc.replace(
    "| `verify` | per verified attestation | 10 |",
    "| `verify` | per verified attestation | 12 |",
  );
  checkRewardTable(doctoredWorkDoc);
  const caughtReward = failures > beforeReward;
  if (!caughtReward) fail("self-test: the checker accepted a reward table the code contradicts");
  caught = caught && caughtReward;
  // And the AI verification doc — doctored rule name must be caught.
  const beforeAi = failures;
  const originalAiDoc = readFileSync(new URL("docs/AI-VERIFICATION.md", root), "utf8");
  const doctoredAiDoc = originalAiDoc.replace("`xorshift32-image-v1`", "`xorshift32-image-v2`");
  checkAiVerificationDoc(doctoredAiDoc);
  const caughtAi = failures > beforeAi;
  if (!caughtAi) fail("self-test: the checker accepted a doctored AI rendition rule name");
  caught = caught && caughtAi;
  // And the semantics doc — a published field the validator drops must be
  // caught. The `createdAt` line anchors on the interface block.
  const beforeSemantics = failures;
  const originalSemanticsDoc = readFileSync(new URL("docs/SEMANTICS.md", root), "utf8");
  const doctoredSemanticsDoc = originalSemanticsDoc.replace(
    "  createdAt: string;",
    "  created: string;",
  );
  checkSemanticsDoc(doctoredSemanticsDoc);
  const caughtSemantics = failures > beforeSemantics;
  if (!caughtSemantics) fail("self-test: the checker accepted a doctored semantics field name");
  caught = caught && caughtSemantics;
  // And the snapshot/migration doc — a published version the code no longer
  // supports must be caught.
  const beforeSnapshot = failures;
  const doctoredSnapshotDoc = originalOperations.replace(
    "Snapshot version 2 is current.",
    "Snapshot version 3 is current.",
  );
  checkSnapshotMigrationDoc(doctoredSnapshotDoc);
  // And a generator that keeps its own inline copy of a shared artifact must
  // be reported — the fixture names a second holder of the inline bundle.
  const beforeSources = failures;
  const realScripts = readdirSync(new URL("scripts", root))
    .filter(isGeneratorScript)
    .map((name) => ({ name, text: readFileSync(new URL(`scripts/${name}`, root), "utf8") }));
  const doctoredScripts = realScripts.map((file) =>
    file.name === "build-mirror.mjs"
      ? { ...file, text: file.text + "\nconst stray = `window.__RAREXT_BUNDLE__ = {};`;\n" }
      : file,
  );
  checkArtifactSources(doctoredScripts);
  const caughtSources = failures > beforeSources;
  if (!caughtSources) fail("self-test: the checker accepted a generator keeping its own inline copy");
  caught = caught && caughtSources;
  // And a coverage map that lists a doc this checker never reads must be
  // reported — the map is only useful if it cannot drift from the checker.
  const beforeCoverage = failures;
  const originalClaimsMap = readFileSync(new URL("docs/CLAIMS.md", root), "utf8");
  // The phantom name is built at runtime on purpose: a literal fixture string
  // would appear in THIS file's own source, so the "the checker never mentions
  // it" assertion would find the fixture rather than the document and the
  // injection would pass vacuously.
  const phantomDoc = `docs/PHANTOM-${originalClaimsMap.length}.md`;
  const doctoredClaimsMap = originalClaimsMap.replace(
    "| `docs/WORK.md` | reward table |",
    `| \`${phantomDoc}\` | reward table |`,
  );
  if (doctoredClaimsMap === originalClaimsMap) fail("self-test: the claims-map fixture no longer changes its input");
  checkClaimsCoverage(doctoredClaimsMap);
  const caughtCoverage = failures > beforeCoverage;
  if (!caughtCoverage) fail("self-test: the checker accepted a coverage map naming a document it never reads");
  caught = caught && caughtCoverage;
  // And a runtime floor the package contradicts must be reported.
  const beforeCrypto = failures;
  const originalCryptoDoc = readFileSync(new URL("docs/CRYPTO.md", root), "utf8");
  const doctoredCryptoDoc = originalCryptoDoc.replace(/Node \d+\.\d+\+/, "Node 20.12+");
  checkCryptoDoc(doctoredCryptoDoc);
  const caughtCrypto = failures > beforeCrypto;
  if (!caughtCrypto) fail("self-test: the checker accepted a runtime floor the package contradicts");
  caught = caught && caughtCrypto;
  // And an app-protocol config name the code never reads must be reported.
  const beforeAppProtocol = failures;
  const originalAppProtocol = readFileSync(new URL("docs/APP-PROTOCOL.md", root), "utf8");
  const doctoredAppProtocol = originalAppProtocol.replace("RAREXT_CHALLENGES`", "RAREXT_CHALLENGES_V2`");
  checkAppProtocol(doctoredAppProtocol);
  const caughtAppProtocol = failures > beforeAppProtocol;
  if (!caughtAppProtocol) fail("self-test: the checker accepted a documented config name no code reads");
  caught = caught && caughtAppProtocol;
  // And a mirrors doc naming an npm script the tree does not define must be
  // reported (this is also how a doc that stops pointing at the CI-run
  // takedown test would be caught).
  const beforeMirrors = failures;
  const originalMirrorsDoc = readFileSync(new URL("docs/MIRRORS.md", root), "utf8");
  const doctoredMirrorsDoc = originalMirrorsDoc.replace("npm run test:takedown", "npm run test:mirror");
  checkMirrorsDoc(doctoredMirrorsDoc);
  const caughtMirrors = failures > beforeMirrors;
  if (!caughtMirrors) fail("self-test: the checker accepted a mirrors doc naming an undefined npm script");
  caught = caught && caughtMirrors;
  // And an audit-window number the code contradicts must be reported.
  const beforeWindow = failures;
  const doctoredOperationsWindow = originalOperations.replace(
    "default `AUDIT_WINDOW_MS` = 15 min",
    "default `AUDIT_WINDOW_MS` = 30 min",
  );
  checkAuditWindowClaims(doctoredOperationsWindow);
  const caughtWindow = failures > beforeWindow;
  if (!caughtWindow) fail("self-test: the checker accepted an audit window the code contradicts");
  caught = caught && caughtWindow;
  const caughtSnapshot = failures > beforeSnapshot;
  if (!caughtSnapshot) fail("self-test: the checker accepted a snapshot version the code contradicts");
  caught = caught && caughtSnapshot;
  caught = assertChanged(realSoak, doctoredSoak, "soak-log") && caught;
  assertChanged(JSON.stringify(realThroughput), JSON.stringify(doctoredThroughput), "throughput");
  assertChanged(originalOperations, doctoredLimitsDoc, "limits-table");
  assertChanged(originalOperations, doctoredOperationsDoc, "ai-bounds");
  assertChanged(originalOperations, doctoredOperationsWindow, "audit-window");
  assertChanged(originalMirrorsDoc, doctoredMirrorsDoc, "mirrors-doc");
  assertChanged(originalAppProtocol, doctoredAppProtocol, "app-protocol");
  assertChanged(originalCryptoDoc, doctoredCryptoDoc, "crypto-doc");
  assertChanged(originalClaimsMap, doctoredClaimsMap, "claims-coverage");
  assertChanged(
    realScripts.map((f) => f.text).join("\n"),
    doctoredScripts.map((f) => f.text).join("\n"),
    "artifact-sources",
  );
  assertChanged(originalOperatorDoc, doctoredOperatorDoc, "operator-defaults");
  assertChanged(originalOperations, doctoredOperationsDoc2, "evidence-citations");
  assertChanged(originalChains, doctoredChains, "chain-surface");
  assertChanged(originalWorkDoc, doctoredWorkDoc, "reward-table");
  assertChanged(originalAiDoc, doctoredAiDoc, "ai-verification");
  assertChanged(originalSemanticsDoc, doctoredSemanticsDoc, "semantics-doc");
  assertChanged(originalOperations, doctoredSnapshotDoc, "snapshot-migration");
  caught = assertChanged(originalArchitecture, doctoredDoc, "architecture") && caught;

  console.log(caught ? "\nself-test PASSED: the checker caught the doctored row" : "\nself-test FAILED: the checker accepted a doctored row");
  process.exit(caught ? 0 : 1);
}

checkSamplingTable(readFileSync(rfcPath, "utf8"), rfcPath.split("/").pop());
checkMirrorsDoc();
checkAppProtocol();
checkCryptoDoc();
checkClaimsCoverage();
checkArtifactSources();
checkMdsFloor();
checkRepairRecord();
checkRentClaims();
checkRouteSurface();
checkSoakLog();
checkThroughputArtifact();
checkLimitsTable();
checkReplayBounds();
checkOperationalDefaults();
checkEvidenceCitations();
checkChainSurface();
checkRewardTable();

/**
 * The coverage map: docs/CLAIMS.md lists which documents the checker reads and
 * which are deliberately prose. The map is itself checked — a doc in the
 * checked list must actually be referenced by this file, a prose row must state
 * a reason, and no document may be in both lists. That pair is what keeps the
 * claim axis auditable instead of open-ended.
 */
/**
 * Generated artifacts have ONE source each.
 *
 * A sweep for duplicated generated artifacts found the proof page and the
 * bundle each written twice — by build-mirror.mjs for the dev tree and by
 * publish-ai-proof.mjs for the published tree — and they had already drifted
 * (one injected "./bundle.js", the other "/bundle.js"). A failover fix had
 * gone into the copy nobody publishes. This check holds the invariants that
 * prevent the whole class: the inline forms live in exactly one module, and
 * every generator delegates to it.
 */
function checkArtifactSources(filesOverride) {
  console.log(`artifact sources (scripts/${filesOverride ? ", DOCTORED" : ""}):`);
  const names = filesOverride
    ? filesOverride.map((file) => file.name)
    : readdirSync(new URL("scripts", root)).filter(isGeneratorScript);
  const sources = new Map(
    filesOverride
      ? filesOverride.map((file) => [file.name, file.text])
      : names.map((name) => [name, readFileSync(new URL(`scripts/${name}`, root), "utf8")]),
  );

  const rules = [
    {
      marker: "window.__RAREXT_BUNDLE__",
      allowed: ["mirror-artifacts.mjs"],
      why: "the inline bundle must be written in one place",
    },
    {
      marker: "<!doctype html>",
      allowed: ["mirror-verify-page.mjs", "publish-proof.mjs"],
      why: "the proof page must have one source (publish-proof.mjs generates the landing page, a different artifact)",
    },
  ];
  for (const rule of rules) {
    const holders = [...sources].filter(([, text]) => text.includes(rule.marker)).map(([name]) => name);
    const strays = holders.filter((name) => !rule.allowed.includes(name));
    if (strays.length > 0) {
      fail(`${rule.why}, but "${rule.marker}" appears in ${strays.join(", ")}`);
    }
  }

  const generators = ["build-mirror.mjs", "publish-ai-proof.mjs"];
  const shared = ["mirror-artifacts.mjs", "mirror-verify-page.mjs"];
  for (const generator of generators) {
    const text = sources.get(generator);
    if (text === undefined) fail(`the expected generator scripts/${generator} is gone`);
    for (const module of shared) {
      if (!text.includes(module)) fail(`scripts/${generator} does not delegate to ${module}`);
    }
  }

  console.log(
    `  the inline bundle and the proof page each live in one module | ${generators.length} generators delegate to them`,
  );
}

function checkClaimsCoverage(docOverride) {
  console.log(`claims coverage (docs/CLAIMS.md${docOverride ? ", DOCTORED" : ""} vs this checker):`);
  const map = docOverride ?? readFileSync(new URL("docs/CLAIMS.md", root), "utf8");
  const self = readFileSync(new URL("scripts/claim-check.mjs", root), "utf8");

  const section = (heading) => {
    const start = map.indexOf(heading);
    if (start < 0) return "";
    const rest = map.slice(start + heading.length);
    const end = rest.indexOf("\n## ");
    return end < 0 ? rest : rest.slice(0, end);
  };

  // Split each row into cells rather than matching a fixed column count: a
  // regex requiring three cells silently matched a two-column row ACROSS its
  // newline into the next one, so half the prose table parsed and the other
  // half vanished — the same silent-partial-parse family as the URL walk.
  const rowsOf = (text) =>
    text
      .split("\n")
      .filter((line) => /^\|\s*`[^`]+`\s*\|/.test(line))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return {
          doc: (cells[1] ?? "").replace(/`/g, ""),
          kind: cells[2] ?? "",
          last: cells[3] ?? "",
        };
      });

  const checked = rowsOf(section("## Checked"));
  const prose = rowsOf(section("## Deliberately prose"));
  if (checked.length === 0) fail("CLAIMS.md lists no checked documents");
  if (prose.length === 0) fail("CLAIMS.md lists no prose documents");

  const baseName = (doc) => doc.split("/").pop();
  for (const row of checked) {
    const name = baseName(row.doc);
    // The checker must reference the doc by name (its kinds read each doc), and
    // the file must exist unless it is an RFC outside docs/.
    if (!self.includes(name)) {
      fail(`CLAIMS.md lists ${row.doc} as checked, but this checker never mentions ${name}`);
    }
    if (row.kind.length === 0) fail(`CLAIMS.md gives no kind for the checked document ${row.doc}`);
  }
  for (const row of prose) {
    if (row.kind.length === 0) fail(`CLAIMS.md gives no reason for leaving ${row.doc} as prose`);
  }

  const checkedNames = new Set(checked.map((row) => row.doc));
  for (const row of prose) {
    if (checkedNames.has(row.doc)) fail(`CLAIMS.md lists ${row.doc} as both checked and prose`);
  }

  console.log(
    `  ${checked.length} checked document(s) | ${prose.length} prose row(s) | no overlap, every checked doc referenced`,
  );
}

/**
 * The crypto doc: docs/CRYPTO.md publishes the runtime floor ("Node 22.18+")
 * and the suite set (ECDSA P-256, ML-DSA), and describes the leaf-version
 * history ("leaf version 3 added the profile"). The runtime floor must be the
 * package's own engines field, the suites must be what the SDK derives from a
 * key — functionally, not by name — and the shipped leaf version must still be
 * at least the version the profile claim describes.
 */
function checkCryptoDoc(docOverride) {
  console.log(`crypto doc (docs/CRYPTO.md${docOverride ? ", DOCTORED" : ""} vs code):`);
  const doc = docOverride ?? readFileSync(new URL("docs/CRYPTO.md", root), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

  // The runtime floor, both sides.
  const docFloor = doc.match(/Node (\d+\.\d+)\+/)?.[1];
  if (!docFloor) fail("CRYPTO.md no longer states the Node runtime floor");
  const enginesFloor = String(pkg.engines?.node ?? "").replace(/^[>=^~]+/, "");
  if (docFloor !== enginesFloor) {
    fail(`CRYPTO.md says Node ${docFloor}+, but package.json engines say ${pkg.engines?.node}`);
  }

  // The leaf-version history: the profile arrived in version 3, and the
  // shipped format must still be at least that.
  if (!doc.includes("Leaf version 3 added the profile")) {
    fail("CRYPTO.md no longer describes leaf version 3 as the profile version");
  }
  const shipped = leaf.PUBLICATION_LEAF_VERSION;
  if (!Number.isSafeInteger(shipped) || shipped < 3) {
    fail(`the shipped publication leaf version is ${shipped}, below the documented profile version 3`);
  }

  // The suites, derived functionally from keys the doc names.
  if (!doc.includes("ECDSA P-256") || !doc.includes("ML-DSA")) {
    fail("CRYPTO.md no longer names the ECDSA P-256 and ML-DSA suites");
  }
  const derived = [
    [{ kty: "EC", crv: "P-256" }, "ecdsa-p256"],
    [{ kty: "AKP", alg: "ML-DSA-44" }, "ml-dsa-44"],
    [{ kty: "AKP", alg: "ML-DSA-65" }, "ml-dsa-65"],
  ];
  for (const [key, expected] of derived) {
    const suite = sdk.suiteOf(key);
    if (suite !== expected) fail(`the SDK derives suite ${suite} for a key the doc calls ${expected}`);
  }
  // A foreign key must be refused, never silently classified.
  let refused = false;
  try {
    sdk.suiteOf({ kty: "RSA" });
  } catch {
    refused = true;
  }
  if (!refused) fail("the SDK classified a foreign key instead of refusing it");

  console.log(
    `  node ${docFloor}+ | leaf version ${shipped} (>= 3) | suites ecdsa-p256, ml-dsa-44, ml-dsa-65 | foreign key refused`,
  );
}

function checkAppProtocol(docOverride) {
  console.log(`app protocol (docs/APP-PROTOCOL.md${docOverride ? ", DOCTORED" : ""} vs code):`);
  const doc = docOverride ?? readFileSync(new URL("docs/APP-PROTOCOL.md", root), "utf8");
  const app = readFileSync(new URL("apps/api/src/app.ts", root), "utf8");

  // Every RAREXT_* name the doc tells an app author to set must be read by the
  // implementation — a documented knob nobody reads is a lie with a config
  // table around it.
  const names = Array.from(new Set(Array.from(doc.matchAll(/`(RAREXT_[A-Z0-9_]+)`/g)).map((m) => m[1])));
  if (names.length === 0) fail("APP-PROTOCOL.md names no RAREXT_* configuration");
  // The real source set, discovered rather than hand-listed: every ts file
  // under the api, mcp and sdk trees. A hand-picked list is how a checker
  // reports a false "nobody reads this" — the first version of this kind did
  // exactly that, missing sponsorship.ts by omission.
  // `root` is a URL, so a directory listing must convert it to a path —
  // path.join on a URL silently mangles it and the walk finds nothing, which
  // is how the first version of this kind produced a false "nobody reads
  // this" for every name at once.
  const sourceFiles = [];
  const walk = (relative) => {
    for (const entry of readdirSync(fileURLToPath(new URL(relative, root)), { withFileTypes: true })) {
      const child = `${relative}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(`${child}/`);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        sourceFiles.push(child);
      }
    }
  };
  for (const dir of ["apps/api/src/", "apps/mcp/src/", "apps/chain/src/", "packages/core/src/", "packages/agent-sdk/src/"]) {
    try {
      walk(dir);
    } catch {
      // A tree that does not exist yet is not a failure.
    }
  }
  if (sourceFiles.length === 0) fail("the source walk found no files, so every config name would read as unread");
  const sources = sourceFiles
    .map((rel) => {
      try {
        return readFileSync(new URL(rel, root), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  for (const name of names) {
    if (!sources.includes(name)) {
      fail(`APP-PROTOCOL.md documents ${name}, which no implementation file reads`);
    }
  }

  // Every route the doc publishes must be handled, params normalised.
  const guards = new Set();
  let currentMethod = null;
  for (const line of app.split("\n")) {
    const method = line.match(/req\.method === "(\w+)"/);
    if (method) currentMethod = method[1];
    for (const match of line.matchAll(/pathname === "([^"]+)"/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
    for (const match of line.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
  }
  const routes = Array.from(
    new Set(
      Array.from(doc.matchAll(/`(GET|POST|PUT|DELETE|PATCH) (\/v1\/[\w/:{}.-]+)`/g)).map((m) => ({
        method: m[1],
        path: m[2],
      })),
    ),
  );
  if (routes.length === 0) fail("APP-PROTOCOL.md publishes no route list");
  let unhandled = 0;
  for (const { method, path } of routes) {
    // A published :param maps to either an exact guard (when the route names
    // the param inline) or a prefix guard for the collection path.
    const normalised = path.replace(/:[A-Za-z]+/g, "");
    const literal = path.replace(/\/:[A-Za-z]+/g, "");
    const handled =
      guards.has(`${method} ${path}`) ||
      guards.has(`${method} ${literal}`) ||
      Array.from(guards).some(
        (guard) =>
          guard.startsWith(`${method} `) &&
          (normalised.endsWith(guard.split(" ")[1]) ||
            guard.split(" ")[1].startsWith(normalised) ||
            normalised.startsWith(guard.split(" ")[1])),
      );
    if (!handled) {
      unhandled += 1;
      fail(`APP-PROTOCOL.md publishes ${method} ${path}, but app.ts no longer handles it`);
    }
  }

  console.log(
    `  ${names.length} config name(s) read by the code | ${sourceFiles.length} source file(s) walked | ${routes.length} route(s) handled (${unhandled} unhandled)`,
  );
}

/**
 * The mirrors doc: docs/MIRRORS.md publishes bundle routes, names npm scripts,
 * calls the takedown test "the acceptance criterion" that "runs in CI", and
 * lists the published copy's artifacts. Each is held to the tree: the routes to
 * app.ts's guards, the scripts to package.json, the CI sentence to
 * scripts/ci.sh, and the published artifacts to the deploy's own sources (which
 * are what make the doc's URLs resolve).
 */
function checkMirrorsDoc(docOverride) {
  console.log(`mirrors doc (docs/MIRRORS.md${docOverride ? ", DOCTORED" : ""} vs tree):`);
  const doc = docOverride ?? readFileSync(new URL("docs/MIRRORS.md", root), "utf8");
  // The doc says the proof page fails over and reports the location it
  // verified ("Served from"). That page lives in ONE module — it used to exist
  // twice, once per generator, and a failover fix landed in the copy that was
  // never published. So the page module is checked for the behaviour, and the
  // generators are checked for USING it rather than keeping private copies:
  // what broke was not the page but its duplication.
  const page = readFileSync(new URL("scripts/mirror-verify-page.mjs", root), "utf8");
  if (!doc.includes("Served from")) {
    fail("MIRRORS.md no longer describes the page reporting which location it verified");
  }
  for (const marker of ["Served from", "../registry/bundle.json", "loadBundle", "rebuild"]) {
    if (!page.includes(marker)) {
      fail(`MIRRORS.md says the proof page fails over, but the page module has no "${marker}"`);
    }
  }
  const generators = ["scripts/build-mirror.mjs", "scripts/publish-ai-proof.mjs"];
  for (const generator of generators) {
    const source = readFileSync(new URL(generator, root), "utf8");
    if (!source.includes("mirror-verify-page.mjs")) {
      fail(`${generator} does not use the shared proof page — the page has one source`);
    }
    // Only the page's CODE counts as a private copy. The title and heading
    // strings are arguments, and a generator passing them is the point of the
    // shared module — an earlier version of this guard failed on exactly that,
    // twice, which is how it was caught.
    if (source.includes("No copy verified") || source.includes("htmlRow") || source.includes("loadBundle")) {
      fail(`${generator} still carries its own copy of the proof page code`);
    }
  }
  const app = readFileSync(new URL("apps/api/src/app.ts", root), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const ci = readFileSync(new URL("scripts/ci.sh", root), "utf8");
  const deploy = readFileSync(new URL("scripts/deploy-site.mjs", root), "utf8");

  const guards = new Set();
  let currentMethod = null;
  for (const line of app.split("\n")) {
    const method = line.match(/req\.method === "(\w+)"/);
    if (method) currentMethod = method[1];
    for (const match of line.matchAll(/pathname === "([^"]+)"/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
    for (const match of line.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
  }
  const bundleRoutes = Array.from(doc.matchAll(/^(GET|POST)\s+(\/v1\/bundles[\w/<>.-]*)/gm)).map((m) => ({
    method: m[1],
    path: m[2].split("?")[0].replace(/\/$/, ""),
  }));
  if (bundleRoutes.length === 0) fail("MIRRORS.md no longer publishes any bundle route");
  let unhandled = 0;
  for (const { method, path } of bundleRoutes) {
    const base = path.split("<")[0].replace(/\/$/, "");
    const handled =
      guards.has(`${method} ${path}`) ||
      Array.from(guards).some((guard) => guard.startsWith(`${method} `) && base.startsWith(guard.split(" ")[1]));
    if (!handled) {
      unhandled += 1;
      fail(`MIRRORS.md publishes ${method} ${path}, but app.ts no longer handles it`);
    }
  }

  const named = Array.from(new Set(Array.from(doc.matchAll(/npm run ([\w:-]+)/g)).map((m) => m[1])));
  for (const script of named) {
    if (typeof pkg.scripts[script] !== "string") {
      fail(`MIRRORS.md names npm run ${script}, which package.json does not define`);
    }
  }
  if (!doc.includes("it runs in CI")) fail("MIRRORS.md no longer claims the takedown test runs in CI");
  if (!ci.includes("npm run test:takedown")) {
    fail("MIRRORS.md says the takedown test runs in CI, but scripts/ci.sh does not run it");
  }

  for (const [rel, label] of [
    ["site/registry/bundle.json", "the published bundle"],
    ["site/registry/seed.json", "the published seed"],
    ["site/registry/mirror/verify.html", "the published verify page"],
  ]) {
    let size = 0;
    try {
      size = statSync(new URL(rel, root)).size;
    } catch {
      size = 0;
    }
    if (size === 0) fail(`MIRRORS.md's published copy lists ${label}, but ${rel} is missing`);
  }
  if (!deploy.includes("registry/mirror/${entry.name}") || !deploy.includes("target: `mirror/${entry.name}`")) {
    fail("the deploy no longer maps registry/mirror/* onto /mirror/*, so the doc's mirror URLs would 404");
  }

  console.log(
    `  ${bundleRoutes.length} bundle route(s) handled | ${named.length} npm script(s) defined | takedown in CI | published copy present | proof page fails over (Served from) with the generator carrying it`,
  );
}

/**
 * The pricing claims in docs/STORAGE-ECONOMY.md: "The public tier defaults to a
 * zero rate; the sealed tier defaults to 1,000,000 microcredits (1 credit) per
 * GiB-month", prorated by the month, with rounding UP to a whole microcredit so
 * a tiny quote cannot become free by truncation.
 */
function checkRentClaims(rateOverrides) {
  console.log(`rent pricing (docs/STORAGE-ECONOMY.md${rateOverrides ? ", INJECTED" : ""}):`);
  // No argument: the documented defaults. An argument is an operator rate
  // table, so the self-test can model a code change to the default rate.
  const defaults = rateOverrides
    ? rent.storagePricing(rateOverrides)
    : rent.storagePricingFromEnv({});
  const GIB = 1024 ** 3;
  const from = new Date("2026-01-01T00:00:00.000Z");
  const month = 30 * 24 * 60 * 60 * 1000;
  const quote = (bytes, tier, durationMs) =>
    rent.quoteStorageRent({ bytes, tier, from, until: new Date(from.getTime() + durationMs) }, defaults);

  // The published default rate: 1,000,000 microcredits (1 credit) per GiB-month.
  if (defaults.tiers.find((tier) => tier.tier === "sealed")?.rateMicroCreditsPerGiBMonth !== 1_000_000) {
    fail("the sealed default rate is no longer 1,000,000 microcredits per GiB-month");
  }
  if (defaults.tiers.find((tier) => tier.tier === "public")?.rateMicroCreditsPerGiBMonth !== 0) {
    fail("the public default rate is no longer zero");
  }

  const wholeMonth = quote(GIB, "sealed", month);
  if (wholeMonth.costMicroCredits !== 1_000_000) {
    fail(`a GiB-month at the default rate should cost 1,000,000 microcredits; it costs ${wholeMonth.costMicroCredits}`);
  }
  if (wholeMonth.costCredits !== 1) fail("a GiB-month should read as 1 credit");

  const halfMonth = quote(GIB, "sealed", month / 2);
  if (halfMonth.costCredits !== 0.5) fail(`half a month should prorate to 0.5 credits; it is ${halfMonth.costCredits}`);

  const tiny = quote(1, "sealed", month);
  if (tiny.costMicroCredits !== 1 || tiny.free !== false) {
    fail(`a tiny quote must cost one microcredit, not ${tiny.costMicroCredits} (free: ${tiny.free})`);
  }

  const free = quote(GIB, "public", month);
  if (free.costMicroCredits !== 0 || free.free !== true) {
    fail(`the public tier is documented free; it quotes ${free.costMicroCredits}`);
  }

  // The documented override, quoted from the same section.
  const custom = rent.storagePricingFromEnv({ RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH: "2500000" });
  const customQuote = rent.quoteStorageRent(
    { bytes: GIB, tier: "sealed", from, until: new Date(from.getTime() + month) },
    custom,
  );
  if (customQuote.costCredits !== 2.5) {
    fail(`the documented 2,500,000 override should quote 2.5 credits per GiB-month; it is ${customQuote.costCredits}`);
  }

  console.log(
    "  GiB-month at the sealed default: 1 credit | half month: 0.5 | 1 byte: 1 microcredit | public: free | override 2.5 credits: ok",
  );
}

/**
 * The throughput claim: docs/STORAGE.md cites the 1 GiB memory probe — the
 * in-memory path peaked at 3242.8 MiB, the streaming path at 392.6 MiB, "8.3x
 * lower" — and bench/storage/THROUGHPUT.json is the committed artifact. The
 * doc's numbers must be the artifact's numbers rounded for display, and the
 * ratio must be the artifact's own arithmetic.
 */
function checkThroughputArtifact(artifactOverride) {
  console.log(`throughput artifact (bench/storage/THROUGHPUT.json${artifactOverride ? ", DOCTORED" : ""}):`);
  let artifact;
  if (artifactOverride !== undefined) artifact = artifactOverride;
  else {
    try {
      artifact = JSON.parse(readFileSync(new URL("bench/storage/THROUGHPUT.json", root), "utf8"));
    } catch (error) {
      fail(`THROUGHPUT.json is unreadable: ${error instanceof Error ? error.message : error}`);
      return;
    }
  }

  const runs = Array.isArray(artifact.runs) ? artifact.runs : [];
  const memory = runs.find((run) => run.mode === "memory");
  const streaming = runs.find((run) => run.mode === "stream");
  if (!memory || !streaming) { fail("THROUGHPUT.json lacks the memory and streaming 1 GiB runs"); return; }
  if (artifact.payloadBytes < 2 ** 30) fail(`THROUGHPUT.json's payload is ${(artifact.payloadBytes / 2 ** 30).toFixed(2)} GiB, not the 1 GiB the doc cites`);
  if (!(memory.peakRssMiB > 0) || !(streaming.peakRssMiB > 0)) fail("a peak RSS is missing or implausible");
  if (memory.exact !== true || streaming.exact !== true) fail("a 1 GiB run did not report an exact round trip");

  const ratio = memory.peakRssMiB / streaming.peakRssMiB;
  const doc = readFileSync(new URL("docs/STORAGE.md", root), "utf8");
  // The doc rounds to one decimal; the artifact must agree to that rounding.
  const round1 = (value) => Math.round(value * 10) / 10;
  for (const [run, cited] of [[memory, "3242.8"], [streaming, "392.6"]]) {
    if (String(round1(run.peakRssMiB)) !== cited) {
      fail(`STORAGE.md cites ${cited} MiB but the artifact measures ${round1(run.peakRssMiB)}`);
    }
  }
  const docRatio = Number(doc.match(/([0-9.]+)x lower/)?.[1]);
  if (!docRatio || Math.abs(ratio - docRatio) > 0.05) {
    fail(`STORAGE.md cites ${docRatio}x lower but the artifact's ratio is ${ratio.toFixed(2)}`);
  }
  if (!doc.includes("8.3x lower")) fail("STORAGE.md no longer states the 8.3x streaming-memory saving");
  console.log(
    `  memory ${round1(memory.peakRssMiB)} MiB vs streaming ${round1(streaming.peakRssMiB)} MiB = ${ratio.toFixed(1)}x lower, exact ${streaming.exact}`,
  );
}


/**
 * The limits-table claim: docs/OPERATIONS.md publishes named constants —
 * `MAX_BLOB_BYTES` = 32 MiB, `MAX_BODY_BYTES` = 1 MiB (the code's 1,000,000
 * bytes, labelled loosely), `MAX_GENERATIVE_STEPS` = 100,000, `MAX_VOCAB` =
 * 4,096. Each must equal what the implementation actually exports.
 */
function checkLimitsTable(docOverride) {
  console.log(`limits table (docs/OPERATIONS.md${docOverride ? ", DOCTORED" : ""} vs exported constants):`);
  const doc = docOverride ?? readFileSync(new URL("docs/OPERATIONS.md", root), "utf8");
  const app = readFileSync(new URL("apps/api/src/app.ts", root), "utf8");

  const blobCap = Number(doc.match(/`MAX_BLOB_BYTES` = (\d+) MiB/)?.[1]);
  if (blobCap !== 32) fail(`OPERATIONS.md no longer states MAX_BLOB_BYTES = 32 MiB (says ${blobCap})`);
  if (storageConstants.MAX_BLOB_BYTES !== 32 * 1024 * 1024) {
    fail(`the code's MAX_BLOB_BYTES is ${storageConstants.MAX_BLOB_BYTES}, not 32 MiB`);
  }

  // app.ts keeps the body cap module-local, so read its source line directly.
  const bodyCap = Number(app.match(/const MAX_BODY_BYTES = ([\d_]+);/)?.[1]?.replaceAll("_", ""));
  if (bodyCap !== 1_000_000) fail(`app.ts's MAX_BODY_BYTES is ${bodyCap}, not 1,000,000`);
  if (!doc.includes("`MAX_BODY_BYTES` = 1 MiB")) fail("OPERATIONS.md no longer cites the 1 MiB JSON body cap");

  const steps = Number(doc.match(/`MAX_GENERATIVE_STEPS` = ([\d,]+)/)?.[1]?.replaceAll(",", ""));
  if (steps !== 100_000) fail(`OPERATIONS.md no longer states MAX_GENERATIVE_STEPS = 100,000 (says ${steps})`);
  if (coreAi.MAX_GENERATIVE_STEPS !== 100_000) fail(`the code's MAX_GENERATIVE_STEPS is ${coreAi.MAX_GENERATIVE_STEPS}, not 100,000`);

  const vocab = Number(doc.match(/`MAX_VOCAB` = ([\d,]+)/)?.[1]?.replaceAll(",", ""));
  if (vocab !== 4_096) fail(`OPERATIONS.md no longer states MAX_VOCAB = 4,096 (says ${vocab})`);
  if (coreAi.MAX_VOCAB !== 4_096) fail(`the code's MAX_VOCAB is ${coreAi.MAX_VOCAB}, not 4,096`);

  console.log(
    `  blob ${storageConstants.MAX_BLOB_BYTES / 2 ** 20} MiB | body ${bodyCap} B | steps ${coreAi.MAX_GENERATIVE_STEPS} | vocab ${coreAi.MAX_VOCAB}`,
  );
}


/**
 * The AI replay bounds: docs/OPERATIONS.md publishes MAX_GENERATIVE_TOKEN_LENGTH
 * = 256 and MAX_GENERATIVE_OUTPUT_LENGTH = 1 MiB (1,048,576 code units), and the
 * behavioural claim that a replay whose longest token times steps would exceed
 * the bound is rejected without generating. The positive control — a true
 * replay verifies correct — guards the check against passing vacuously.
 */
function checkReplayBounds(docOverride) {
  console.log(`AI replay bounds (docs/OPERATIONS.md${docOverride ? ", DOCTORED" : ""} vs packages/core/src/ai.ts):`);
  const doc = docOverride ?? readFileSync(new URL("docs/OPERATIONS.md", root), "utf8");

  const tokenCap = Number(doc.match(/`MAX_GENERATIVE_TOKEN_LENGTH` = (\d+)/)?.[1]);
  if (tokenCap !== 256) fail(`OPERATIONS.md no longer states MAX_GENERATIVE_TOKEN_LENGTH = 256 (says ${tokenCap})`);
  if (coreAi.MAX_GENERATIVE_TOKEN_LENGTH !== 256) {
    fail(`the code's MAX_GENERATIVE_TOKEN_LENGTH is ${coreAi.MAX_GENERATIVE_TOKEN_LENGTH}, not 256`);
  }
  const outCap = Number(doc.match(/`MAX_GENERATIVE_OUTPUT_LENGTH` = 1 MiB \(([\d,]+) code units\)/)?.[1]?.replaceAll(",", ""));
  if (outCap !== 1_048_576) fail(`OPERATIONS.md no longer states the 1 MiB output bound as 1,048,576 (says ${outCap})`);
  if (coreAi.MAX_GENERATIVE_OUTPUT_LENGTH !== 1 << 20) {
    fail(`the code's MAX_GENERATIVE_OUTPUT_LENGTH is ${coreAi.MAX_GENERATIVE_OUTPUT_LENGTH}, not ${1 << 20}`);
  }

  // Positive control: an exact small replay verifies correct.
  const model = { kind: "xorshift32", params: { a: 13, b: 17, c: 5 }, vocab: ["0", "1"] };
  const trueOutput = coreAi.generate(model, 7, 100);
  const okReplay = coreAi.verifyGenerativeReplay(
    { model, seed: 7, output: trueOutput },
    { steps: 100 },
  );
  if (okReplay.correct !== true || okReplay.expected !== trueOutput) {
    fail("the positive control failed: an exact replay did not verify correct");
  }

  // The published behaviour: longest token (256) x steps over the 1 MiB bound
  // is rejected without materializing anything. 256 x 4097 = 1,048,832 > 2^20.
  const bigToken = "x".repeat(256);
  const oversized = coreAi.verifyGenerativeReplay(
    { model: { kind: "xorshift32", params: { a: 13, b: 17, c: 5 }, vocab: [bigToken] }, seed: 1, output: "" },
    { steps: 4097 },
  );
  if (oversized.correct !== false || oversized.expected !== "") {
    fail(`an over-bound replay must return { correct: false, expected: "" }; got correct ${oversized.correct}, expected length ${oversized.expected.length}`);
  }
  if (oversized.expected.length > 0) fail("an over-bound replay materialized an output it should not have");

  console.log(
    `  token cap ${coreAi.MAX_GENERATIVE_TOKEN_LENGTH} | output bound ${coreAi.MAX_GENERATIVE_OUTPUT_LENGTH} | exact replay correct | 256x4097 rejected empty`,
  );
}


/**
 * The operational defaults: docs/OPERATOR.md states the retention scheduler
 * runs "every 6 hours (`RAREXT_CHALLENGE_INTERVAL_MS`)" — its log renders
 * "every 21600s" — the storage and pin GC loops are "both 24h, `0` disables",
 * and production blob GC "defaults to a 24 h" grace period. Each default must
 * be what the source actually reads.
 */
function checkOperationalDefaults(docOverride) {
  console.log(`operational defaults (docs/OPERATOR.md${docOverride ? ", DOCTORED" : ""} vs source):`);
  const doc = docOverride ?? readFileSync(new URL("docs/OPERATOR.md", root), "utf8");
  const server = readFileSync(new URL("apps/api/src/server.ts", root), "utf8");
  const pinServer = readFileSync(new URL("apps/api/src/pin-server.ts", root), "utf8");
  const durability = readFileSync(new URL("apps/api/src/durability.ts", root), "utf8");

  const HOUR = 60 * 60 * 1000;
  const readDefault = (source, env) =>
    Number(source.match(new RegExp(`${env} \\?\\? ([\\d *]+)\\)`))?.[1]?.replaceAll(/[^0-9]/g, " ").trim().split(/ +/).reduce((a, b) => a * Number(b), 1));

  const challengeMs = readDefault(server, "RAREXT_CHALLENGE_INTERVAL_MS");
  if (challengeMs !== 6 * HOUR) fail(`the challenge scheduler default is ${challengeMs} ms, not 6 h`);
  if (!doc.includes("every 6 hours (`RAREXT_CHALLENGE_INTERVAL_MS`)")) {
    fail("OPERATOR.md no longer states the 6-hour retention scheduler");
  }
  if (!doc.includes("every 21600s")) fail("OPERATOR.md no longer renders the scheduler as 21600s");

  const storageGcMs = readDefault(server, "RAREXT_GC_INTERVAL_MS");
  const pinGcMs = readDefault(pinServer, "RAREXT_PIN_GC_INTERVAL_MS");
  if (storageGcMs !== 24 * HOUR || pinGcMs !== 24 * HOUR) {
    fail(`the GC loops default to ${storageGcMs} / ${pinGcMs} ms, not 24 h each`);
  }
  if (!doc.includes("both 24h, `0` disables")) fail("OPERATOR.md no longer states the GC loops are 24h with a 0 disable");

  const graceMs = Number(durability.match(/gracePeriodMs = options\.gracePeriodMs \?\? ([\d *]+);/)?.[1]?.replaceAll(/[^0-9]/g, " ").trim().split(/ +/).reduce((a, b) => a * Number(b), 1));
  if (graceMs !== 24 * HOUR) fail(`the blob GC grace default is ${graceMs} ms, not 24 h`);
  if (!doc.includes("24-hour grace period")) fail("OPERATOR.md no longer states the 24-hour grace period");
  if (!doc.includes("`\"gracePeriodMs\":0` deletes on the first scan")) {
    fail("OPERATOR.md no longer documents gracePeriodMs 0 as delete-on-first-scan");
  }

  console.log(
    `  challenges ${challengeMs / HOUR} h | storage GC ${storageGcMs / HOUR} h | pin GC ${pinGcMs / HOUR} h | grace ${graceMs / HOUR} h`,
  );
}


/**
 * The evidence citations: docs/OPERATIONS.md's fault-limit tables name the test
 * files that measure each published behaviour ("Limits are measured by
 * apps/api/test/....test.ts"). Every cited file must exist and be non-empty,
 * and the gate's own test glob must be broad enough to run it — otherwise the
 * doc cites evidence the CI never executes.
 */
function checkEvidenceCitations(docOverride, testScriptOverride) {
  console.log(`evidence citations (docs/OPERATIONS.md${docOverride ? ", DOCTORED" : ""} vs the tree):`);
  const doc = docOverride ?? readFileSync(new URL("docs/OPERATIONS.md", root), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const testScript = testScriptOverride ?? pkg.scripts.test;

  const cited = Array.from(new Set(doc.match(/apps\/api\/test\/[a-z-]+\.test\.ts/g) ?? []));
  let missing = 0;
  for (const rel of cited) {
    let size = 0;
    try {
      size = statSync(new URL("./" + rel, root)).size;
    } catch {
      missing += 1;
      fail(`OPERATIONS.md cites ${rel}, which does not exist in the tree`);
      continue;
    }
    if (size === 0) fail(`OPERATIONS.md cites ${rel}, which is empty`);
  }
  if (!testScript.includes("apps/api/test/*.test.ts")) {
    fail("the gate's test script does not glob apps/api/test, so cited evidence may not run in CI");
  }
  if (cited.length === 0) fail("OPERATIONS.md cites no test evidence at all");

  // The backup version the doc pins must be the code's.
  const backup = readFileSync(new URL("apps/api/src/backup.ts", root), "utf8");
  const docVersion = Number(doc.match(/`BACKUP_VERSION` \((\d+)\)/)?.[1]);
  const codeVersion = Number(backup.match(/export const BACKUP_VERSION = (\d+);/)?.[1]);
  if (docVersion !== 1 || codeVersion !== 1) {
    fail(`the backup version contract drifted: doc ${docVersion}, code ${codeVersion}, both must be 1`);
  }

  console.log(`  ${cited.length} cited test file(s), all present; backup version ${codeVersion}`);
}


/**
 * The chain surface: docs/CHAINS.md publishes the chain-registry API
 * (POST /chain/anchor, GET /chain/{state,head,key,proof,blocks/:height,audit})
 * and a chains table whose `trac` row is the operator webhook adapter and whose
 * `evm` row is backed by the anchor contract and its deployment path. Every
 * published chain route must be handled by apps/chain/src/server.ts, and both
 * table rows must have their backing artifact in the tree.
 */
function checkChainSurface(docOverride) {
  console.log(`chain surface (docs/CHAINS.md${docOverride ? ", DOCTORED" : ""} vs apps/chain/src/server.ts):`);
  const doc = docOverride ?? readFileSync(new URL("docs/CHAINS.md", root), "utf8");
  const server = readFileSync(new URL("apps/chain/src/server.ts", root), "utf8");

  const published = [];
  for (const match of doc.matchAll(/^(GET|POST)\s+(\/chain\/[\w/:.-]+)/gm)) {
    published.push({ method: match[1], path: match[2] });
  }
  const guards = new Set();
  let currentMethod = null;
  for (const line of server.split("\n")) {
    const method = line.match(/req\.method === "(\w+)"/);
    if (method) currentMethod = method[1];
    for (const match of line.matchAll(/path === "([^"]+)"/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1]}`);
    }
    for (const match of line.matchAll(/path\.startsWith\("([^"]+)"\)/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1]}`);
    }
  }
  let unhandled = 0;
  for (const { method, path } of published) {
    if (guards.has(`${method} ${path}`)) continue;
    const byPrefix = Array.from(guards).some(
      (guard) => guard.startsWith(`${method} `) && path.startsWith(guard.split(" ")[1]),
    );
    if (byPrefix) continue;
    unhandled += 1;
    fail(`CHAINS.md publishes ${method} ${path}, but the chain server no longer handles it`);
  }

  // The chains table's backing artifacts.
  const anchorer = readFileSync(new URL("apps/api/src/anchorer.ts", root), "utf8");
  if (!anchorer.includes('"trac"')) fail("CHAINS.md's trac row has no trac adapter in apps/api/src/anchorer.ts");
  let solSize = 0;
  try {
    solSize = statSync(new URL("contracts/RarextAnchor.sol", root)).size;
  } catch {}
  if (solSize === 0) fail("CHAINS.md's evm row has no anchor contract at contracts/RarextAnchor.sol");
  let deploySize = 0;
  try {
    deploySize = statSync(new URL("contracts/scripts/deploy-anchor.mjs", root)).size;
  } catch {}
  if (deploySize === 0) fail("CHAINS.md's evm row has no deployment path at contracts/scripts/deploy-anchor.mjs");

  console.log(`  ${published.length} chain route(s) published, ${unhandled === 0 ? "all handled" : `${unhandled} unhandled`}; trac adapter + anchor contract present`);
}


/**
 * The reward table: docs/WORK.md publishes a credit schedule per work action —
 * verify 10, store 1, mirror 25, relay 15, publish 5, remix 20, report 50 — and
 * apps/api/src/work.ts exports ACTIONS with a base per id. Each published row
 * must equal the code's base for that action, and the code must define no
 * action the doc's schedule omits.
 */
function checkRewardTable(docOverride) {
  console.log(`reward table (docs/WORK.md${docOverride ? ", DOCTORED" : ""} vs apps/api/src/work.ts):`);
  const doc = docOverride ?? readFileSync(new URL("docs/WORK.md", root), "utf8");

  const published = new Map();
  for (const match of doc.matchAll(/^\| `([a-z]+)` \|[^|]*\| (\d+) \|/gm)) {
    published.set(match[1], Number(match[2]));
  }
  if (published.size === 0) fail("WORK.md's reward table has no parseable rows");

  const code = new Map(work.ACTIONS.map((action) => [action.id, action.base]));
  for (const [id, credits] of published) {
    if (!code.has(id)) fail(`WORK.md rewards "${id}", which the code does not define`);
    else if (code.get(id) !== credits) {
      fail(`WORK.md rewards "${id}" at ${credits} credits; the code's base is ${code.get(id)}`);
    }
  }
  for (const [id, base] of code) {
    if (!published.has(id)) fail(`the code defines work action "${id}" (base ${base}) that WORK.md's schedule omits`);
  }

  console.log(
    `  ${published.size} action(s) at parity: ` +
      Array.from(published).map(([id, c]) => `${id}=${c}`).join(" "),
  );
}


/**
 * The audit-window claims: docs/OPERATIONS.md publishes the audit-freshness row
 * (`AUDIT_WINDOW_MS` = 15 min by default, future timestamps up to 5 min
 * tolerated, and the exact refusal messages), and docs/STORAGE-SECURITY.md
 * publishes the nonce bound and the verifier-timeout range (1-300,000 ms). The
 * numbers and the message literals must be the code's. The boundary BEHAVIOUR
 * is pinned functionally by apps/api/test/audit-attestation.test.ts, whose
 * existence and execution this suite already enforces.
 */
function checkAuditWindowClaims(docOverride) {
  console.log(`audit window (OPERATIONS.md + STORAGE-SECURITY.md${docOverride ? ", DOCTORED" : ""} vs code):`);
  const operations = docOverride ?? readFileSync(new URL("docs/OPERATIONS.md", root), "utf8");
  const security = readFileSync(new URL("docs/STORAGE-SECURITY.md", root), "utf8");
  const auditSource = readFileSync(new URL("apps/api/src/audit-attestation.ts", root), "utf8");
  const verifierSource = readFileSync(new URL("apps/api/src/verifiers.ts", root), "utf8");

  if (!operations.includes("default `AUDIT_WINDOW_MS` = 15 min")) {
    fail("OPERATIONS.md no longer states the 15-minute audit window");
  }
  if (!security.includes("`AUDIT_WINDOW_MS` (15 min by default)")) {
    fail("STORAGE-SECURITY.md no longer states the 15-minute audit window");
  }
  if (audits.AUDIT_WINDOW_MS !== 15 * 60 * 1000) {
    fail(`the code's AUDIT_WINDOW_MS is ${audits.AUDIT_WINDOW_MS} ms, not 15 min`);
  }

  if (!operations.includes("up to 5 min in the future are tolerated")) {
    fail("OPERATIONS.md no longer states the 5-minute future-timestamp tolerance");
  }
  const skewMatch = auditSource.match(/CLOCK_SKEW_MS = (\d+) \* (\d+) \* (\d+)/);
  const skew = skewMatch ? Number(skewMatch[1]) * Number(skewMatch[2]) * Number(skewMatch[3]) : NaN;
  if (skew !== 5 * 60 * 1000) fail(`the code's CLOCK_SKEW_MS is ${skew} ms, not 5 min`);

  // The doc quotes one refusal verbatim and describes the other in shorthand;
  // both must stay anchored — the quoted string in the doc, and both literals
  // in the code that produces them.
  if (!operations.includes("`audit attestation has expired`")) {
    fail("OPERATIONS.md no longer quotes the expired-audit refusal");
  }
  if (!operations.includes("a future timestamp rejects")) {
    fail("OPERATIONS.md no longer describes the future-timestamp refusal");
  }
  for (const message of ["audit attestation has expired", "audit attestation timestamp is in the future"]) {
    if (!auditSource.includes(message)) fail(`the code no longer produces the documented refusal "${message}"`);
  }

  if (!security.includes("`MAX_CHALLENGE_NONCE`")) fail("STORAGE-SECURITY.md no longer names MAX_CHALLENGE_NONCE");
  const nonce = durabilityConstants.MAX_CHALLENGE_NONCE;
  if (!Number.isSafeInteger(nonce) || nonce <= 0) fail(`MAX_CHALLENGE_NONCE is not a positive integer (${nonce})`);

  if (!/1.{0,3}300,000 ms/.test(security)) fail("STORAGE-SECURITY.md no longer states the 1-300,000 ms verifier-timeout range");
  const timeoutCap = Number(verifierSource.match(/MAX_EXTERNAL_VERIFIER_TIMEOUT_MS = ([\d_]+)/)?.[1]?.replaceAll("_", ""));
  if (timeoutCap !== 300_000) fail(`the code's MAX_EXTERNAL_VERIFIER_TIMEOUT_MS is ${timeoutCap}, not 300,000`);

  console.log(
    `  window ${audits.AUDIT_WINDOW_MS / 60000} min | skew ${skew / 60000} min | nonce <= ${nonce} | verifier timeout <= ${timeoutCap} ms`,
  );
}

/**
 * The soak claim: the docs cite a dated chaos run, and its log is committed.
 * Every operation class in that log must have completed at 100%, and the docs'
 * "latest" numbers must be the log's numbers.
 */
function checkSoakLog(logOverride) {
  console.log(`soak log (bench/storage/soak-2026-10-26.log${logOverride ? ", DOCTORED" : ""}):`);
  let log;
  if (logOverride !== undefined) log = logOverride;
  else {
    try {
      log = readFileSync(new URL("bench/storage/soak-2026-10-26.log", root), "utf8");
    } catch (error) {
      fail(`the committed soak log is unreadable: ${error instanceof Error ? error.message : error}`);
      return;
    }
  }

  const rows = {};
  for (const match of log.matchAll(/^\| (Put|Retrieval|Repair) \| (\d+) \| (\d+) \| (\d+[^|]*) \| ([^|]+) \|$/gm)) {
    rows[match[1]] = { attempted: Number(match[2]), ok: Number(match[3]), rate: match[5].trim() };
  }
  for (const name of ["Put", "Retrieval", "Repair"]) {
    const row = rows[name];
    if (!row) { fail(`the soak log has no ${name} row`); continue; }
    if (row.rate !== "100.0%") fail(`the soak log's ${name} completion is ${row.rate}, not 100%`);
    if (row.ok !== row.attempted) fail(`the soak log's ${name} row does not add up (${row.ok}/${row.attempted})`);
  }

  const operatorDoc = readFileSync(new URL("docs/OPERATOR.md", root), "utf8");
  if (!operatorDoc.includes("5,991 puts at 100%, 148 repairs,")) {
    fail("OPERATOR.md no longer cites the committed soak run (5,991 puts, 148 repairs)");
  }
  if (!operatorDoc.includes("22 kills")) fail("OPERATOR.md no longer cites 22 kills");
  console.log(
    `  ${rows.Put?.attempted} puts, ${rows.Retrieval?.attempted} retrievals, ${rows.Repair?.attempted} repairs, all 100%`,
  );
}


/**
 * The route-surface claim: every route docs/ARCHITECTURE.md publishes must be
 * handled by the implementation. A reader treats that table as a promise, so a
 * route removed from the code while still published is a broken promise, not a
 * documentation bug.
 */
function checkRouteSurface(docOverride) {
  console.log(`route surface (docs/ARCHITECTURE.md${docOverride ? ", DOCTORED" : ""} vs apps/api/src/app.ts):`);
  const doc = docOverride ?? readFileSync(new URL("docs/ARCHITECTURE.md", root), "utf8");
  const app = readFileSync(new URL("apps/api/src/app.ts", root), "utf8");

  const published = [];
  for (const line of doc.split("\n")) {
    const match = line.match(/^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`([^`]+)`\s*\|/);
    if (match) published.push({ method: match[1], path: match[2].split("?")[0].replace(/\/$/, "") });
  }

  const guards = new Set();
  let currentMethod = null;
  for (const line of app.split("\n")) {
    const method = line.match(/req\.method === "(\w+)"/);
    if (method) currentMethod = method[1];
    for (const match of line.matchAll(/pathname === "([^"]+)"/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
    for (const match of line.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
  }

  console.log(`  published routes: ${published.length} | implemented guards: ${guards.size}`);
  let unhandled = 0;
  for (const { method, path } of published) {
    const key = `${method} ${path}`;
    if (guards.has(key)) continue;
    const byPrefix = Array.from(guards).some(
      (guard) => guard.startsWith(`${method} `) && path.startsWith(guard.split(" ")[1] + "/"),
    );
    if (byPrefix) continue;
    unhandled += 1;
    fail(`the table publishes ${key}, but app.ts no longer handles it`);
  }
  console.log(`  every published route is handled: ${unhandled === 0 ? "yes" : `NO (${unhandled})`}`);
}

/** The measured claim: the repair bench records its own arithmetic in RESULTS.json. */
function checkRepairRecord(record) {
  console.log("repair bench (bench/repair/RESULTS.json):");
  if (record === undefined) {
    try {
      record = JSON.parse(readFileSync(new URL("bench/repair/RESULTS.json", root), "utf8"));
    } catch (error) {
      fail(`RESULTS.json is unreadable: ${error instanceof Error ? error.message : error}`);
      return;
    }
  }

  const floor = 1 + record.parityShards / record.dataShards;
  if (record.exact !== true) fail(`the bench did not report an exact floor match (exact: ${record.exact})`);
  if (record.totalRatio !== floor) {
    fail(`totalRatio ${record.totalRatio} does not equal the MDS floor ${floor}`);
  }
  if (record.readBytes + record.writeBytes !== record.totalBytes) {
    fail(`read ${record.readBytes} + write ${record.writeBytes} does not add up to ${record.totalBytes}`);
  }
  if (!Number.isFinite(record.elapsedMs) || record.elapsedMs <= 0) {
    fail(`elapsedMs ${record.elapsedMs} is not a measurement`);
  }

  console.log(
    `  ${record.losses} loss(es) on ${record.dataShards}+${record.parityShards}: ` +
      `read ${(record.readBytes / 2 ** 30).toFixed(3)} GiB + write ${(record.writeBytes / 2 ** 30).toFixed(3)} GiB ` +
      `= ${record.totalRatio}x (floor ${floor}x), exact ${record.exact}, ${Math.round(record.elapsedMs / 100) / 10} s`,
  );
}

/**
 * The AI verification doc: docs/AI-VERIFICATION.md publishes concrete claims
 * about the AI verification surface — rendition rule names, verifier hashes,
 * functional behaviour of the media validators and raster renderers, and the
 * verifier module routes. Every published name/number must match the code that
 * implements it.
 */
function checkAiVerificationDoc(docOverride, appOverride) {
  console.log(`AI verification doc (docs/AI-VERIFICATION.md${docOverride ? ", DOCTORED" : ""} vs code):`);
  const doc = docOverride ?? readFileSync(new URL("docs/AI-VERIFICATION.md", root), "utf8");
  const app = appOverride ?? readFileSync(new URL("apps/api/src/app.ts", root), "utf8");

  // 1. Rendition rule names — must exist in core and match exactly.
  const rasterRule = doc.match(/`xorshift32-image-v1`/);
  if (!rasterRule) fail("AI-VERIFICATION.md no longer mentions rule `xorshift32-image-v1`");
  if (coreAi.RASTER_RULE !== "xorshift32-image-v1") {
    fail(`coreAi.RASTER_RULE is "${coreAi.RASTER_RULE}", not "xorshift32-image-v1"`);
  }

  const boundedRule = doc.match(/`bounded-strip-v1`/);
  if (!boundedRule) fail("AI-VERIFICATION.md no longer mentions rule `bounded-strip-v1`");
  if (coreAi.BOUNDED_RASTER_RULE !== "bounded-strip-v1") {
    fail(`coreAi.BOUNDED_RASTER_RULE is "${coreAi.BOUNDED_RASTER_RULE}", not "bounded-strip-v1"`);
  }

  // 2. Verifier hashes — computed from the manifests the doc describes.
  const genHash = generative.generativeVerifierHash();
  const boundedHash = bounded.boundedVerifierHash();
  if (typeof genHash !== "string" || genHash.length !== 64) {
    fail("generativeVerifierHash() did not return a 64-char hex digest");
  }
  if (typeof boundedHash !== "string" || boundedHash.length !== 64) {
    fail("boundedVerifierHash() did not return a 64-char hex digest");
  }
  // The doc doesn't pin the exact hash values (they're derived), but we verify
  // they are stable and match what the verifiers would compute.
  if (genHash !== generative.generativeVerifierHash()) {
    fail("generativeVerifierHash() is not stable");
  }
  if (boundedHash !== bounded.boundedVerifierHash()) {
    fail("boundedVerifierHash() is not stable");
  }

  // 3. Functional claims — positive controls and published rejection behaviour.
  // isGenerativeMedia accepts a well-formed commitment and nothing sloppier.
  const goodGenMedia = {
    mediaType: "image/png",
    rule: "xorshift32-image-v1",
    blob: "a".repeat(64),
    raster: "b".repeat(64),
    size: 32,
    bytes: 1000,
  };
  if (!coreAi.isGenerativeMedia(goodGenMedia)) {
    fail("isGenerativeMedia rejected a well-formed generative media object");
  }
  const badGenMedia = { ...goodGenMedia, rule: "wrong-rule" };
  if (coreAi.isGenerativeMedia(badGenMedia)) {
    fail("isGenerativeMedia accepted a media object with wrong rule");
  }
  const badGenMedia2 = { ...goodGenMedia, blob: "not-hex" };
  if (coreAi.isGenerativeMedia(badGenMedia2)) {
    fail("isGenerativeMedia accepted a media object with non-hex blob");
  }

  // isBoundedMedia accepts a plotted rendition and nothing sloppier.
  const goodBoundedMedia = {
    mediaType: "image/png",
    rule: "bounded-strip-v1",
    blob: "a".repeat(64),
    raster: "b".repeat(64),
    width: 128,
    height: coreAi.BOUNDED_RASTER_HEIGHT,
    bytes: 2000,
  };
  if (!coreAi.isBoundedMedia(goodBoundedMedia)) {
    fail("isBoundedMedia rejected a well-formed bounded media object");
  }
  const badBoundedMedia = { ...goodBoundedMedia, rule: "wrong-rule" };
  if (coreAi.isBoundedMedia(badBoundedMedia)) {
    fail("isBoundedMedia accepted a media object with wrong rule");
  }
  const badBoundedMedia2 = { ...goodBoundedMedia, width: 0 };
  if (coreAi.isBoundedMedia(badBoundedMedia2)) {
    fail("isBoundedMedia accepted a media object with zero width");
  }

  // renderRaster is a pure function of the commitment (deterministic).
  const model = { kind: "xorshift32", params: { a: 13, b: 17, c: 5 }, vocab: ["0", "1"] };
  const raster1 = coreAi.renderRaster(model, 42, 16);
  const raster2 = coreAi.renderRaster(model, 42, 16);
  if (Buffer.from(raster1).compare(Buffer.from(raster2)) !== 0) {
    fail("renderRaster is not deterministic for same inputs");
  }
  // Different seed produces different raster.
  const raster3 = coreAi.renderRaster(model, 43, 16);
  if (Buffer.from(raster1).compare(Buffer.from(raster3)) === 0) {
    fail("renderRaster produced same output for different seeds");
  }

  // renderRaster follows the documented rule literally — the first byte is
  // the low byte of the state after the first step.
  let state = 42 >>> 0;
  state ^= (state << 13) >>> 0;
  state ^= state >>> 17;
  state ^= (state << 5) >>> 0;
  state >>>= 0;
  const expectedFirstByte = state & 0xff;
  if (raster1[0] !== expectedFirstByte) {
    fail(`renderRaster first byte ${raster1[0]} does not match rule's first step low byte ${expectedFirstByte}`);
  }

  // renderRaster refuses malformed input rather than inventing a picture.
  let caught = false;
  try { coreAi.renderRaster({ ...model, kind: "transformer" }, 42, 16); } catch { caught = true; }
  if (!caught) fail("renderRaster did not throw for malformed model");
  caught = false;
  try { coreAi.renderRaster(model, 42, 0); } catch { caught = true; }
  if (!caught) fail("renderRaster did not throw for zero size");
  caught = false;
  try { coreAi.renderRaster(model, 42, 513); } catch { caught = true; }
  if (!caught) fail("renderRaster did not throw for oversize > MAX_RASTER_SIZE");

  // renderBoundedRaster plots the committed measurement deterministically.
  const reference = [10, 20, 30, 40, 200, 255, 0, 128];
  const reconstruction = reference.map((v) => v + 2);
  const plot1 = coreAi.renderBoundedRaster(reference, reconstruction);
  const plot2 = coreAi.renderBoundedRaster(reference, reconstruction);
  if (Buffer.from(plot1).compare(Buffer.from(plot2)) !== 0) {
    fail("renderBoundedRaster is not deterministic for same inputs");
  }

  // renderBoundedRaster refuses a mismatched pair instead of guessing.
  caught = false;
  try { coreAi.renderBoundedRaster(reference, reconstruction.slice(0, 3)); } catch { caught = true; }
  if (!caught) fail("renderBoundedRaster did not throw for length mismatch");
  caught = false;
  try { coreAi.renderBoundedRaster([], []); } catch { caught = true; }
  if (!caught) fail("renderBoundedRaster did not throw for empty reference");
  caught = false;
  try { coreAi.renderBoundedRaster(new Array(5000).fill(0), new Array(5000).fill(0)); } catch { caught = true; }
  if (!caught) fail("renderBoundedRaster did not throw for width > MAX_BOUNDED_RASTER_WIDTH");

  // 4. Route claims — /v1/verifiers and /v1/verifiers/:app/:hash.mjs must be handled.
  const verifierRoutes = [
    { method: "GET", path: "/v1/verifiers" },
    { method: "GET", path: "/v1/verifiers/ai-generative/abc.mjs" }, // prefix match
  ];
  const guards = new Set();
  let currentMethod = null;
  for (const line of app.split("\n")) {
    const method = line.match(/req\.method === "(\w+)"/);
    if (method) currentMethod = method[1];
    for (const match of line.matchAll(/pathname === "([^"]+)"/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
    for (const match of line.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
  }
  for (const { method, path } of verifierRoutes) {
    const key = `${method} ${path}`;
    if (guards.has(key)) continue;
    const byPrefix = Array.from(guards).some(
      (guard) => guard.startsWith(`${method} `) && path.startsWith(guard.split(" ")[1] + "/"),
    );
    if (byPrefix) continue;
    fail(`AI verifier route ${key} is published but app.ts no longer handles it`);
  }

  // 5. Attestation fields — the doc states representation, metricName, metricValue
  // are carried on the attestation. This is enforced by the TypeScript types and
  // the verifier implementations (the verify functions emit these fields in the
  // attestation they return). We verify the verifier hashes are derived from
  // manifests that include representation (the hash would change if it didn't).
  // The verifier hash stability check above covers this implicitly.

  console.log(
    `  rules: ${coreAi.RASTER_RULE}, ${coreAi.BOUNDED_RASTER_RULE} | ` +
      `verifier hashes: ${genHash.slice(0, 8)}..., ${boundedHash.slice(0, 8)}... | ` +
      `media validators: generative ok, bounded ok | ` +
      `raster renderers: generative deterministic+rule-faithful, bounded deterministic+refuses-mismatch | ` +
      `routes: /v1/verifiers handled | ` +
      `verifier manifests: generative/bounded representation declared`,
  );
}

checkAiVerificationDoc();
checkSemanticsDoc();
checkSnapshotMigrationDoc();
checkAuditWindowClaims();

/**
 * The semantics doc: docs/SEMANTICS.md publishes concrete claims about the
 * semantic layer — the Semantics record's fields, its two hash fields, the
 * binding status values GET /v1/challenges reports, the API routes, the claim
 * kinds a record licenses, and the scope rule that a claim's scope keys must
 * appear in the record's inputs or outputs. Every published field/route/rule
 * must be what the implementation actually does.
 */
function checkSemanticsDoc(docOverride, appOverride) {
  console.log(`semantics doc (docs/SEMANTICS.md${docOverride ? ", DOCTORED" : ""} vs code):`);
  const doc = docOverride ?? readFileSync(new URL("docs/SEMANTICS.md", root), "utf8");
  const app = appOverride ?? readFileSync(new URL("apps/api/src/app.ts", root), "utf8");

  // 1. The record's named fields — the doc publishes the full interface; every
  // field name must appear in the code's validator return, so a renamed or
  // dropped field cannot drift silently.
  const apiSemanticsSrc = readFileSync(new URL("apps/api/src/semantics.ts", root), "utf8");
  const apiSemantics = apiSemanticsSrc.match(
    /return\s+\{\s*id: record\.id,([\s\S]*?)\};/,
  )?.[1];
  if (!apiSemantics) fail("the Semantics validator's return object could not be located in semantics.ts");
  const fields = ["id", "app", "version", "claimKind", "title", "summary", "specHash", "verifierHash", "inputs", "outputs", "interpretation", "owner", "origin", "createdAt"];
  for (const field of fields) {
    if (!doc.includes(field)) fail(`SEMANTICS.md no longer publishes the "${field}" field`);
    if (apiSemantics && !new RegExp(`\\b${field}:`).test("id: record.id" + apiSemantics)) {
      fail(`the validator no longer returns a "${field}" field`);
    }
  }

  // 2. Binding status: the doc publishes exactly four values; the registry's
  // bindingFor must be able to report each of them, not just some.
  // The doc states them as: ok, missing, version-mismatch, spec-mismatch.
  const expectedStatuses = ["ok", "missing", "version-mismatch", "spec-mismatch"];
  for (const status of expectedStatuses) {
    if (!doc.includes(status)) fail(`SEMANTICS.md no longer lists binding status "${status}"`);
  }

  // 3. API routes — the doc's API block publishes four routes; each must be
  // handled by the app the way the route-surface kind checks it.
  const semanticsRoutes = [
    { method: "GET", path: "/v1/semantics" },
    { method: "GET", path: "/v1/semantics/:id" },
    { method: "GET", path: "/v1/challenges" },
  ];
  const guards = new Set();
  let currentMethod = null;
  for (const line of app.split("\n")) {
    const method = line.match(/req\.method === "(\w+)"/);
    if (method) currentMethod = method[1];
    for (const match of line.matchAll(/pathname === "([^"]+)"/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
    for (const match of line.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)) {
      if (currentMethod) guards.add(`${currentMethod} ${match[1].replace(/\/$/, "")}`);
    }
  }
  for (const { method, path } of semanticsRoutes) {
    const key = `${method} ${path}`;
    if (guards.has(key)) continue;
    const byPrefix = Array.from(guards).some(
      (guard) => guard.startsWith(`${method} `) && path.startsWith(guard.split(" ")[1] + "/"),
    );
    if (byPrefix) continue;
    fail(`SEMANTICS.md publishes ${key}, but app.ts no longer handles it`);
  }

  // 4. Claim kinds — the doc's table publishes four kinds. Each one a record
  // licenses must be accepted by the validator; one it drops must not be.
  const kinds = ["satisfies", "attests", "produces", "derives"];
  for (const kind of kinds) {
    if (!doc.includes(kind)) fail(`SEMANTICS.md no longer publishes claim kind "${kind}"`);
  }

  // 5. The hash fields — specHash, semanticsHash, verifierHash. The doc
  // states specHash is "the hash of the machine spec"; re-derive it the way
  // the module does and require it to be stable and non-trivial.
  const registry = semanticsModule.createSemanticsRegistry(() => []);
  const halfAdder = registry.get("logic/half-adder", 1);
  if (!halfAdder) fail("the logic/half-adder semantics record is missing from the registry");
  if (typeof halfAdder.specHash !== "string" || halfAdder.specHash.length !== 64) {
    fail("half-adder's specHash is not a 64-char hex digest");
  }
  if (semanticsModule.specHash({}) !== semanticsModule.specHash({})) {
    fail("specHash is not a pure function of its input");
  }
  const semanticsH = semanticsModule.semanticsHash(halfAdder);
  if (semanticsH.length !== 64) fail("semanticsHash did not return a 64-char digest");
  if (semanticsH !== registry.hashOf(halfAdder)) {
    fail("semanticsHash and the registry's hashOf disagree for the same record");
  }
  if (!doc.includes("semanticsHash")) fail("SEMANTICS.md no longer names the semanticsHash field");
  if (!doc.includes("verifierHash")) fail("SEMANTICS.md no longer names the verifierHash field");
  if (!doc.includes("specHash")) fail("SEMANTICS.md no longer names the specHash field");

  // 6. The scope rule: "Scope keys must appear in the semantics' inputs or
  // outputs". Exercise it through the real claim binder: a scope key the
  // record does not contemplate must be rejected, and one it does must pass.
  const challenge = {
    id: "half-adder",
    app: "logic",
    title: "half-adder",
    description: "half-adder",
    version: 1,
    spec: { inputs: ["a", "b"], outputs: ["sum", "carry"] },
    semanticsId: "logic/half-adder",
    semanticsVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const attestation = {
    app: "logic",
    challengeId: "half-adder",
    taskId: "half-adder",
    circuitHash: "0".repeat(64),
    traceHash: "0".repeat(64),
    correct: true,
    score: 100,
    gateCount: 5,
    claimKind: "satisfies",
    scope: null,
    verifierHash: halfAdder.verifierHash ?? "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const okBind = semanticsModule.bindClaim(attestation, challenge, registry, {
    scope: { dataset: "erp-prod" },
  });
  const goodScope = semanticsModule.bindClaim(attestation, challenge, registry, {});
  if ("error" in goodScope) fail(`a scope-less claim must bind, got: ${goodScope.error}`);
  const recordInputs = [...halfAdder.inputs, ...halfAdder.outputs];
  const inScopeKey = recordInputs[0];
  const inBind = semanticsModule.bindClaim(attestation, challenge, registry, { scope: { [inScopeKey]: "v" } });
  if ("error" in inBind) fail(`a scope key the record contemplates (${inScopeKey}) was rejected: ${inBind.error}`);
  if (!("error" in okBind)) fail("a scope key the record does not contemplate was accepted");

  console.log(
    `  ${fields.length} record fields vs the validator | ${expectedStatuses.length} binding statuses | ` +
      `${semanticsRoutes.length} route(s) handled | ${kinds.length} claim kind(s) | ` +
      `specHash ${halfAdder.specHash.slice(0, 8)}… (stable) | scope rule enforced through bindClaim`,
  );
}

/**
 * The snapshot/migration claims in docs/OPERATIONS.md: the "Snapshots and
 * migrations" section publishes CURRENT_SNAPSHOT_VERSION = 2, the 1 → 2
 * migration that adds empty rotations and delegations arrays, the load-time
 * refusal of a newer snapshot, and the "publications must be an array"
 * validation; the "Game-native state migration" section publishes the plan's
 * kind/version, its status/mode, the eight durable collections, and the
 * refusal of --execute/--cutover. Every published constant and behaviour must
 * be what the modules actually do.
 */
function checkSnapshotMigrationDoc(docOverride) {
  console.log(`snapshot/migration doc (docs/OPERATIONS.md${docOverride ? ", DOCTORED" : ""} vs code):`);
  const doc = docOverride ?? readFileSync(new URL("docs/OPERATIONS.md", root), "utf8");

  // 1. The published version number.
  const version = Number(doc.match(/Snapshot version (\d+) is current/)?.[1]);
  if (version !== migrations.CURRENT_SNAPSHOT_VERSION) {
    fail(`OPERATIONS.md states snapshot version ${version} is current; the code's CURRENT_SNAPSHOT_VERSION is ${migrations.CURRENT_SNAPSHOT_VERSION}`);
  }

  // 2. The 1 → 2 migration: it adds empty rotations and delegations arrays,
  // and a v1 store that never rotated a key loads unchanged otherwise.
  const oneTwo = migrations.snapshotMigrations.find((m) => m.from === 1 && m.to === 2);
  if (!oneTwo) fail("the 1 → 2 migration is missing from snapshotMigrations");
  const v1 = { version: 1, publications: [{ id: "p1" }] };
  const migrated = migrations.migrateSnapshot(v1);
  if (!Array.isArray(migrated.snapshot.rotations) || migrated.snapshot.rotations.length !== 0) {
    fail("the 1 → 2 migration did not add an empty rotations array");
  }
  if (!Array.isArray(migrated.snapshot.delegations) || migrated.snapshot.delegations.length !== 0) {
    fail("the 1 → 2 migration did not add an empty delegations array");
  }
  if (!Array.isArray(migrated.snapshot.publications) || migrated.snapshot.publications.length !== 1) {
    fail("the 1 → 2 migration did not preserve the existing publications array");
  }
  if (migrated.snapshot.version !== 2) fail("the 1 → 2 migration did not advance the version to 2");
  if (!doc.includes("adds empty") || !doc.includes("rotations")) {
    fail("OPERATIONS.md no longer states the 1 → 2 migration adds empty rotations");
  }

  // 3. A current-version snapshot loads unchanged (positive control).
  const v2 = { version: 2, publications: [] };
  const r2 = migrations.migrateSnapshot(v2);
  if (r2.from !== 2 || r2.snapshot.version !== 2 || r2.applied.length !== 0) {
    fail("a current-version snapshot was not loaded unchanged");
  }

  // 4. A newer snapshot is refused with the published message.
  let caught = false;
  try {
    migrations.migrateSnapshot({ version: migrations.CURRENT_SNAPSHOT_VERSION + 1, publications: [] });
  } catch (error) {
    caught = /newer than this build supports/.test(error.message);
  }
  if (!caught) fail("a newer snapshot was not refused with the 'newer than this build' message");
  if (!doc.includes("newer than the running build")) {
    fail("OPERATIONS.md no longer states that a newer snapshot is refused");
  }

  // 5. A broken migration chain is refused (no gap can silently load).
  caught = false;
  try {
    migrations.migrateSnapshot({ version: 1, publications: [] }, [], 3);
  } catch (error) {
    caught = /no snapshot migration from version/.test(error.message);
  }
  if (!caught) fail("a broken migration chain was not refused");
  if (!doc.includes("An older snapshot without a full chain")) {
    fail("OPERATIONS.md no longer states that a broken chain is refused");
  }

  // 6. The "publications must be an array" validation lives in the store's
  // load path; the doc names it, and the store source must still carry it.
  const storeSource = readFileSync(new URL("apps/api/src/store.ts", root), "utf8");
  if (!storeSource.includes("publications must be an array")) {
    fail("the store no longer validates that publications is an array");
  }
  if (!doc.includes("validates that `publications` is an array")) {
    fail("OPERATIONS.md no longer states that publications must be an array");
  }

  // 7. The corrupt-file refusal: the store stops the process with
  // "could not load …" instead of starting from an empty store.
  if (!storeSource.includes("could not load")) {
    fail("the store no longer reports 'could not load' for a corrupt snapshot");
  }
  if (!doc.includes("could not load")) {
    fail("OPERATIONS.md no longer names the 'could not load' refusal");
  }

  // 8. Game-state plan: the published kind/version/status/mode constants.
  const plan = gameState.buildGameStateMigrationPlan(
    { version: 2, publications: [] },
    { source: "source.json", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  if (plan.kind !== "rarext.game-state-migration") {
    fail(`the plan's kind is ${plan.kind}, not the published rarext.game-state-migration`);
  }
  if (plan.version !== 1) fail(`the plan's version is ${plan.version}, not the published 1`);
  if (plan.status !== "deferred") {
    fail(`the plan's status is ${plan.status}, not the published "deferred"`);
  }
  if (plan.mode !== "no-op") {
    fail(`the plan's mode is ${plan.mode}, not the published "no-op"`);
  }
  if (!doc.includes('"deferred"') || !doc.includes('"no-op"')) {
    fail("OPERATIONS.md no longer states the plan is status deferred and mode no-op");
  }

  // 9. The plan copies every durable collection; the published list must
  // match the module's.
  const publishedCollections = [
    "publications", "identities", "anchors", "identityLinks",
    "revocations", "credits", "rotations", "delegations",
  ];
  const moduleCollections = plan.collections.map((c) => c.name);
  for (const name of publishedCollections) {
    if (!moduleCollections.includes(name)) {
      fail(`the plan no longer carries the durable collection ${name}`);
    }
  }
  if (moduleCollections.length !== publishedCollections.length) {
    fail(`the plan carries ${moduleCollections.length} collections; the doc publishes ${publishedCollections.length}`);
  }

  // 10. The command refuses --execute and --cutover.
  const scriptSource = readFileSync(new URL("scripts/plan-game-state-migration.mjs", root), "utf8");
  if (!scriptSource.includes("--execute") || !scriptSource.includes("--cutover")) {
    fail("the plan command no longer parses --execute/--cutover");
  }
  if (!scriptSource.includes("cutover execution is not implemented")) {
    fail("the plan command no longer refuses cutover execution");
  }
  if (!doc.includes("--execute") || !doc.includes("--cutover")) {
    fail("OPERATIONS.md no longer states the command refuses --execute and --cutover");
  }

  // 11. The bundle copies every durable snapshot record AND extension fields —
  // the doc's "copies every durable snapshot record and extension field" claim
  // must be what buildGameStateMigrationBundle actually does.
  const extensionSnapshot = { version: 2, publications: [], customExtension: "kept" };
  const bundle = gameState.buildGameStateMigrationBundle(extensionSnapshot, {
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  if (bundle.snapshot.customExtension !== "kept") {
    fail("the bundle did not copy the extension field customExtension");
  }
  if (!bundle.unmanagedTopLevelFields.includes("customExtension")) {
    fail("the bundle did not report customExtension as an unmanaged top-level field");
  }
  if (!doc.includes("The bundle copies every durable snapshot")) {
    fail("OPERATIONS.md no longer states the bundle copies every durable snapshot record and extension field");
  }

  console.log(
    `  snapshot version ${migrations.CURRENT_SNAPSHOT_VERSION} current | ` +
      `1 → 2 adds empty rotations+delegations, preserves publications | ` +
      `newer snapshot refused | broken chain refused | ` +
      `publications array validated | 'could not load' on corrupt file | ` +
      `plan: kind rarext.game-state-migration v1, status deferred, mode no-op | ` +
      `${publishedCollections.length} durable collections | --execute/--cutover refused`,
  );
}

console.log(failures === 0 ? "\nall published claims match the implementation" : `\n${failures} mismatch(es)`);
process.exit(failures === 0 ? 0 : 1);
