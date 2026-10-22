import { createHash } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";

/**
 * Erasure coding over GF(256).
 *
 * A payload is cut into k data blocks, and n = k + m shards are produced with a
 * systematic Reed-Solomon code: the first k shards are the data itself, and the
 * remaining m are parity. Any k of the n shards rebuild the payload, and any
 * k - 1 do not. That is the difference between "we kept enough copies" and "we
 * can rebuild it from whoever is left".
 *
 * Each shard's digest covers its own identity — index, code parameters, original
 * length — as well as its bytes, so a shard cannot be corrupted, relabelled, or
 * borrowed from another set without the digest failing first.
 *
 * The GF(256) field uses the AES/Rijndael polynomial 0x11d. Encoding is
 * deterministic, which is what lets two independent replicas compute the same
 * shard and compare digests instead of paying for a third opinion.
 */

const PRIMITIVE = 0x11d;
const FIELD_MAX = 255;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;

  for (let index = 0; index < FIELD_MAX; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;

    if (value & 0x100) value ^= PRIMITIVE;
  }

  for (let index = FIELD_MAX; index < EXP.length; index += 1) {
    EXP[index] = EXP[index - FIELD_MAX]!;
  }
}

function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[LOG[left]! + LOG[right]!]!;
}

function inverse(value: number): number {
  if (value === 0) throw new Error("there is no inverse of zero in GF(256)");
  return EXP[FIELD_MAX - LOG[value]!]!;
}

function identity(size: number): number[][] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
}

function invertMatrix(matrix: number[][]): number[][] {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [...row, ...identity(size)[index]!]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;

    while (pivot < size && augmented[pivot]![column] === 0) pivot += 1;

    if (pivot === size) throw new Error("the shard matrix is singular");

    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];

    const scale = inverse(augmented[column]![column]!);

    for (let position = 0; position < 2 * size; position += 1) {
      augmented[column]![position] = multiply(augmented[column]![position]!, scale);
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;

      const factor = augmented[row]![column]!;
      if (factor === 0) continue;

      for (let position = 0; position < 2 * size; position += 1) {
        augmented[row]![position] ^= multiply(factor, augmented[column]![position]!);
      }
    }
  }

  return augmented.map((row) => row.slice(size));
}

/**
 * The systematic generator matrix. Row i is the coefficient vector for shard i,
 * and the first k rows are the identity, so shard j < k is data block j.
 */
function generatorMatrix(shards: number, dataShards: number): number[][] {
  const vandermonde = Array.from({ length: shards }, (_, row) => {
    const base = row;
    let power = 1;
    return Array.from({ length: dataShards }, () => {
      const coefficient = power;
      power = multiply(power, base);
      return coefficient;
    });
  });

  const top = vandermonde.slice(0, dataShards);
  const inverseTop = invertMatrix(top);

  return vandermonde.map((row) =>
    Array.from({ length: dataShards }, (_, column) => {
      let sum = 0;

      for (let inner = 0; inner < dataShards; inner += 1) {
        sum ^= multiply(row[inner]!, inverseTop[inner]![column]!);
      }

      return sum;
    }),
  );
}

export interface ErasureShard {
  index: number;
  dataShards: number;
  parityShards: number;
  /** Length of the original payload, in bytes. */
  length: number;
  /** The digest of the whole payload, so a shard from another set is caught. */
  payloadDigest: string;
  /** The shard payload, padded to a common size across the set. */
  bytes: Uint8Array;
  /** The digest of the shard's identity and bytes. */
  digest: string;
}

/**
 * A V8 string cannot exceed ~512 MB. A shard whose hex encoding would cross that
 * limit cannot use the original digest input, and no such shard could have been
 * created before this branch existed. Stream those bytes instead, with an
 * explicit marker so the two encodings cannot collide.
 */
const MAX_HEX_CHARS = 0x1fffffe8;

export function shardDigest(
  shard: Omit<ErasureShard, "digest"> | ErasureShard,
): string {
  const metadata = {
    index: shard.index,
    dataShards: shard.dataShards,
    parityShards: shard.parityShards,
    length: shard.length,
    payloadDigest: shard.payloadDigest,
  };

  if (shard.bytes.length * 2 <= MAX_HEX_CHARS) {
    return createHash("sha256")
      .update(canonicalize({ ...metadata, bytes: Buffer.from(shard.bytes).toString("hex") }))
      .digest("hex");
  }

  return createHash("sha256")
    .update(canonicalize({ ...metadata, bytes: null, byteLength: shard.bytes.length, streamed: true }))
    .update(shard.bytes)
    .digest("hex");
}

export function verifyShard(shard: ErasureShard): boolean {
  const { index, dataShards, parityShards, length, payloadDigest, bytes, digest } = shard;

  if (!Number.isInteger(index) || index < 0) return false;
  if (!Number.isInteger(dataShards) || dataShards < 1) return false;
  if (!Number.isInteger(parityShards) || parityShards < 0) return false;
  if (index >= dataShards + parityShards) return false;
  if (!Number.isInteger(length) || length < 0) return false;
  if (typeof payloadDigest !== "string" || payloadDigest.length !== 64) return false;
  if (!(bytes instanceof Uint8Array)) return false;
  if (typeof digest !== "string") return false;

  return digest === shardDigest(shard);
}

function assertParameters(dataShards: number, parityShards: number): void {
  if (!Number.isInteger(dataShards) || dataShards < 1) {
    throw new Error("data shards must be an integer of at least 1");
  }

  if (!Number.isInteger(parityShards) || parityShards < 0) {
    throw new Error("parity shards must be a non-negative integer");
  }

  if (dataShards + parityShards > FIELD_MAX) {
    throw new Error(`a shard set cannot exceed ${FIELD_MAX} shards`);
  }
}

export function encodeBytes(
  payload: Uint8Array,
  dataShards: number,
  parityShards: number,
): ErasureShard[] {
  assertParameters(dataShards, parityShards);

  const shards = dataShards + parityShards;
  const blockLength = Math.ceil(payload.length / dataShards);
  const payloadDigest = createHash("sha256").update(payload).digest("hex");

  const blocks = Array.from({ length: dataShards }, (_, block) =>
    Uint8Array.from(
      { length: blockLength },
      (_, position) => payload[block * blockLength + position] ?? 0,
    ),
  );

  const matrix = generatorMatrix(shards, dataShards);

  return Array.from({ length: shards }, (_, row) => {
    const coefficients = matrix[row]!;
    const bytes = new Uint8Array(blockLength);

    for (let position = 0; position < blockLength; position += 1) {
      let sum = 0;

      for (let block = 0; block < dataShards; block += 1) {
        const coefficient = coefficients[block]!;
        if (coefficient === 0) continue;
        sum ^= multiply(coefficient, blocks[block]![position]!);
      }

      bytes[position] = sum;
    }

    const shard = {
      index: row,
      dataShards,
      parityShards,
      length: payload.length,
      payloadDigest,
      bytes,
    };

    return { ...shard, digest: shardDigest(shard) };
  });
}

export function decodeBytes(shards: ErasureShard[]): Uint8Array {
  if (shards.length === 0) throw new Error("there are no shards to decode");

  const { dataShards, parityShards, length, payloadDigest } = shards[0]!;

  assertParameters(dataShards, parityShards);

  if (shards.length < dataShards) {
    throw new Error(`at least ${dataShards} shards are needed to reconstruct`);
  }

  const seen = new Set<number>();

  for (const shard of shards) {
    if (
      shard.dataShards !== dataShards ||
      shard.parityShards !== parityShards ||
      shard.length !== length ||
      shard.payloadDigest !== payloadDigest
    ) {
      throw new Error("the shards do not belong to the same set");
    }

    if (shard.bytes.length !== shards[0]!.bytes.length) {
      throw new Error("the shards do not have the same size");
    }

    if (seen.has(shard.index)) {
      throw new Error(`shard ${shard.index} appears twice`);
    }

    seen.add(shard.index);

    if (!verifyShard(shard)) {
      throw new Error(`shard ${shard.index} does not match its digest`);
    }
  }

  const chosen = [...shards].sort((left, right) => left.index - right.index).slice(0, dataShards);
  const matrix = generatorMatrix(dataShards + parityShards, dataShards);
  const square = chosen.map((shard) => matrix[shard.index]!);
  const inverseSquare = invertMatrix(square);
  const blockLength = chosen[0]!.bytes.length;

  const blocks = Array.from({ length: dataShards }, (_, block) => {
    const coefficients = inverseSquare[block]!;
    const bytes = new Uint8Array(blockLength);

    for (let position = 0; position < blockLength; position += 1) {
      let sum = 0;

      for (let shard = 0; shard < dataShards; shard += 1) {
        const coefficient = coefficients[shard]!;
        if (coefficient === 0) continue;
        sum ^= multiply(coefficient, chosen[shard]!.bytes[position]!);
      }

      bytes[position] = sum;
    }

    return bytes;
  });

  const payload = new Uint8Array(length);

  for (let block = 0; block < dataShards; block += 1) {
    const source = blocks[block]!;
    const offset = block * blockLength;
    const take = Math.max(0, Math.min(source.length, length - offset));

    if (take > 0) payload.set(source.subarray(0, take), offset);
  }

  const reconstructed = createHash("sha256").update(payload).digest("hex");

  if (reconstructed !== payloadDigest) {
    throw new Error("the reconstructed payload does not match its digest");
  }

  return payload;
}
