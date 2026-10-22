import { chunkLeaves, SHARD_CHUNK_BYTES } from "./durability.ts";
import { merkleRoot, verifyProof } from "./merkle.ts";
import { sha256Bytes } from "./storage.ts";
import type { ErasureShard } from "./erasure.ts";

/**
 * Data availability sampling for media.
 *
 * A shard is committed as a Merkle tree over 4 KiB chunks. A reader asks for a
 * random chunk, receives the bytes plus a Merkle path, and checks both. If at
 * least `a` of `N` chunks are withheld, the probability a sample of `t` distinct
 * chunks misses all of them is the hypergeometric
 *
 *     C(N - a, t) / C(N, t) <= (1 - a/N)^t.
 *
 * The bound is about bytes the reader did not download. It is not a proof that
 * the whole media file is available, and it does not replace the holder audit:
 * one answered chunk proves that chunk, not the shard's future.
 */

export interface AvailabilityShard {
  index: number;
  storedAs: string | null;
  root: string;
  leaves: number;
  bytes: number;
}

export interface AvailabilityCommitment {
  version: 1;
  blobHash: string;
  chunkBytes: number;
  units: number;
  shards: AvailabilityShard[];
}

export interface AvailabilitySample {
  shard: number;
  leaf: number;
  bytes: Uint8Array;
  proof: string[];
}

export interface AvailabilityReport {
  ok: boolean;
  sampled: number;
  units: number;
  chunkBytes: number;
  bytesRead: number;
  failures: { shard: number; leaf: number; reason: string }[];
  /** Probability a sample of this size misses a withheld fraction, at 10%. */
  falseNegativeAt10Percent: number;
  /** Smallest withheld fraction this sample detects with 99% confidence. */
  detectableFractionAt99Percent: number;
}

export interface LeafReader {
  read(request: { shard: number; storedAs: string; leaf: number }): Promise<AvailabilitySample | null>;
}

export function availabilityCommitment(
  shards: ErasureShard[],
  storedAs: string[] = [],
): AvailabilityCommitment {
  const first = shards[0];
  if (!first) throw new Error("at least one shard is required");

  const seen = new Set<number>();
  let units = 0;
  let bytes = 0;

  for (const shard of shards) {
    if (seen.has(shard.index)) throw new Error(`shard ${shard.index} appears twice`);
    seen.add(shard.index);
    if (
      shard.dataShards !== first.dataShards ||
      shard.parityShards !== first.parityShards ||
      shard.payloadDigest !== first.payloadDigest
    ) {
      throw new Error(`shard ${shard.index} belongs to another set`);
    }
  }

  const committed = shards.map((shard) => {
    const leaves = chunkLeaves(shard.bytes);
    units += leaves.length;
    bytes += shard.bytes.length;

    return {
      index: shard.index,
      storedAs: storedAs[shard.index] ?? null,
      root: merkleRoot(leaves),
      leaves: leaves.length,
      bytes: shard.bytes.length,
    };
  });

  return {
    version: 1,
    blobHash: first.payloadDigest,
    chunkBytes: SHARD_CHUNK_BYTES,
    units,
    shards: committed.sort((left, right) => left.index - right.index),
  };
}

export function unitAt(
  commitment: AvailabilityCommitment,
  ordinal: number,
): { shard: number; leaf: number } | null {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= commitment.units) return null;

  let cursor = ordinal;

  for (const shard of commitment.shards) {
    if (cursor < shard.leaves) return { shard: shard.index, leaf: cursor };
    cursor -= shard.leaves;
  }

  return null;
}

/**
 * Sample `samples` distinct chunks without replacement. A failure is reported,
 * never retried away: retrying until something answers changes the bound.
 */
export async function sampleAvailability(
  commitment: AvailabilityCommitment,
  reader: LeafReader,
  { samples = 64, random = Math.random }: { samples?: number; random?: () => number } = {},
): Promise<AvailabilityReport> {
  const total = commitment.units;
  const wanted = Math.min(Math.max(1, Math.floor(samples)), total);
  const ordinals = Array.from({ length: total }, (_, index) => index);

  for (let index = 0; index < wanted; index += 1) {
    const pick = index + Math.floor(random() * (total - index));
    [ordinals[index], ordinals[pick]] = [ordinals[pick], ordinals[index]];
  }

  const failures: AvailabilityReport["failures"] = [];
  let bytesRead = 0;

  for (const ordinal of ordinals.slice(0, wanted)) {
    const unit = unitAt(commitment, ordinal);
    if (!unit) continue;
    const shard = commitment.shards.find((candidate) => candidate.index === unit.shard)!;

    if (!shard.storedAs) {
      failures.push({ ...unit, reason: "no holder location" });
      continue;
    }

    let sample: AvailabilitySample | null = null;

    try {
      sample = await reader.read({ shard: unit.shard, storedAs: shard.storedAs, leaf: unit.leaf });
    } catch (error) {
      failures.push({
        ...unit,
        reason: error instanceof Error ? error.message : "read failed",
      });
      continue;
    }

    if (!sample) {
      failures.push({ ...unit, reason: "chunk is missing" });
      continue;
    }

    bytesRead += sample.bytes.length;
    const leaf = sha256Bytes(sample.bytes);

    if (!verifyProof(leaf, sample.proof, shard.root, unit.leaf)) {
      failures.push({ ...unit, reason: "proof does not match the committed root" });
    }
  }

  return {
    ok: failures.length === 0,
    sampled: wanted,
    units: total,
    chunkBytes: commitment.chunkBytes,
    bytesRead,
    failures,
    falseNegativeAt10Percent: missProbability(total, Math.ceil(total * 0.1), wanted),
    detectableFractionAt99Percent: detectableFraction(total, wanted, 0.01),
  };
}

/**
 * Exact hypergeometric miss probability: all `samples` distinct units avoid
 * `unavailable` bad units out of `units`. Computed in log space.
 */
export function missProbability(units: number, unavailable: number, samples: number): number {
  if (units <= 0 || samples <= 0) return 1;
  if (unavailable <= 0) return 1;
  if (unavailable >= units) return samples > 0 ? 0 : 1;

  const t = Math.min(samples, units);

  if (t > units - unavailable) return 0;

  let log = 0;

  for (let index = 0; index < t; index += 1) {
    log += Math.log(units - unavailable - index) - Math.log(units - index);
  }

  return Math.min(1, Math.exp(log));
}

/** Conservative in-sample bound when only the withheld fraction is known. */
export function missProbabilityFraction(fraction: number, samples: number): number {
  if (fraction <= 0) return 1;
  if (fraction >= 1) return 0;
  return Math.pow(1 - fraction, Math.max(0, samples));
}

/** Minimal distinct-sample count to detect `fraction` withheld at `epsilon` risk. */
export function samplesForMissingFraction(
  units: number,
  fraction: number,
  epsilon = 0.01,
): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return Math.min(1, units);

  const unavailable = Math.max(1, Math.ceil(units * fraction));
  let low = 0;
  let high = Math.min(units, Math.ceil(Math.log(epsilon) / Math.log(1 - fraction)));

  while (missProbability(units, unavailable, high) > epsilon && high < units) {
    high = Math.min(units, high * 2);
  }

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (missProbability(units, unavailable, middle) <= epsilon) high = middle;
    else low = middle + 1;
  }

  return low;
}

/**
 * The smallest withheld fraction the sample would detect at `epsilon`, assuming
 * the unavailable units are a fixed subset. Binary search on the exact bound.
 */
export function detectableFraction(units: number, samples: number, epsilon = 0.01): number {
  if (units <= 0 || samples <= 0) return 1;
  if (samples >= units) return 1 / units;

  let low = 0;
  let high = units;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (missProbability(units, middle, samples) <= epsilon) high = middle;
    else low = middle + 1;
  }

  return Math.min(1, Math.max(low, 1) / units);
}

/** A reader for the holder HTTP surface. It never sees a blob hash. */
export function httpLeafReader(holderUrl: string): LeafReader {
  return {
    async read({ storedAs, leaf }) {
      const response = await fetch(
        `${holderUrl.replace(/\/+$/, "")}/v1/holder/shards/${encodeURIComponent(storedAs)}/leaves/${leaf}`,
      );

      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`holder returned ${response.status}`);

      const body = (await response.json()) as {
        index?: number;
        bytes?: string;
        proof?: string[];
      };

      if (body.index !== leaf || typeof body.bytes !== "string" || !Array.isArray(body.proof)) {
        throw new Error("holder returned a malformed leaf");
      }

      return {
        shard: 0,
        leaf,
        bytes: Uint8Array.from(Buffer.from(body.bytes, "base64")),
        proof: body.proof,
      };
    },
  };
}
