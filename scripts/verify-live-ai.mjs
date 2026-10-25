// Verify the LIVE site's AI renditions by recomputation — no browser, no trust.
//
//   node scripts/verify-live-ai.mjs [base-url]
//
// For each AI claim the published mirror carries, this fetches the claim, the
// challenge spec, and the rendition blob, then:
//   1. re-derives the raster from the commitment (model+seed for generative,
//      reference+reconstruction for bounded) and compares it to the committed
//      raster digest;
//   2. decodes the published PNG and checks its pixels hash to the same digest,
//      so the picture that is actually served is the picture the claim covers;
//   3. checks the blob bytes hash to the committed blob digest.
// Any mismatch exits non-zero with the failing step named.

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const base = (process.argv[2] ?? "https://999svs999.github.io/RAREXT-protocol/mirror").replace(/\/$/, "");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function getBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Minimal PNG reader: 8-bit truecolour RGB, filter 0 rows (what the encoder writes). */
function decodePngRaster(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47) throw new Error("not a PNG");

  let width = 0;
  let height = 0;
  const idat = [];
  let offset = 8;

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      if (depth !== 8 || colorType !== 2) throw new Error(`unsupported PNG: depth ${depth}, colour ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const raster = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    if (filter !== 0) throw new Error(`unsupported PNG filter ${filter} on row ${y}`);
    raw.copy(raster, y * stride, y * (1 + stride) + 1, y * (1 + stride) + 1 + stride);
  }
  return { width, height, raster };
}

const core = await import(new URL("../packages/core/src/index.ts", import.meta.url).href);

const bundle = await getJson(`${base}/bundle.json`);
const blobs = (await getJson(`${base}/blobs.json`)).blobs ?? [];
const challengeSpec = Object.fromEntries((bundle.challenges ?? []).map((c) => [c.id, c.spec ?? {}]));
const byHash = new Map(blobs.map((b) => [b.hash, b]));

let checked = 0;
let failed = 0;

for (const publication of bundle.publications ?? []) {
  const body = publication.artifact?.body;
  const media = body?.media;
  const representation = publication.attestation?.representation;
  if (!media?.blob) continue;

  const label = `${representation} · ${publication.id.slice(0, 8)}`;
  const fail = (step, detail) => {
    failed += 1;
    console.log(`  ✖ ${label} — ${step}: ${detail}`);
  };

  try {
    const entry = byHash.get(media.blob);
    if (!entry) throw new Error(`rendition blob ${media.blob.slice(0, 16)}… is not in the published mirror`);

    const blobBytes = Buffer.from(entry.content, "base64");
    if (sha256(blobBytes) !== media.blob) fail("blob digest", "published bytes do not hash to the committed blob");

    const { width, height, raster } = decodePngRaster(blobBytes);
    const servedRaster = sha256(raster);
    if (servedRaster !== media.raster) fail("served pixels", `${servedRaster.slice(0, 16)}… ≠ committed ${media.raster.slice(0, 16)}…`);

    // Re-derive from the commitment, not from the file.
    let derived = null;
    if (representation === "generative") {
      const out = core.renderRaster(body.model, body.seed, media.size);
      derived = sha256(out);
      if (width !== media.size || height !== media.size) fail("geometry", `${width}x${height} ≠ ${media.size}²`);
    } else if (representation === "bounded") {
      const spec = challengeSpec[publication.challengeId];
      const out = core.renderBoundedRaster(spec.reference, body.values, media.width, media.height);
      derived = sha256(out);
      if (width !== media.width || height !== media.height) fail("geometry", `${width}x${height} ≠ ${media.width}x${media.height}`);
    }

    if (derived === null) {
      console.log(`  · ${label} — representation not locally derivable here (skipped)`);
      continue;
    }
    if (derived !== media.raster) fail("re-derivation", `${derived.slice(0, 16)}… ≠ committed ${media.raster.slice(0, 16)}…`);

    if (!failed) {
      console.log(`  ✔ ${label} — raster re-derived from the commitment, served pixels match, blob digest matches`);
      checked += 1;
    }
  } catch (error) {
    fail("fetch/decode", error instanceof Error ? error.message : String(error));
  }
}

console.log(
  `\n${checked} rendition(s) verified by recomputation against ${base}` +
    (failed ? ` — ${failed} FAILURE(S)` : ""),
);
process.exit(failed === 0 && checked > 0 ? 0 : 1);
