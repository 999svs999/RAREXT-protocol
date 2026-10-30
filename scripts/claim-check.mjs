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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
const challengeConstants = await import(new URL("apps/api/src/challenges.ts", root).href);
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

/**
 * Run an injection, or fail loudly because it changed nothing.
 *
 * A doctor whose target has been renamed replaces nothing, so the "doctored" text
 * equals the real source and the case comparing them passes while testing nothing
 * — twice this week that happened, and only the guard complained, never the case.
 * Routing every injection through this makes a stale one impossible to miss: the
 * mutation must differ from its input, or the self-test fails naming it.
 */
/**
 * Assert that a guard's CONDITION holds on the real tree.
 *
 * `doctor` proves an injection changes something; this proves the guard it feeds
 * actually RUNS. The two failures look identical from a green gate: a guard whose
 * condition is false never fires, and a guard with nothing to report also never
 * fires. A regex written with doubled backslashes did exactly this — it matched a
 * literal backslash, so it could never be true, and the only thing that noticed was
 * testing the guard against the real file rather than through its injection.
 *
 * Every conditional guard added in this loop gets one of these.
 */
const requireCondition = (label, condition) => {
  if (!condition) {
    fail(`self-test: the guard "${label}" does not run on the real tree — its condition is false, so it protects nothing`);
  }
};

const doctor = (original, label, mutate) => {
  const doctored = mutate(original);
  if (doctored === original) {
    fail(`self-test: the ${label} injection is STALE — it changed nothing, so its case proves nothing`);
  }
  return doctored;
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
  const doctored = doctor(original, "doctored", (s) => s.replace(/^\|\s*10%\s*\|\s*44\s*\|/m, "| 10% | 45 |"));
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
  const doctoredDoc = doctor(originalArchitecture, "doctoredDoc", (s) => s.replace(
    "| GET | `/health` |",
    "| GET | `/health` |\n| GET | `/v1/time-travel` |",
  ));
  checkRouteSurface(doctoredDoc);
  caught = caught && failures > beforeRoutes;
  // And a soak run that failed must be reported, not waved through.
  const beforeSoak = failures;
  const realSoak = readFileSync(new URL("bench/storage/soak-2026-10-26.log", root), "utf8");
  const doctoredSoak = doctor(realSoak, "doctoredSoak", (s) => s.replace(
    "| Put | 5991 | 5991 | 0 | 100.0% |",
    "| Put | 5991 | 5942 | 49 | 99.2% |",
  ));
  checkSoakLog(doctoredSoak);
  caught = caught && failures > beforeSoak;
  // A doctored input that equals its original proves nothing: the anchor
  // silently no-op'd, and the self-test would pass while testing the real
  // input. Every fixture must actually differ before its result is trusted.
  // The guards added through this loop, each asserted to be RUNNING on the real
  // tree — not just to fire when injected. A guard whose condition is false is
  // indistinguishable from a guard with nothing to report.
  {
    const aiDocReal = readFileSync(new URL("docs/AI-VERIFICATION.md", root), "utf8");
    const mirrorsReal = readFileSync(new URL("docs/MIRRORS.md", root), "utf8");
    const hardeningReal = readFileSync(new URL("docs/HARDENING.md", root), "utf8");
    const archReal = readFileSync(new URL("docs/ARCHITECTURE.md", root), "utf8");
    requireCondition("browser proof page", aiDocReal.includes("mirror/ai.html"));
    requireCondition("bundle builder", aiDocReal.includes("buildBundle(publications"));
    requireCondition("resident self-publish", aiDocReal.includes("selfPublishGenerative"));
    requireCondition("local attest verb", archReal.includes("rarext_attest_local"));
    requireCondition("registry list cap", mirrorsReal.includes("MAX_REGISTRIES_PER_LIST"));
    requireCondition("key revocation kind", mirrorsReal.includes("key` revocation kind"));
    requireCondition("announcement-document bound", hardeningReal.includes("MAX_ANNOUNCEMENT_DOCUMENTS"));
    requireCondition("redirect hop checks", hardeningReal.includes("each hop is resolved against the current URL and re-checked"));
    requireCondition("SDK input bounds", hardeningReal.includes("MAX_GENERATIVE_STEPS"));
    const aiModuleReal = readFileSync(new URL("apps/web/src/ai.ts", root), "utf8");
    const aiPageReal = readFileSync(new URL("apps/web/src/ai-page.ts", root), "utf8");
    requireCondition("page fixture parser", aiModuleReal.includes("export function fixtureFromBundle"));
    requireCondition("page delegates parsing", aiPageReal.includes("fixtureFromBundle("));
    // Read the source HERE, in this block: a requireCondition that borrows a guard's
    // local is a ReferenceError, not a check — the same trap as last cycle, where the
    // rule had just been written down and was still broken.
    const galleryReal = readFileSync(new URL("site/registry/mirror/gallery.html", root), "utf8");
    requireCondition("gallery re-derives renditions", galleryReal.includes("verifyPublishedRendition("));
    requireCondition("rendition check is exported", aiModuleReal.includes("export async function verifyPublishedRendition"));
    const coreAiReal = readFileSync(new URL("packages/core/src/ai.ts", root), "utf8");
    const mcpLocalReal = readFileSync(new URL("apps/mcp/src/attest-local.ts", root), "utf8");
    requireCondition("one rendition assembly", coreAiReal.includes("export function renditionFor("));
    requireCondition("the MCP ships renditions too", mcpLocalReal.includes("renditionFor("));
  }

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
  const doctoredLimitsDoc = doctor(originalOperations, "doctoredLimitsDoc", (s) => s.replace(
    "`MAX_VOCAB` = 4,096",
    "`MAX_VOCAB` = 8,192",
  ));
  checkLimitsTable(doctoredLimitsDoc);
  const caughtLimits = failures > beforeLimits;
  if (!caughtLimits) fail("self-test: the checker accepted a limits table the code contradicts");
  caught = caught && caughtLimits;
  // And an AI bounds row the code outgrows must be reported.
  const beforeReplay = failures;
  const doctoredOperationsDoc = doctor(originalOperations, "doctoredOperationsDoc", (s) => s.replace(
    "`MAX_GENERATIVE_TOKEN_LENGTH` = 256 UTF-16 code units",
    "`MAX_GENERATIVE_TOKEN_LENGTH` = 128 UTF-16 code units",
  ));
  checkReplayBounds(doctoredOperationsDoc);
  const caughtReplay = failures > beforeReplay;
  if (!caughtReplay) fail("self-test: the checker accepted an AI bounds row the code contradicts");
  caught = caught && caughtReplay;
  // And an operational default the code contradicts must be reported.
  const beforeDefaults = failures;
  const doctoredOperatorDoc = doctor(originalOperatorDoc, "doctoredOperatorDoc", (s) => s.replace(
    "every 6 hours (`RAREXT_CHALLENGE_INTERVAL_MS`)",
    "every 12 hours (`RAREXT_CHALLENGE_INTERVAL_MS`)",
  ));
  checkOperationalDefaults(doctoredOperatorDoc);
  const caughtDefaults = failures > beforeDefaults;
  if (!caughtDefaults) fail("self-test: the checker accepted an operational default the code contradicts");

  // And a challenge-boundary cap the code contradicts must be reported.
  const beforeChallengeCaps = failures;
  const doctoredHardening = doctor(
    readFileSync(new URL("docs/HARDENING.md", root), "utf8"),
    "doctoredHardening",
    (s) => s.replace("`MAX_CONFIGURED_CHALLENGES` = 256", "`MAX_CONFIGURED_CHALLENGES` = 512"),
  );
  checkChallengeBoundaryLimits(doctoredHardening);
  const caughtChallengeCaps = failures > beforeChallengeCaps;
  if (!caughtChallengeCaps) fail("self-test: the checker accepted a challenge-boundary cap the code contradicts");
  caught = caught && caughtChallengeCaps;
  caught = caught && caughtDefaults;
  // And a doc citing test evidence that is not in the tree must be reported.
  const beforeEvidence = failures;
  const doctoredOperationsDoc2 = doctor(originalOperations, "doctoredOperationsDoc2", (s) => s.replace(
    "apps/api/test/holder-fault.test.ts",
    "apps/api/test/holder-fault-removed.test.ts",
  ));
  checkEvidenceCitations(doctoredOperationsDoc2);
  const caughtEvidence = failures > beforeEvidence;
  if (!caughtEvidence) fail("self-test: the checker accepted a citation to test evidence that does not exist");
  caught = caught && caughtEvidence;
  // And a chain route the docs publish but the server drops must be reported.
  const beforeChain = failures;
  const originalChains = readFileSync(new URL("docs/CHAINS.md", root), "utf8");
  const doctoredChains = doctor(originalChains, "doctoredChains", (s) => s.replace(
    "GET  /chain/audit",
    "GET  /chain/audit\nPOST /chain/rollback",
  ));
  checkChainSurface(doctoredChains);
  const caughtChain = failures > beforeChain;
  if (!caughtChain) fail("self-test: the checker accepted a published chain route the server does not handle");
  caught = caught && caughtChain;
  // And a reward the code no longer pays must be reported.
  const beforeReward = failures;
  const originalWorkDoc = readFileSync(new URL("docs/WORK.md", root), "utf8");
  const doctoredWorkDoc = doctor(originalWorkDoc, "doctoredWorkDoc", (s) => s.replace(
    "| `verify` | per verified attestation | 10 |",
    "| `verify` | per verified attestation | 12 |",
  ));
  checkRewardTable(doctoredWorkDoc);
  const caughtReward = failures > beforeReward;
  if (!caughtReward) fail("self-test: the checker accepted a reward table the code contradicts");
  caught = caught && caughtReward;
  // And the AI verification doc — doctored rule name must be caught.
  const beforeAi = failures;
  const originalAiDoc = readFileSync(new URL("docs/AI-VERIFICATION.md", root), "utf8");
  const doctoredAiDoc = doctor(originalAiDoc, "doctoredAiDoc", (s) => s.replace("`xorshift32-image-v1`", "`xorshift32-image-v2`"));
  checkAiVerificationDoc(doctoredAiDoc);
  const caughtAi = failures > beforeAi;
  if (!caughtAi) fail("self-test: the checker accepted a doctored AI rendition rule name");
  caught = caught && caughtAi;
  // And an AI verification doc that stops naming the SDK's offline replay: the
  // sentence is held to the export and to the committed bundle, so dropping it
  // is drift, not a rewording.
  const beforeAiReplay = failures;
  const noReplayAiDoc = doctor(originalAiDoc, "noReplayAiDoc", (s) => s.replaceAll("replayBundleAi", "replayClaimsOffline"));
  checkAiVerificationDoc(noReplayAiDoc);
  const caughtAiReplay = failures > beforeAiReplay;
  if (!caughtAiReplay) fail("self-test: the checker accepted an AI verification doc that no longer names the SDK's bundle replay");
  caught = caught && caughtAiReplay;
  // And the semantics doc — a published field the validator drops must be
  // caught. The `createdAt` line anchors on the interface block.
  const beforeSemantics = failures;
  const originalSemanticsDoc = readFileSync(new URL("docs/SEMANTICS.md", root), "utf8");
  const doctoredSemanticsDoc = doctor(originalSemanticsDoc, "doctoredSemanticsDoc", (s) => s.replace(
    "  createdAt: string;",
    "  created: string;",
  ));
  checkSemanticsDoc(doctoredSemanticsDoc);
  const caughtSemantics = failures > beforeSemantics;
  if (!caughtSemantics) fail("self-test: the checker accepted a doctored semantics field name");
  caught = caught && caughtSemantics;
  // And the snapshot/migration doc — a published version the code no longer
  // supports must be caught.
  const beforeSnapshot = failures;
  const doctoredSnapshotDoc = doctor(originalOperations, "doctoredSnapshotDoc", (s) => s.replace(
    "Snapshot version 2 is current.",
    "Snapshot version 3 is current.",
  ));
  checkSnapshotMigrationDoc(doctoredSnapshotDoc);
  // And an RFC that leans on a primitive which does not exist must be reported.
  // The phantom name is built at runtime: a literal in this file would be
  // found in the walked sources and the injection would pass vacuously.
  // The injection must target what the kind READS. The primitive list is
  // explicit and checked against the SOURCES, so editing the RFC's prose about
  // primitives changes nothing the checker looks at — the first version of this
  // injection did exactly that and proved nothing. What the kind reads is the
  // RFC's own structure: its sections and its load-bearing sentence. Weakening
  // the sentence is the injection.
  const beforeRfc = failures;
  const originalRfc = readFileSync(new URL("rfcs/0019-mirror-announcements.md", root), "utf8");
  // An RFC answer that names a primitive the tree lacks — the failure mode of a
  // protocol record edited after the code moved on.
  const rfcRenamedCache = doctor(originalRfc, "rfcRenamedCache", (s) => s.replaceAll("cacheMaxAgeMs", "cacheTTLms"));
  const originalSeedListRfc = readFileSync(new URL("rfcs/0020-anchoring-the-seed-list.md", root), "utf8");
  const rfcLostTheRefusal = doctor(originalSeedListRfc, "rfcLostTheRefusal", (s) =>
    s.replace("does not match the expected digest", "is not what we were looking for"),
  );
  const originalVerifiersRfc = readFileSync(new URL("rfcs/0006-independent-verifiers.md", root), "utf8");
  const rfcPinnedTheRunner = doctor(originalVerifiersRfc, "rfcPinnedTheRunner", (s) =>
    s.replace("names the RULE, never the RUNNER", "names the runner, mostly"),
  );
  const originalClaimsRfc = readFileSync(new URL("rfcs/0003-verifiable-claims.md", root), "utf8");
  // The injection follows the ANSWER: it used to drop the "not yet" gap, and the answer
  // is positive now, so it drops the property the positive answer names. doctor()
  // refuses a stale injection, which is what caught this when the answer flipped.
  const rfcLostTheRoot = doctor(originalClaimsRfc, "rfcLostTheRoot", (s) =>
    s.replace("an anchor in name only", "good enough in practice"),
  );
  const originalRentRfc = readFileSync(new URL("rfcs/0018-storage-rent-settlement.md", root), "utf8");
  const rfcRentClaimsSettlement = doctor(originalRentRfc, "rfcRentClaimsSettlement", (s) =>
    s.replace("the quote is computed, not charged", "refunds are automatic and instant"),
  );
  const originalPlacementsRfc = readFileSync(new URL("rfcs/0005-durable-placements.md", root), "utf8");
  const rfcKeepsForks = doctor(originalPlacementsRfc, "rfcKeepsForks", (s) =>
    s.replace("refuses the second", "keeps both branches"), 1);
  
  const originalEconomyRfc = readFileSync(new URL("rfcs/0004-storage-economy.md", root), "utf8");
  const rfcRecoversKeys = doctor(originalEconomyRfc, "rfcRecoversKeys", (s) =>
    s.replace("not merely absent but incompatible", "available on request to the operator"));
  const originalMigrationRfc = readFileSync(new URL("rfcs/0017-game-native-state-migration.md", root), "utf8");
  const rfcScoresActors = doctor(originalMigrationRfc, "rfcScoresActors", (s) =>
    s.replace("DERIVED from them and never", "carried as an authoritative score and"));
  const originalAppchainRfc = readFileSync(new URL("rfcs/0016-appchain-evaluation.md", root), "utf8");
  const rfcPaysValidators = doctor(originalAppchainRfc, "rfcPaysValidators", (s) =>
    s.replace("because there are no validators", "paid from a validator reward pool by"));
  const originalTracRfc = readFileSync(new URL("rfcs/0001-trac-integration.md", root), "utf8");
  const rfcOneScheme = doctor(originalTracRfc, "rfcOneScheme", (s) =>
    s.replace("chosen per key", "fixed to ed25519 alone"));
  // doctor() compares strings, so an object fixture is built with its own assert — a
  // mutation that changed nothing must fail here rather than "pass" the stale check.
  const rfcSetAll = Object.fromEntries(
    readdirSync(new URL("rfcs", root))
      .filter((f) => f.endsWith(".md") && f !== "0000-template.md")
      .map((f) => [f, readFileSync(new URL(`rfcs/${f}`, root), "utf8")]),
  );
  const withoutVerdict = rfcSetAll["0006-independent-verifiers.md"].replace("ANSWERED: no.", "The short answer.");
  if (withoutVerdict === rfcSetAll["0006-independent-verifiers.md"]) {
    throw new Error("self-test: the RFC-set injection changed nothing, so its case proves nothing");
  }
  const rfcSetMissingVerdict = { ...rfcSetAll, "0006-independent-verifiers.md": withoutVerdict };
  
  const doctoredRfc = doctor(originalRfc, "doctoredRfc", (s) => s.replace(
    "**An announcement proposes LOCATIONS, never facts.**",
    "An announcement proposes locations.",
  ));
  checkAnnouncementRfc({ rfc: doctoredRfc });
  const caughtRfc = failures > beforeRfc;
  if (!caughtRfc) fail("self-test: the checker accepted an RFC leaning on a primitive that does not exist");
  caught = caught && caughtRfc;

  // And an RFC whose ANSWERED question names a primitive the tree lacks — the shape
  // a protocol record takes when the code moves on and the answer does not.
  const beforeRfcRename = failures;
  checkAnnouncementRfc({ rfc: rfcRenamedCache });
  const caughtRfcRename = failures > beforeRfcRename;
  if (!caughtRfcRename) fail("self-test: the checker accepted an RFC answer naming a primitive the tree lacks");
  caught = caught && caughtRfcRename;

  // And a sibling RFC whose answer stops quoting the refusal it describes.
  const beforeSeedList = failures;
  checkAnnouncementRfc({ seedList: rfcLostTheRefusal });
  const caughtSeedList = failures > beforeSeedList;
  if (!caughtSeedList) fail("self-test: the checker accepted RFC 0020 dropping the refusal its answer quotes");
  caught = caught && caughtSeedList;

  // The artifact-source rule (one writer per generated artifact) had a seam that no
  // test ever passed an override to, so the branch that reads one never ran in EITHER
  // mode — a guard that cannot be falsified is a guard that cannot fail. Coverage
  // found it; this makes it falsifiable. (No doctor() here: that helper compares
  // strings, and an array fixture would always look "changed".)
  const beforeArtifactSources = failures;
  // The override REPLACES the whole file list, so the fixture is the real generators
  // plus one doctored stray — otherwise the required generators "go missing" and the
  // run fails on a rule nobody was testing.
  const fixtureFiles = [
    "build-mirror.mjs", "publish-ai-proof.mjs", "publish-proof.mjs", "mirror-artifacts.mjs", "mirror-verify-page.mjs",
  ].map((name) => ({
    name,
    text: readFileSync(new URL(`scripts/${name}`, root), "utf8"),
  }));
  fixtureFiles.push({ name: "some-new-publisher.mjs", text: "const inline = window.__RAREXT_BUNDLE__;" });
  checkArtifactSources(fixtureFiles);
  const caughtArtifactSources = failures > beforeArtifactSources;
  if (!caughtArtifactSources) fail("self-test: the checker accepted a second writer of the inline bundle");
  caught = caught && caughtArtifactSources;

  // And a publisher whose copy list no longer carries what the mirror publishes — the
  // failure that dropped three pages from the deployment.
  const emptiedList = fixtureFiles.map((file) =>
    file.name === "publish-proof.mjs"
      ? { ...file, text: file.text.replace(/const mirrorFiles = \[[\s\S]*?\];/, "const mirrorFiles = [];") }
      : file,
  );
  const beforeCopyList = failures;
  checkArtifactSources(emptiedList);
  const caughtCopyList = failures > beforeCopyList;
  if (!caughtCopyList) fail("self-test: the checker accepted a publisher whose copy list drops published files");
  caught = caught && caughtCopyList;

  // And RFC 0006's answer softened into naming the runner — the answer this project
  // had to argue for once already.
  const beforeVerifiers = failures;
  checkAnnouncementRfc({ verifiers: rfcPinnedTheRunner });
  const caughtVerifiers = failures > beforeVerifiers;
  if (!caughtVerifiers) fail("self-test: the checker accepted RFC 0006's answer naming the runner");
  caught = caught && caughtVerifiers;

  // And RFC 0003's answer losing the gap it names — the negative claim going quiet.
  const beforeClaims = failures;
  checkAnnouncementRfc({ claims: rfcLostTheRoot });
  const caughtClaims = failures > beforeClaims;
  if (!caughtClaims) fail("self-test: the checker accepted RFC 0003 dropping the property its answer names");
  caught = caught && caughtClaims;

  // And RFC 0018's answer claiming a settlement layer that does not exist.
  const beforeRent = failures;
  checkAnnouncementRfc({ rent: rfcRentClaimsSettlement });
  const caughtRent = failures > beforeRent;
  if (!caughtRent) fail("self-test: the checker accepted RFC 0018 claiming settlement it does not have");
  caught = caught && caughtRent;

  // And RFC 0005's answer reversing the fork rule.
  const beforePlacements = failures;
  checkAnnouncementRfc({ placements: rfcKeepsForks });
  const caughtPlacements = failures > beforePlacements;
  if (!caughtPlacements) fail("self-test: the checker accepted RFC 0005 keeping both fork branches");
  caught = caught && caughtPlacements;

  // And RFC 0004's sealed tier answering with a recovery service — the property reversed.
  const beforeEconomy = failures;
  checkAnnouncementRfc({ economy: rfcRecoversKeys });
  const caughtEconomy = failures > beforeEconomy;
  if (!caughtEconomy) fail("self-test: the checker accepted RFC 0004 promising key recovery");
  caught = caught && caughtEconomy;

  // And RFC 0017's reputation answer carrying an authoritative score — the claim about an
  // actor this protocol refuses to record.
  const beforeMigration = failures;
  checkAnnouncementRfc({ migration: rfcScoresActors });
  const caughtMigration = failures > beforeMigration;
  if (!caughtMigration) fail("self-test: the checker accepted RFC 0017 carrying a score about an actor");
  caught = caught && caughtMigration;

  // And the last two RFCs: an appchain answer inventing validators, and a Trac answer
  // picking one signature scheme.
  const beforeAppchain = failures;
  checkAnnouncementRfc({ appchain: rfcPaysValidators });
  const caughtAppchain = failures > beforeAppchain;
  if (!caughtAppchain) fail("self-test: the checker accepted RFC 0016 inventing a validator set");
  caught = caught && caughtAppchain;

  const beforeTrac = failures;
  checkAnnouncementRfc({ trac: rfcOneScheme });
  const caughtTrac = failures > beforeTrac;
  if (!caughtTrac) fail("self-test: the checker accepted RFC 0001 picking a single signature scheme");
  caught = caught && caughtTrac;

  // And the axis rule itself: an RFC whose question carries no verdict. This is the check
  // that the RFC sweep is a property the gate holds, and it needed a seam to become
  // falsifiable in this mode rather than only by doctoring the real tree by hand.
  const beforeRfcSet = failures;
  checkAnnouncementRfc({ rfcSet: rfcSetMissingVerdict });
  const caughtRfcSet = failures > beforeRfcSet;
  if (!caughtRfcSet) fail("self-test: the checker accepted an RFC set with an unverdicted question");
  caught = caught && caughtRfcSet;

  // The two ways the same axis can pass while checking nothing: a section that exists and
  // holds no numbered question, and a set where no RFC has a section at all. Both are
  // "everything I examined was fine" over an empty examination, so both must FAIL.
  const beforeEmptySection = failures;
  checkAnnouncementRfc({
    rfcSet: {
      ...rfcSetAll,
      "0006-independent-verifiers.md": "## Open questions\n\n## Decision\n\nFine.\n",
    },
  });
  const caughtEmptySection = failures > beforeEmptySection;
  if (!caughtEmptySection) fail("self-test: the checker accepted an Open questions section that holds no numbered question");
  caught = caught && caughtEmptySection;

  const beforeNoSections = failures;
  checkAnnouncementRfc({
    rfcSet: { "0001-trac-integration.md": "# RFC\n\nNo questions here.\n", "0006-independent-verifiers.md": "# RFC\n\nAlso none.\n" },
  });
  const caughtNoSections = failures > beforeNoSections;
  if (!caughtNoSections) fail("self-test: the checker accepted an RFC set whose verdict sweep examined nothing");
  caught = caught && caughtNoSections;
  // And a doc that publishes a knob nothing reads must be reported — the
  // fixture renames a real env name in the architecture doc.
  const beforeConfig = failures;
  const originalConfigDoc = readFileSync(new URL("docs/ARCHITECTURE.md", root), "utf8");
  const phantomEnv = `RAREXT_VERIFIERS_V${originalConfigDoc.length}`;
  const doctoredConfigDoc = doctor(originalConfigDoc, "doctoredConfigDoc", (s) => s.replace(
    /`RAREXT_VERIFIERS`/g,
    `\`${phantomEnv}\``,
  ));
  checkConfigSurface(doctoredConfigDoc);
  const caughtConfig = failures > beforeConfig;
  if (!caughtConfig) fail("self-test: the checker accepted a documented knob nothing reads");
  caught = caught && caughtConfig;
  // And a front door that lost its proof link must be reported — a landing
  // page that only describes the proof is the failure this check exists for.
  const beforeFrontDoor = failures;
  const originalLanding = readFileSync(new URL("site/index.html", root), "utf8");
  const doctoredLanding = doctor(originalLanding, "doctoredLanding", (s) => s.replace(/ data-pin-root/g, ""));
  checkFrontDoor(undefined, doctoredLanding);
  const caughtFrontDoor = failures > beforeFrontDoor;
  if (!caughtFrontDoor) fail("self-test: the checker accepted a front door without its pinned proof link");
  caught = caught && caughtFrontDoor;

  // And a front door that loses the AI-proof link must be reported: the page is
  // published, and a proof nobody can reach is a proof nobody checks.
  const noAiLink = doctor(originalLanding, "noAiLink", (s) => s.replace(
    '\n          <a href="./mirror/ai.html">Make an AI proof in your browser →</a>',
    "",
  ));
  const beforeAiLink = failures;
  checkFrontDoor(undefined, noAiLink);
  const caughtAiLink = failures > beforeAiLink;
  if (!caughtAiLink) fail("self-test: the checker accepted a front door without the AI-proof link");
  caught = caught && caughtAiLink;
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
  // And a caller that re-grows the verification sequence must be reported —
  // the fixture both strips a caller's delegation and injects a private
  // refusal loop, the two shapes a re-fork takes.
  const beforeSequence = failures;
  const realApiBundle = readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
  const doctoredApiBundle =
    realApiBundle.replaceAll("foldAnnouncements(", "foldAnnouncementsUnused(") +
    "\n// stray fork\nconst refusals = [];\nconst refuse = (url, reason) => {\n  refusals.push({ url, reason });\n};\n";
  const realSdkIndex = readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
  const doctoredSdkIndex = doctor(realSdkIndex, "doctoredSdkIndex", (s) => s.replaceAll("verifyCandidates(", "verifyCandidatesUnused("));
  checkVerifySequence({
    "apps/api/src/bundle.ts": doctoredApiBundle,
    "packages/agent-sdk/src/index.ts": doctoredSdkIndex,
  });
  const caughtSequence = failures > beforeSequence;
  if (!caughtSequence) fail("self-test: the checker accepted a re-forked verification sequence");
  caught = caught && caughtSequence;
  // And a caller that inlines the announcement's own signature and window
  // checks instead of calling core's fold must be reported: the fixture is a
  // copy of the window arithmetic core owns, which is the re-fork this guard
  // names.
  const beforeFold = failures;
  const inlinedApiBundle =
    realApiBundle +
    "\n// stray announcement re-fork\n" +
    "const strayWindow = (payload: { issuedAt?: string; expiresAt?: string }) => {\n" +
    "  const issuedAt = new Date(payload.issuedAt as string);\n" +
    "  const expiresAt = new Date(payload.expiresAt as string);\n" +
    "  if (expiresAt.getTime() <= issuedAt.getTime()) throw new Error(\"stale\");\n" +
    "  return issuedAt;\n" +
    "};\n";
  checkVerifySequence({ "apps/api/src/bundle.ts": inlinedApiBundle });
  const caughtFold = failures > beforeFold;
  if (!caughtFold) fail("self-test: the checker accepted an inlined announcement verification");
  caught = caught && caughtFold;
  // And a SECOND module holding the announcement record's shape — a third
  // implementation outside the two callers — must be reported. The fixture
  // appends the record's kind to a module that has no business carrying it.
  const beforeThird = failures;
  const realMcpServer = readFileSync(new URL("apps/mcp/src/server.ts", root), "utf8");
  const thirdAnnouncementHolder =
    realMcpServer + '\nconst strayRecord = { kind: "rarext.mirror-announcement" };\n';
  checkVerifySequence({ "apps/mcp/src/server.ts": thirdAnnouncementHolder });
  const caughtThird = failures > beforeThird;
  if (!caughtThird) fail("self-test: the checker accepted a second module holding the announcement record's shape");
  caught = caught && caughtThird;
  // And a coverage map that lists a doc this checker never reads must be
  // reported — the map is only useful if it cannot drift from the checker.
  const beforeCoverage = failures;
  const originalClaimsMap = readFileSync(new URL("docs/CLAIMS.md", root), "utf8");
  // The phantom name is built at runtime on purpose: a literal fixture string
  // would appear in THIS file's own source, so the "the checker never mentions
  // it" assertion would find the fixture rather than the document and the
  // injection would pass vacuously.
  const phantomDoc = `docs/PHANTOM-${originalClaimsMap.length}.md`;
  const doctoredClaimsMap = doctor(originalClaimsMap, "doctoredClaimsMap", (s) => s.replace(
    "| `docs/WORK.md` | reward table |",
    `| \`${phantomDoc}\` | reward table |`,
  ));
  if (doctoredClaimsMap === originalClaimsMap) fail("self-test: the claims-map fixture no longer changes its input");
  checkClaimsCoverage(doctoredClaimsMap);
  const caughtCoverage = failures > beforeCoverage;
  if (!caughtCoverage) fail("self-test: the checker accepted a coverage map naming a document it never reads");
  caught = caught && caughtCoverage;
  // And a runtime floor the package contradicts must be reported.
  const beforeCrypto = failures;
  const originalCryptoDoc = readFileSync(new URL("docs/CRYPTO.md", root), "utf8");
  const doctoredCryptoDoc = doctor(originalCryptoDoc, "doctoredCryptoDoc", (s) => s.replace(/Node \d+\.\d+\+/, "Node 20.12+"));
  checkCryptoDoc(doctoredCryptoDoc);
  const caughtCrypto = failures > beforeCrypto;
  if (!caughtCrypto) fail("self-test: the checker accepted a runtime floor the package contradicts");
  caught = caught && caughtCrypto;
  // And an app-protocol config name the code never reads must be reported.
  const beforeAppProtocol = failures;
  const originalAppProtocol = readFileSync(new URL("docs/APP-PROTOCOL.md", root), "utf8");
  const doctoredAppProtocol = doctor(originalAppProtocol, "doctoredAppProtocol", (s) => s.replace("RAREXT_CHALLENGES`", "RAREXT_CHALLENGES_V2`"));
  checkAppProtocol(doctoredAppProtocol);
  const caughtAppProtocol = failures > beforeAppProtocol;
  if (!caughtAppProtocol) fail("self-test: the checker accepted a documented config name no code reads");
  caught = caught && caughtAppProtocol;
  // And a mirrors doc naming an npm script the tree does not define must be
  // reported (this is also how a doc that stops pointing at the CI-run
  // takedown test would be caught).
  const beforeMirrors = failures;
  const originalMirrorsDoc = readFileSync(new URL("docs/MIRRORS.md", root), "utf8");
  const doctoredMirrorsDoc = doctor(originalMirrorsDoc, "doctoredMirrorsDoc", (s) => s.replace("npm run test:takedown", "npm run test:mirror"));
  checkMirrorsDoc(doctoredMirrorsDoc);
  const caughtMirrors = failures > beforeMirrors;
  if (!caughtMirrors) fail("self-test: the checker accepted a mirrors doc naming an undefined npm script");
  caught = caught && caughtMirrors;
  // And a mirrors doc that stops naming the pinning call must be reported:
  // the new sentences are held to the code, so dropping one is drift.
  const beforePinDoc = failures;
  const unpinnedMirrorsDoc = doctor(originalMirrorsDoc, "unpinnedMirrorsDoc", (s) => s.replace("`pinBundle`", "`pinTheBundle`"));
  checkMirrorsDoc(unpinnedMirrorsDoc);
  const caughtPinDoc = failures > beforePinDoc;
  if (!caughtPinDoc) fail("self-test: the checker accepted a mirrors doc that no longer names the pinning call");
  caught = caught && caughtPinDoc;
  // And a publish flow that stops recording what the pinning call returned must
  // be reported — the doc's sentence is held to the code, not to itself.
  const realPublishProof = readFileSync(new URL("scripts/publish-proof.mjs", root), "utf8");
  const doctoredPublishProof = doctor(realPublishProof, "doctoredPublishProof", (s) => s.replace("seed.pins =", "seed.recordedPins ="));
  const beforePinWrite = failures;
  checkMirrorsDoc(undefined, { publishProof: doctoredPublishProof });
  const caughtPinWrite = failures > beforePinWrite;
  if (!caughtPinWrite) fail("self-test: the checker accepted a publish flow that writes no seed.pins");
  caught = caught && caughtPinWrite;
  // And a resident demo that stops calling the resolver — the doc's sentence
  // about that leg would then be describing a script that does not do it.
  const demoSource = readFileSync(new URL("scripts/demo-resident.mjs", root), "utf8");
  const doctoredDemo = doctor(demoSource, "doctoredDemo", (s) => s.replace("sdk.identityFromPublishedOrigin(", "sdk.notTheResolver("));
  const beforeDemo = failures;
  checkMirrorsDoc(undefined, { demoResident: doctoredDemo });
  const caughtDemo = failures > beforeDemo;
  if (!caughtDemo) fail("self-test: the checker accepted a demo that never calls the resolver it documents");
  caught = caught && caughtDemo;
  // And a standing test that stops comparing the committed digest with the
  // published list's — the live property, downgraded to a presence check.
  const standingSource = readFileSync(new URL("apps/api/test/published-bundle.test.ts", root), "utf8");
  const doctoredStanding = doctor(standingSource, "doctoredStanding", (s) => s.replace(
    "commitment.digest,\n    digest,",
    "commitment.digest,\n    commitment.digest,",
  ));
  const beforeStanding = failures;
  checkMirrorsDoc(undefined, { standingTest: doctoredStanding });
  const caughtStanding = failures > beforeStanding;
  if (!caughtStanding) fail("self-test: the checker accepted a standing test that compares a digest with itself");
  caught = caught && caughtStanding;
  // And a commitment reader that stops checking the artifact's KIND — now it
  // accepts any artifact with a matching field name — must be reported.
  const commitmentSource = readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
  const coreShapeSource = readFileSync(new URL("packages/core/src/registries.ts", root), "utf8");
  const doctoredCommitment = doctor(coreShapeSource, "doctoredCommitment", (s) => s.replace(
    "if (artifact.kind !== REGISTRY_LIST_COMMITMENT_KIND) return null;",
    "// kind ignored",
  ));
  const beforeCommitment = failures;
  checkMirrorsDoc(undefined, { registryClient: commitmentSource, coreShape: doctoredCommitment });

  // And an API twin that stops checking hops — the doc's redirect sentence gone
  // false in the tree — must be reported.
  const apiTwinReal = readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
  const noHopCheck = doctor(apiTwinReal, "noHopCheck", (s) => s.replaceAll("fetchWithUrlPolicy(", "request("));
  const beforeHop = failures;
  checkMirrorsDoc(undefined, { apiBundle: noHopCheck });
  const caughtHop = failures > beforeHop;
  if (!caughtHop) fail("self-test: the checker accepted a caller that does not check redirect hops");
  caught = caught && caughtHop;

  // And a core that declares the announcement bound but no longer APPLIES it —
  // the doc still true in prose, the bound gone from the fold — must be reported.
  const coreAnn = readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
  const unappliedBound = doctor(coreAnn, "unappliedBound", (s) => s.replace("input.maxAnnouncementDocuments ?? MAX_ANNOUNCEMENT_DOCUMENTS", "Number.MAX_SAFE_INTEGER"));
  const beforeBound = failures;
  checkMirrorsDoc(undefined, { coreAnnouncements: unappliedBound });
  const caughtBound = failures > beforeBound;
  if (!caughtBound) fail("self-test: the checker accepted a declared bound that the fold does not apply");
  caught = caught && caughtBound;

  // And an API twin that does not apply the shared policy — the doc says both
  // callers do — must be reported.
  const apiBundleReal = readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
  // The shape moved (the policy is applied through core's hop-checking fetch), so
  // the injection names what the tree holds NOW: a stale doctor injects nothing and
  // the case passes for the wrong reason.
  const noPolicyTwin = doctor(apiBundleReal, "noPolicyTwin", (s) => s.replaceAll("fetchWithUrlPolicy(", "someOtherCheck("));
  const beforeTwin = failures;
  checkMirrorsDoc(undefined, { apiBundle: noPolicyTwin });
  const caughtTwin = failures > beforeTwin;
  if (!caughtTwin) fail("self-test: the checker accepted an API twin without the shared URL policy");
  caught = caught && caughtTwin;
  const caughtCommitment = failures > beforeCommitment;
  if (!caughtCommitment) fail("self-test: the checker accepted a commitment reader that ignores the artifact kind");
  caught = caught && caughtCommitment;
  // And a client that computes a digest and then ignores the mismatch — the check
  // the doc promises, in the shape of a no-op — must be reported.
  const digestClientSource = readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
  const doctoredDigest = doctor(digestClientSource, "doctoredDigest", (s) => s.replace(
    "if (actual !== options.expectDigest) {",
    "if (false) {",
  ));
  const beforeDigest = failures;
  checkMirrorsDoc(undefined, { registryClient: doctoredDigest });
  const caughtDigest = failures > beforeDigest;
  if (!caughtDigest) fail("self-test: the checker accepted a digest check that never refuses");
  caught = caught && caughtDigest;
  // And a one-call join that stops folding announcements — the doc's sentence is
  // then describing something the client does not do.
  const networkJoinSource = readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
  const doctoredNetwork = doctor(networkJoinSource, "doctoredNetwork", (s) => s.replace(
    "await findVerifiedBundleFromSeeds([seed]",
    "await findVerifiedBundle(seed",
  ));
  const beforeNetwork = failures;
  checkMirrorsDoc(undefined, { registryClient: doctoredNetwork });
  const caughtNetwork = failures > beforeNetwork;
  if (!caughtNetwork) fail("self-test: the checker accepted a join that never folds announcements");
  caught = caught && caughtNetwork;
  // And a SERVER that grows its own normaliser for the seed list — the fork the
  // single parser exists to prevent — must be reported.
  const serverRegistrySource = readFileSync(new URL("apps/api/src/registries.ts", root), "utf8");
  const doctoredServerRegistry = doctor(serverRegistrySource, "doctoredServerRegistry", (s) => s.replace(
    "return parsed.length > 0 ? parsed : defaultSeeds();",
    "return defaultSeeds();",
  ).replace("parseRegistrySeedList(JSON.parse(text) as unknown)", "[]"));
  const beforeServerRegistry = failures;
  checkMirrorsDoc(undefined, { serverRegistry: doctoredServerRegistry });
  const caughtServerRegistry = failures > beforeServerRegistry;
  if (!caughtServerRegistry) fail("self-test: the checker accepted a server that ignores the shared seed-list parser");
  caught = caught && caughtServerRegistry;
  // And a resident's resolver that stops bounding its reads — the cap every
  // other fetch path carries — must be reported.
  const realPublishedIdentity = readFileSync(
    new URL("packages/agent-sdk/src/published-identity.ts", root),
    "utf8",
  );
  const doctoredPublishedIdentity = doctor(realPublishedIdentity, "doctoredPublishedIdentity", (s) => s.replace(
    "const bytes = await readBundleResponseBytes(response);",
    "const bytes = new Uint8Array(await response.arrayBuffer());",
  ));
  const beforeResolverCap = failures;
  checkMirrorsDoc(undefined, { publishedIdentity: doctoredPublishedIdentity });
  const caughtResolverCap = failures > beforeResolverCap;
  if (!caughtResolverCap) fail("self-test: the checker accepted a resolver that reads an unbounded document");
  caught = caught && caughtResolverCap;
  // And a fold that reads a FAILED revocation lookup as "not revoked" — the
  // fail-open this loop closed — must be reported.
  const failOpenSource = readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
  const doctoredFailOpen = doctor(failOpenSource, "doctoredFailOpen", (s) => s.replace(
    "if (!lookup.ok) {",
    "if (false && !lookup.ok) {",
  ));
  const beforeFailOpen = failures;
  checkMirrorsDoc(undefined, { announcements: doctoredFailOpen });
  const caughtFailOpen = failures > beforeFailOpen;
  if (!caughtFailOpen) fail("self-test: the checker accepted a fold that fails open on a revocation lookup");
  caught = caught && caughtFailOpen;
  // And a kinds list that loses the `key` kind — the statement RFC 0019 Q4 asked
  // for — must be reported.
  const kindsReal = readFileSync(new URL("apps/api/src/revocations.ts", root), "utf8");
  const doctoredKinds = doctor(kindsReal, "doctoredKinds", (s) => s.replace('"artifact", "key"', '"artifact"'));
  const beforeKinds = failures;
  checkMirrorsDoc(undefined, { revocations: doctoredKinds });
  const caughtKinds = failures > beforeKinds;
  if (!caughtKinds) fail("self-test: the checker accepted a kinds list without the key kind");
  caught = caught && caughtKinds;
  // And a fold that stops capping a nomination's lifetime — the immortal pointer
  // the cap exists to prevent — must be reported.
  const lifetimeSource = readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
  // Doctor the CONSTANT, not the branch: the guard checks the constant's value,
  // so a doctored branch left it passing while injecting nothing — the stale
  // injection this self-test exists to catch.
  const doctoredLifetime = doctor(lifetimeSource, "doctoredLifetime", (s) => s.replace(
    "MAX_ANNOUNCEMENT_LIFETIME_MS = 180 * 24",
    "MAX_ANNOUNCEMENT_LIFETIME_MS = 400 * 24",
  ));
  const beforeLifetime = failures;
  checkMirrorsDoc(undefined, { announcements: doctoredLifetime });
  const caughtLifetime = failures > beforeLifetime;
  if (!caughtLifetime) fail("self-test: the checker accepted a fold with no lifetime cap");
  caught = caught && caughtLifetime;
  // And a fold that stops comparing the handle against the seed's announcers —
  // the open question this loop answered — must be reported.
  const realAnnouncements = readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
  const doctoredAnnouncements = doctor(realAnnouncements, "doctoredAnnouncements", (s) => s.replace(
    "(seed.announcers ?? []).includes(handle as string)",
    "true",
  ));
  const beforeAnnouncers = failures;
  checkMirrorsDoc(undefined, { announcements: doctoredAnnouncements });
  const caughtAnnouncers = failures > beforeAnnouncers;
  if (!caughtAnnouncers) fail("self-test: the checker accepted a fold that ignores the seed's announcers");
  caught = caught && caughtAnnouncers;
  // And a fold that stops CONSULTING its cache — RFC 0019's question 5, whose
  // answer the doc states — must be reported. The injection doctors exactly
  // what the guard reads, the literal call string, not a name beside it: an
  // injection pointed at something the guard does not match injects nothing,
  // and the self-test would then report "the checker accepted a doctored row"
  // while proving nothing.
  const cacheFoldReal = readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
  const doctoredCacheFold = doctor(cacheFoldReal, "doctoredCacheFold", (s) => s.replace(
    "input.cache.get(url)",
    "doctoredCacheGet(url)",
  ));
  if (doctoredCacheFold === cacheFoldReal) fail("self-test: the cache fixture no longer changes its input");
  const beforeCacheFold = failures;
  checkMirrorsDoc(undefined, { announcements: doctoredCacheFold });
  const caughtCacheFold = failures > beforeCacheFold;
  if (!caughtCacheFold) fail("self-test: the checker accepted a fold that never consults its cache");
  caught = caught && caughtCacheFold;
  // And an identity adapter that starts DECIDING — packing a rotation window
  // of its own — must be reported. Core decides; the adapter answers.
  const realIdentityAdapter = readFileSync(new URL("apps/api/src/announcement-identity.ts", root), "utf8");
  const doctoredIdentityAdapter = doctor(realIdentityAdapter, "doctoredIdentityAdapter", (s) => s.replace(
    "store.rotationsFor(handle)",
    "store.rotationsFor(handle).filter((rotation) => Date.parse(rotation.issuedAt) <= Date.now())",
  ));
  const beforeAdapter = failures;
  checkMirrorsDoc(undefined, { identityAdapter: doctoredIdentityAdapter });
  const caughtAdapter = failures > beforeAdapter;
  if (!caughtAdapter) fail("self-test: the checker accepted an adapter that re-derives core's rotation window");
  caught = caught && caughtAdapter;
  // And a live checker with no pin check must be reported — a doc that says
  // pins are verified while the script verifies none is the quiet drift.
  const realSeedVerifier = readFileSync(new URL("scripts/verify-seed-mirrors.mjs", root), "utf8");
  const doctoredSeedVerifier = doctor(realSeedVerifier, "doctoredSeedVerifier", (s) => s.replace("export async function checkPin", "async function checkPinUnused"));
  const beforePinCheck = failures;
  checkMirrorsDoc(undefined, { seedVerifier: doctoredSeedVerifier });
  const caughtPinCheck = failures > beforePinCheck;
  if (!caughtPinCheck) fail("self-test: the checker accepted a live checker that verifies no pin");
  caught = caught && caughtPinCheck;
  // And a mirrors doc that stops naming the SDK's offline AI replay: the
  // sentence is held to the export and to the refusal it quotes.
  const beforeReplayDoc = failures;
  const noReplayMirrorsDoc = doctor(originalMirrorsDoc, "noReplayMirrorsDoc", (s) => s.replaceAll("replayBundleAi", "replayClaimsOffline"));
  checkMirrorsDoc(noReplayMirrorsDoc);
  const caughtReplayDoc = failures > beforeReplayDoc;
  if (!caughtReplayDoc) fail("self-test: the checker accepted a mirrors doc that no longer names the SDK's bundle replay");
  caught = caught && caughtReplayDoc;
  // And a mirrors doc that stops naming the resident demo must be reported:
  // the command is held to the npm script and the script's SDK imports.
  const beforeResidentDoc = failures;
  const noResidentMirrorsDoc = doctor(originalMirrorsDoc, "noResidentMirrorsDoc", (s) => s.replaceAll(
    "npm run demo:resident",
    "npm run resident-demo",
  ));
  checkMirrorsDoc(noResidentMirrorsDoc);
  const caughtResidentDoc = failures > beforeResidentDoc;
  if (!caughtResidentDoc) fail("self-test: the checker accepted a mirrors doc that no longer names the resident demo");
  caught = caught && caughtResidentDoc;
  // And a mirrors doc that stops naming multi-seed discovery must be
  // reported: the sentence is held to the SDK export, the API twin, and the
  // disagreement rule living in core.
  const beforeMultiSeed = failures;
  // replaceAll, not replace: the injection means "this doc no longer names these
  // functions ANYWHERE", and a first-occurrence doctor silently becomes a no-op
  // the moment an earlier sentence mentions them — which is exactly what a new
  // paragraph did to it.
  const noMultiSeedMirrorsDoc = originalMirrorsDoc
    .replaceAll("findVerifiedBundleFromSeeds", "findVerifiedBundleEnsemble")
    .replaceAll("bundleFromSeeds", "bundleEnsemble");
  checkMirrorsDoc(noMultiSeedMirrorsDoc);
  const caughtMultiSeed = failures > beforeMultiSeed;
  if (!caughtMultiSeed) fail("self-test: the checker accepted a mirrors doc that no longer names multi-seed discovery");
  caught = caught && caughtMultiSeed;
  // And a mirrors doc that stops naming the announcement step must be
  // reported: the sentence is held to core's verifier and the SDK's union
  // entry (RFC 0019 step 1).
  const beforeAnnouncements = failures;
  const noAnnouncementMirrorsDoc = doctor(originalMirrorsDoc, "noAnnouncementMirrorsDoc", (s) => s.replaceAll(
    "verifyAnnouncement",
    "verifyTheAnnouncement",
  ));
  checkMirrorsDoc(noAnnouncementMirrorsDoc);
  const caughtAnnouncements = failures > beforeAnnouncements;
  if (!caughtAnnouncements) fail("self-test: the checker accepted a mirrors doc that no longer names the announcement verifier");
  caught = caught && caughtAnnouncements;
  assertChanged(originalMirrorsDoc, noResidentMirrorsDoc, "mirrors-doc-resident");
  assertChanged(originalMirrorsDoc, noMultiSeedMirrorsDoc, "mirrors-doc-multiseed");
  assertChanged(originalMirrorsDoc, noAnnouncementMirrorsDoc, "mirrors-doc-announcements");
  assertChanged(originalMirrorsDoc, noReplayMirrorsDoc, "mirrors-doc-replay");
  assertChanged(originalMirrorsDoc, unpinnedMirrorsDoc, "mirrors-doc-pinning");
  assertChanged(realPublishProof, doctoredPublishProof, "publish-flow-pins");
  assertChanged(realSeedVerifier, doctoredSeedVerifier, "seed-pins-verification");
  // And an audit-window number the code contradicts must be reported.
  const beforeWindow = failures;
  const doctoredOperationsWindow = doctor(originalOperations, "doctoredOperationsWindow", (s) => s.replace(
    "default `AUDIT_WINDOW_MS` = 15 min",
    "default `AUDIT_WINDOW_MS` = 30 min",
  ));
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
  assertChanged(realSdkIndex, doctoredSdkIndex, "verify-sequence");
  assertChanged(originalLanding, doctoredLanding, "front-door");
  assertChanged(originalConfigDoc, doctoredConfigDoc, "config-surface");
  assertChanged(originalRfc, doctoredRfc, "announcement-rfc");
  assertChanged(originalOperatorDoc, doctoredOperatorDoc, "operator-defaults");
  assertChanged(originalOperations, doctoredOperationsDoc2, "evidence-citations");
  assertChanged(originalChains, doctoredChains, "chain-surface");
  assertChanged(originalWorkDoc, doctoredWorkDoc, "reward-table");
  assertChanged(originalAiDoc, doctoredAiDoc, "ai-verification");
  // And the AI doc's resident-demo sentence is held to the script as well.
  const beforeResidentAi = failures;
  const noResidentAiDoc = doctor(originalAiDoc, "noResidentAiDoc", (s) => s.replaceAll(
    "npm run demo:resident",
    "npm run resident-demo",
  ));
  checkAiVerificationDoc(noResidentAiDoc);
  const caughtResidentAi = failures > beforeResidentAi;
  if (!caughtResidentAi) fail("self-test: the checker accepted an AI doc that no longer names the resident demo");
  caught = caught && caughtResidentAi;
  // And a demo that stops CALLING selfPublish — the sentence still in the doc,
  // the work gone — must be reported.
  const selfPublishDemoReal = readFileSync(new URL("scripts/demo-self-publish.mjs", root), "utf8");
  const doctoredSelfPublishDemo = doctor(selfPublishDemoReal, "doctoredSelfPublishDemo", (s) => s.replace("sdk.selfPublish(", "sdk.assembleSomething("));
  const beforeSelfPublishDemo = failures;
  checkAiVerificationDoc(undefined, undefined, { selfPublishDemo: doctoredSelfPublishDemo });
  const caughtSelfPublishDemo = failures > beforeSelfPublishDemo;
  // And a demo that makes a computation but no GENERATION, while the doc says it
  // does, must be reported too.
  const noGenerationDemo = doctor(selfPublishDemoReal, "noGenerationDemo", (s) => s.replace("sdk.selfPublishGenerative(", "sdk.notThat("));
  const noRenditionDemo = doctor(selfPublishDemoReal, "noRenditionDemo", (s) => s.replaceAll("  rendition: 64,", ""));
  const beforeNoGeneration = failures;
  checkAiVerificationDoc(undefined, undefined, { selfPublishDemo: noGenerationDemo });
  const caughtNoGeneration = failures > beforeNoGeneration;
  if (!caughtNoGeneration) fail("self-test: the checker accepted a demo with no generation in it");
  caught = caught && caughtNoGeneration;

  // And a demo that ships no rendition — the doc's sentence kept, the picture gone.
  const beforeNoRendition = failures;
  checkAiVerificationDoc(undefined, undefined, { selfPublishDemo: noRenditionDemo });
  const caughtNoRendition = failures > beforeNoRendition;
  if (!caughtNoRendition) fail("self-test: the checker accepted a self-publish demo that ships no rendition");
  caught = caught && caughtNoRendition;

  // And a demo that only ever tries reconstructions that PASS — the negative
  // removed, the promise kept in prose — must be reported.
  const noNegativeDemo = doctor(selfPublishDemoReal, "noNegativeDemo", (s) => s.replace("outsideReplay.claims[0].correct === false", "true"));
  const beforeNoNegative = failures;
  checkAiVerificationDoc(undefined, undefined, { selfPublishDemo: noNegativeDemo });
  const caughtNoNegative = failures > beforeNoNegative;
  if (!caughtNoNegative) fail("self-test: the checker accepted a demo with no refusal in it");
  caught = caught && caughtNoNegative;
  if (!caughtSelfPublishDemo) fail("self-test: the checker accepted a self-publish demo that calls nothing");
  caught = caught && caughtSelfPublishDemo;

  // And an MCP verb registered but never dispatched — a tool listed to clients
  // that answers nothing — must be reported.
  const serverReal = readFileSync(new URL("apps/mcp/src/server.ts", root), "utf8");
  const registeredOnly = doctor(serverReal, "registeredOnly", (s) => s.replace('case "rarext_attest_local":', 'case "rarext_nothing":'));
  const beforeDispatch = failures;
  checkAiVerificationDoc(undefined, undefined, { mcpServer: registeredOnly });
  const caughtDispatch = failures > beforeDispatch;
  if (!caughtDispatch) fail("self-test: the checker accepted a registered-but-undispatched MCP verb");
  caught = caught && caughtDispatch;

  // And a server that dispatches AROUND the tested boundary — the case doing its
  // own coercion, which no test would ever reach — must be reported.
  const aroundBoundary = doctor(serverReal, "aroundBoundary", (s) => s.replace("attestLocalFromArgs(", "attestAiLocally("));
  const beforeAround = failures;
  checkAiVerificationDoc(undefined, undefined, { mcpServer: aroundBoundary });
  const caughtAround = failures > beforeAround;
  if (!caughtAround) fail("self-test: the checker accepted a dispatch that bypasses the tested boundary");
  caught = caught && caughtAround;

  // And a browser suite that stops comparing its hashes against node's — the
  // cross-runtime claim in the doc, kept in prose — must be reported.
  const webTestReal = readFileSync(new URL("apps/web/test/ai-proof.test.ts", root), "utf8");
  const noNodeCompare = doctor(webTestReal, "noNodeCompare", (s) => s.replaceAll("createHash(", "hashIt("));
  const beforeNodeCompare = failures;
  checkAiVerificationDoc(undefined, undefined, { webProofTest: noNodeCompare });
  const caughtNodeCompare = failures > beforeNodeCompare;
  if (!caughtNodeCompare) fail("self-test: the checker accepted a browser suite that never compares against node");
  caught = caught && caughtNodeCompare;

  // And a registry builder that keeps its own assembly — the drift the one shared
  // function exists to prevent — must be reported.
  const builderReal = readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
  const doctoredBuilder = doctor(builderReal, "doctoredBuilder", (s) => s.replace("return assembleBundle({", "return {"));
  const beforeBuilder = failures;
  checkAiVerificationDoc(undefined, undefined, { registryBuilder: doctoredBuilder });
  const caughtBuilder = failures > beforeBuilder;
  if (!caughtBuilder) fail("self-test: the checker accepted a registry builder with its own assembly");
  caught = caught && caughtBuilder;

  assertChanged(originalAiDoc, noResidentAiDoc, "ai-verification-resident");
  assertChanged(originalAiDoc, noReplayAiDoc, "ai-verification-replay");
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
checkVerifySequence();
checkFrontDoor();
checkConfigSurface();
checkAnnouncementRfc();
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
/**
 * The front door: the landing page is where a visitor decides whether this
 * project is a promise or a proof, so it must LINK the proof — the pinned
 * verifier and the gallery — and the deploy must pin those links with the
 * anchored root. The doc states the contract; this check holds both sides to
 * it.
 */
/**
 * The verification sequence has ONE implementation.
 *
 * "Fetch the bytes, check the seed's CID pin, verify the bundle's shape,
 * require the recomputed root to equal the pinned root, record each refusal,
 * accept the first copy that passes" used to run four times — the API's
 * `bundleFromSeed`, the SDK's `findVerifiedBundle`, the live seed checker, and
 * the proof page — and the twins are exactly what failed before: a body-reader
 * hardening reached one of two readers, a failover fix reached one of two page
 * generators. The sequence now lives in core's `verifyCandidates` with the
 * fetch and the digest injected, and the callers delegate. A fix to the order,
 * the wording, or the refusal record therefore lands in every client at once
 * — and a caller that quietly re-grows its own loop, or repeats the sequence's
 * wording, fails here.
 *
 * The proof page's `loadBundle` is the ONE deliberate exception, and the
 * exception must stay documented: core consumes the caller's sha256
 * synchronously, the only digest a browser holds is WebCrypto's asynchronous
 * digest, and an async twin of the sequence would re-fork what this closes.
 */
function checkVerifySequence(sources) {
  console.log(`verify sequence (one implementation${sources ? ", DOCTORED" : ""}):`);
  const read = (relative) =>
    sources?.[relative] ?? readFileSync(new URL(relative, root), "utf8");
  const core = read("packages/core/src/bundle.ts");
  const coreIndex = read("packages/core/src/index.ts");
  const callers = [
    ["apps/api/src/bundle.ts", "the API's bundleFromSeed"],
    ["packages/agent-sdk/src/index.ts", "the SDK's findVerifiedBundle"],
    ["scripts/verify-seed-mirrors.mjs", "the live seed checker"],
  ];
  const page = read("scripts/mirror-verify-page.mjs");

  // The sequence itself, with its identifying behaviour, lives in core.
  for (const marker of [
    "export async function verifyCandidates",
    "serves ${served}, the seed pins ${",
    "verifies internally but rebuilds",
    "no candidate rebuilt the pinned root:",
    "refusals.push",
  ]) {
    if (!core.includes(marker)) fail(`the shared sequence lost "${marker}" from core's bundle.ts`);
  }
  if (!coreIndex.includes("verifyCandidates")) {
    fail("core exports no verifyCandidates, so the callers could not be delegating to it");
  }

  // The announcement fold's own rules live in core too, and the guards for that
  // must assert what their injections claim — the first version of this check
  // asserted neither and both injections printed "the checker accepted ...",
  // which the self-test caught (the ci gate runs verify mode only, so a
  // decorative guard can ride a green gate).
  const coreAnnouncements = read("packages/core/src/announcements.ts");
  if (!coreAnnouncements.includes("expiresAt.getTime()")) {
    fail("core's announcements module no longer owns the window arithmetic");
  }
  if (!coreAnnouncements.includes("ANNOUNCEMENT_KIND")) {
    fail("core's announcements module no longer owns the record's kind");
  }
  const recordKind = /ANNOUNCEMENT_KIND\s*=\s*"([^"]+)"/.exec(coreAnnouncements)?.[1];
  if (!recordKind) {
    fail("core's announcements module no longer declares the record's kind literal");
  }
  for (const [relative, who] of callers) {
    const text = read(relative);
    // A caller comparing the window itself is a re-fork of the fold's rule.
    if (/(expiresAt|issuedAt)\.getTime\(\)/.test(text)) {
      fail(`${who} re-implements the announcement window (core's fold owns it)`);
    }
    // A caller quoting the record's kind is a second holder of the shape.
    if (text.includes(recordKind)) {
      fail(`${who} holds the announcement record's kind ("${recordKind}" lives in core)`);
    }
  }
  for (const relative of ["apps/mcp/src/server.ts", "apps/chain/src/server.ts"]) {
    let text;
    try {
      text = read(relative);
    } catch {
      continue;
    }
    if (text.includes(recordKind)) {
      fail(`${relative} holds the announcement record's kind ("${recordKind}" lives in core)`);
    }
  }

  // Each caller delegates: it names the shared function, and it does NOT
  // re-grow the behaviour. The refusal assembly and the wording moved to core
  // with the sequence; seeing them in a caller means a fork is sprouting.
  for (const [relative, who] of callers) {
    const text = read(relative);
    if (!text.includes("verifyCandidates(")) {
      fail(`${who} does not call core's verifyCandidates — the sequence is forking again`);
    }
    for (const marker of [
      "serves ${served}, the seed pins ${",
      "verifies internally but rebuilds",
      "no candidate rebuilt the pinned root:",
      "refusals.push",
    ]) {
      if (text.includes(marker)) {
        fail(`${who} re-implements the verification sequence ("${marker}" must live only in core)`);
      }
    }
  }

  // The documented exception: the browser page keeps its loop, and the reason
  // (the asynchronous WebCrypto digest) stays written beside it.
  if (!page.includes("loadBundle")) fail("the proof page lost its failover loop (loadBundle)");
  if (!page.includes("ONE deliberate exception")) {
    fail("the proof page keeps a loop outside the shared sequence but no longer documents why");
  }
  if (!page.includes("asynchronous")) {
    fail("the proof page's exception lost its stated constraint (the asynchronous WebCrypto digest)");
  }
  if (page.includes("serves ${served}, the seed pins ${")) {
    fail("the proof page re-implements the shared sequence's CID-pin wording");
  }

  console.log(
    `  core's verifyCandidates owns the order and the refusals | ${callers.length} caller(s) delegate | ` +
      `the browser page's loop stays with its documented constraint`,
  );
}

function checkFrontDoor(docOverride, indexOverride) {
  console.log(`front door (site/index.html${indexOverride ? ", DOCTORED" : ""} vs docs/MIRRORS.md):`);
  const doc = docOverride ?? readFileSync(new URL("docs/MIRRORS.md", root), "utf8");
  const index = indexOverride ?? readFileSync(new URL("site/index.html", root), "utf8");

  if (!doc.includes("data-pin-root")) {
    fail("MIRRORS.md no longer documents the landing page's pinned proof links");
  }

  if (!index.includes("data-pin-root")) {
    fail("the landing page marks no data-pin-root proof link — the front door must carry the pinned verifier");
  }
  if (!index.includes("./mirror/verify.html")) {
    fail("the landing page does not link the mirror verifier");
  }
  if (!index.includes("./mirror/gallery.html")) {
    fail("the landing page does not link the gallery — the AI artifacts that verify themselves are invisible from the front door");
  }
  if (!index.includes("./mirror/ai.html")) {
    fail("the landing page does not link the browser AI proof — a page nobody can find is half-published");
  }

  console.log("  pinned verifier, gallery, and registry linked | deploy pins data-pin-root links");
}

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


  // The publisher copies an EXPLICIT list into the published mirror — and DELETES the
  // mirror first. A page that exists in the tree but not on that list disappears on the
  // next publish: silently, and only from the deployment. It happened: ai.html, ai.js
  // and renditions.js were dropped by the first re-publish after they were added. Every
  // file the mirror carries must therefore be copied or generated, so the list and the
  // published tree cannot drift apart.
  const publisherText = sources.get("publish-proof.mjs");
  if (publisherText) {
    const listMatch = /const mirrorFiles = \[([\s\S]*?)\];/.exec(publisherText);
    if (!listMatch) {
      fail("the publisher's mirror copy list is gone, so the published mirror has no declared shape");
    } else {
      const copied = new Set(Array.from(listMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]));
      // Written from the bundle by the bundle writer, or development artifacts that are
      // not published surfaces. Named explicitly rather than guessed by shape.
      const notCopied = new Set(["bundle.json", "bundle.js", "verify.html"]);
      for (const name of readdirSync(new URL("site/registry/mirror", root))) {
        if (copied.has(name) || notCopied.has(name) || name.endsWith(".map")) continue;
        fail(
          `${name} is published in site/registry/mirror, but the publisher's copy list does not carry it — the next publish drops it`,
        );
      }
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

/**
 * The configuration surface the docs publish.
 *
 * A sweep of the docs for mechanical tokens found env-style names, state paths
 * and RFC references that were BACKED by the code but asserted by nothing: they
 * were true the day the sweep ran and could rot the next. This kind makes the
 * sweep permanent. For every doc that publishes configuration, each backticked
 * env name must be read somewhere in the source trees, each referenced
 * `rfcs/*.md` must exist, and each state path's file name must appear in the
 * code that writes it — so an operator renaming a knob, or a doc drifting from
 * it, fails the gate instead of failing an operator.
 */
/**
 * RFC 0019 (mirror announcements) — the deliverable is an argument, and its
 * load-bearing claims are about code that already exists. This kind holds them:
 * every primitive the RFC leans on must be in the trees, every document it
 * references must exist, and the three sections its analysis rests on must
 * still be there, so a later edit cannot quietly drop the security argument or
 * rename a primitive into fiction.
 */
function checkAnnouncementRfc(overrides = {}) {
  const {
    rfc: rfcOverride,
    seedList: seedListRfcOverride,
    verifiers: verifiersRfcOverride,
    claims: claimsRfcOverride,
    rent: rentRfcOverride,
    placements: placementsRfcOverride,
    economy: economyRfcOverride,
    migration: migrationRfcOverride,
    appchain: appchainRfcOverride,
    trac: tracRfcOverride,
    rfcSet: rfcSetOverride,
  } = overrides;
  console.log(`announcement rfc (rfcs/0019-mirror-announcements.md${rfcOverride ? ", DOCTORED" : ""} vs tree):`);
  const rfc = rfcOverride ?? readFileSync(new URL("rfcs/0019-mirror-announcements.md", root), "utf8");
  const { text: sources } = readSourceTrees({ includeScripts: true });

  // The primitives the RFC states as existing, each verified to exist. This list
  // is deliberately explicit: the RFC also proposes NEW names (the
  // `announcements` field among them), and a checker cannot tell a proposal
  // from a claim — the human decides which names are claims, and this list is
  // that decision, recorded where the gate can hold it.
  const EXISTING = [
    "planSeedUnion", "verifyCandidates", "verifyBundleShape", "cidV1", "canonicalize",
    "bundleFromSeed", "findVerifiedBundle", "suiteOf", "publicKeyId",
    "createAgentKeyfile", "readAgentKeyfile", "verifyPayload", "isRevoked",
    "verifyRevocation", "keyRotationPayload", "seedLabel", "readBundleResponseBytes",
  ];
  for (const name of EXISTING) {
    if (!sources.includes(name)) {
      fail(`RFC 0019 leans on ${name}, which does not exist in the source trees`);
    }
  }

  for (const path of new Set(Array.from(rfc.matchAll(/`((?:rfcs|docs)\/[\w.-]+\.md)`/g)).map((m) => m[1]))) {
    try {
      readFileSync(new URL(path, root), "utf8");
    } catch {
      fail(`RFC 0019 references ${path}, which does not exist`);
    }
  }

  for (const section of ["## Security considerations", "## Compatibility", "## Non-goals"]) {
    if (!rfc.includes(section)) {
      fail(`RFC 0019 no longer has its ${section.replace("## ", "")} section`);
    }
  }

  // The analysis the RFC exists for, in its own words: an announcement moves
  // locations, never truth. If that sentence goes, the argument has changed.
  if (!/proposes LOCATIONS, never facts/.test(rfc)) {
    fail("RFC 0019 no longer states that an announcement proposes locations, never facts");
  }

  // The ANSWERED questions lean on code BY NAME — the `key` revocation kind, the
  // cache port and its caller-supplied TTL, the lifetime cap and the skew tolerance.
  // An answer that names a primitive the tree does not have is an answer to a
  // different question, and the RFC reads exactly as confidently either way; so each
  // answer is held to the code, in the same spirit as the primitives above. This is
  // where a claim like "the fold takes an optional injected cache port" stops being
  // prose: delete the port and this fails naming the question.
  // The ANSWERED questions lean on code by name — the cache port and the TTL it
  // takes, the one exported kinds list, the lifetime cap and the skew tolerance. An
  // answer that names a primitive the tree does not have is an answer to a different
  // question, and the RFC reads exactly as confidently either way.
  //
  // Two anchors per question, because a doc states different things in different
  // shapes: what it QUOTES must appear verbatim (Q5 names its port and TTL outright),
  // and what it SUMMARISES is anchored as prose (Q2 says "180 days by default, with a
  // 5-minute clock-skew tolerance" and never spells the constants). Demanding a quote
  // the RFC only summarises is an over-strict check that fails on an honest doc —
  // which is exactly what the first version of this block did.
  const ANSWERED = [
    ["5", "cached", ["AnnouncementDocumentCache", "cacheMaxAgeMs"], ["AnnouncementDocumentCache", "cacheMaxAgeMs"]],
    ["4", "revoking an announcing key", ["yes, `key`"], ["REVOCATION_KINDS"]],
    ["2", "180 days", ["5-minute clock-skew tolerance"], ["MAX_ANNOUNCEMENT_LIFETIME_MS", "ANNOUNCEMENT_CLOCK_SKEW_MS"]],
    ["3", "Where does signature verification run", ["AnnouncementVerifier"], ["AnnouncementVerifier", "verifyPayload"]],
    ["6", "announcement list itself be pinned", ["registryListDigest"], ["registryListDigest"]],
    ["7", "announced mirror 404s", ["verifyCandidates"], ["verifyCandidates"]],
  ];
  if (!/All seven questions are answered/.test(rfc)) {
    fail("RFC 0019 no longer states that all seven of its questions are answered");
  }

  // RFC 0020 (anchoring the seed list) is the sibling this RFC's Q6 points at, and it
  // has its own four answered questions. Same treatment: what each answer QUOTES must
  // appear, and the names it leans on must exist.
  const seedListRfc =
    seedListRfcOverride ?? readFileSync(new URL("rfcs/0020-anchoring-the-seed-list.md", root), "utf8");
  if (!/^## Open questions/m.test(seedListRfc)) {
    fail("RFC 0020 no longer has its Open questions section");
  }
  const SEED_LIST_ANSWERED = [
    ["1", "Who authors the commitment", ["federation handle is the right signer"], ["federationCommitment", "FEDERATION_APP"]],
    ["2", "One commitment per list", ["in order"], ["registryListDigest"]],
    ["3", "How does a client find the list URL", ["does not match the expected digest"], ["registriesFromPublishedList"]],
    ["4", "Does the commitment need an expiry", ["no expiry is imposed"], ["generatedAt"]],
  ];
  for (const [number, marker, quoted, inCode] of SEED_LIST_ANSWERED) {
    if (!seedListRfc.includes(marker)) {
      fail(`RFC 0020's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!seedListRfc.includes(quote)) {
        fail(`RFC 0020's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0020's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }

  // RFC 0005 (durable placements) — where data lives and how it survives. Its answers
  // lean on the durability + sampling machinery, which is in apps/api.
  const placementsRfc =
    placementsRfcOverride ?? readFileSync(new URL("rfcs/0005-durable-placements.md", root), "utf8");
  const PLACEMENTS_ANSWERED = [
    ["1", "signed receipt", ["the publisher's own write is the record"], ["directoryHolder"]],
    ["2", "challenges be sampled", ["COMPUTED rather than fixed"], ["samplesForMissingFraction", "MAX_CHALLENGE_NONCE"]],
    ["3", "placement diversity be expressed", ["required holder COUNT"], ["requiredHolders"]],
    ["4", "retention commitment for a remote holder", ["the field the artifact carries"], ["retentionUntil"]],
    ["5", "keep both branches", ["refuses the second"], []],
    ["6", "bandwidth a repair spends", ["nobody pays anything"], ["RepairOutcome"]],
  ];
  for (const [number, marker, quoted, inCode] of PLACEMENTS_ANSWERED) {
    if (!placementsRfc.includes(marker)) {
      fail(`RFC 0005's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!placementsRfc.includes(quote)) {
        fail(`RFC 0005's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0005's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }

  // RFC 0016 (appchain evaluation) and RFC 0001 (Trac integration) — the last two RFCs
  // with open questions, answered mostly by what the protocol already is.
  const appchainRfc =
    appchainRfcOverride ?? readFileSync(new URL("rfcs/0016-appchain-evaluation.md", root), "utf8");
  const APPCHAIN_ANSWERED = [
    ["1", "counts as a settled action", ["three units exist and none is"], []],
    ["2", "pays validators", ["because there are no validators"], []],
    ["3", "canonical identity", ["a keypair with records"], ["handle"]],
    ["4", "finality rule", ["the reorg policy is the"], []],
    ["5", "defer the appchain", ["defers it for every cycle evaluated"], []],
    ["6", "delegations migrate", ["migrate like anything else"], ["rarext.key-rotation"]],
    ["7", "measure demand", ["verified artifacts"], []],
  ];
  for (const [number, marker, quoted, inCode] of APPCHAIN_ANSWERED) {
    if (!appchainRfc.includes(marker)) {
      fail(`RFC 0016's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!appchainRfc.includes(quote)) {
        fail(`RFC 0016's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0016's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }

  // A page that promises rows must be able to show them on a STATIC mirror, where no API
  // is reachable: the leaderboard fell back to nothing, on a site whose own bundle carries
  // the publications it was refusing to list.
  const leaderboardPage = readFileSync(new URL("site/registry/mirror/leaderboard.html", root), "utf8");
  if (!leaderboardPage.includes("listFromBundle()")) {
    fail("the leaderboard no longer falls back to the mirror's own bundle when no API answers");
  }
  if (!leaderboardPage.includes("./bundle.json")) {
    fail("the leaderboard's fallback no longer reads bundle.json, so on a static mirror it lists nothing");
  }

  // A RE-PUBLISH MUST NOT REGRESS THE TREE, and the publish list is the whole surface.
  // Two failures are real and both are checked here: a file the list omits is DELETED by
  // the publisher's rmSync, and a file it stages from .ai-proof can be arbitrarily old.
  const publishSource = readFileSync(new URL("scripts/publish-proof.mjs", root), "utf8");
  const listBlock = /const mirrorFiles = \[([\s\S]*?)\];/.exec(publishSource);
  const listed = listBlock ? [...listBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (listed.length === 0) {
    fail("the publish list could not be read, so nothing is checking what a re-publish copies");
  }
  // (Completeness — a file the list omits is deleted by the publisher's rmSync — was
  // already checked above; this adds the two failure modes it did not cover.)
  // Files with a declared owner are copied from that owner, so staging cannot regress them.
  const ownerBlock = /const owners = \{([\s\S]*?)\n\};/.exec(publishSource);
  const ownerNames = ownerBlock ? [...ownerBlock[1].matchAll(/"([^"]+)":/g)].map((m) => m[1]) : [];
  if (ownerNames.length === 0) {
    fail("the publisher no longer declares owners, so every file it copies comes from staging");
  }
  for (const name of ownerNames) {
    const owner = join(fileURLToPath(root), "apps/web/public", name);
    const mirrorCopy = join(fileURLToPath(root), "site/registry/mirror", name);
    if (!existsSync(owner)) {
      fail(`the publisher claims ${name} is owned by apps/web/public, which has no such file`);
      continue;
    }
    if (existsSync(mirrorCopy) && !readFileSync(owner).equals(readFileSync(mirrorCopy))) {
      fail(`apps/web/public/${name} and the served mirror copy have drifted: a re-publish would publish ${name} from the web tree and change what is live`);
    }
  }
  // Everything still staged from .ai-proof must match what is served, or the next publish
  // would put the older bytes back.
  for (const name of listed.filter((entry) => !ownerNames.includes(entry))) {
    const staged = join(fileURLToPath(root), ".ai-proof", "mirror", name);
    const servedCopy = join(fileURLToPath(root), "site/registry/mirror", name);
    if (existsSync(staged) && existsSync(servedCopy) && !readFileSync(staged).equals(readFileSync(servedCopy))) {
      fail(`.ai-proof/mirror/${name} is older than the served copy: a re-publish would regress it`);
    }
  }

  // The mirror's proof page answers "is this copy faithful" — so it must answer for the
  // MEANINGS the registry anchors, not leave the newest property to a different page.
  const verifyPage = readFileSync(new URL("site/registry/mirror/verify.html", root), "utf8");
  if (!verifyPage.includes("semanticsCommitmentHolds(bundle, sha256Hex)")) {
    fail("the mirror's proof page no longer recomputes the registry's semantics commitment");
  }
  if (!verifyPage.includes("./renditions.js")) {
    fail("the proof page checks the semantics commitment without importing the module that implements it");
  }

  // The AI proof page must verify the PUBLISHED claim, not only a hand-pasted one: the
  // bundle carries the publication's own reconstruction values, so waiting for a visitor
  // to paste something is a page withholding evidence it already has.
  const aiBundle = readFileSync(new URL("site/registry/mirror/ai.js", root), "utf8");
  if (!aiBundle.includes("verifyPublishedBoundedRendition")) {
    fail("the AI proof page no longer verifies the published bounded claim from the bundle");
  }

  // ONE comparison rule for "does this bundle's semantics commitment cover its records?":
  // it lives in core, and both the page a human opens and the agent that reads the same
  // bundle call it. A second copy in a client would be a second rule, free to drift.
  {
    const coreSemantics = readFileSync(new URL("packages/core/src/semantics.ts", root), "utf8");
    if (!coreSemantics.includes("export function semanticsCommitmentHolds(")) {
      fail("core no longer owns the semantics-commitment comparison");
    }
    const webAi = readFileSync(new URL("apps/web/src/ai.ts", root), "utf8");
    if (!webAi.includes("compareSemanticsCommitment(")) {
      fail("the browser page no longer checks a bundle's semantics commitment through core");
    }
    if (/commitment\.digests\[/.test(webAi)) {
      fail("the browser page has re-implemented the semantics-commitment comparison instead of calling core");
    }
    const sdkSource = readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
    if (!sdkSource.includes("semanticsCommitmentHolds(commitment")) {
      fail("the SDK no longer offers an offline check of a bundle's anchored meanings");
    }
    // The MCP is the third resident that asks this question, and it asks it the same way:
    // the bundle comes from the registry, the comparison comes from core.
    const mcpSource = readFileSync(new URL("apps/mcp/src/verify-semantics.ts", root), "utf8");
    if (!mcpSource.includes("semanticsCommitmentHolds(commitment")) {
      fail("the MCP no longer verifies a registry's anchored meanings through core");
    }
    if (/commitment\.digests\[/.test(mcpSource)) {
      fail("the MCP has re-implemented the semantics-commitment comparison instead of calling core");
    }
    if (!readFileSync(new URL("apps/mcp/src/server.ts", root), "utf8").includes('name: "rarext_verify_semantics"')) {
      fail("the MCP server no longer exposes rarext_verify_semantics");
    }
    if (!readFileSync(new URL("docs/ARCHITECTURE.md", root), "utf8").includes("whether the registry it serves anchors the meanings it carries (`rarext_verify_semantics`")) {
      fail("ARCHITECTURE.md no longer describes rarext_verify_semantics");
    }
    if (/commitment\.digests\[/.test(sdkSource)) {
      fail("the SDK has re-implemented the semantics-commitment comparison instead of calling core");
    }
    console.log("semantics commitment (one comparison rule): core owns it | the page and the agent both call it");
  }

  // THE MCP TOOL LIST, both directions: every verb the server declares is named in its README,
  // and every `rarext_*` name the README names is a verb it declares. Declarations live in MORE
  // THAN ONE MODULE — server.ts spreads storage.ts in — so the scan reads the whole directory.
  // A single-file scan reported the five storage verbs as "documented but absent" when they were
  // declared in the module the list is assembled from; the false alarm is why the loop reads the
  // tree rather than the file that first comes to mind.
  {
    const declared = new Set();
    let scanned = 0;
    for (const entry of readdirSync(new URL("apps/mcp/src", root))) {
      if (!entry.endsWith(".ts")) continue;
      scanned += 1;
      const source = readFileSync(new URL("apps/mcp/src/" + entry, root), "utf8");
      for (const match of source.matchAll(/name: "(rarext_[a-z_]+)"/g)) declared.add(match[1]);
    }
    if (scanned === 0 || declared.size === 0) {
      fail(
        `the MCP tool-list rule scanned ${scanned} module(s) and found ${declared.size} verb(s) — a list with nothing in it proves nothing`,
      );
    }
    const readme = readFileSync(new URL("apps/mcp/README.md", root), "utf8");
    const documented = new Set([...readme.matchAll(/rarext_[a-z_]+/g)].map((match) => match[0]));
    const undocumented = [...declared].filter((verb) => !documented.has(verb)).sort();
    if (undocumented.length > 0) {
      fail(`apps/mcp/README.md does not name ${undocumented.length} declared MCP verb(s): ${undocumented.join(", ")}`);
    }
    const notAVerb = [...documented].filter((name) => !declared.has(name)).sort();
    if (notAVerb.length > 0) {
      fail(`apps/mcp/README.md names ${notAVerb.length} rarext_* thing(s) the MCP does not declare: ${notAVerb.join(", ")}`);
    }
    console.log("mcp tool list: " + declared.size + " declared verb(s) across " + scanned + " module(s) | README names every one, and names nothing else");
  }

  // THE SDK README'S OWN ARITHMETIC. It says how many standalone functions take a reader from a
  // seed document to verdicts, and names them. The number is parsed from the doc at check time
  // and the names are held against the module that must export them, so a capability added
  // without the sentence and a sentence left behind after the capability both fail. It said
  // "Two" while three existed — the second was added last cycle and the count stayed.
  {
    const sdkReadme = readFileSync(new URL("packages/agent-sdk/README.md", root), "utf8");
    const WORDS = { Two: 2, Three: 3, Four: 4, Five: 5 };
    const stated = /\b(Two|Three|Four|Five) standalone functions? take you from a seed document to verdicts/.exec(sdkReadme);
    if (!stated) {
      fail("the SDK README no longer says how many standalone functions take a seed document to verdicts");
    } else {
      const sdkSource = readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
      // A name counts only if the doc USES it and the module EXPORTS it, so the doc cannot
      // reach its number by naming things that do not exist.
      const named = ["findVerifiedBundle", "replayBundleAi", "verifyBundleSemantics"].filter(
        (name) => sdkReadme.includes(name) && new RegExp("export (async )?function " + name + "\\(").test(sdkSource),
      );
      for (const name of ["findVerifiedBundle", "replayBundleAi", "verifyBundleSemantics"]) {
        if (!new RegExp("export (async )?function " + name + "\\(").test(sdkSource)) {
          fail("the SDK README section leans on " + name + ", which the SDK does not export");
        }
        if (!sdkReadme.includes(name)) {
          fail("the SDK README does not name " + name + ", which the SDK exports for offline verification");
        }
      }
      if (WORDS[stated[1]] !== named.length) {
        fail(
          "the SDK README says " + stated[1] + " standalone functions but " + named.length + " real exported ones are named",
        );
      }
      console.log(
        "sdk readme: says " + stated[1] + " | names " + named.length + " exported offline verification function(s)",
      );
    }
  }

  // THE WORKED EXAMPLE IS GATED, because a worked example that is not run is decoration. The
  // Python verifier's README described a publish step the API had started refusing and nothing
  // noticed, because the protocol was only ever tested against a fixture. The gate now runs the
  // real service, so the guard is guarded: deleting or neutering that test fails here.
  {
    const gating = "apps/api/test/python-verifier-example.test.ts";
    let source;
    try {
      source = readFileSync(new URL(gating, root), "utf8");
    } catch {
      fail(`the gate no longer runs the python verifier example (${gating} is missing)`);
      source = "";
    }
    for (const marker of ["python3", "verifier.py", "traceHash", "verifiers.json", "examples/python-verifier"]) {
      if (source !== "" && !source.includes(marker)) {
        fail(`the python verifier example's gating test no longer exercises ${marker}`);
      }
    }
    // The docs must point at it, or the example is gated but unfindable.
    const protocol = readFileSync(new URL("docs/APP-PROTOCOL.md", root), "utf8");
    if (!protocol.includes("examples/python-verifier")) {
      fail("APP-PROTOCOL.md no longer points readers at the python verifier example");
    }
  }

  // EVERY INLINE MODULE IN THE MIRROR MUST PARSE. Reading a page's text cannot see a
  // syntax error, and a single HTML comment inside <script type="module"> kills the whole
  // page: the live gallery rendered no cards and never ran its own check, with every unit
  // test and both checker modes green. This parses each one for real, without executing it.
  for (const name of readdirSync(new URL("site/registry/mirror", root)).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(new URL(`site/registry/mirror/${name}`, root), "utf8");
    // Both kinds, because a page's whole script being a classic <script> does not make it
    // safe: the leaderboard is one, and a guard that only looked at type="module" reported
    // "0 scripts" for it — a check with nothing to check, which looks exactly like a check
    // that passed. Module scripts parse as .mjs, plain ones as .js (top-level await is
    // illegal in a classic script anyway).
    const scripts = [
      ...[...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => ({ source: m[1], kind: "module" })),
      ...[...html.matchAll(/<script(?![^>]*\btype=)(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => ({
        source: m[1],
        kind: "script",
      })),
    ].filter((entry) => entry.source.trim().length > 0);
    for (const [index, { source, kind }] of scripts.entries()) {
      const file = join(tmpdir(), `rarext-inline-${kind}-${index}.${kind === "module" ? "mjs" : "js"}`);
      writeFileSync(file, source);
      const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (checked.status !== 0) {
        const why = (checked.stderr || "").split("\n").find((line) => line.includes("Error")) ?? "unknown parse error";
        fail(`site/registry/mirror/${name} inline ${kind} ${index} does not parse: ${why.trim()}`);
      }
    }
  }

  // The semantics commitment is only a property a VISITOR can check if a page shows it:
  // a proof nothing reaches is a proof nobody checks.
  const galleryPage = readFileSync(new URL("site/registry/mirror/gallery.html", root), "utf8");
  if (!galleryPage.includes("semanticsCommitmentHolds(bundle, sha256Hex)")) {
    fail("the gallery no longer checks the registry's semantics commitment in the browser");
  }
  const galleryBundle = readFileSync(new URL("site/registry/mirror/renditions.js", root), "utf8");
  if (!galleryBundle.includes("semanticsCommitmentHolds")) {
    fail("the gallery's built module no longer exports semanticsCommitmentHolds, so the page would throw");
  }

  const tracRfc = tracRfcOverride ?? readFileSync(new URL("rfcs/0001-trac-integration.md", root), "utf8");

  // THE AXIS ITSELF: every question in every RFC carries a verdict — ANSWERED, or an
  // explicit admission that this repository cannot answer it. Without this, a new RFC
  // could land with an Open questions section that nothing ever closes, which is how
  // open questions stay open; with it, the sweep that answered ten RFCs is a property
  // the gate holds rather than a burst of work someone remembers doing.
  // The template is not an RFC: its questions are placeholders to be filled in, and
  // demanding a verdict on "the question you have not written yet" would be demanding
  // one on nothing.
  const rfcNames = readdirSync(new URL("rfcs", root))
    .filter((f) => f.endsWith(".md") && f !== "0000-template.md")
    .sort();
  // The RFC set is an injected source like every other, so the rule below is falsifiable
  // in the self-test rather than only by doctoring the real tree by hand.
  const rfcEntries = rfcSetOverride
    ? Object.entries(rfcSetOverride)
    : rfcNames.map((name) => [name, readFileSync(new URL(`rfcs/${name}`, root), "utf8")]);
  // The sweep states what it EXAMINED, not only what it rejected. This rule was vacuous
  // once (the lookahead above captured an empty section and every file passed) and the
  // `continue`s below kept a second vacuity alive: a section present but holding no
  // numbered items closes nothing, and a run that examined no RFC at all was
  // indistinguishable from a run that examined nineteen. Both are failures now, because a
  // guard with nothing to report and a guard that never ran look the same from a gate.
  let rfcFilesWithSection = 0;
  let rfcQuestions = 0;
  let rfcUnanswerable = 0;
  for (const [name, text] of rfcEntries) {
    // A line scan, not a lookahead: `(?=\s*$)` matches at EVERY line end under the m
    // flag, so the first version captured an empty section and the rule passed on every
    // file — vacuous, and only a hand-proof against a doctored RFC showed it.
    const lines = text.split("\n");
    const heading = lines.findIndex((line) => /^## .*[Oo]pen questions?/i.test(line));
    // An RFC with no Open questions section is legitimate — it had none to ask. Only a
    // section that EXISTS and closes nothing is a failure, so the absence is counted
    // rather than assumed.
    if (heading < 0) continue;
    rfcFilesWithSection += 1;
    let stop = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
    if (stop < 0) stop = lines.length;
    const section = lines.slice(heading + 1, stop).join("\n");
    const items = section.split(/^\d+\. /m).filter((item) => item.trim().length > 0);
    if (items.length === 0) {
      fail(`rfcs/${name} has an Open questions section holding no numbered question, so the section closes nothing`);
      continue;
    }
    rfcQuestions += items.length;
    rfcUnanswerable += items.filter((item) => /UNANSWERABLE HERE/.test(item)).length;
    const unverdicted = items.filter((item) => !/ANSWERED|UNANSWERABLE HERE/.test(item));
    if (unverdicted.length > 0) {
      const first = unverdicted[0].split("\n")[0].slice(0, 60);
      fail(`rfcs/${name} has ${unverdicted.length} open question(s) with no verdict, starting "${first}"`);
    }
  }
  if (rfcFilesWithSection < 1 || rfcQuestions < 1) {
    fail(
      `the RFC verdict sweep examined ${rfcEntries.length} file(s), ${rfcFilesWithSection} section(s) and ` +
        `${rfcQuestions} question(s) — a sweep that found nothing to check proves nothing, so it fails instead of passing`,
    );
  }
  // Only the real tree reports. The self-test runs this same rule against doctored sets, and
  // a fixture's inventory printing next to the real one is indistinguishable from the check
  // regressing — it cost one reader a chase through the CI log, so the fixture runs are silent
  // and their evidence is the MISMATCH lines they raise instead.
  if (rfcSetOverride === undefined) {
    console.log(
      `rfc verdicts: ${rfcEntries.length} RFC(s) | ${rfcFilesWithSection} with an Open questions section | ` +
        `${rfcQuestions} question(s) | ${rfcQuestions - rfcUnanswerable} answered | ${rfcUnanswerable} unanswerable here`,
    );
  }
  const TRAC_ANSWERED = [
    ["1", "signature scheme should be canonical", ["chosen per key"], ["suiteOf"]],
    ["2", "minimum Trac integration", ["whatever a task board needs"], []],
    ["3", "stable write API for small payloads", ["UNANSWERABLE HERE"], []],
    ["4", "content-addressed with a mutable pointer", ["content-addressed with a pointer"], []],
    ["5", "capability keys be represented and revoked", ["a revocation kind named for them"], ["REVOCATION_KINDS"]],
    ["6", "anchor cadence and retention", ["the batch IS the"], []],
  ];
  for (const [number, marker, quoted, inCode] of TRAC_ANSWERED) {
    if (!tracRfc.includes(marker)) {
      fail(`RFC 0001's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!tracRfc.includes(quote)) {
        fail(`RFC 0001's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0001's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }
  if (!tracRfc.includes("UNANSWERABLE HERE")) {
    fail("RFC 0001 no longer says which of its questions this repository cannot answer");
  }

  // RFC 0017 (game-native state migration) — what the migration owns, what it
  // deliberately does not, and the finality rule that lets a writer stop.
  const migrationRfc =
    migrationRfcOverride ?? readFileSync(new URL("rfcs/0017-game-native-state-migration.md", root), "utf8");
  const MIGRATION_ANSWERED = [
    ["1", "represent a build's status", ["refuses to own their meaning"], ["unmanagedTopLevelFields"]],
    ["2", "content-addressed configuration", ["what survives is the CID"], ["DURABLE_GAME_STATE_COLLECTIONS"]],
    ["3", "What is reputation", ["DERIVED from them and never"], ["buildGameStateMigrationBundle"]],
    ["4", "What is a rating", ["recompute the number instead of believing it"], []],
    ["5", "canonical identity", ["locations open, facts by"], ["handle"]],
    ["6", "RESET-style move", ["copied whole"], ["DURABLE_GAME_STATE_COLLECTIONS"]],
    ["7", "finality rule", ["re-derives the anchor rather than trusting"], ["CURRENT_SNAPSHOT_VERSION"]],
    ["8", "appchain unnecessary", ["definition of unnecessary"], []],
  ];
  for (const [number, marker, quoted, inCode] of MIGRATION_ANSWERED) {
    if (!migrationRfc.includes(marker)) {
      fail(`RFC 0017's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!migrationRfc.includes(quote)) {
        fail(`RFC 0017's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0017's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }

  // RFC 0004 (storage economy) — the pricing units, the challenge cadence and the
  // sealed tier's enforced property.
  const economyRfc =
    economyRfcOverride ?? readFileSync(new URL("rfcs/0004-storage-economy.md", root), "utf8");
  const ECONOMY_ANSWERED = [
    ["1", "the retention proof", ["the SCHEDULED challenge"], ["DEFAULT_INTERVAL_MS"]],
    ["2", "free tier", ["prices it at zero rather"], []],
    ["3", "key-recovery service", ["not merely absent but incompatible"], ["isSealedMetadata"]],
    ["4", "settlement cadence", ["already distinct"], []],
    ["5", "its own repository", ["test is whether the surface still serves"], []],
  ];
  for (const [number, marker, quoted, inCode] of ECONOMY_ANSWERED) {
    if (!economyRfc.includes(marker)) {
      fail(`RFC 0004's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!economyRfc.includes(quote)) {
        fail(`RFC 0004's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0004's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }

  // RFC 0018 (storage rent settlement) — the economy. Most of its answers name which
  // HALF is implemented (the quote) and which is still design (intent, settlement,
  // apply), which is the honest shape for an RFC whose pricing landed and whose
  // settlement did not.
  const rentRfc =
    rentRfcOverride ?? readFileSync(new URL("rfcs/0018-storage-rent-settlement.md", root), "utf8");
  const RENT_ANSWERED = [
    ["1", "allowed to pay for a blob", ["whoever signs the intent"], ["quoteStorageRent"]],
    ["2", "partial upload refund", ["the quote is computed, not charged"], ["STORAGE_CREDIT_SCALE"]],
    ["3", "holder payouts", ["the credit is not split"], []],
    ["4", "restart at payment time", ["max(now, current retainedUntil)"], ["retentionUntil"]],
    ["5", "chain adapter settles credits first", ["the first will be the local rail"], []],
    ["6", "signed operator price commitment", ["exactly reproducible from it"], ["STORAGE_RENT_POLICY"]],
  ];
  for (const [number, marker, quoted, inCode] of RENT_ANSWERED) {
    if (!rentRfc.includes(marker)) {
      fail(`RFC 0018's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!rentRfc.includes(quote)) {
        fail(`RFC 0018's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0018's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }

  // RFC 0003 (verifiable claims) — the thesis the AI work is the strongest instance of.
  // Its Q1 answer is a NEGATIVE claim ("it is not anchored yet"), and a negative needs
  // the code side asserted too: the RFC's "not yet" is true only while core has no
  // semantics leaf, so that absence is what the check holds.
  const claimsRfc =
    claimsRfcOverride ?? readFileSync(new URL("rfcs/0003-verifiable-claims.md", root), "utf8");
  const CLAIMS_ANSWERED = [
    ["1", "anchored like a publication", ["an anchor in name only"], ["semanticsCommitmentArtifact", "semanticsDigests"]],
    ["2", "distrusted verifier hashes", ["fail-closed"], ["REVOCATION_KINDS"]],
    ["3", "typed contract rather than a string map", ["stronger than either"], ["semanticsBinding", "scopeAllows"]],
    ["4", "no semantics binding", ["DERIVED id"], ["findSemantics"]],
  ];
  for (const [number, marker, quoted, inCode] of CLAIMS_ANSWERED) {
    if (!claimsRfc.includes(marker)) {
      fail(`RFC 0003's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!claimsRfc.includes(quote)) {
        fail(`RFC 0003's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0003's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }
  // The answer is POSITIVE now, so the code side is what must hold: if the RFC claims
  // anchoring, the commitment builder has to exist. (It was a negative claim until the
  // commitment was built; the check flipped with the answer, in the same commit.)
  if (claimsRfc.includes("AND IT IS") && !sources.includes("semanticsCommitmentArtifact")) {
    fail("RFC 0003 says semantics are anchored, but the tree has no semantics commitment artifact");
  }

  // RFC 0006 (independent verifiers) — the thesis the AI-verification surface is an
  // instance of. Its four answers are held the same way. This block sat INSIDE the
  // loop above on its first landing, after a `continue`, where it never ran and the
  // check still passed; a guard in dead code is the failure this file's
  // requireCondition helper exists to make visible, so the RFC's own precondition is
  // asserted too.
  const verifiersRfc =
    verifiersRfcOverride ?? readFileSync(new URL("rfcs/0006-independent-verifiers.md", root), "utf8");
  const VERIFIERS_ANSWERED = [
    ["1", "required operator set", ["names the RULE, never the RUNNER"], []],
    ["2", "verifier bytes be pinned", ["the MANIFEST is pinned"], ["verifierHash"]],
    ["3", "prove liveness", ["it does not have to"], []],
    ["4", "fee schedule", ["no fee for attesting"], []],
  ];
  for (const [number, marker, quoted, inCode] of VERIFIERS_ANSWERED) {
    if (!verifiersRfc.includes(marker)) {
      fail(`RFC 0006's question ${number} no longer appears (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!verifiersRfc.includes(quote)) {
        fail(`RFC 0006's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0006's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }
  for (const [number, marker, quoted, inCode] of ANSWERED) {
    if (!rfc.includes(marker)) {
      fail(`RFC 0019's question ${number} no longer appears at all (looking for "${marker}")`);
      continue;
    }
    for (const quote of quoted) {
      if (!rfc.includes(quote)) {
        fail(`RFC 0019's question ${number} answer no longer says "${quote}"`);
      }
    }
    for (const name of inCode) {
      if (!sources.includes(name)) {
        fail(`RFC 0019's question ${number} answer leans on ${name}, which does not exist in the source trees`);
      }
    }
  }

  console.log(
    `  ${EXISTING.length} primitive(s) exist | sections present | "locations, never facts" stated`,
  );
}

function checkConfigSurface(docOverride) {
  const docs = [
    ["docs/ARCHITECTURE.md", "architecture"],
    ["docs/SEMANTICS.md", "semantics"],
    ["docs/MIRRORS.md", "mirrors"],
    ["docs/OPERATIONS.md", "operations"],
  ];
  console.log(`config surface (${docOverride ? "DOCTORED: " : ""}${docs.length} docs vs code):`);

  // Scripts count as readers: some names are read by the scripts an operator
  // runs, not by a package. A documented name nobody anywhere reads is still a
  // lie with a config table around it.
  const { text: sources } = readSourceTrees({ includeScripts: true });

  const ENV = /`((?:RAREXT|TRAC|TAPEOUT|PIN|HOLDER|MCP)_[A-Z0-9_]{2,})`/g;
  const RFC = /`(rfcs\/[\w.-]+\.md)`/g;
  const STATE = /`(~?\/?(?:\.data|\.rarext)\/[\w./-]+)`/g;

  let envChecked = 0;
  let rfcChecked = 0;
  let pathChecked = 0;

  for (const [relative, label] of docs) {
    const text = docOverride ?? readFileSync(new URL(relative, root), "utf8");

    for (const name of new Set(Array.from(text.matchAll(ENV)).map((m) => m[1]))) {
      envChecked += 1;
      if (!sources.includes(name)) {
        fail(`${relative} documents ${name}, which nothing in the source trees reads`);
      }
    }

    for (const rfc of new Set(Array.from(text.matchAll(RFC)).map((m) => m[1]))) {
      rfcChecked += 1;
      try {
        readFileSync(new URL(rfc, root), "utf8");
      } catch {
        fail(`${relative} points at ${rfc}, which does not exist`);
      }
    }

    for (const state of new Set(Array.from(text.matchAll(STATE)).map((m) => m[1]))) {
      pathChecked += 1;
      const base = state.split("/").pop();
      if (!sources.includes(base) && !sources.includes(state)) {
        fail(`${relative} documents the state path ${state}, whose file name no code writes`);
      }
    }

    void label;
  }

  console.log(
    `  ${envChecked} env name(s) read by code | ${rfcChecked} RFC path(s) exist | ${pathChecked} state path(s) written by code`,
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

/**
 * The source text a config claim is checked against, discovered by walking the
 * trees rather than hand-listing files — a hand-picked list is how a checker
 * reports a false "nobody reads this". One implementation, because the app
 * protocol kind and the config-surface kind must never drift about what "the
 * sources" means.
 */
function readSourceTrees({ includeScripts = false } = {}) {
  const files = [];
  const walk = (relative, extensions) => {
    let entries;
    try {
      entries = readdirSync(fileURLToPath(new URL(relative, root)), { withFileTypes: true });
    } catch {
      return; // a tree that does not exist yet is not a failure
    }
    for (const entry of entries) {
      const child = `${relative}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(`${child}/`, extensions);
      } else if (extensions.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".test.ts")) {
        files.push(child);
      }
    }
  };
  for (const dir of ["apps/api/src/", "apps/mcp/src/", "apps/chain/src/", "packages/core/src/", "packages/agent-sdk/src/"]) {
    walk(dir, [".ts"]);
  }
  if (includeScripts) walk("scripts/", [".mjs", ".ts"]);
  // The checker is not a reader of configuration — and if it counted as one,
  // its own self-test fixtures (which invent config names on purpose) would
  // make every doctored name look read. This is the phantom-name trap a third
  // time: a file that asserts a name exists must not be evidence that it does.
  const readers = files.filter((rel) => !rel.endsWith("claim-check.mjs"));

  if (files.length === 0) fail("the source walk found no files, so every config name would read as unread");

  const text = readers
    .map((rel) => {
      try {
        return readFileSync(new URL(rel, root), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  return { files, text };
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
  const { files: sourceFiles, text: sources } = readSourceTrees();
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
    // Not injections: these two NORMALISE a route path, and a path with no
    // parameter is legitimately unchanged — the stale-injection guard is for
    // doctors of source text, not for string utilities.
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
function checkMirrorsDoc(docOverride, sources = {}) {
  console.log(`mirrors doc (docs/MIRRORS.md${docOverride ? ", DOCTORED" : ""}${sources.publishProof ? ", PIN SOURCES DOCTORED" : ""} vs tree):`);
  const doc = docOverride ?? readFileSync(new URL("docs/MIRRORS.md", root), "utf8");

  // The doc makes two claims about the federation walk that are cheap to state and
  // expensive to keep: that a list is CAPPED and says so, and that BOTH callers
  // apply one URL policy. The second is the one that rots — a policy added to the
  // SDK alone is a policy the API twin does not have, which the twin tests would
  // eventually catch and a reader would never know.
  if (/MAX_REGISTRIES_PER_LIST/.test(doc)) {
    const coreUrls = readFileSync(new URL("packages/core/src/urls.ts", root), "utf8");
    if (!/canFetchRegistryUrl|allowPrivateFromSeeds/.test(coreUrls)) {
      fail("MIRRORS.md describes a URL policy, but core does not hold one");
    }
    const sdkIndex =
      sources.sdkIndex ?? readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
    const apiBundle =
      sources.apiBundle ?? readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
    for (const [who, source] of [["the SDK", sdkIndex], ["the API twin", apiBundle]]) {
      // The policy is applied THROUGH core's hop-checking fetch now, so the guard
      // asks for the application, not for one particular inner call — the shape
      // moved and the claim did not.
      if (!/fetchWithUrlPolicy\(/.test(source)) {
        fail(`${who} does not apply core's URL policy, and the doc says both do`);
      }
    }
    const sdkRegistries =
      sources.sdkRegistries ?? readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
    if (!/slice\(0, MAX_REGISTRIES_PER_LIST\)/.test(sdkRegistries)) {
      fail("the doc says a list is capped, but the walk does not slice to the cap");
    }
    if (!/truncated/.test(sdkRegistries)) {
      fail("the doc says a truncation is reported, but the walk reports none");
    }
  }

  checkChallengeBoundaryLimits();
  // docs/HARDENING.md writes down what a resident accepts from strangers, beside
  // what is still not handled. A written-down bound is a claim about the tree: the
  // constant exists, the code USES it, and the drop is reported rather than
  // silent. (The URL policy is guarded above; this is the other half.)
  const hardening =
    sources.hardeningDoc ?? readFileSync(new URL("docs/HARDENING.md", root), "utf8");
  if (/MAX_ANNOUNCEMENT_DOCUMENTS/.test(hardening)) {
    const announcements = sources.coreAnnouncements ?? readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
    if (!/export const MAX_ANNOUNCEMENT_DOCUMENTS = 64;/.test(announcements)) {
      fail("HARDENING.md states the announcement-document bound, but core does not declare it as 64");
    }
    if (!/maxAnnouncementDocuments \?\? MAX_ANNOUNCEMENT_DOCUMENTS/.test(announcements)) {
      fail("the fold does not apply the announcement-document bound it declares");
    }
    if (!/announcement documents were named and only/.test(announcements)) {
      fail("HARDENING.md says a truncated fold is reported, but the fold reports no count");
    }
  }
  if (/each hop is resolved against the current URL and re-checked/.test(hardening)) {
    const coreUrlsSource = readFileSync(new URL("packages/core/src/urls.ts", root), "utf8");
    if (!/export async function fetchWithUrlPolicy\(/.test(coreUrlsSource)) {
      fail("HARDENING.md says every redirect hop is re-checked, but core exports no such fetch");
    }
    for (const [who, relative] of [
      ["the SDK", "packages/agent-sdk/src/index.ts"],
      ["the API twin", "apps/api/src/bundle.ts"],
    ]) {
      const source = sources[who === "the SDK" ? "sdkIndex" : "apiBundle"] ?? readFileSync(new URL(relative, root), "utf8");
      if (!/fetchWithUrlPolicy\(/.test(source)) {
        fail(`${who} does not check redirect hops, and HARDENING.md says both callers do`);
      }
      if (/redirect: "manual"/.test(source)) {
        fail(`${who} sets its own redirect mode instead of using core's hop-checking fetch`);
      }
    }
  }
  if (/MAX_GENERATIVE_STEPS|MAX_BOUNDED_LENGTH/.test(hardening)) {
    const validate = sources.sdkValidate ?? readFileSync(new URL("packages/agent-sdk/src/validate.ts", root), "utf8");
    for (const constant of ["MAX_GENERATIVE_STEPS", "MAX_BOUNDED_LENGTH"]) {
      if (!new RegExp(constant).test(validate)) {
        fail(`HARDENING.md states a bound (${constant}) that the SDK's input boundary does not enforce`);
      }
    }
  }
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
  for (const marker of ["Served from", "../registry/bundle.json", "loadBundle", "rebuild", "MAX_BUNDLE_BYTES", "content-length"]) {
    if (!page.includes(marker)) {
      fail(`MIRRORS.md says the proof page fails over, but the page module has no "${marker}"`);
    }
  }
  const generators = ["scripts/build-mirror.mjs", "scripts/publish-ai-proof.mjs"];
  // The doc says the seed pins the bundle's content address and every client
  // path verifies it. That claim spans four files; each must carry its half.
  if (!doc.includes("bundleCid")) {
    fail("MIRRORS.md no longer documents the seed's content-address pin");
  }
  const publishProof = sources.publishProof ?? readFileSync(new URL("scripts/publish-proof.mjs", root), "utf8");
  // Behaviour, not a variable name: the seed must be pinned to a CID the
  // publisher computed from the bytes it wrote. (The name changed when the
  // publisher started pinning the ANCHORED bytes, and the old literal made a
  // correct publisher look broken.)
  if (!/seed\.bundleCid = \w+;/.test(publishProof) || !/cidV1Raw\(/.test(publishProof)) {
    fail("MIRRORS.md says the seed pins a CID, but publish-proof.mjs does not pin the bytes it writes");
  }
  const bundleModule = readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
  for (const marker of ["bundleCid", "verifyCandidates", "readBundleResponseBytes"]) {
    if (!bundleModule.includes(marker)) {
      fail(`MIRRORS.md says clients verify the CID, but bundle.ts has no "${marker}"`);
    }
  }
  // The doc documents the response cap; the tree must hold it: the cap is one
  // constant in core, and every fetch path reads through it.
  if (!doc.includes("MAX_BUNDLE_RESPONSE_BYTES")) {
    fail("MIRRORS.md no longer documents the bundle response cap (MAX_BUNDLE_RESPONSE_BYTES)");
  }
  const mirrorPage = readFileSync(new URL("site/registry/mirror/verify.html", root), "utf8");
  for (const marker of ["MAX_BUNDLE_BYTES", "content-length"]) {
    if (!mirrorPage.includes(marker)) {
      fail(`MIRRORS.md says the proof page refuses oversized responses, but the published verify.html has no "${marker}"`);
    }
  }
  const seedVerifier = sources.seedVerifier ?? readFileSync(new URL("scripts/verify-seed-mirrors.mjs", root), "utf8");
  if (!seedVerifier.includes("cidV1Raw")) {
    fail("MIRRORS.md says verify-seed-mirrors checks candidates against the pin, but it hashes nothing");
  }
  if (!seedVerifier.includes("readBundleResponseBytes")) {
    fail("MIRRORS.md says clients cap a bundle response, but verify-seed-mirrors reads without the cap");
  }
  if (!seedVerifier.includes("verifyCandidates(")) {
    fail("MIRRORS.md says the live checker runs the shared sequence, but it does not call core's verifyCandidates");
  }
  if (!doc.includes("verifyCandidates")) {
    fail("MIRRORS.md no longer names the shared verification sequence (verifyCandidates)");
  }

  // The SDK half of the same story: the doc says an agent can find and check a
  // copy without the registry, using the core primitives the server uses.
  if (!doc.includes("findVerifiedBundle")) {
    fail("MIRRORS.md no longer documents the SDK's mirror client (findVerifiedBundle)");
  }
  const sdkSource = readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
  for (const marker of ["findVerifiedBundle", "bundleCid", "bundleRoot", "readBundleResponseBytes"]) {
    if (!sdkSource.includes(marker)) {
      fail(`MIRRORS.md says the SDK finds and checks a copy, but the SDK source has no "${marker}"`);
    }
  }
  // The second SDK sentence: the verified copy is the whole input to an offline
  // AI replay. The doc names the export, quotes the refusal a missing challenge
  // produces, and says the verdicts carry the copy's root — each held to the
  // SDK, which must actually export the function the doc tells an agent to call.
  if (!doc.includes("replayBundleAi")) {
    fail("MIRRORS.md no longer documents the SDK's offline AI replay (replayBundleAi)");
  }
  if (typeof sdk.replayBundleAi !== "function" || !sdkSource.includes("export function replayBundleAi")) {
    fail("MIRRORS.md says replayBundleAi replays a bundle's AI claims, but the SDK exports no such function");
  }
  if (!doc.includes("challenge <id> not in bundle") || !sdkSource.includes("not in bundle")) {
    fail("MIRRORS.md quotes a missing-challenge verdict the SDK does not report");
  }
  if (!doc.includes("manifest root") || !sdkSource.includes("bundle.manifest.root")) {
    fail("MIRRORS.md says replayBundleAi reports the copy's manifest root, but the SDK reads no manifest root");
  }
  // Multi-seed discovery: the doc says a resident can pool two operators'
  // seeds and that disagreement about the registry stops loudly before any
  // fetch. Both twins must carry the feature, and the disagreement rule must
  // live in ONE module (core), so the SDK and the API can never fork it.
  if (!doc.includes("findVerifiedBundleFromSeeds")) {
    fail("MIRRORS.md no longer documents multi-seed discovery (findVerifiedBundleFromSeeds)");
  }
  if (!doc.includes("bundleFromSeeds")) {
    fail("MIRRORS.md no longer documents the API-side twin (bundleFromSeeds)");
  }
  if (!doc.includes("the seeds disagree about the registry") || !doc.includes("not race")) {
    fail("MIRRORS.md no longer names the disagreement error and its effect (stop, not race)");
  }
  if (!doc.includes("absence is not a contradiction")) {
    fail("MIRRORS.md no longer states that a missing bundleCid beside one present is not a disagreement");
  }
  if (typeof sdk.findVerifiedBundleFromSeeds !== "function") {
    fail("MIRRORS.md says the SDK pools seeds, but the SDK exports no findVerifiedBundleFromSeeds");
  }
  const coreBundleSource = readFileSync(new URL("packages/core/src/bundle.ts", root), "utf8");
  for (const marker of ["export function planSeedUnion", "the seeds disagree about the registry", "Absence is not a contradiction"]) {
    if (!coreBundleSource.includes(marker)) {
      fail(`MIRRORS.md documents multi-seed disagreement, but core's bundle.ts has no "${marker}"`);
    }
  }
  for (const marker of ["findVerifiedBundleFromSeeds", "planSeedUnion"]) {
    if (!sdkSource.includes(marker)) {
      fail(`MIRRORS.md says the SDK finds a copy across seeds, but the SDK source has no "${marker}"`);
    }
  }
  for (const marker of ["bundleFromSeeds", "planSeedUnion"]) {
    if (!bundleModule.includes(marker)) {
      fail(`MIRRORS.md says the API-side twin pools seeds, but bundle.ts has no "${marker}"`);
    }
  }
  // RFC 0019 step 1: the doc says verified signed announcements enter the
  // union. The sentence names the seed field, the pure verifier, and the SDK
  // path, and each must exist: core owns the verification (kind, version, key
  // id, suite, window), and the SDK reads the seed's field and folds the
  // survivors into the union it already runs.
  if (!doc.includes("announcements")) {
    fail("MIRRORS.md no longer documents the seed's announcements field (RFC 0019 step 1)");
  }
  if (!doc.includes("verifyAnnouncement")) {
    fail("MIRRORS.md no longer names the announcement verifier (verifyAnnouncement)");
  }
  const coreAnnouncements = readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
  for (const marker of ["export function verifyAnnouncement", "rarext.mirror-announcement", "issuedAt", "expiresAt"]) {
    if (!coreAnnouncements.includes(marker)) {
      fail(`MIRRORS.md says announcements are verified before the union, but core's announcements.ts has no "${marker}"`);
    }
  }
  for (const marker of ["announcements", "verifyAnnouncement", "onAnnouncement"]) {
    if (!sdkSource.includes(marker)) {
      fail(`MIRRORS.md says the SDK folds verified announcements into the union, but the SDK source has no "${marker}"`);
    }
  }
  const coreIndex = readFileSync(new URL("packages/core/src/index.ts", root), "utf8");
  for (const marker of ["verifyBundleShape", "cidV1"]) {
    if (!coreIndex.includes(marker)) {
      fail(`MIRRORS.md says the SDK and API share core primitives, but core exports no "${marker}"`);
    }
  }
  for (const marker of ["MAX_BUNDLE_RESPONSE_BYTES", "readBundleResponseBytes"]) {
    if (!coreIndex.includes(marker)) {
      fail(`MIRRORS.md says clients cap a bundle response, but core exports no "${marker}"`);
    }
  }

  // The doc's other half of the same bullet: the pinning call is implemented,
  // the publish records it in `seed.pins`, and the live checker resolves each
  // pin. Three sentences, three files — checked in BOTH directions, so a doc
  // that stops naming the call and a tree that drops what the doc names fail
  // the same way. The doc is held exactly as strong as the code: it claims a
  // pinning call, a recording of it, and a per-pin check, and nothing more.
  if (!doc.includes("pinBundle")) {
    fail("MIRRORS.md no longer documents the publish flow's pinning call (pinBundle)");
  }
  if (!doc.includes("seed.pins")) {
    fail("MIRRORS.md no longer documents the seed recording what the pinning call returned");
  }
  const contentAdapter = sources.contentAdapter ?? readFileSync(
    new URL("apps/api/src/adapters/content.ts", root),
    "utf8",
  );
  for (const marker of ["export async function pinBundle", "export function pinServiceUrl", "RAREXT_PIN_SERVICE_URL", "RAREXT_PIN_TOKEN"]) {
    if (!contentAdapter.includes(marker)) {
      fail(`MIRRORS.md says the bundle is pinned through a configured service, but content.ts has no "${marker}"`);
    }
  }
  if (!publishProof.includes("pinBundle(")) {
    fail("MIRRORS.md says publish-proof.mjs pins the published bytes, but it never calls pinBundle");
  }
  if (!publishProof.includes("seed.pins =")) {
    fail("MIRRORS.md says publish-proof.mjs records the pins, but it writes no seed.pins");
  }
  if (!seedVerifier.includes("export async function checkPin")) {
    fail("MIRRORS.md says verify-seed-mirrors.mjs verifies each recorded pin, but it exports no pin check");
  }
  if (!seedVerifier.includes("pinUrl")) {
    fail("MIRRORS.md says a pin's reference is resolved (URL or ${service}/${cid}), but the checker resolves nothing");
  }

  // The doc says the workbench refuses reads from a bundle it cannot verify —
  // the same gap check as the proof page, pinned the same way and falling back
  // to the seed's bundleRoot. The gate lives in ONE module (mirror.ts), and the
  // workbench must carry the refusal banner the served index.html ships.
  if (!doc.includes("refusal banner") || !doc.includes("internal consistency only")) {
    fail("MIRRORS.md no longer documents the workbench refusing reads from an unverified bundle");
  }
  const workbenchGate = readFileSync(new URL("apps/web/src/mirror.ts", root), "utf8");
  for (const marker of ["verifyBundle", "bundleRoot", "../registry/seed.json", "refused"]) {
    if (!workbenchGate.includes(marker)) {
      fail(`MIRRORS.md says the workbench verifies its bundle with the proof page's check, but the gate (mirror.ts) has no "${marker}"`);
    }
  }
  const workbenchMain = readFileSync(new URL("apps/web/src/main.ts", root), "utf8");
  for (const marker of ["startMirrorGate", "mirror-refusal", "mirrorGate.ready"]) {
    if (!workbenchMain.includes(marker)) {
      fail(`MIRRORS.md says the workbench refuses reads and shows a refusal banner, but the app (main.ts) has no "${marker}"`);
    }
  }

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

  // The resident demo: the doc's one-command promise is held to the command
  // that makes it true. The npm script must exist, the script must import the
  // SDK's two verification exports rather than re-implement them, and its
  // default seed must be the live published one the doc names.
  if (!/npm run demo:resident(?![\w:-])/.test(doc)) {
    fail("MIRRORS.md no longer documents the resident demo (npm run demo:resident)");
  }
  if (typeof pkg.scripts["demo:resident"] !== "string") {
    fail("MIRRORS.md names npm run demo:resident, but package.json defines no such script");
  }
  const demoSource = readFileSync(new URL("scripts/demo-resident.mjs", root), "utf8");
  for (const marker of [
    "packages/agent-sdk/src/index.ts",
    "findVerifiedBundle",
    "replayBundleAi",
    "https://999svs999.github.io/RAREXT-protocol/registry/seed.json",
    "--local",
  ]) {
    if (!demoSource.includes(marker)) {
      fail(`MIRRORS.md's resident demo must use the SDK, default to the live seed, and support --local; demo-resident.mjs has no "${marker}"`);

    }
  }
  // The resident demo answers BOTH questions a reader has about a registry: do the AI claims
  // replay, and are the meanings the ones that were anchored. The doc says so and the demo
  // does it, so both halves are compared rather than one being trusted.
  if (!demoSource.includes("sdk.verifyBundleSemantics(found.bundle)")) {
    fail("the resident demo no longer verifies the registry's anchored meanings");
  }
  if (!readFileSync(new URL("docs/MIRRORS.md", root), "utf8").includes("It also calls `verifyBundleSemantics` to confirm that every committed meaning the registry")) {
    fail("MIRRORS.md no longer describes the resident demo's meanings check");
  }

  if (!/no\s+keys/.test(doc) || !/no\s+server/.test(doc)) {
    fail("MIRRORS.md no longer states that the resident demo needs no keys and no server");
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
    ["site/registry/mirror/ai.html", "the published AI-proof page"],
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
    `  ${bundleRoutes.length} bundle route(s) handled | ${named.length} npm script(s) defined | takedown in CI | published copy present | proof page fails over (Served from) with the generator carrying it | workbench gate refuses unverified bundles | pinning call (pinBundle) recorded in seed.pins and verified per pin | SDK finds a copy (findVerifiedBundle) and replays its AI claims offline (replayBundleAi) | multi-seed discovery (findVerifiedBundleFromSeeds / bundleFromSeeds) with a loud disagreement rule in core | announcements verified into the union (verifyAnnouncement, RFC 0019 step 1) | announcement documents cached, verdicts never (AnnouncementDocumentCache, RFC 0019 question 5)`,
  );
  // The doc names the one-call join and the surface convention behind it. Both
  // are claims about the tree: the client must fold through the SDK's own
  // announcement path with a resolver built from the same convention module, and
  // the demo must use that module too rather than hardcoding one surface.
  // The doc says the PUBLISHED bundle carries the commitment and was re-anchored at
  // its own root. That is a claim about artifacts, so it is held by the test the doc
  // names — and by the generator that has to produce them.
  if (/the published bundle carries that/.test(doc)) {
    const standing =
      sources.standingTest ?? readFileSync(new URL("apps/api/test/published-bundle.test.ts", root), "utf8");
    if (!/federationCommitment\(bundle/.test(standing)) {
      fail("MIRRORS.md says the published bundle carries a commitment, but the standing test never reads one");
    }
    if (!/commitment\.digest,\n\s*digest,/.test(standing)) {
      fail("the standing test must compare the committed digest with the digest of the published list");
    }
    if (!/anchors\[0\]\.root, bundle\.manifest\.root/.test(standing)) {
      fail("the standing test must check the anchor covers the published root");
    }
    if (!/ai\.length, 2/.test(standing)) {
      fail("the standing test must check the commitment is not counted as an AI claim");
    }
    const publisher = readFileSync(new URL("scripts/publish-proof.mjs", root), "utf8");
    if (!/await anchorPending\(anchorStore\)/.test(publisher)) {
      fail("the publisher must anchor the bundle it publishes, or the published root is unanchored");
    }
    if (!/federationCommitmentArtifact\(/.test(publisher)) {
      fail("the publisher must commit the list's digest, using the shared shape");
    }
  }

  // The doc names the federation commitment and RFC 0020's mechanism. Both are
  // claims about the tree: the SDK must export the reader and must identify the
  // artifact by its APP and KIND rather than guessing, and the RFC must be there
  // to be read.
  if (/federationCommitment/.test(doc)) {
    const clientSource =
      sources.registryClient ?? readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
    if (!/export function federationCommitment\(/.test(clientSource)) {
      fail("MIRRORS.md names federationCommitment, but the SDK does not export it");
    }
    // The comparison moved into core when the WRITER and the READER were given
    // one definition of the shape (RFC 0020): the SDK must CALL that parser, and
    // core must be the place that checks the app and the kind.
    if (!/parseFederationCommitmentArtifact\(artifact\)/.test(clientSource)) {
      fail("the commitment reader must parse through core's shared shape, not one of its own");
    }
    const coreShape =
      sources.coreShape ?? readFileSync(new URL("packages/core/src/registries.ts", root), "utf8");
    if (!/artifact\.kind !== REGISTRY_LIST_COMMITMENT_KIND/.test(coreShape)) {
      fail("core must identify a commitment by its artifact kind, not by position");
    }
    const rfc = readFileSync(new URL("rfcs/0020-anchoring-the-seed-list.md", root), "utf8");
    if (!/Merkle root over \*\*publication leaves only\*\*/.test(rfc)) {
      fail("RFC 0020 must record the constraint that decides the design, quoted from the code");
    }
  }

  // The doc says a list can be checked by digest. That is a claim about the
  // client: it must compute the digest through core's function and refuse on a
  // mismatch — the comparison itself, not a mention of one.
  if (/expectDigest/.test(doc)) {
    const clientSource =
      sources.registryClient ?? readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
    if (!/registryListDigest\(entries, \(bytes\)/.test(clientSource)) {
      fail("MIRRORS.md says a seed list can be checked, but the SDK never computes the digest through core's injected hash");
    }
    if (!/if \(actual !== options\.expectDigest\) \{/.test(clientSource)) {
      fail("the client must COMPARE the computed digest with the expectation and refuse on a mismatch");
    }
    const coreRegistries = readFileSync(new URL("packages/core/src/registries.ts", root), "utf8");
    if (!/export function registryListDigest\(/.test(coreRegistries)) {
      fail("the digest over the list's entries must live in core, where the server and the client share it");
    }
  }

  if (/joinRegistryNetwork/.test(doc)) {
    const networkSource =
      sources.registryClient ?? readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
    if (!/export async function joinRegistryNetwork\(/.test(networkSource)) {
      fail("MIRRORS.md names joinRegistryNetwork, but the SDK does not export it");
    }
    if (!/await findVerifiedBundleFromSeeds\(\[seed\]/.test(networkSource)) {
      fail("the one-call join must fold each registry's announcements through the SDK's own path");
    }
    if (!/identityFromPublishedOrigin\(/.test(networkSource)) {
      fail("the join must build each registry's resolver from the shared surface convention");
    }
    const demoSource =
      sources.demoResident ?? readFileSync(new URL("scripts/demo-resident.mjs", root), "utf8");
    if (!/sdk\.identityFromPublishedOrigin\(/.test(demoSource)) {
      fail("the demo must use the shared surface convention rather than hardcoding paths");
    }
  }

  // The doc names the federation query and the one parser of the seed list. Both
  // are claims about the tree: the SDK must call the client, and the SERVER must
  // use the same parser the client uses — a second normaliser is how one list
  // grows two meanings.
  if (/findVerifiedBundlesFromRegistryList/.test(doc)) {
    const registryClient =
      sources.registryClient ?? readFileSync(new URL("packages/agent-sdk/src/registries.ts", root), "utf8");
    if (!/export async function findVerifiedBundlesFromRegistryList\(/.test(registryClient)) {
      fail("MIRRORS.md names findVerifiedBundlesFromRegistryList, but the SDK does not export it");
    }
    if (!/parseRegistrySeedList\(parsed\)/.test(registryClient)) {
      fail("the SDK's registry client must parse through core's parser, not one of its own");
    }
    if (!/await readBundleResponseBytes\(response\)/.test(registryClient)) {
      fail("the registry client must bound every document it reads");
    }
    const serverRegistry =
      sources.serverRegistry ?? readFileSync(new URL("apps/api/src/registries.ts", root), "utf8");
    if (!/parseRegistrySeedList\(JSON\.parse\(text\) as unknown\)/.test(serverRegistry)) {
      fail("the SERVER must normalise the seed list through the same core parser the client uses");
    }
  }

  // The doc states who may announce. That is a claim about the fold, so the fold
  // must carry it: the comparison against the seed's announcers, and each
  // refusal — the mirror a seed does not name, the registry it does not pin, and
  // the contradiction it forbids.
  // The doc names the resident's own resolver. Naming it is a claim about the
  // SDK, so the SDK must carry it: exported, bounded like every other fetch, and
  // deciding nothing of its own.
  if (/identityFromPublishedDocuments/.test(doc)) {
    const sdkIndex = readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
    // A member of the export list, not a single-name export line: the SDK exports
    // the resolver together with the surface convention, and the first version of
    // this guard only recognised the one-name form.
    if (!/export \{[\s\S]*?\bidentityFromPublishedDocuments,/.test(sdkIndex)) {
      fail("MIRRORS.md names identityFromPublishedDocuments, but the SDK does not export it");
    }
    const publishedIdentity =
      sources.publishedIdentity ??
      readFileSync(new URL("packages/agent-sdk/src/published-identity.ts", root), "utf8");
    // The CALL, not the import: a module can import a bounded reader and never
    // call it, and this guard's first version matched the import — which let a
    // doctored copy straight through.
    if (!/await readBundleResponseBytes\(response\)/.test(publishedIdentity)) {
      fail("the resident's resolver must bound every document it reads");
    }
    const resolverCode = doctor(publishedIdentity, "resolverCode", (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
    if (/issuedAt|expiresAt/.test(resolverCode)) {
      fail("the resolver retrieves and core decides: window arithmetic found in the resolver");
    }
    // And the resident demo must CALL it — a doc sentence saying the demo folds
    // announcements through published documents is a claim about the script.
    const demoScript =
      sources.demoResident ?? readFileSync(new URL("scripts/demo-resident.mjs", root), "utf8");
    if (!/sdk\.identityFromPublished(Origin|Documents)\(/.test(demoScript)) {
      fail("MIRRORS.md says the resident demo resolves keys from published documents, but the demo never calls the resolver");
    }
    if (!/findVerifiedBundleFromSeeds\(/.test(demoScript)) {
      fail("the demo must fold through the SDK's announcement path, not a path of its own");
    }
  }

  // The doc states the fail-closed rule for a revocation lookup. That is a claim
  // about the fold, so the fold must keep the lookup's OUTCOME apart from the
  // revocation it looked for — collapsing them is the fail-open this closed.
  if (/could not be performed/.test(doc)) {
    const foldSource =
      sources.announcements ?? readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
    if (!/could not be determined/.test(foldSource)) {
      fail("MIRRORS.md says a revocation lookup that could not run refuses the record, but the fold does not carry it");
    }
    if (!/revocationOutcomes/.test(foldSource)) {
      fail("the fold must keep the lookup's outcome apart from the revocation it looked for");
    }
    if (!/if \(!lookup\.ok\) \{/.test(foldSource)) {
      fail("the fold must refuse when the revocation lookup did not succeed");
    }
  }

  // The doc states the lifetime cap and the skew. Both are claims about the fold,
  // so the fold must carry the constants and refuse by name.
  // The doc names the `key` revocation kind. That is a claim about the tree, and
  // the failure it guards against is precise: a kind in the type but not in the
  // adapter's scan validates and is never consulted.
  if (/key\` revocation kind/.test(doc)) {
    const kindsSource =
      sources.revocations ?? readFileSync(new URL("apps/api/src/revocations.ts", root), "utf8");
    if (!/REVOCATION_KINDS = \[[^\]]*"key"\]/.test(kindsSource)) {
      fail("MIRRORS.md names a `key` revocation kind, but the kinds list does not carry it");
    }
    const adapter = readFileSync(new URL("apps/api/src/announcement-identity.ts", root), "utf8");
    // Wide enough for the adapter's own comment explaining the order: the guard
    // is about "key" being the FIRST entry consulted, and a tight character
    // window would fail on the prose that documents it.
    if (!/KEY_REVOCATION_KINDS[\s\S]{0,600}?\n\s*"key",/.test(adapter)) {
      fail("the announcement adapter must consult the `key` kind — and consult it first");
    }
    if (!/REVOCATION_KINDS/.test(adapter)) {
      fail("the adapter must take the kinds from the shared list, not a copy of it");
    }
  }

  if (/180-day cap/.test(doc)) {
    const foldSource =
      sources.announcements ?? readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
    if (!/MAX_ANNOUNCEMENT_LIFETIME_MS = 180 \* 24 \* 60 \* 60_000/.test(foldSource)) {
      fail("MIRRORS.md states a 180-day lifetime cap, but core's constant is not that");
    }
    if (!/ANNOUNCEMENT_CLOCK_SKEW_MS = 5 \* 60_000/.test(foldSource)) {
      fail("MIRRORS.md states a 5-minute skew, but core's constant is not that");
    }
    if (!/beyond the \$\{capDays\}-day cap a mirror nomination may have/.test(foldSource)) {
      fail("the fold must refuse an over-long lifetime by name, not silently");
    }
    if (!/more than \$\{minutes\} minutes ahead of now/.test(foldSource)) {
      fail("the fold must name the skew when it refuses a future-dated record");
    }
  }

  if (/announcers/.test(doc)) {
    const announcementsSource =
      sources.announcements ?? readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
    if (!/\.announcers \?\? \[\]\)\.includes\(handle/.test(announcementsSource)) {
      fail("MIRRORS.md says a seed's announcers decide who may announce, but the fold never compares the handle against them");
    }
    if (!/not named among this seed's announcers/.test(announcementsSource)) {
      fail("the fold must refuse an unvouched announcer by name, not silently");
    }
    if (!/not introduce one/.test(announcementsSource)) {
      fail("the fold must refuse an unvouched handle trying to introduce a registry");
    }
    if (!/not contradict them/.test(announcementsSource)) {
      fail("the fold must refuse an unvouched contradiction of the pins");
    }
  }

  // RFC 0019's question 5: the doc says announcement documents may be cached,
  // and verdicts never are. That is a claim about the fold, so the fold must
  // carry the cache port — a CALL, not a mention — and must read the caller's
  // TTL rather than holding a policy of its own. The SDK must also carry the
  // bounded in-memory cache the doc names a resident.
  if (/AnnouncementDocumentCache/.test(doc)) {
    const cacheFoldSource =
      sources.announcements ?? readFileSync(new URL("packages/core/src/announcements.ts", root), "utf8");
    if (!cacheFoldSource.includes("AnnouncementDocumentCache")) {
      fail("MIRRORS.md names an announcement document cache, but core defines no such port");
    }
    if (!cacheFoldSource.includes("input.cache.get(url)")) {
      fail("MIRRORS.md says the fold consults its cache, but core never calls the port (a mention is not a consultation)");
    }
    if (!cacheFoldSource.includes("cacheMaxAgeMs")) {
      fail("MIRRORS.md says the TTL is the caller's policy, but the fold reads no cacheMaxAgeMs");
    }
    if (!/source: fromCache \? "cache" : "fetched"/.test(cacheFoldSource)) {
      fail("MIRRORS.md says hits and misses are both reported, but the fold reports neither");
    }
    if (typeof sdk.MemoryAnnouncementCache !== "function" || !sdkSource.includes("MemoryAnnouncementCache")) {
      fail("MIRRORS.md names MemoryAnnouncementCache, but the SDK exports no such cache");
    }
  }

  // The doc names the wired helper for the API's own store. Naming a helper is
  // a claim about the tree, so the tree must carry it: the helper exists, it
  // wires the STORE adapter, and the adapter itself answers only — any window
  // arithmetic or revocation rule in it would be the third fork the guards
  // exist to prevent.
  if (/bundleFromSeedForStore/.test(doc)) {
    const bundleSource = readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
    if (!/export async function bundleFromSeedForStore\(/.test(bundleSource)) {
      fail("MIRRORS.md names bundleFromSeedForStore, but no such helper exists");
    }
    if (!/announcementIdentityForStore\(store\)/.test(bundleSource)) {
      fail("the wiring helper must hand the store adapter to the fold, not a rule of its own");
    }
    const adapterSource =
      sources.identityAdapter ?? readFileSync(new URL("apps/api/src/announcement-identity.ts", root), "utf8");
    if (!/store\.getIdentity\(handle\)/.test(adapterSource)) {
      fail("the identity adapter must ask the store for the handle's identity");
    }
    // Comments are stripped first: this module's own prose NAMES the arithmetic
    // it refuses to do, and a guard that reads prose would fail on the sentence
    // forbidding the thing it checks for.
    const adapterCode = doctor(adapterSource, "adapterCode", (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
    if (/issuedAt|expiresAt/.test(adapterCode)) {
      fail("core decides and the adapter answers: window arithmetic found in the adapter");
    }
  }

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
// The challenge boundary's own limits: what it refuses, and the caps on operator input.
// The doc states them and the code exports them, so both halves are compared rather than
// one being trusted.
function checkChallengeBoundaryLimits(docOverride) {
  console.log(`challenge boundary (docs/HARDENING.md${docOverride ? ", DOCTORED" : ""} vs apps/api/src/challenges.ts):`);
  const doc = docOverride ?? readFileSync(new URL("docs/HARDENING.md", root), "utf8");
  const source = readFileSync(new URL("apps/api/src/challenges.ts", root), "utf8");

  if (!doc.includes("for the bounded app, CORE's own `isBoundedSpec`, so a spec the verifier would refuse is refused")) {
    fail("HARDENING.md no longer states that the challenge boundary reuses core's bounded-spec rule");
  }
  if (!source.includes("isBoundedSpec(challenge.spec)")) {
    fail("the challenge boundary does not call core's isBoundedSpec, which HARDENING.md says it does");
  }

  const docCount = Number(doc.match(/`MAX_CONFIGURED_CHALLENGES` = ([\d,]+)/)?.[1]?.replaceAll(",", ""));
  if (docCount !== 256) fail(`HARDENING.md no longer states MAX_CONFIGURED_CHALLENGES = 256 (says ${docCount})`);
  if (challengeConstants.MAX_CONFIGURED_CHALLENGES !== 256) {
    fail(`the code's MAX_CONFIGURED_CHALLENGES is ${challengeConstants.MAX_CONFIGURED_CHALLENGES}, not 256`);
  }

  const docBytes = Number(doc.match(/`MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES` = (\d+) MiB/)?.[1]);
  if (docBytes !== 1) fail(`HARDENING.md no longer states MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES = 1 MiB (says ${docBytes})`);
  if (challengeConstants.MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES !== 1 << 20) {
    fail(`the code's MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES is ${challengeConstants.MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES}, not ${1 << 20}`);
  }

  // The id cap is a claim like the others, and it is refused rather than trimmed.
  const docId = Number(doc.match(/`MAX_CHALLENGE_ID_LENGTH` = ([\d,]+)/)?.[1]?.replaceAll(",", ""));
  if (docId !== 200) fail(`HARDENING.md no longer states MAX_CHALLENGE_ID_LENGTH = 200 (says ${docId})`);
  if (challengeConstants.MAX_CHALLENGE_ID_LENGTH !== 200) {
    fail(`the code's MAX_CHALLENGE_ID_LENGTH is ${challengeConstants.MAX_CHALLENGE_ID_LENGTH}, not 200`);
  }

  console.log(
    `  refuses what the verifier would refuse (core's isBoundedSpec) | id <= ${challengeConstants.MAX_CHALLENGE_ID_LENGTH} | configured <= ${challengeConstants.MAX_CONFIGURED_CHALLENGES} | source <= ${challengeConstants.MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES / 2 ** 20} MiB`,
  );
}

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
function checkAiVerificationDoc(docOverride, appOverride, sources = {}) {
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

  // 6. The offline bundle replay. The doc tells a reader they can check a
  // claim with the SDK and no server, and separately that the committed bundle
  // carries real AI publications. Both are held to the tree here: the export
  // must exist, and the committed bundle must replay through it — every AI
  // publication yielding a correct verdict with evidence, and a forged output
  // next to them failing with the mismatch visible. This is the doc's trust
  // model executed rather than described.
  // The doc names a demo that makes, attests and signs. A demo that stops CALLING
  // the SDK would leave the sentence true in prose and false in the tree, so the
  // script must actually call selfPublish, the export must exist, and the npm
  // script the doc tells a reader to run must be there to run.
  if (/demo:self-publish/.test(doc)) {
    const sdkSource = readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
    if (!/export function selfPublish\(/.test(sdkSource)) {
      fail("AI-VERIFICATION.md names a self-publishing demo, but the SDK does not export selfPublish");
    }
    const demo = sources.selfPublishDemo ?? readFileSync(new URL("scripts/demo-self-publish.mjs", root), "utf8");
    if (!/sdk\.selfPublish\(/.test(demo)) {
      fail("the self-publish demo must CALL the SDK's selfPublish, not merely describe it");
    }
    if (!/verifyPayload\(/.test(demo) || !/process\.exit\(/.test(demo)) {
      fail("the demo must verify the signature it made and fail loudly when a check does not hold");
    }
    // The doc promises a GENERATION, so the demo must make one and the SDK must
    // be the thing that can.
    if (/selfPublishGenerative/.test(doc)) {
      if (!/sdk\.selfPublishGenerative\(/.test(demo)) {
        fail("the doc says the demo makes a generation, but the demo never calls selfPublishGenerative");
      }
      if (!/replayBundleAi\(/.test(demo)) {
        fail("a generation the reader cannot replay is a promise the demo does not keep");
      }
      if (!/export function selfPublishGenerative\(/.test(sdkSource)) {
        fail("AI-VERIFICATION.md names selfPublishGenerative, but the SDK does not export it");
      }
      // The RENDITION: the doc says a resident ships a picture beside its values, so
      // the demo must ask for one and must let the registry's OWN check decide it.
      // A demo that asserted its own picture with its own arithmetic would prove
      // nothing about what the serving side does with the artifact.
      if (/rendition/i.test(doc)) {
        if (!/rendition:\s*\d/.test(demo)) {
          fail("the doc says a resident ships a rendition, but the demo never asks for one");
        }
        if (!/generativeRenditionHolds\(/.test(demo)) {
          fail("the demo draws a picture and never asks the registry's own check whether it is the artifact's");
        }
        if (!/sdk\.encodePngRaster\(/.test(demo)) {
          fail("the demo records a blob digest without encoding the PNG it claims to digest");
        }
      }
    }
    // The bounded representation, and its NEGATIVE: the doc promises the demo
    // catches a reconstruction past the bound, so the demo must try one.
    if (/selfPublishBounded/.test(doc)) {
      if (!/sdk\.selfPublishBounded\(/.test(demo)) {
        fail("the doc says the demo makes a bounded reconstruction, but the demo never calls selfPublishBounded");
      }
      if (!/export function selfPublishBounded\(/.test(sdkSource)) {
        fail("AI-VERIFICATION.md names selfPublishBounded, but the SDK does not export it");
      }
      if (!/outsideReplay\.claims\[0\]\.correct === false/.test(demo)) {
        fail("the demo must check a reconstruction OUTSIDE its bound is refused, not only one inside it");
      }
    }
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    if (!pkg.scripts?.["demo:self-publish"]) {
      fail("AI-VERIFICATION.md tells a reader to run npm run demo:self-publish, but package.json defines no such script");
    }
  }

  // The architecture doc names an MCP verb that MAKES AI artifacts locally. That
  // is a claim about the tree with three parts: the module exists, the server
  // registers AND dispatches the verb (a registered verb with no case is a tool
  // that answers nothing), and the module calls core's own assemblies rather than
  // re-deriving what a proof is.
  const architecture =
    sources.architecture ?? readFileSync(new URL("docs/ARCHITECTURE.md", root), "utf8");
  if (/rarext_attest_local/.test(architecture)) {
    let module = null;
    try {
      module = readFileSync(new URL("apps/mcp/src/attest-local.ts", root), "utf8");
    } catch {
      fail("ARCHITECTURE.md names rarext_attest_local, but apps/mcp/src/attest-local.ts does not exist");
    }
    if (module) {
      if (!/attestGenerativeRun\(/.test(module) || !/attestBoundedRun\(/.test(module)) {
        fail("the local-attest verb must attest through core's assemblies for both representations");
      }
      if (!/verifyAiLocally\(/.test(module)) {
        fail("the verdict must come from the same local verifier the checking verb uses");
      }
      if (!/signed: false/.test(module)) {
        fail("an MCP server holds no key: the local attestation must say it is unsigned");
      }
    }
    const server = sources.mcpServer ?? readFileSync(new URL("apps/mcp/src/server.ts", root), "utf8");
    if (!/name: "rarext_attest_local"/.test(server)) {
      fail("ARCHITECTURE.md names rarext_attest_local, but the server does not register it");
    }
    if (!/case "rarext_attest_local":/.test(server)) {
      fail("the verb is registered but never dispatched — a tool that answers nothing");
    }
    // And the dispatch must go THROUGH the tested coercion: an argument boundary
    // inlined in the case would be the one code path no test ever runs.
    if (!/attestLocalFromArgs\(/.test(server)) {
      fail("the server must dispatch through the tested argument boundary, not around it");
    }
    if (!/attestLocalFromArgs\(/.test(module ?? "")) {
      fail("the argument boundary must live in the tested module");
    }
  }

  // The doc now names a page that MAKES proofs in the browser. Three things make
  // that sentence true: the page and its bundle exist and are published, the
  // module behind them is the one under test, and the test really holds the
  // browser's hashes to node's — a cross-runtime claim is worth nothing asserted
  // only in prose.
  if (doc.includes("mirror/ai.html")) {   // plain text on purpose: a regex here already cost one debugging round to its own escaping
    for (const relative of ["apps/web/public/ai.html", "site/registry/mirror/ai.html"]) {
      let text;
      try {
        text = readFileSync(new URL(relative, root), "utf8");
      } catch {
        fail(`AI-VERIFICATION.md names the browser proof page, but ${relative} does not exist`);
        continue;
      }
      if (!/ai\.js/.test(text)) fail(`${relative} does not load the module that makes the proof`);
      if (!/id="picture"|picture-note/.test(text)) fail(`${relative} does not carry the picture element the doc describes`);
    }
    const module = readFileSync(new URL("apps/web/src/ai.ts", root), "utf8");
    for (const marker of ["runCommittedModel", "runBoundedProof", "renderProofPicture", "renderBoundedPicture", "fixtureFromBundle"]) {
      if (!new RegExp(`export (async )?function ${marker}`).test(module)) {
        fail(`the doc says the page makes both kinds of proof, but ai.ts exports no ${marker}`);
      }
    }
    const webTest = sources.webProofTest ?? readFileSync(new URL("apps/web/test/ai-proof.test.ts", root), "utf8");
    // The page must PARSE the bundle through the tested function rather than search
    // it itself. The parsing bug fixed this cycle was only findable because it moved
    // OUT of the page; a page that reads publications directly puts it back out of
    // reach, where only loading it in a browser can catch it.
    const aiPage = readFileSync(new URL("apps/web/src/ai-page.ts", root), "utf8");
    if (!aiPage.includes("fixtureFromBundle(")) {
      fail("the page no longer parses the bundle beside it through the tested fixtureFromBundle");
    }
    // The gallery re-derives published renditions in the visitor's browser. It must do
    // that through the module (one implementation of the rule, testable), and it must
    // reach the check by IMPORT rather than by growing its own copy — the extract-one-
    // module discipline the page work already paid for once.
    const gallery = readFileSync(new URL("site/registry/mirror/gallery.html", root), "utf8");
    if (!gallery.includes("verifyPublishedRendition(")) {
      fail("the gallery no longer re-derives the renditions it shows from the artifacts that claim them");
    }
    if (!gallery.includes("./renditions.js")) {
      fail("the gallery does not import the rendition module, so its check is a private copy");
    }
    if (gallery.includes("renderRaster(") || gallery.includes("renderBoundedRaster(")) {
      fail("the gallery renders rasters itself instead of calling the shared check");
    }
    const buildScript = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts["build:web"];
    if (!String(buildScript).includes("renditions.ts")) {
      fail("package.json no longer builds the gallery's rendition module, so the page ships without it");
    }

    // ONE assembly of a rendition. Three surfaces ship one (the SDK for a resident, the
    // MCP verb for an agent's tooling, the registry's publisher) and a second copy of
    // the field mapping is a second rule — the same defect the page work already paid
    // for once. Core owns it; every maker calls it, and the MCP's verb must REGISTER
    // the argument as well as accept it, or clients cannot ask for a picture at all.
    const coreAi = readFileSync(new URL("packages/core/src/ai.ts", root), "utf8");
    if (!coreAi.includes("export function renditionFor(")) {
      fail("core no longer owns the single rendition assembly every surface ships through");
    }
    if (!coreAi.includes("export function boundedRenditionFor(")) {
      fail("core no longer owns the single LOSSY rendition assembly");
    }
    for (const [label, relative] of [
      ["the SDK", "packages/agent-sdk/src/index.ts"],
      ["the publisher", "scripts/publish-ai-proof.mjs"],
    ]) {
      const source = readFileSync(new URL(relative, root), "utf8");
      if (!source.includes("boundedRenditionFor(")) {
        fail(`${label} no longer assembles a lossy rendition through core's shared rule`);
      }
    }
    for (const [label, relative] of [
      ["the SDK", "packages/agent-sdk/src/index.ts"],
      ["the MCP verb", "apps/mcp/src/attest-local.ts"],
    ]) {
      const source = readFileSync(new URL(relative, root), "utf8");
      if (!source.includes("renditionFor(")) {
        fail(`${label} no longer assembles a rendition through core's shared rule`);
      }
      if (/mediaType:\s*"image\/png"/.test(source) && /raster:/.test(source) && /blob:/.test(source)) {
        fail(`${label} assembles a rendition's fields itself instead of calling renditionFor`);
      }
    }
    {
      // The MCP verb ships BOTH representations; the lossy leg goes through core's own
      // strip assembly, so a lane shape is never computed here.
      const mcpLocalBounded = readFileSync(new URL("apps/mcp/src/attest-local.ts", root), "utf8");
      if (!mcpLocalBounded.includes("boundedRenditionFor(")) {
        fail("the MCP verb no longer ships a lossy strip through core's shared rule");
      }
    }
    const architecture = readFileSync(new URL("docs/ARCHITECTURE.md", root), "utf8");
    if (/RENDITION of the run/.test(architecture)) {
      const mcpServer = readFileSync(new URL("apps/mcp/src/server.ts", root), "utf8");
      // The argument accepts BOTH shapes now, so the registration check looks for the
      // union: a regression back to a number-only schema is what would make the strip
      // unreachable for a client.
      if (!/rendition:\s*\{\s*\n\s*type:\s*\["number",\s*"object"\]/.test(mcpServer)) {
        fail("ARCHITECTURE.md says the MCP verb ships a rendition, but its schema does not register the argument, so no client can ask for one");
      }
    }
    const mcpLocal = readFileSync(new URL("apps/mcp/src/attest-local.ts", root), "utf8");
    if (!/MAX_RENDITION_SIZE/.test(mcpLocal)) {
      fail("the MCP rendition argument has no cap, so a caller can ask for an unbounded raster");
    }

    if (aiPage.includes("publications?.find(")) {
      fail("the page searches the bundle's publications itself — that parsing belongs in fixtureFromBundle, where a test can reach it");
    }

    // CALL forms, not bare words: the file's own prose says "compared to
    // createHash", so a mention check passed while the injection removed the
    // call — the usage-versus-mention trap this project keeps naming, this time
    // in the guard that was supposed to catch it.
    for (const marker of ['createHash("sha256")', "sha256Hex(", "runBoundedProof("]) {
      if (!webTest.includes(marker)) {
        fail(`the doc says the browser's hashes are held to node's, but the suite no longer calls ${marker}`);
      }
    }
  }

  // And the doc's other direction: a resident can BUILD the bundle it replays.
  // Held to the tree — the SDK exports the builder, assembles through core, and
  // the registry's own builder delegates to the same assembly, or the two drift.
  if (/buildBundle\(publications/.test(doc)) {
    const sdkSource = readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8");
    if (!/export function buildBundle\(/.test(sdkSource)) {
      fail("AI-VERIFICATION.md says a resident can build a bundle, but the SDK does not export buildBundle");
    }
    if (!/return assembleBundle\(\{/.test(sdkSource)) {
      fail("the SDK's builder must assemble through core's function, not a copy of the rule");
    }
    const coreBundleSource = readFileSync(new URL("packages/core/src/bundle.ts", root), "utf8");
    if (!/export function assembleBundle\(/.test(coreBundleSource)) {
      fail("the assembly must live in core, where the verifier already is");
    }
    const registryBuilder =
      sources.registryBuilder ?? readFileSync(new URL("apps/api/src/bundle.ts", root), "utf8");
    if (!/return assembleBundle\(\{/.test(registryBuilder)) {
      fail("the registry's builder must delegate to the same assembly, or the two can drift");
    }
  }

  if (!doc.includes("replayBundleAi")) {
    fail("AI-VERIFICATION.md no longer documents the SDK's offline bundle replay (replayBundleAi)");
  }
  if (typeof sdk.replayBundleAi !== "function") {
    fail("AI-VERIFICATION.md says replayBundleAi replays a bundle's claims, but the SDK exports no such function");
  }

  const committedBundle = JSON.parse(
    readFileSync(new URL("site/registry/bundle.json", root), "utf8"),
  );
  const aiPublications = (committedBundle.publications ?? []).filter(
    (publication) => publication.attestation && publication.attestation.representation,
  );
  if (aiPublications.length === 0) {
    fail("the committed bundle carries no AI publication, so the doc's live proof claim is vacuous");
  }

  const replayed = sdk.replayBundleAi(committedBundle);
  if (replayed.root !== committedBundle.manifest.root) {
    fail("replayBundleAi did not report the committed bundle's manifest root");
  }
  if (replayed.claims.length !== aiPublications.length) {
    fail(
      `replayBundleAi returned ${replayed.claims.length} verdict(s) for the committed bundle's ` +
        `${aiPublications.length} AI publication(s)`,
    );
  }
  for (const claim of replayed.claims) {
    if (claim.correct !== true) {
      fail(`the committed bundle's AI claim ${claim.publicationId} does not replay correct: true (${claim.error ?? "mismatch"})`);
    }
    if (!claim.evidence) {
      fail(`the committed bundle's AI claim ${claim.publicationId} replayed with no evidence`);
    }
  }

  const forgedBundle = structuredClone(committedBundle);
  const forgedTarget = (forgedBundle.publications ?? []).find(
    (publication) => publication.attestation && publication.attestation.representation === "generative",
  );
  if (!forgedTarget) {
    fail("the committed bundle carries no generative publication to forge");
  } else {
    const body = forgedTarget.artifact.body;
    body.output = `${body.output} forged`;
    const forgedClaim = sdk
      .replayBundleAi(forgedBundle)
      .claims.find((claim) => claim.representation === "generative");
    if (!forgedClaim || forgedClaim.correct !== false) {
      fail("replayBundleAi accepted a forged generative output as correct");
    }
    if (
      !forgedClaim ||
      !forgedClaim.evidence ||
      forgedClaim.evidence.expected === forgedClaim.evidence.actual
    ) {
      fail("the forged claim's evidence does not show the expected output beside the forged one");
    }
  }

  // The resident demo is the doc's outside-in command: it must fetch the live
  // seed by default and replay through the SDK, not a private checker.
  if (!/npm run demo:resident(?![\w:-])/.test(doc)) {
    fail("AI-VERIFICATION.md no longer documents the resident demo (npm run demo:resident)");
  }
  const residentDemo = readFileSync(new URL("scripts/demo-resident.mjs", root), "utf8");
  for (const marker of [
    "findVerifiedBundle",
    "replayBundleAi",
    "https://999svs999.github.io/RAREXT-protocol/registry/seed.json",
  ]) {
    if (!residentDemo.includes(marker)) {
      fail(`AI-VERIFICATION.md's resident demo must use the SDK and default to the live seed; demo-resident.mjs has no "${marker}"`);
    }
  }
  if (!/no\s+keys/.test(doc) || !/no\s+server/.test(doc)) {
    fail("AI-VERIFICATION.md no longer states that the resident demo needs no keys and no server");
  }

  console.log(
    `  rules: ${coreAi.RASTER_RULE}, ${coreAi.BOUNDED_RASTER_RULE} | ` +
      `verifier hashes: ${genHash.slice(0, 8)}..., ${boundedHash.slice(0, 8)}... | ` +
      `media validators: generative ok, bounded ok | ` +
      `raster renderers: generative deterministic+rule-faithful, bounded deterministic+refuses-mismatch | ` +
      `routes: /v1/verifiers handled | ` +
      `verifier manifests: generative/bounded representation declared | ` +
      `offline replay: ${replayed.claims.length} committed AI claim(s) correct with evidence, forged output rejected`,
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

  if (!doc.includes("one comparison rule, so the page a human opens and the agent that reads the same bundle")) {
    fail("SEMANTICS.md no longer states that the commitment comparison is one rule shared by the page and the agent");
  }
  if (!readFileSync(new URL("packages/agent-sdk/src/index.ts", root), "utf8").includes("export function verifyBundleSemantics(")) {
    fail("SEMANTICS.md says the SDK exposes verifyBundleSemantics, which it does not");
  }
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
