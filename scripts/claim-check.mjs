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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const rfcPath = process.env.RAREXT_CLAIM_RFC ?? fileURLToPath(new URL("rfcs/0010-data-availability-sampling.md", root));
const architecturePath = new URL("docs/ARCHITECTURE.md", root);

const das = await import(new URL("apps/api/src/das.ts", root).href);
const rent = await import(new URL("apps/api/src/storage-rent.ts", root).href);
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
  // The health row is the table's first line, and it is `/health` — no /v1
  // prefix, which is exactly the kind of detail a hand-written anchor gets wrong.
  const doctoredDoc = originalArchitecture.replace(
    "| GET | `/health` |",
    "| GET | `/health` |\n| GET | `/v1/time-travel` |",
  );
  checkRouteSurface(doctoredDoc);
  caught = caught && failures > beforeRoutes;
  console.log(caught ? "\nself-test PASSED: the checker caught the doctored row" : "\nself-test FAILED: the checker accepted a doctored row");
  process.exit(caught ? 0 : 1);
}

checkSamplingTable(readFileSync(rfcPath, "utf8"), rfcPath.split("/").pop());
checkMdsFloor();
checkRepairRecord();
checkRentClaims();
checkRouteSurface();

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
