// packages/core/src/canonical.ts
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value;
  const keys = Object.keys(record).filter((key) => record[key] !== void 0).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

// packages/core/src/ai.ts
var MAX_VOCAB = 4096;
var MAX_GENERATIVE_TOKEN_LENGTH = 256;
var MAX_GENERATIVE_OUTPUT_LENGTH = 1 << 20;
function isXorshiftModel(value) {
  if (typeof value !== "object" || value === null) return false;
  const model = value;
  if (model.kind !== "xorshift32") return false;
  const params = model.params;
  if (!params) return false;
  return Number.isInteger(params.a) && params.a >= 1 && params.a <= 31 && Number.isInteger(params.b) && params.b >= 1 && params.b <= 31 && Number.isInteger(params.c) && params.c >= 1 && params.c <= 31 && Array.isArray(model.vocab) && model.vocab.length >= 1 && model.vocab.length <= MAX_VOCAB && model.vocab.every(
    (token) => typeof token === "string" && token.length > 0 && token.length <= MAX_GENERATIVE_TOKEN_LENGTH
  );
}
var MAX_BOUNDED_LENGTH = 1 << 20;
var RASTER_RULE = "xorshift32-image-v1";
var MAX_RASTER_SIZE = 512;
function renderRaster(model, seed, size) {
  if (!isXorshiftModel(model)) throw new Error("renderRaster: malformed model");
  if (!Number.isInteger(size) || size < 1 || size > MAX_RASTER_SIZE) {
    throw new Error(`renderRaster: size must be 1..${MAX_RASTER_SIZE}`);
  }
  const { a, b, c } = model.params;
  let state = seed >>> 0;
  const out = new Uint8Array(size * size * 3);
  for (let i = 0; i < out.length; i++) {
    state ^= state << a >>> 0;
    state ^= state >>> b;
    state ^= state << c >>> 0;
    state >>>= 0;
    out[i] = state & 255;
  }
  return out;
}
var BOUNDED_RASTER_RULE = "bounded-strip-v1";
var BOUNDED_RASTER_SCALE = 16;
var BOUNDED_RASTER_LANE = 48;
var BOUNDED_RASTER_GUTTER = 4;
var BOUNDED_RASTER_GAIN = 32;
var MAX_BOUNDED_RASTER_WIDTH = 4096;
var BOUNDED_RASTER_HEIGHT = 3 * BOUNDED_RASTER_LANE + 2 * BOUNDED_RASTER_GUTTER;
function renderBoundedRaster(reference, reconstruction, width, height = BOUNDED_RASTER_HEIGHT) {
  if (!Array.isArray(reference) || reference.length < 1) {
    throw new Error("renderBoundedRaster: reference must be a non-empty array");
  }
  if (!Array.isArray(reconstruction) || reconstruction.length !== reference.length) {
    throw new Error("renderBoundedRaster: reconstruction must match the reference length");
  }
  if (reference.length > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: at most ${MAX_BOUNDED_RASTER_WIDTH} values`);
  }
  const w = width ?? reference.length * BOUNDED_RASTER_SCALE;
  if (!Number.isInteger(w) || w < 1 || w > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: width must be 1..${MAX_BOUNDED_RASTER_WIDTH}`);
  }
  if (!Number.isInteger(height) || height < 1 || height > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: height must be 1..${MAX_BOUNDED_RASTER_WIDTH}`);
  }
  const raster = new Uint8Array(w * height * 3);
  const lane = BOUNDED_RASTER_LANE;
  const gutter = BOUNDED_RASTER_GUTTER;
  const laneStarts = [0, lane + gutter, 2 * (lane + gutter)];
  for (let x = 0; x < w; x++) {
    const index = Math.min(
      reference.length - 1,
      Math.floor(x * reference.length / w)
    );
    const grey = clampByte(reference[index]);
    const reconstructionGrey = clampByte(reconstruction[index]);
    const error = clampByte(Math.abs(reference[index] - reconstruction[index]) * BOUNDED_RASTER_GAIN);
    for (let y = 0; y < height; y++) {
      const offset = (y * w + x) * 3;
      let r = 0;
      let g = 0;
      let b = 0;
      if (y < lane) {
        r = g = b = grey;
      } else if (y < lane + gutter) {
      } else if (y < laneStarts[1] + lane) {
        r = g = b = reconstructionGrey;
      } else if (y < laneStarts[1] + lane + gutter) {
      } else if (y < laneStarts[2] + lane) {
        r = error;
      }
      raster[offset] = r;
      raster[offset + 1] = g;
      raster[offset + 2] = b;
    }
  }
  return raster;
}
function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

// packages/core/src/semantics.ts
var SEMANTICS_APP = "rarext-semantics";
var SEMANTICS_COMMITMENT_KIND = "semantics-commitment";
function parseSemanticsCommitmentArtifact(artifact) {
  if (artifact.app !== SEMANTICS_APP || artifact.kind !== SEMANTICS_COMMITMENT_KIND) return null;
  if (typeof artifact.body !== "string") return null;
  try {
    const parsed = JSON.parse(artifact.body);
    if (typeof parsed.digests !== "object" || parsed.digests === null) return null;
    const digests = {};
    for (const [key, value] of Object.entries(parsed.digests)) {
      if (typeof value !== "string") return null;
      digests[key] = value;
    }
    return { digests };
  } catch {
    return null;
  }
}
function semanticsKey(record) {
  return `${record.id}@${record.version}`;
}
function semanticsCommitmentHolds(commitment, records, digestOf) {
  const missing = [];
  let matched = 0;
  for (const record of records) {
    const key = semanticsKey(record);
    if (commitment.digests[key] === digestOf(record)) matched += 1;
    else missing.push(key);
  }
  return { committed: Object.keys(commitment.digests).length, matched, missing };
}
function bundleSemanticsCommitment(bundle) {
  for (const publication of bundle.publications ?? []) {
    const parsed = parseSemanticsCommitmentArtifact(publication?.artifact ?? {});
    if (parsed) return parsed;
  }
  return null;
}

// apps/web/src/ai.ts
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function renderProofPicture(body, size) {
  if (body.media?.rule && body.media.rule !== RASTER_RULE) {
    throw new Error(`renderProofPicture: this page does not implement the rendition rule ${String(body.media.rule)}`);
  }
  return renderRaster(body.model, body.seed, size);
}
function renderBoundedPicture(reference, values, size = {}) {
  if (size.rule && size.rule !== BOUNDED_RASTER_RULE) {
    throw new Error(`renderBoundedPicture: this page does not implement the rendition rule ${size.rule}`);
  }
  return renderBoundedRaster(reference, values, size.width, size.height ?? BOUNDED_RASTER_HEIGHT);
}
async function verifyPublishedRendition(input) {
  const media = input.body?.media;
  const recorded = typeof media?.raster === "string" ? media.raster : "";
  if (!recorded) return { recorded: "", derived: null, matches: false, reason: "the artifact records no raster" };
  try {
    let raster;
    if (media.rule === RASTER_RULE) {
      if (!input.body?.model || typeof input.body.seed !== "number" || typeof media.size !== "number") {
        return { recorded, derived: null, matches: false, reason: "the artifact does not carry a usable model, seed and size" };
      }
      raster = renderRaster(input.body.model, input.body.seed, media.size);
    } else if (media.rule === BOUNDED_RASTER_RULE) {
      const reference = input.challenge?.spec?.reference;
      if (!Array.isArray(reference) || !Array.isArray(input.body?.values)) {
        return { recorded, derived: null, matches: false, reason: "the artifact's challenge does not carry the committed reference" };
      }
      raster = renderBoundedRaster(
        reference,
        input.body.values,
        media.width,
        media.height ?? BOUNDED_RASTER_HEIGHT
      );
    } else {
      return { recorded, derived: null, matches: false, reason: `this page does not implement the rule ${String(media.rule)}` };
    }
    const derived = await sha256Bytes(raster);
    return { recorded, derived, matches: derived === recorded };
  } catch (error) {
    return {
      recorded,
      derived: null,
      matches: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
async function semanticsCommitmentHolds2(bundle, sha256) {
  const commitment = bundleSemanticsCommitment(bundle);
  if (!commitment) return null;
  const records = bundle.semantics ?? [];
  const digests = {};
  for (const record of records) {
    digests[semanticsKey(record)] = await semanticsRecordDigestAsync(record, sha256);
  }
  return semanticsCommitmentHolds(commitment, records, (record) => digests[semanticsKey(record)]);
}
async function semanticsRecordDigestAsync(record, sha256) {
  return await sha256(canonicalize(record));
}
export {
  renderBoundedPicture,
  renderProofPicture,
  semanticsCommitmentHolds2 as semanticsCommitmentHolds,
  sha256Bytes,
  sha256Hex,
  verifyPublishedRendition
};
//# sourceMappingURL=renditions.js.map
