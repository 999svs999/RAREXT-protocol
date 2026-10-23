import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

import { decodeBytes, encodeBytes, shardDigest, type ErasureShard } from "./erasure.ts";
import { merkleRoot } from "./merkle.ts";

/**
 * File-backed erasure coding for large payloads.
 *
 * `encodeBytes` holds the payload, every block, and every shard in memory at
 * once: peak RSS is roughly `payload * (1 + (k + m) / k)`. This module keeps the
 * same Reed-Solomon code but stripes the payload into fixed chunks, encodes one
 * chunk at a time, and appends each shard block to a file. Peak memory is a
 * function of the chunk size, not the payload size.
 *
 * The shard files are valid inputs to the existing Merkle leaf and challenge
 * code: every chunk block is a multiple of 4 KiB (when non-empty), so
 * `chunkLeaves(shardFile)` is the concatenation of the per-chunk leaves, and the
 * recorded root commits to the same bytes the file holds.
 *
 * Scope: this is the large-blob path. `DurabilityLedger.placeStreamed` uploads
 * the shard files through the holder's raw PUT endpoint and `retrieveStreamed`
 * downloads any k of them through raw GET, so the HTTP path stays bounded too.
 * Repair rebuilds one lost shard at a time from k survivor files and uploads it
 * through raw PUT, so it follows the chunk size rather than the payload size. The
 * MCP put path still buffers its (8 MiB-capped) input.
 */

export const STREAM_CHUNK_BYTES = 8 * 1024 * 1024;
const SHARD_CHUNK_BYTES = 4096;

export interface StreamedShard {
  index: number;
  path: string;
  bytes: number;
  leaves: number;
  root: string;
  sha256: string;
}

export interface StreamedPlacement {
  version: 1;
  /** SHA-256 of the original (unpadded) payload. */
  payloadDigest: string;
  length: number;
  /** Total encoded length after per-chunk padding; `shardBytes = paddedLength / k`. */
  paddedLength: number;
  chunkBytes: number;
  chunks: number;
  chunkDigests: string[];
  dataShards: number;
  parityShards: number;
  shards: StreamedShard[];
}

export interface EncodeFileOptions {
  inputPath: string;
  outputDir: string;
  dataShards: number;
  parityShards: number;
  chunkBytes?: number;
}

export interface DecodeFileOptions {
  placement: StreamedPlacement;
  outputPath: string;
  /** Override shard locations, e.g. after losing a holder. Defaults to the recorded paths. */
  available?: { index: number; path: string }[];
}

function assertParameters(dataShards: number, parityShards: number, chunkBytes: number): void {
  if (!Number.isInteger(dataShards) || dataShards < 1) throw new Error("dataShards must be at least 1");
  if (!Number.isInteger(parityShards) || parityShards < 0) throw new Error("parityShards must be at least 0");
  if (dataShards + parityShards > 255) throw new Error("a shard set cannot exceed 255 shards");
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw new Error("chunkBytes must be a positive integer");

  if (chunkBytes % (dataShards * SHARD_CHUNK_BYTES) !== 0) {
    throw new Error(`chunkBytes must be a multiple of dataShards * ${SHARD_CHUNK_BYTES}`);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFully(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;

  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) throw new Error("unexpected end of input file");
    offset += read;
  }
}

function writeFully(fd: number, bytes: Uint8Array): void {
  let offset = 0;

  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

function chunkPlan(size: number, chunkBytes: number, dataShards: number) {
  const chunks = size === 0 ? 1 : Math.ceil(size / chunkBytes);
  const padded: number[] = [];

  for (let index = 0; index < chunks; index += 1) {
    const raw = Math.max(0, Math.min(chunkBytes, size - index * chunkBytes));
    const block = dataShards * SHARD_CHUNK_BYTES;
    padded.push(raw === 0 ? 0 : Math.ceil(raw / block) * block);
  }

  return { chunks, padded };
}

export function encodeFileToShards(options: EncodeFileOptions): StreamedPlacement {
  const { inputPath, outputDir, dataShards, parityShards } = options;
  const chunkBytes = options.chunkBytes ?? STREAM_CHUNK_BYTES;

  assertParameters(dataShards, parityShards, chunkBytes);
  mkdirSync(outputDir, { recursive: true });

  const size = statSync(inputPath).size;
  const { chunks, padded } = chunkPlan(size, chunkBytes, dataShards);
  const total = dataShards + parityShards;
  const input = openSync(inputPath, "r");
  const outputs = Array.from({ length: total }, (_, index) =>
    openSync(join(outputDir, `shard-${index}`), "w"),
  );
  const hashers = Array.from({ length: total }, () => createHash("sha256"));
  const leaves: string[][] = Array.from({ length: total }, () => []);
  const chunkDigests: string[] = [];
  const payloadHasher = createHash("sha256");

  try {
    for (let index = 0; index < chunks; index += 1) {
      const rawLength = Math.max(0, Math.min(chunkBytes, size - index * chunkBytes));
      const raw = Buffer.alloc(rawLength);

      if (rawLength > 0) readFully(input, raw, index * chunkBytes);

      const blockLength = padded[index]!;
      const chunk = Buffer.alloc(blockLength);
      raw.copy(chunk);

      payloadHasher.update(raw);
      chunkDigests.push(sha256Hex(chunk));

      const shards = encodeBytes(chunk, dataShards, parityShards);

      for (const shard of shards) {
        writeFully(outputs[shard.index]!, shard.bytes);
        hashers[shard.index]!.update(shard.bytes);

        if (shard.bytes.length === 0) {
          leaves[shard.index]!.push(sha256Hex(new Uint8Array(0)));
          continue;
        }

        for (let offset = 0; offset < shard.bytes.length; offset += SHARD_CHUNK_BYTES) {
          leaves[shard.index]!.push(
            sha256Hex(shard.bytes.subarray(offset, offset + SHARD_CHUNK_BYTES)),
          );
        }
      }
    }
  } finally {
    closeSync(input);
    for (const fd of outputs) closeSync(fd);
  }

  const paddedLength = padded.reduce((sum, value) => sum + value, 0);
  const shardBytes = paddedLength / dataShards;

  return {
    version: 1,
    payloadDigest: payloadHasher.digest("hex"),
    length: size,
    paddedLength,
    chunkBytes,
    chunks,
    chunkDigests,
    dataShards,
    parityShards,
    shards: Array.from({ length: total }, (_, index) => {
      const path = join(outputDir, `shard-${index}`);
      return {
        index,
        path,
        bytes: shardBytes,
        leaves: leaves[index]!.length,
        root: merkleRoot(leaves[index]!),
        sha256: hashers[index]!.digest("hex"),
      };
    }),
  };
}

/**
 * Regenerate one shard file from any k survivors, one chunk at a time. Repair
 * uses this instead of rebuilding the whole payload: peak memory is still the
 * chunk size, and only the missing shard is written.
 */
export function reencodeStreamedShard(options: {
  placement: StreamedPlacement;
  targetIndex: number;
  available: { index: number; path: string }[];
  outputPath: string;
}): { bytes: number; sha256: string; leaves: number; root: string } {
  const { placement, targetIndex, outputPath } = options;
  const { dataShards, parityShards, chunkBytes, chunks, paddedLength, chunkDigests } = placement;

  assertParameters(dataShards, parityShards, chunkBytes);

  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= dataShards + parityShards) {
    throw new Error("targetIndex is out of range");
  }
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error("chunks must be a positive integer");
  if (!Number.isInteger(paddedLength) || paddedLength < 0) throw new Error("paddedLength is invalid");
  if (!Array.isArray(chunkDigests) || chunkDigests.length !== chunks) {
    throw new Error("chunkDigests does not match the chunk count");
  }

  const unique = new Map<number, string>();
  for (const shard of options.available) {
    if (!Number.isInteger(shard.index) || shard.index < 0 || shard.index >= dataShards + parityShards) {
      throw new Error("available shard index is out of range");
    }
    if (shard.index === targetIndex) throw new Error("the target shard cannot be a survivor");
    unique.set(shard.index, shard.path);
  }

  const chosen = [...unique.entries()].sort((left, right) => left[0] - right[0]).slice(0, dataShards);
  if (chosen.length < dataShards) throw new Error(`need ${dataShards} survivor shards, have ${chosen.length}`);

  const fullBlock = chunkBytes / dataShards;
  const lastBlock = (paddedLength - (chunks - 1) * chunkBytes) / dataShards;

  if (!Number.isInteger(lastBlock) || lastBlock < 0) throw new Error("the last chunk is misaligned");

  const handles = chosen.map(([, path]) => openSync(path, "r"));
  const output = openSync(outputPath, "w");

  try {
    for (let index = 0; index < chunks; index += 1) {
      const blockLength = index === chunks - 1 ? lastBlock : fullBlock;
      const offset = index * fullBlock;
      const shards: ErasureShard[] = [];

      for (const [position, [shardIndex]] of chosen.entries()) {
        const bytes = Buffer.alloc(blockLength);
        if (blockLength > 0) readFully(handles[position]!, bytes, offset);
        const partial = {
          index: shardIndex,
          dataShards,
          parityShards,
          length: blockLength * dataShards,
          payloadDigest: chunkDigests[index]!,
          bytes,
        };
        shards.push({ ...partial, digest: shardDigest(partial) });
      }

      const chunk = decodeBytes(shards);
      const encoded = encodeBytes(chunk, dataShards, parityShards);
      writeFully(output, encoded[targetIndex]!.bytes);
    }
  } finally {
    closeSync(output);
    for (const fd of handles) closeSync(fd);
  }

  const bytes = paddedLength / dataShards;
  const hash = createHash("sha256");
  const leaves: string[] = [];
  const reader = openSync(outputPath, "r");

  try {
    const buffer = Buffer.alloc(SHARD_CHUNK_BYTES);
    let position = 0;

    for (;;) {
      const read = readSync(reader, buffer, 0, SHARD_CHUNK_BYTES, position);
      if (read === 0) break;
      const slice = buffer.subarray(0, read);
      hash.update(slice);
      leaves.push(sha256Hex(slice));
      position += read;
    }
  } finally {
    closeSync(reader);
  }

  return {
    bytes,
    sha256: hash.digest("hex"),
    leaves: leaves.length > 0 ? leaves.length : 1,
    root: merkleRoot(leaves.length > 0 ? leaves : [sha256Hex(new Uint8Array())]),
  };
}

export function decodeShardsToFile(options: DecodeFileOptions): {
  bytes: number;
  payloadDigest: string;
  sha256: string;
} {
  const { placement, outputPath } = options;
  const { dataShards, parityShards, chunkBytes, chunks, paddedLength, length } = placement;

  assertParameters(dataShards, parityShards, chunkBytes);

  if (!Number.isInteger(chunks) || chunks < 1) throw new Error("chunks must be a positive integer");
  if (!Number.isInteger(paddedLength) || paddedLength < 0) throw new Error("paddedLength is invalid");
  if (!Number.isInteger(length) || length < 0 || length > paddedLength) {
    throw new Error("length does not fit the padded length");
  }
  if (!Array.isArray(placement.chunkDigests) || placement.chunkDigests.length !== chunks) {
    throw new Error("chunkDigests does not match the chunk count");
  }

  const fullBlock = chunkBytes / dataShards;
  const lastBlock = (paddedLength - (chunks - 1) * chunkBytes) / dataShards;

  if (!Number.isInteger(lastBlock) || lastBlock < 0) throw new Error("the last chunk is misaligned");

  const source = options.available ?? placement.shards;
  const unique = new Map<number, string>();

  for (const shard of source) {
    if (Number.isInteger(shard.index)) unique.set(shard.index, shard.path);
  }

  const chosen = [...unique.entries()].sort((left, right) => left[0] - right[0]).slice(0, dataShards);

  if (chosen.length < dataShards) {
    throw new Error(`need ${dataShards} shard files, have ${chosen.length}`);
  }

  const expectedBytes = paddedLength / dataShards;

  for (const [index, path] of chosen) {
    const actual = statSync(path).size;
    if (actual !== expectedBytes) {
      throw new Error(`shard ${index} file is ${actual} bytes, expected ${expectedBytes}`);
    }
  }

  const handles = chosen.map(([, path]) => openSync(path, "r"));
  const output = openSync(outputPath, "w");
  const outputHasher = createHash("sha256");
  let written = 0;

  try {
    for (let index = 0; index < chunks; index += 1) {
      const blockLength = index === chunks - 1 ? lastBlock : fullBlock;
      const offset = index * fullBlock;
      const shards: ErasureShard[] = [];

      for (let position = 0; position < dataShards; position += 1) {
        const [shardIndex] = chosen[position]!;
        const bytes = Buffer.alloc(blockLength);

        if (blockLength > 0) readFully(handles[position]!, bytes, offset);

        const shard = {
          index: shardIndex,
          dataShards,
          parityShards,
          length: blockLength * dataShards,
          payloadDigest: placement.chunkDigests[index]!,
          bytes,
        };

        shards.push({ ...shard, digest: shardDigest(shard) });
      }

      const chunk = decodeBytes(shards);
      const take = Math.max(0, Math.min(chunk.length, length - written));

      if (take > 0) {
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, take);
        writeFully(output, bytes);
        outputHasher.update(bytes);
        written += take;
      }
    }
  } finally {
    for (const fd of handles) closeSync(fd);
    closeSync(output);
  }

  if (written !== length) throw new Error(`wrote ${written} bytes, expected ${length}`);

  const digest = outputHasher.digest("hex");

  if (digest !== placement.payloadDigest) {
    throw new Error("the reconstructed payload does not match its digest");
  }

  return { bytes: written, payloadDigest: placement.payloadDigest, sha256: digest };
}
