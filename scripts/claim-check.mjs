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

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const rfcPath = process.env.RAREXT_CLAIM_RFC ?? fileURLToPath(new URL("rfcs/0010-data-availability-sampling.md", root));
const architecturePath = new URL("docs/ARCHITECTURE.md", root);

const das = await import(new URL("apps/api/src/das.ts", root).href);
const rent = await import(new URL("apps/api/src/storage-rent.ts", root).href);
const coreAi = await import(new URL("packages/core/src/ai.ts", root).href);
const storageConstants = await import(new URL("apps/api/src/storage.ts", root).href);
const erasure = await import(new URL("apps/api/src/erasure.ts", root).href);
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
  caught = assertChanged(original, doctored, "sampling-table") && caught;
  caught = assertChanged(realSoak, doctoredSoak, "soak-log") && caught;
  assertChanged(JSON.stringify(realThroughput), JSON.stringify(doctoredThroughput), "throughput");
  assertChanged(originalOperations, doctoredLimitsDoc, "limits-table");
  assertChanged(originalOperations, doctoredOperationsDoc, "ai-bounds");
  assertChanged(originalOperatorDoc, doctoredOperatorDoc, "operator-defaults");
  assertChanged(originalOperations, doctoredOperationsDoc2, "evidence-citations");
  caught = assertChanged(originalArchitecture, doctoredDoc, "architecture") && caught;

  console.log(caught ? "\nself-test PASSED: the checker caught the doctored row" : "\nself-test FAILED: the checker accepted a doctored row");
  process.exit(caught ? 0 : 1);
}

checkSamplingTable(readFileSync(rfcPath, "utf8"), rfcPath.split("/").pop());
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

console.log(failures === 0 ? "\nall published claims match the implementation" : `\n${failures} mismatch(es)`);
process.exit(failures === 0 ? 0 : 1);
