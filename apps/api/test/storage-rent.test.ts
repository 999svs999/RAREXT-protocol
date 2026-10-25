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
  STORAGE_RENT_MAX_TERM_MS,
  STORAGE_RENT_MONTH_MS,
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
