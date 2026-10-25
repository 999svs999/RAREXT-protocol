import type { StorageTier } from "../../../packages/core/src/index.ts";

/**
 * Storage rent is priced in byte-months. A byte-month is one byte held for one
 * accounting month of 30 days. The quote is deterministic, but it is only a
 * price: it does not reserve bytes, extend a retention term, or move credits.
 *
 * The price is computed in exact integer arithmetic. A float path looks
 * harmless — the numbers are small and the result is a ceiling — but the
 * intermediate product bytes x duration x rate reaches 1e27 for legal inputs
 * (MAX_SAFE_INTEGER bytes held for the ten-year cap), and double precision
 * then cannot represent it: a sweep of 25,800 legal quotes disagreed with exact
 * arithmetic 88 times, in both directions, including undercharges of tens of
 * microcredits at TB-scale multi-year terms. Since a quote is committed and a
 * tenant may pay it, "approximately the right price" is not a price. BigInt
 * makes the ceiling exact; the safe-integer refusal below keeps the result
 * representable.
 */
export const STORAGE_RENT_POLICY = "storage-rent-v1";
export const STORAGE_RENT_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
export const STORAGE_RENT_MAX_TERM_MS = 10 * 365 * 24 * 60 * 60 * 1000;
export const STORAGE_CREDIT_SCALE = 1_000_000;
const GIB = 1024 ** 3;
const MICRO_SCALE = 1_000_000n;

export interface StorageTierPrice {
  tier: StorageTier;
  /** Microcredits per GiB-month; 0 makes the tier free. */
  rateMicroCreditsPerGiBMonth: number;
  free: boolean;
}

export interface StoragePricing {
  policy: typeof STORAGE_RENT_POLICY;
  unit: "byte-month";
  monthMs: number;
  creditScale: number;
  currency: "credit";
  tiers: StorageTierPrice[];
}

export interface StorageRentQuote {
  policy: typeof STORAGE_RENT_POLICY;
  bytes: number;
  tier: StorageTier;
  from: string;
  until: string;
  durationMs: number;
  monthMs: number;
  byteMonths: number;
  gibMonths: number;
  rateMicroCreditsPerGiBMonth: number;
  costMicroCredits: number;
  costCredits: number;
  free: boolean;
}

export function isStorageTier(value: unknown): value is StorageTier {
  return value === "public" || value === "sealed";
}

function round(value: number, places = 12): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function readRate(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer of microcredits`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} is above the safe integer range`);
  }

  return value;
}

/**
 * Operator policy, not a protocol constant. The open tier defaults to free; the
 * sealed default is illustrative and can be replaced without changing the
 * quote shape.
 */
export function storagePricingFromEnv(env: NodeJS.ProcessEnv = process.env): StoragePricing {
  return storagePricing({
    public: readRate(env, "RAREXT_STORAGE_PUBLIC_MICROCREDITS_PER_GIB_MONTH", 0),
    sealed: readRate(env, "RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH", 1_000_000),
  });
}

export function storagePricing(rates: Record<StorageTier, number>): StoragePricing {
  for (const tier of ["public", "sealed"] as const) {
    const rate = rates[tier];
    if (!Number.isSafeInteger(rate) || rate < 0) {
      throw new Error(`the ${tier} rate must be a non-negative integer of microcredits`);
    }
  }

  return {
    policy: STORAGE_RENT_POLICY,
    unit: "byte-month",
    monthMs: STORAGE_RENT_MONTH_MS,
    creditScale: STORAGE_CREDIT_SCALE,
    currency: "credit",
    tiers: [
      {
        tier: "public",
        rateMicroCreditsPerGiBMonth: rates.public,
        free: rates.public === 0,
      },
      {
        tier: "sealed",
        rateMicroCreditsPerGiBMonth: rates.sealed,
        free: rates.sealed === 0,
      },
    ],
  };
}

/**
 * Cost is rounded up to a whole microcredit so a tiny quote never becomes free
 * by truncation. The result is an integer number of microcredits.
 */
export function quoteStorageRent(
  input: {
    bytes: number;
    tier: StorageTier;
    from: Date;
    until: Date;
  },
  pricing: StoragePricing,
): StorageRentQuote {
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
    throw new Error("bytes must be a positive safe integer");
  }

  if (!isStorageTier(input.tier)) {
    throw new Error("tier must be public or sealed");
  }

  const from = input.from.getTime();
  const until = input.until.getTime();

  if (!Number.isFinite(from) || !Number.isFinite(until)) {
    throw new Error("from and until must be valid dates");
  }

  const durationMs = until - from;

  if (durationMs <= 0) {
    throw new Error("until must be after from");
  }

  if (durationMs > STORAGE_RENT_MAX_TERM_MS) {
    throw new Error(`a rent term is at most ${STORAGE_RENT_MAX_TERM_MS} ms`);
  }

  // The quote reports policy fields and computes with them, so a drifted
  // pricing object would publish numbers that do not describe its own maths.
  // Refusing is the only honest option: a quote has to be readable back.
  if (
    pricing.policy !== STORAGE_RENT_POLICY ||
    pricing.monthMs !== STORAGE_RENT_MONTH_MS ||
    pricing.creditScale !== STORAGE_CREDIT_SCALE
  ) {
    throw new Error(
      "pricing policy, monthMs, and creditScale must match the committed storage-rent-v1 constants",
    );
  }

  const price = pricing.tiers.find((entry) => entry.tier === input.tier);
  if (!price) throw new Error(`no price for tier ${input.tier}`);

  // Exact integer arithmetic: byte-months, GiB-months, and the ceiling are all
  // rational, so they are computed as such and only then narrowed to numbers.
  // MICRO_SCALE keeps the reported decimal fields exact to six places without
  // ever putting a float back into the price.
  const numerator =
    BigInt(input.bytes) * BigInt(durationMs) * BigInt(price.rateMicroCreditsPerGiBMonth);
  const denominator = BigInt(pricing.monthMs) * BigInt(GIB);
  const costExact = (numerator + denominator - 1n) / denominator;

  if (costExact > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "the quoted cost exceeds the range a quote can carry exactly; reduce the term or the rate",
    );
  }

  const costMicroCredits = Number(costExact);
  const byteMonthsMicro =
    (BigInt(input.bytes) * BigInt(durationMs) * MICRO_SCALE) / BigInt(pricing.monthMs);
  const byteMonths = Number(byteMonthsMicro) / Number(MICRO_SCALE);
  const gibMonths = byteMonths / GIB;

  return {
    policy: pricing.policy,
    bytes: input.bytes,
    tier: input.tier,
    from: input.from.toISOString(),
    until: input.until.toISOString(),
    durationMs,
    monthMs: pricing.monthMs,
    byteMonths: round(byteMonths),
    gibMonths: round(gibMonths),
    rateMicroCreditsPerGiBMonth: price.rateMicroCreditsPerGiBMonth,
    costMicroCredits,
    costCredits: costMicroCredits / pricing.creditScale,
    free: costMicroCredits === 0,
  };
}
