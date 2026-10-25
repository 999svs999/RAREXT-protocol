import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { BlobStore } from "../src/storage.ts";
import {
  STORAGE_CREDIT_SCALE,
  STORAGE_RENT_MAX_TERM_MS,
  STORAGE_RENT_MONTH_MS,
  STORAGE_RENT_POLICY,
  quoteStorageRent,
  storagePricing,
  storagePricingFromEnv,
} from "../src/storage-rent.ts";
import { RarextStore } from "../src/store.ts";

const GIB = 1024 ** 3;
const pricing = storagePricing({ public: 0, sealed: 1_000_000 });
const from = new Date("2026-01-01T00:00:00.000Z");

test("a GiB held for a 30-day month is one GiB-month", () => {
  const until = new Date(from.getTime() + STORAGE_RENT_MONTH_MS);
  const quote = quoteStorageRent(
    { bytes: GIB, tier: "sealed", from, until },
    pricing,
  );

  assert.equal(quote.byteMonths, GIB);
  assert.equal(quote.gibMonths, 1);
  assert.equal(quote.durationMs, STORAGE_RENT_MONTH_MS);
  assert.equal(quote.rateMicroCreditsPerGiBMonth, 1_000_000);
  assert.equal(quote.costMicroCredits, 1_000_000);
  assert.equal(quote.costCredits, 1);
  assert.equal(quote.free, false);
});

test("the public tier is free and a partial month is prorated", () => {
  const half = new Date(from.getTime() + STORAGE_RENT_MONTH_MS / 2);
  const publicQuote = quoteStorageRent(
    { bytes: GIB, tier: "public", from, until: half },
    pricing,
  );
  const sealedQuote = quoteStorageRent(
    { bytes: GIB, tier: "sealed", from, until: half },
    pricing,
  );

  assert.equal(publicQuote.byteMonths, GIB / 2);
  assert.equal(publicQuote.costMicroCredits, 0);
  assert.equal(publicQuote.free, true);
  assert.equal(sealedQuote.costMicroCredits, 500_000);
  assert.equal(sealedQuote.costCredits, 0.5);
});

test("a tiny quote costs at least one microcredit instead of truncating to zero", () => {
  const until = new Date(from.getTime() + STORAGE_RENT_MONTH_MS);
  const quote = quoteStorageRent(
    { bytes: 1, tier: "sealed", from, until },
    pricing,
  );

  assert.equal(quote.costMicroCredits, 1);
  assert.equal(quote.free, false);
});

test("rent quotes reject malformed sizes, tiers, and terms", () => {
  const until = new Date(from.getTime() + STORAGE_RENT_MONTH_MS);

  for (const bytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => quoteStorageRent({ bytes, tier: "sealed", from, until }, pricing),
      /bytes must be a positive safe integer/,
    );
  }

  assert.throws(
    () =>
      quoteStorageRent(
        { bytes: 1, tier: "nope" as "sealed", from, until },
        pricing,
      ),
    /tier must be public or sealed/,
  );
  assert.throws(
    () =>
      quoteStorageRent(
        { bytes: 1, tier: "sealed", from, until: from },
        pricing,
      ),
    /until must be after from/,
  );
  assert.throws(
    () =>
      quoteStorageRent(
        {
          bytes: 1,
          tier: "sealed",
          from,
          until: new Date(from.getTime() + STORAGE_RENT_MAX_TERM_MS + 1),
        },
        pricing,
      ),
    /at most/,
  );
});

test("operator rates come from the environment and are validated", () => {
  const custom = storagePricingFromEnv({
    RAREXT_STORAGE_PUBLIC_MICROCREDITS_PER_GIB_MONTH: "0",
    RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH: "2500000",
  });

  assert.equal(
    custom.tiers.find((tier) => tier.tier === "sealed")
      ?.rateMicroCreditsPerGiBMonth,
    2_500_000,
  );
  assert.equal(
    custom.tiers.find((tier) => tier.tier === "public")
      ?.rateMicroCreditsPerGiBMonth,
    0,
  );

  assert.throws(
    () =>
      storagePricingFromEnv({
        RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH: "1.5",
      }),
    /non-negative integer/,
  );
  assert.equal(
    storagePricingFromEnv({}).tiers.find((tier) => tier.tier === "sealed")
      ?.rateMicroCreditsPerGiBMonth,
    1_000_000,
  );
});

test("usage reports the committed byte-months and the latest retained term", () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-rent-usage-"));
  const blobs = new BlobStore(dir);
  const size = 1024 * 1024;
  const until = new Date(Date.now() + STORAGE_RENT_MONTH_MS).toISOString();

  try {
    blobs.put(Buffer.alloc(size), { retentionUntil: until });
    const usage = blobs.usage();
    const publicTier = usage.find((entry) => entry.tier === "public");

    assert.ok(publicTier);
    assert.equal(publicTier.retainedUntil, until);
    assert.ok(publicTier.committedByteMonths > size * 0.9);
    assert.ok(publicTier.committedByteMonths <= size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the API publishes pricing and quotes without reserving anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-rent-api-"));
  const server = createApp({
    store: new RarextStore(),
    blobs: new BlobStore(join(dir, "blobs")),
    storagePricing: pricing,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const published = await fetch(`${base}/v1/storage/pricing`);
    assert.equal(published.status, 200);
    const policy = (await published.json()) as {
      policy: string;
      unit: string;
      tiers: { tier: string; free: boolean }[];
    };
    assert.equal(policy.policy, "storage-rent-v1");
    assert.equal(policy.unit, "byte-month");
    assert.equal(
      policy.tiers.find((tier) => tier.tier === "public")?.free,
      true,
    );

    const until = new Date(Date.now() + STORAGE_RENT_MONTH_MS).toISOString();
    const response = await fetch(
      `${base}/v1/storage/quote?bytes=${GIB}&tier=sealed&until=${encodeURIComponent(until)}`,
    );
    assert.equal(response.status, 200);
    const quote = (await response.json()) as {
      costMicroCredits: number;
      costCredits: number;
      free: boolean;
    };
    assert.equal(quote.costMicroCredits, 1_000_000);
    assert.equal(quote.costCredits, 1);
    assert.equal(quote.free, false);

    const free = await fetch(
      `${base}/v1/storage/quote?bytes=${GIB}&tier=public&until=${encodeURIComponent(until)}`,
    );
    const freeQuote = (await free.json()) as { costMicroCredits: number; free: boolean };
    assert.equal(freeQuote.costMicroCredits, 0);
    assert.equal(freeQuote.free, true);

    const invalid = await fetch(
      `${base}/v1/storage/quote?bytes=0&tier=sealed&until=${encodeURIComponent(until)}`,
    );
    assert.equal(invalid.status, 400);

    const listed = (await (await fetch(`${base}/v1/storage/usage`)).json()) as unknown[];
    assert.ok(Array.isArray(listed));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hardening round: the money path, by mechanism. Each case names the mechanism
// it guards so a regression says which promise broke, not just which line.
// ---------------------------------------------------------------------------

/** The price the quote must equal: ceil(bytes * duration * rate / (month * GiB)). */
function exactCeilMicroCredits(bytes: number, durationMs: number, rate: number): bigint {
  const numerator = BigInt(bytes) * BigInt(durationMs) * BigInt(rate);
  const denominator = BigInt(STORAGE_RENT_MONTH_MS) * BigInt(GIB);
  return (numerator + denominator - 1n) / denominator;
}

test("mechanism: exactness — the quoted cost is the exact rational ceiling over a sweep", () => {
  // Before the fix the float path disagreed with exact arithmetic 88 times out
  // of 25,800 legal quotes. The sweep is what makes this a property rather than
  // three lucky examples.
  const rates = [1, 7, 250_000, 1_000_000, 2_500_000];
  let checked = 0;

  for (const rate of rates) {
    const pricing = storagePricing({ public: 0, sealed: rate });
    for (let power = 0; power <= 48; power += 3) {
      for (const bytes of [2 ** power, 2 ** power - 1, 10 ** Math.min(power, 15)]) {
        if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
        for (const durationMs of [
          1,
          1_000,
          STORAGE_RENT_MONTH_MS - 1,
          STORAGE_RENT_MONTH_MS,
          STORAGE_RENT_MAX_TERM_MS - 1,
          STORAGE_RENT_MAX_TERM_MS,
        ]) {
          const quote = quoteStorageRent(
            { bytes, tier: "sealed", from, until: new Date(from.getTime() + durationMs) },
            pricing,
          );
          assert.equal(
            BigInt(quote.costMicroCredits),
            exactCeilMicroCredits(bytes, durationMs, rate),
            `bytes=${bytes} durationMs=${durationMs} rate=${rate}`,
          );
          assert.ok(Number.isSafeInteger(quote.costMicroCredits));
          checked += 1;
        }
      }
    }
  }

  assert.ok(checked > 300, `expected a real sweep, checked ${checked}`);
});

test("mechanism: exactness — the two quotes the float path got wrong", () => {
  // Both reproduced against the pre-fix implementation, and both inside the
  // exact range so the fixed code must quote them rather than refuse them:
  // the first undercharged by 1 microcredit, the second overcharged by 1.
  // Pinned because a silently mispriced quote is what this round exists to stop.
  const undercharged = quoteStorageRent(
    {
      bytes: 1_000_000_000_000_000,
      tier: "sealed",
      from,
      until: new Date(from.getTime() + 315_360_000_000),
    },
    storagePricing({ public: 0, sealed: 2_500_000 }),
  );
  assert.equal(undercharged.costMicroCredits, 283277283112209);

  const overcharged = quoteStorageRent(
    {
      bytes: 1_125_899_906_842_623,
      tier: "sealed",
      from,
      until: new Date(from.getTime() + 315_359_999_999),
    },
    storagePricing({ public: 0, sealed: 1_000_000 }),
  );
  assert.equal(overcharged.costMicroCredits, 127576746666263);

  // Both stay exact against the independent rational ceiling.
  assert.equal(
    BigInt(undercharged.costMicroCredits),
    exactCeilMicroCredits(1_000_000_000_000_000, 315_360_000_000, 2_500_000),
  );
  assert.equal(
    BigInt(overcharged.costMicroCredits),
    exactCeilMicroCredits(1_125_899_906_842_623, 315_359_999_999, 1_000_000),
  );
});

test("mechanism: exactness — a cost beyond the exact range is refused, not approximated", () => {
  assert.throws(
    () =>
      quoteStorageRent(
        {
          bytes: Number.MAX_SAFE_INTEGER,
          tier: "sealed",
          from,
          until: new Date(from.getTime() + STORAGE_RENT_MAX_TERM_MS),
        },
        storagePricing({ public: 0, sealed: 1_000_000_000 }),
      ),
    /exceeds the range a quote can carry exactly/,
  );
});

test("mechanism: hostile inputs — bytes, tiers, and terms are refused explicitly", () => {
  const until = new Date(from.getTime() + STORAGE_RENT_MONTH_MS);

  for (const bytes of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => quoteStorageRent({ bytes, tier: "sealed", from, until }, pricing),
      /bytes must be a positive safe integer/,
    );
  }

  for (const term of [0, -1, -STORAGE_RENT_MONTH_MS]) {
    assert.throws(
      () => quoteStorageRent({ bytes: 1, tier: "sealed", from, until: new Date(from.getTime() + term) }, pricing),
      /until must be after from/,
    );
  }

  assert.throws(
    () => quoteStorageRent({ bytes: 1, tier: "sealed", from: new Date(NaN), until }, pricing),
    /from and until must be valid dates/,
  );
  assert.throws(
    () => quoteStorageRent({ bytes: 1, tier: "sealed", from, until: new Date(NaN) }, pricing),
    /from and until must be valid dates/,
  );
  assert.throws(
    () =>
      quoteStorageRent(
        { bytes: 1, tier: "sealed", from, until: new Date(from.getTime() + STORAGE_RENT_MAX_TERM_MS + 1) },
        pricing,
      ),
    /a rent term is at most/,
  );
});

test("mechanism: hostile inputs — a bad rate never becomes a price", () => {
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => storagePricing({ public: 0, sealed: bad }),
      /must be a non-negative integer of microcredits/,
    );
  }

  assert.throws(
    () => storagePricing({ public: -1, sealed: 1 }),
    /public rate must be a non-negative integer/,
  );

  // A pricing object that carries no entry for the requested tier cannot quote.
  const missingTier = {
    ...pricing,
    tiers: pricing.tiers.filter((entry) => entry.tier !== "sealed"),
  };
  assert.throws(
    () => quoteStorageRent({ bytes: GIB, tier: "sealed", from, until: new Date(from.getTime() + STORAGE_RENT_MONTH_MS) }, missingTier),
    /no price for tier sealed/,
  );
});

test("mechanism: policy drift — a pricing object must describe the maths it is used for", () => {
  const until = new Date(from.getTime() + STORAGE_RENT_MONTH_MS);
  const input = { bytes: GIB, tier: "sealed" as const, from, until };

  // Reported monthMs must be the month actually used, or the quote publishes
  // numbers that do not describe its own arithmetic.
  assert.throws(
    () => quoteStorageRent(input, { ...pricing, monthMs: 1_000 }),
    /must match the committed storage-rent-v1 constants/,
  );
  assert.throws(
    () => quoteStorageRent(input, { ...pricing, creditScale: 1 }),
    /must match the committed storage-rent-v1 constants/,
  );
  assert.throws(
    () => quoteStorageRent(input, { ...pricing, policy: "storage-rent-v2" as typeof STORAGE_RENT_POLICY }),
    /must match the committed storage-rent-v1 constants/,
  );

  const sound = quoteStorageRent(input, pricing);
  assert.equal(sound.monthMs, STORAGE_RENT_MONTH_MS);
  assert.equal(sound.policy, STORAGE_RENT_POLICY);
  assert.equal(sound.costCredits, sound.costMicroCredits / STORAGE_CREDIT_SCALE);
});

test("mechanism: boundaries — a term of n months charges exactly n months", () => {
  for (const months of [1, 2, 3, 6, 12, 120]) {
    const quote = quoteStorageRent(
      { bytes: GIB, tier: "sealed", from, until: new Date(from.getTime() + months * STORAGE_RENT_MONTH_MS) },
      pricing,
    );
    assert.equal(quote.byteMonths, GIB * months);
    assert.equal(quote.gibMonths, months);
    assert.equal(quote.costMicroCredits, months * 1_000_000);
  }

  // One millisecond short of a month is not a whole month.
  const short = quoteStorageRent(
    { bytes: GIB, tier: "sealed", from, until: new Date(from.getTime() + STORAGE_RENT_MONTH_MS - 1) },
    pricing,
  );
  // Reported decimal fields are truncated at the micro-credit scale; the price
  // itself is the exact integer above. A millisecond short of a month is
  // therefore reported as just under one month, and still costs a full one.
  assert.ok(Math.abs(short.gibMonths - 1) < 1e-6, `gibMonths ${short.gibMonths}`);
  assert.ok(short.gibMonths < 1);
  assert.equal(short.costMicroCredits, 1_000_000);
});

test("mechanism: invariants — price is monotone in bytes and in term", () => {
  for (const durationMs of [1_000, STORAGE_RENT_MONTH_MS, 12 * STORAGE_RENT_MONTH_MS]) {
    let previous = 0;
    for (const bytes of [1, 1_000, 2 ** 20, 2 ** 30, 2 ** 40, 10 ** 14]) {
      const quote = quoteStorageRent(
        { bytes, tier: "sealed", from, until: new Date(from.getTime() + durationMs) },
        pricing,
      );
      assert.ok(quote.costMicroCredits >= previous, `cost fell as bytes rose at ${bytes}`);
      previous = quote.costMicroCredits;
    }
  }

  let previous = 0;
  for (const durationMs of [1, 1_000, STORAGE_RENT_MONTH_MS, 10 * STORAGE_RENT_MONTH_MS]) {
    const quote = quoteStorageRent(
      { bytes: GIB, tier: "sealed", from, until: new Date(from.getTime() + durationMs) },
      pricing,
    );
    assert.ok(quote.costMicroCredits >= previous, `cost fell as the term rose at ${durationMs}`);
    previous = quote.costMicroCredits;
  }
});

test("mechanism: invariants — doubling the term doubles the byte-months and the price exactly", () => {
  const term = 7 * STORAGE_RENT_MONTH_MS;
  const single = quoteStorageRent(
    { bytes: 3 * GIB, tier: "sealed", from, until: new Date(from.getTime() + term) },
    pricing,
  );
  const double = quoteStorageRent(
    { bytes: 3 * GIB, tier: "sealed", from, until: new Date(from.getTime() + 2 * term) },
    pricing,
  );

  assert.equal(double.byteMonths, single.byteMonths * 2);
  assert.equal(double.costMicroCredits, single.costMicroCredits * 2);
});

test("mechanism: invariants — the tier ordering holds for the shipped default policy", () => {
  const shipped = storagePricingFromEnv({});
  const sealed = shipped.tiers.find((entry) => entry.tier === "sealed")!;
  const open = shipped.tiers.find((entry) => entry.tier === "public")!;

  assert.ok(sealed.rateMicroCreditsPerGiBMonth >= open.rateMicroCreditsPerGiBMonth);
  assert.equal(open.free, true, "the open tier ships free");

  const until = new Date(from.getTime() + STORAGE_RENT_MONTH_MS);
  const sealedQuote = quoteStorageRent({ bytes: GIB, tier: "sealed", from, until }, shipped);
  const openQuote = quoteStorageRent({ bytes: GIB, tier: "public", from, until }, shipped);
  assert.ok(sealedQuote.costMicroCredits >= openQuote.costMicroCredits);
});

test("mechanism: purity — a quote is a function of its inputs alone", async () => {
  const until = new Date(from.getTime() + 3 * STORAGE_RENT_MONTH_MS);
  const input = { bytes: 5 * GIB, tier: "sealed" as const, from, until };

  const first = quoteStorageRent(input, pricing);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = quoteStorageRent(input, pricing);

  assert.deepEqual(second, first, "the same inputs must quote identically across wall-clock time");
  // The quote carries no clock of its own: only the term the caller passed.
  assert.equal(first.from, from.toISOString());
  assert.equal(first.until, until.toISOString());
});

test("mechanism: environment — malformed rates are refused, absent ones fall back", () => {
  const sealedRate = (pricing: ReturnType<typeof storagePricingFromEnv>) =>
    pricing.tiers.find((entry) => entry.tier === "sealed")?.rateMicroCreditsPerGiBMonth;

  for (const value of ["abc", "1.5", "-5", "1e6", "0x10", " 12 34 "]) {
    assert.throws(
      () => storagePricingFromEnv({ RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH: value }),
      /must be a non-negative integer of microcredits|above the safe integer range/,
      `env value ${JSON.stringify(value)} must not price anything`,
    );
  }

  for (const absent of ["", "   "]) {
    assert.equal(
      sealedRate(storagePricingFromEnv({ RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH: absent })),
      1_000_000,
      "an empty value is absent, so the documented default applies",
    );
  }

  assert.throws(
    () =>
      storagePricingFromEnv({
        RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH: "9".repeat(20),
      }),
    /above the safe integer range/,
  );
});

test("mechanism: scope — quoting moves nothing, and the quote says so", async () => {
  // The primitive prices; it does not settle. This guards against a later
  // change that quietly makes a quote reserving or charging.
  const dir = mkdtempSync(join(tmpdir(), "rarext-rent-scope-"));
  const blobs = new BlobStore(dir);
  const size = 512 * 1024;

  try {
    blobs.put(Buffer.alloc(size), { retentionUntil: new Date(Date.now() + STORAGE_RENT_MONTH_MS).toISOString() });
    const before = blobs.usage();
    const quote = quoteStorageRent(
      { bytes: size, tier: "sealed", from, until: new Date(from.getTime() + STORAGE_RENT_MONTH_MS) },
      pricing,
    );
    const after = blobs.usage();

    assert.ok(quote.costMicroCredits > 0);
    assert.deepEqual(after, before, "a quote must not change usage");
    assert.equal(Object.hasOwn(quote, "balance"), false);
    assert.equal(Object.hasOwn(quote, "charge"), false);
    assert.equal(quote.policy, "storage-rent-v1");
    // The quote carries no settlement unit of its own: pricing only, no ledger.
    assert.equal(Object.hasOwn(quote, "unit"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
