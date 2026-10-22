// Storage methods measured by the benchmark.
//
// Each runner returns one row: what it stored, whether the decoded bytes are
// bit-exact, how long verification and decoding took, and a reference digest for
// the reconstruction. The harness adds the row to the table; it never upgrades a
// mismatch to "exact".

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeBytes, encodeBytes } from "../../apps/api/src/erasure.ts";
import { sha256, sliceByModality } from "./corpus.mjs";
import { learnedRunners, polynomialRunner } from "./learned.mjs";

const ZSTD_LEVEL = 19;

function now() {
  return performance.now();
}

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000,
    ...options,
  });
}

function combinedDigest(digests) {
  return createHash("sha256").update(digests.join("\n")).digest("hex");
}

function videoRaw(work, source, label) {
  const raw = join(work, `${label}.raw`);

  exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", source, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-y", raw]);

  return raw;
}

function psnr(reference, decoded) {
  const length = Math.min(reference.length, decoded.length);
  let squared = 0;
  let differing = 0;

  for (let index = 0; index < length; index += 1) {
    const delta = reference[index] - decoded[index];

    if (delta !== 0) differing += 1;
    squared += delta * delta;
  }

  const mse = squared / Math.max(1, length);

  return {
    psnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
    differing,
    ratio: differing / Math.max(1, length),
  };
}

export function zstdRunner() {
  return {
    id: "zstd-19",
    label: "zstd -19",
    kind: "classical",
    declaresExact: true,
    decoderBytes: null,
    async run({ root, manifest, work }) {
      const outDir = join(work, "zstd");

      mkdirSync(outDir, { recursive: true });

      const stored = [];
      const started = now();

      for (const slice of manifest.slices) {
        const destination = join(outDir, `${slice.path.replaceAll("/", "__")}.zst`);

        exec("zstd", ["-q", "-f", `-${ZSTD_LEVEL}`, join(root, slice.path), "-o", destination]);
        stored.push({ path: destination, digest: sha256(readFileSync(destination)), bytes: statSync(destination).size });
      }

      const encodeMs = now() - started;
      const storedBytes = stored.reduce((total, file) => total + file.bytes, 0);

      const verifyStart = now();

      for (const file of stored) {
        if (sha256(readFileSync(file.path)) !== file.digest) throw new Error(`zstd: ${file.path} changed after encode`);
      }

      const verifyMs = now() - verifyStart;
      const decodeStart = now();
      const digests = [];

      for (const [index, slice] of manifest.slices.entries()) {
        const decodedPath = join(outDir, `${index}.decoded`);
        const source = stored[index].path;

        exec("zstd", ["-q", "-d", "-f", source, "-o", decodedPath]);

        if (sha256(readFileSync(decodedPath)) !== slice.sha256) {
          throw new Error(`zstd: ${slice.path} did not decode to its reference digest`);
        }

        digests.push(slice.sha256);
      }

      const decodeMs = now() - decodeStart;
      const referenceDigest = combinedDigest(manifest.slices.map((slice) => slice.sha256));
      const reconstructedDigest = combinedDigest(digests);

      return {
        slice: "all files",
        inputBytes: manifest.totalBytes,
        storedBytes,
        referenceDigest,
        reconstructedDigest,
        exact: referenceDigest === reconstructedDigest,
        errorRatio: 0,
        psnr: null,
        verifyMs,
        decodeMs,
        encodeMs,
        decoderBytes: null,
        kind: "classical",
        notes: `per-file level ${ZSTD_LEVEL}; system zstd decoder not counted`,
      };
    },
  };
}

function framePayload(root, manifest) {
  const files = manifest.slices.map((slice) => ({
    path: slice.path,
    bytes: slice.bytes,
    sha256: slice.sha256,
  }));
  const header = Buffer.from(JSON.stringify({ version: 1, files }), "utf8");
  const prefix = Buffer.alloc(8);

  prefix.writeUInt32LE(header.length, 0);
  prefix.writeUInt32LE(manifest.slices.length, 4);

  const parts = [prefix, header];

  for (const slice of manifest.slices) parts.push(readFileSync(join(root, slice.path)));

  return Buffer.concat(parts);
}

export function erasureRunner({ dataShards = 4, parityShards = 2 } = {}) {
  return {
    id: `erasure-${dataShards}-of-${dataShards + parityShards}`,
    label: `erasure ${dataShards}+${parityShards}`,
    kind: "classical",
    declaresExact: true,
    decoderBytes: null,
    async run({ root, manifest, work }) {
      const outDir = join(work, "erasure");
      const payload = framePayload(root, manifest);

      mkdirSync(outDir, { recursive: true });

      const encodeStart = now();
      const shards = encodeBytes(new Uint8Array(payload), dataShards, parityShards);
      const stored = shards.map((shard, index) => {
        const bytes = Buffer.from(shard.bytes);
        const path = join(outDir, `shard-${index}.bin`);

        writeFileSync(path, bytes);

        return { path, digest: sha256(bytes), bytes: bytes.length };
      });
      const encodeMs = now() - encodeStart;
      const storedBytes = stored.reduce((total, file) => total + file.bytes, 0);
      const referenceDigest = combinedDigest(manifest.slices.map((slice) => slice.sha256));

      const verifyStart = now();
      const rebuilt = [];

      for (const file of stored) {
        const bytes = readFileSync(file.path);

        if (sha256(bytes) !== file.digest) throw new Error(`erasure: ${file.path} changed after encode`);

        rebuilt.push(bytes);
      }

      const verifyMs = now() - verifyStart;
      const decodeStart = now();
      const decoded = decodeBytes(
        rebuilt.map((bytes, index) => shards[index] && { ...shards[index], bytes: new Uint8Array(bytes) }),
      );
      const decodedPayload = Buffer.from(decoded);
      const headerLength = decodedPayload.readUInt32LE(0);
      const header = JSON.parse(decodedPayload.subarray(8, 8 + headerLength).toString("utf8"));
      let offset = 8 + headerLength;
      const digests = [];

      for (const file of header.files) {
        const bytes = decodedPayload.subarray(offset, offset + file.bytes);

        digests.push(sha256(bytes));
        offset += file.bytes;
      }

      const decodeMs = now() - decodeStart;
      const reconstructedDigest = combinedDigest(digests);

      return {
        slice: "all files",
        inputBytes: manifest.totalBytes,
        storedBytes,
        referenceDigest,
        reconstructedDigest,
        exact: referenceDigest === reconstructedDigest && offset === decodedPayload.length,
        errorRatio: 0,
        psnr: null,
        verifyMs,
        decodeMs,
        encodeMs,
        decoderBytes: null,
        kind: "classical",
        notes: `${dataShards} data + ${parityShards} parity; no compression, ${(storedBytes / manifest.totalBytes).toFixed(2)}x durability overhead; system decoder not counted`,
      };
    },
  };
}

function ffmpegAvailable(encoder) {
  try {
    return exec("ffmpeg", ["-hide_banner", "-encoders"]).toString("utf8").includes(encoder);
  } catch {
    return false;
  }
}

function videoRunner({ id, label, encoder, lossless, qualityArgs }) {
  return {
    id,
    label,
    kind: "classical",
    declaresExact: lossless,
    decoderBytes: null,
    async run({ root, manifest, work }) {
      const video = sliceByModality(manifest, "video");

      if (!video) throw new Error("corpus has no video slice");
      if (!ffmpegAvailable(encoder)) {
        return { skipped: true, reason: `ffmpeg has no ${encoder} encoder`, slice: "video" };
      }

      const source = join(root, video.path);
      const out = join(work, `${id}.mp4`);
      const encodeStart = now();

      exec("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source,
        "-c:v",
        encoder,
        "-pix_fmt",
        "yuv420p",
        ...qualityArgs,
        "-y",
        out,
      ]);

      const encodeMs = now() - encodeStart;
      const storedBytes = statSync(out).size;
      const storedDigest = sha256(readFileSync(out));
      const referencePath = videoRaw(work, source, "reference");
      const reference = readFileSync(referencePath);
      const referenceDigest = sha256(reference);
      const verifyStart = now();

      if (sha256(readFileSync(out)) !== storedDigest) throw new Error(`${label}: encoded file changed after encode`);

      const verifyMs = now() - verifyStart;
      const decodedPath = join(work, `${id}.decoded.raw`);
      const decodeStart = now();

      exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-y", decodedPath]);

      const decodeMs = now() - decodeStart;
      const decoded = readFileSync(decodedPath);
      const reconstructedDigest = sha256(decoded);
      const measured = psnr(reference, decoded);

      return {
        slice: "video",
        inputBytes: reference.length,
        storedBytes,
        referenceDigest,
        reconstructedDigest,
        exact: reconstructedDigest === referenceDigest,
        errorRatio: measured.ratio,
        psnr: measured.psnr,
        verifyMs,
        decodeMs,
        encodeMs,
        decoderBytes: null,
        kind: "classical",
        notes: `${lossless ? "lossless" : "lossy"} ${encoder}; system ffmpeg decoder not counted`,
      };
    },
  };
}

export function x265Runner() {
  return [
    videoRunner({
      id: "x265-lossless",
      label: "x265 lossless",
      encoder: "libx265",
      lossless: true,
      qualityArgs: ["-preset", "ultrafast", "-x265-params", "lossless=1"],
    }),
    videoRunner({
      id: "x265-crf28",
      label: "x265 CRF 28",
      encoder: "libx265",
      lossless: false,
      qualityArgs: ["-preset", "ultrafast", "-crf", "28"],
    }),
  ];
}

export function av1Runner() {
  return [
    videoRunner({
      id: "av1-lossless",
      label: "AV1 lossless",
      encoder: "libsvtav1",
      lossless: true,
      qualityArgs: ["-preset", "10", "-svtav1-params", "lossless=1"],
    }),
    videoRunner({
      id: "av1-crf35",
      label: "AV1 CRF 35",
      encoder: "libsvtav1",
      lossless: false,
      qualityArgs: ["-preset", "10", "-crf", "35"],
    }),
  ];
}

export function allRunners() {
  return [
    ...x265Runner(),
    ...av1Runner(),
    zstdRunner(),
    erasureRunner(),
    ...learnedRunners(),
    polynomialRunner(),
  ];
}
