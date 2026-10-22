// The fixed corpus for the storage benchmark.
//
// The default corpus is generated from a committed seed and a committed lock
// file. It is public (this file and the lock are the whole recipe), fixed
// (regenerate it anywhere and the SHA-256s match), and needs no network. Pass
// --corpus <dir> to measure a downloaded public corpus instead.
//
// Slices: one short raw video (yuv444p, so AV1 lossless is possible), three
// photos (PPM), stereo PCM audio, text, generated source, and a PLY point cloud.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const CORPUS_VERSION = 1;
export const LOCK_PATH = new URL("./corpus.lock.json", import.meta.url).pathname;
export const DEFAULT_CORPUS_DIR = new URL("./.corpus", import.meta.url).pathname;

const VIDEO = { width: 480, height: 270, frames: 180, fps: 30 };
const PHOTOS = { count: 4, width: 2048, height: 1536 };
const AUDIO = { seconds: 30, rate: 48000, channels: 2 };
const TEXT_BYTES = 9 * 1024 * 1024;
const SOURCE_BYTES = 10 * 1024 * 1024;
const SCAN_POINTS = 300_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rng(seed) {
  let state = seed >>> 0 || 1;

  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function noiseTable(seed = 0x9e3779b9) {
  const next = rng(seed);
  const table = new Uint8Array(1 << 16);

  for (let index = 0; index < table.length; index += 1) table[index] = Math.floor(next() * 256);

  return table;
}

export function videoFrameCount(scale = 1) {
  return Math.max(6, Math.round(VIDEO.frames * scale));
}

function generateVideo(scale) {
  const frames = videoFrameCount(scale);
  const { width, height, fps } = VIDEO;
  const noise = noiseTable(0x51ed270b);
  const header = Buffer.from(
    `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420 XYSCSS=420\n`,
    "ascii",
  );
  const luma = width * height;
  const chromaWidth = width >> 1;
  const chromaHeight = height >> 1;
  const chroma = chromaWidth * chromaHeight;
  const frameSize = luma + chroma * 2;
  const out = Buffer.alloc(header.length + frames * (6 + frameSize));
  let offset = header.copy(out, 0);

  for (let frame = 0; frame < frames; frame += 1) {
    offset += Buffer.from("FRAME\n", "ascii").copy(out, offset);
    const base = offset;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        const texture = noise[(pixel * 31 + frame * 977) & 0xffff];
        const wave = Math.sin((x + frame * 3) / 23) * 18 + Math.cos((y - frame * 2) / 17) * 14;

        out[base + pixel] = (x * 0.35 + y * 0.55 + frame * 1.7 + wave + (texture & 0x1f)) & 0xff;
      }
    }

    for (let y = 0; y < chromaHeight; y += 1) {
      for (let x = 0; x < chromaWidth; x += 1) {
        const pixel = y * chromaWidth + x;
        const texture = noise[(pixel * 53 + frame * 389) & 0xffff];
        const U = (128 + Math.sin((x - y) / 31) * 40 + (texture & 0x0f) - 8) & 0xff;
        const V = (128 + Math.cos((x + y + frame * 5) / 27) * 42 + (texture >> 4) - 8) & 0xff;

        out[base + luma + pixel] = U;
        out[base + luma + chroma + pixel] = V;
      }
    }

    offset += frameSize;
  }

  return out.subarray(0, offset);
}

function generatePhoto(seed, scale = 1) {
  const width = Math.max(64, Math.round(PHOTOS.width * Math.sqrt(scale)));
  const height = Math.max(48, Math.round(PHOTOS.height * Math.sqrt(scale)));
  const next = rng(seed);
  const noise = noiseTable(seed);
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  const pixels = Buffer.alloc(width * height * 3);
  const cx = width * (0.3 + next() * 0.4);
  const cy = height * (0.3 + next() * 0.4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const distance = Math.hypot(x - cx, y - cy);
      const rings = Math.sin(distance / (18 + seed % 11)) * 36;
      const sky = Math.sin((x + y) / 190) * 22;
      const texture = noise[(x * 17 + y * 101) & 0xffff];
      const r = (x / width) * 150 + rings + sky + (texture & 0x1f);
      const g = (y / height) * 130 + rings * 0.7 + sky + ((texture >> 2) & 0x1f);
      const b = 90 + Math.sin(distance / 60) * 50 + (texture & 0x0f);

      pixels[index] = Math.max(0, Math.min(255, r)) & 0xff;
      pixels[index + 1] = Math.max(0, Math.min(255, g)) & 0xff;
      pixels[index + 2] = Math.max(0, Math.min(255, b)) & 0xff;
    }
  }

  return Buffer.concat([header, pixels]);
}

function generateAudio(scale) {
  const { seconds, rate, channels } = AUDIO;
  const frames = Math.max(rate, Math.round(rate * seconds * scale));
  const next = rng(0x2545f491);
  const data = Buffer.alloc(frames * channels * 2);
  let offset = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / rate;
    const sweep = 220 + 110 * Math.sin(time * 0.8);
    const carrier =
      Math.sin(2 * Math.PI * sweep * time) * 0.42 +
      Math.sin(2 * Math.PI * sweep * 2.01 * time) * 0.16 +
      Math.sin(2 * Math.PI * 60 * time) * 0.08;
    const left = Math.max(-1, Math.min(1, carrier + (next() - 0.5) * 0.02));
    const right = Math.max(-1, Math.min(1, carrier * 0.92 + (next() - 0.5) * 0.02));

    data.writeInt16LE(Math.round(left * 32767), offset);
    data.writeInt16LE(Math.round(right * 32767), offset + 2);
    offset += 4;
  }

  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

const WORDS = [
  "storage", "verification", "holder", "shard", "claim", "artifact", "registry",
  "semantic", "digest", "replica", "challenge", "repair", "anchor", "identity",
  "agent", "corpus", "representation", "exact", "bounded", "generative", "network",
  "durable", "placement", "witness", "commitment", "evidence", "protocol", "reader",
  "key", "signature", "mirror", "availability", "sample", "coordinate", "erasure",
];

function generateText(scale) {
  const next = rng(0x1234abcd);
  const target = Math.max(16_384, Math.round(TEXT_BYTES * scale));
  const lines = [];
  let bytes = 0;

  while (bytes < target) {
    const words = [];

    for (let index = 0; index < 12 + Math.floor(next() * 10); index += 1) {
      words.push(WORDS[Math.floor(next() * WORDS.length)]);
    }

    const line = `${words.join(" ")} ${next() > 0.7 ? `(${Math.floor(next() * 1e6)})` : ""}\n`;

    lines.push(line);
    bytes += Buffer.byteLength(line);
  }

  return Buffer.from(lines.join(""), "utf8");
}

function generateSource(scale) {
  const next = rng(0xdeadbeef);
  const target = Math.max(16_384, Math.round(SOURCE_BYTES * scale));
  const chunks = ['// Generated source slice for the storage benchmark.\n\n'];
  let bytes = chunks[0].length;

  for (let index = 0; bytes < target; index += 1) {
    const constant = Math.floor(next() * 10000);
    const chunk = `export function step${index}(value) {\n  const scaled = value * ${constant};\n  return scaled % ${37 + (index % 11)} === 0 ? scaled : scaled + ${index};\n}\n\n`;

    chunks.push(chunk);
    bytes += chunk.length;
  }

  return Buffer.from(chunks.join(""), "utf8");
}

function generateScan(scale) {
  const points = Math.max(4096, Math.round(SCAN_POINTS * scale));
  const next = rng(0x0badf00d);
  const chunks = [
    "ply\nformat ascii 1.0\ncomment procedural terrain\nelement vertex " + points +
      "\nproperty float x\nproperty float y\nproperty float z\nend_header\n",
  ];
  let bytes = chunks[0].length;

  for (let index = 0; index < points; index += 1) {
    const x = (index % 1000) * 0.37 + (next() - 0.5) * 0.02;
    const y = Math.floor(index / 1000) * 0.41 + (next() - 0.5) * 0.02;
    const z = Math.sin(x * 1.7) * Math.cos(y * 1.3) * 3 + (next() - 0.5) * 0.01;
    const line = `${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}\n`;

    chunks.push(line);
    bytes += line.length;
  }

  return Buffer.from(chunks.join(""), "utf8");
}

function writeSlice(root, slice, bytes) {
  const path = join(root, slice.path);

  mkdirSync(join(root, slice.path.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(path, bytes);

  return {
    name: slice.name,
    path: slice.path,
    modality: slice.modality,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

export function generateCorpus(root, { scale = 1 } = {}) {
  mkdirSync(root, { recursive: true });

  const slices = [];

  slices.push(
    writeSlice(root, { name: "video", path: "video.y4m", modality: "video" }, generateVideo(scale)),
  );
  slices.push(
    writeSlice(root, { name: "audio", path: "audio.wav", modality: "audio" }, generateAudio(scale)),
  );
  slices.push(
    writeSlice(root, { name: "text", path: "text.txt", modality: "text" }, generateText(scale)),
  );
  slices.push(
    writeSlice(root, { name: "source", path: "source.js", modality: "code" }, generateSource(scale)),
  );
  slices.push(
    writeSlice(root, { name: "scan", path: "scan.ply", modality: "3d" }, generateScan(scale)),
  );

  for (let index = 0; index < PHOTOS.count; index += 1) {
    slices.push(
      writeSlice(
        root,
        { name: `photo-${index + 1}`, path: `photos/photo-${index + 1}.ppm`, modality: "photo" },
        generatePhoto(0x1000 + index * 7919, scale),
      ),
    );
  }

  slices.sort((left, right) => left.path.localeCompare(right.path));

  return manifestFor(slices, scale);
}

function manifestFor(slices, scale) {
  const totalBytes = slices.reduce((total, slice) => total + slice.bytes, 0);
  const digest = sha256(JSON.stringify(slices.map((slice) => ({ path: slice.path, sha256: slice.sha256, bytes: slice.bytes }))));

  return {
    version: CORPUS_VERSION,
    generator: "rarext-storage-bench",
    scale,
    slices,
    totalBytes,
    digest,
  };
}

function walk(root, current, slices) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const path = relative(root, full).split(sep).join("/");

    if (entry.isDirectory()) {
      walk(root, full, slices);
      continue;
    }

    if (!entry.isFile() || path === "manifest.json") continue;

    const bytes = readFileSync(full);

    slices.push({
      name: path,
      path,
      modality: path.split(".").pop() ?? "unknown",
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
}

export function manifestForDirectory(root) {
  const slices = [];

  walk(root, root, slices);
  slices.sort((left, right) => left.path.localeCompare(right.path));

  return manifestFor(slices, 1);
}

export function readLock(lockPath = LOCK_PATH) {
  if (!existsSync(lockPath)) return null;

  return JSON.parse(readFileSync(lockPath, "utf8"));
}

export function assertMatchesLock(manifest, lock) {
  if (!lock) return;

  const expected = new Map(lock.slices.map((slice) => [slice.path, slice.sha256]));

  for (const slice of manifest.slices) {
    if (expected.get(slice.path) !== slice.sha256) {
      throw new Error(
        `corpus slice ${slice.path} does not match corpus.lock.json; regenerate with --update-lock only if the corpus change is intended`,
      );
    }
  }

  if (manifest.slices.length !== lock.slices.length) {
    throw new Error("corpus has a different slice count than corpus.lock.json");
  }
}

export function writeLock(manifest, lockPath = LOCK_PATH) {
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        version: CORPUS_VERSION,
        slices: manifest.slices.map((slice) => ({
          path: slice.path,
          bytes: slice.bytes,
          sha256: slice.sha256,
        })),
        totalBytes: manifest.totalBytes,
      },
      null,
      2,
    )}\n`,
  );
}

export function ensureCorpus({ root = DEFAULT_CORPUS_DIR, scale = 1, lockPath = LOCK_PATH, updateLock = false, external = null } = {}) {
  if (external) {
    const manifest = manifestForDirectory(external);

    if (manifest.slices.length === 0) throw new Error(`no files in corpus directory ${external}`);

    return { root: external, manifest };
  }

  const manifestPath = join(root, "manifest.json");
  let manifest = null;

  if (existsSync(manifestPath) && scale === 1) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
  }

  if (!manifest) {
    manifest = generateCorpus(root, { scale });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  if (updateLock && scale === 1) writeLock(manifest, lockPath);
  if (scale === 1) assertMatchesLock(manifest, readLock(lockPath));

  return { root, manifest };
}

export function fileDigests(root, manifest) {
  return manifest.slices.map((slice) => ({
    ...slice,
    digest: sha256(readFileSync(join(root, slice.path))),
  }));
}

export function readSlice(root, manifest, path) {
  return readFileSync(join(root, manifest.slices.find((slice) => slice.path === path).path));
}

export function sliceByModality(manifest, modality) {
  return manifest.slices.find((slice) => slice.modality === modality) ?? null;
}

export function corpusStats(manifest) {
  const byModality = {};

  for (const slice of manifest.slices) {
    byModality[slice.modality] = (byModality[slice.modality] ?? 0) + slice.bytes;
  }

  return {
    totalBytes: manifest.totalBytes,
    slices: manifest.slices.length,
    byModality,
  };
}

export { sha256 };
