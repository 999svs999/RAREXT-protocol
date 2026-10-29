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
var MAX_GENERATIVE_STEPS = 1e5;
var MAX_VOCAB = 4096;
var MAX_GENERATIVE_TOKEN_LENGTH = 256;
var MAX_GENERATIVE_OUTPUT_LENGTH = 1 << 20;
function replayOutputBound(model, steps) {
  let longest = 0;
  for (const token of model.vocab) {
    if (token.length > longest) longest = token.length;
  }
  return longest * steps;
}
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
function isGenerativeBody(value) {
  if (typeof value !== "object" || value === null) return false;
  const body = value;
  return isXorshiftModel(body.model) && Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 4294967295 && typeof body.output === "string" && body.output.length <= MAX_GENERATIVE_OUTPUT_LENGTH;
}
function isGenerativeSpec(value) {
  if (typeof value !== "object" || value === null) return false;
  const spec = value;
  return Number.isInteger(spec.steps) && spec.steps >= 1 && spec.steps <= MAX_GENERATIVE_STEPS;
}
function generate(model, seed, steps) {
  const { a, b, c } = model.params;
  let state = seed >>> 0;
  let out = "";
  for (let i = 0; i < steps; i++) {
    state ^= state << a >>> 0;
    state ^= state >>> b;
    state ^= state << c >>> 0;
    state >>>= 0;
    out += model.vocab[state % model.vocab.length];
  }
  return out;
}
function verifyGenerativeReplay(body, spec) {
  if (!isGenerativeBody(body) || !isGenerativeSpec(spec)) {
    return { correct: false, expected: "" };
  }
  if (replayOutputBound(body.model, spec.steps) > MAX_GENERATIVE_OUTPUT_LENGTH) {
    return { correct: false, expected: "" };
  }
  const expected = generate(body.model, body.seed, spec.steps);
  return { correct: expected === body.output, expected };
}
var MAX_BOUNDED_LENGTH = 1 << 20;
function maxAbsError(values, reference) {
  let max = 0;
  for (let i = 0; i < reference.length; i++) {
    const err = Math.abs(values[i] - reference[i]);
    if (err > max) max = err;
  }
  return max;
}
function meanAbsError(values, reference) {
  let sum = 0;
  for (let i = 0; i < reference.length; i++) {
    sum += Math.abs(values[i] - reference[i]);
  }
  return sum / reference.length;
}
function computeBoundedMetric(metric, values, reference) {
  return metric === "maxAbsError" ? maxAbsError(values, reference) : meanAbsError(values, reference);
}
function verifyBoundedReconstruction(body, spec) {
  if (body.values.length !== spec.reference.length) {
    return {
      error: `reconstruction length ${body.values.length} does not match reference length ${spec.reference.length}`
    };
  }
  const metricValue = computeBoundedMetric(spec.metric, body.values, spec.reference);
  return { correct: metricValue <= spec.bound, metricValue };
}
function boundedScore(metricValue, bound) {
  if (!(metricValue <= bound)) return 0;
  if (bound === 0) return metricValue === 0 ? 100 : 0;
  const ratio = metricValue / bound;
  return Math.max(1, Math.round(100 * (1 - ratio)));
}
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

// apps/web/src/ai.ts
var STARTER_MODEL = {
  kind: "xorshift32",
  params: { a: 13, b: 17, c: 5 },
  vocab: ["alpha", "beta", "gamma", "delta"]
};
var STARTER_SEED = 42;
var STARTER_STEPS = 32;
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function runCommittedModel(model, seed, steps = STARTER_STEPS) {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new Error("steps must be a non-negative integer");
  }
  if (steps > MAX_GENERATIVE_STEPS) {
    throw new Error(`steps must not exceed ${MAX_GENERATIVE_STEPS}`);
  }
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new Error("seed must be a finite number");
  }
  const output = generate(model, seed, steps);
  const body = { model, seed, output };
  const replay = verifyGenerativeReplay(body, { steps });
  const modelDigest = await sha256Hex(canonicalize(model));
  const trace = { modelDigest, seed, steps, expected: replay.expected };
  const artifact = {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body
  };
  return {
    output,
    proof: {
      body,
      steps,
      modelDigest,
      traceHash: await sha256Hex(canonicalize(trace)),
      artifactHash: await sha256Hex(canonicalize(artifact)),
      correct: replay.correct
    }
  };
}
function checkClaim(model, seed, output, steps) {
  return verifyGenerativeReplay({ model, seed, output }, { steps });
}
async function runBoundedProof(reference, values, metric, bound) {
  if (!Array.isArray(values) || !values.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error("values must be an array of finite numbers");
  }
  if (values.length > MAX_BOUNDED_LENGTH) {
    throw new Error(`values must not exceed ${MAX_BOUNDED_LENGTH} entries`);
  }
  if (typeof bound !== "number" || !Number.isFinite(bound)) {
    throw new Error("bound must be a finite number");
  }
  const body = { values };
  const spec = { metric, bound, reference };
  const check = verifyBoundedReconstruction(body, spec);
  if ("error" in check) {
    throw new Error(check.error);
  }
  const referenceDigest = await sha256Hex(canonicalize(reference));
  const reconstructionDigest = await sha256Hex(canonicalize(values));
  const trace = {
    metric,
    metricValue: check.metricValue,
    bound,
    referenceDigest,
    reconstructionDigest
  };
  const artifact = {
    app: "ai-bounded",
    kind: "ai.bounded",
    version: 1,
    mediaType: "application/json",
    body
  };
  return {
    body,
    metric,
    metricValue: check.metricValue,
    bound,
    correct: check.correct,
    score: check.correct ? boundedScore(check.metricValue, bound) : 0,
    referenceDigest,
    reconstructionDigest,
    traceHash: await sha256Hex(canonicalize(trace)),
    artifactHash: await sha256Hex(canonicalize(artifact))
  };
}
function checkBoundedClaim(reference, values, metric, bound) {
  const check = verifyBoundedReconstruction({ values }, { metric, bound, reference });
  return "error" in check ? { correct: false, error: check.error } : { correct: check.correct, metricValue: check.metricValue };
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

// apps/web/src/ai-page.ts
var $ = (id) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found;
};
var seedInput = $("seed");
var stepsInput = $("steps");
var outputPre = $("output");
var evidencePre = $("evidence");
var verdict = $("verdict");
var claimInput = $("claim");
var checkResult = $("check-result");
seedInput.value = String(STARTER_SEED);
stepsInput.value = String(STARTER_STEPS);
async function run() {
  const seed = Number(seedInput.value);
  const steps = Number(stepsInput.value);
  try {
    const started = performance.now();
    const { output, proof } = await runCommittedModel(STARTER_MODEL, seed, steps);
    const took = Math.round(performance.now() - started);
    outputPre.textContent = output;
    const rasterBytes = renderProofPicture(proof.body, RENDITION_SIZE);
    drawRaster(picture, rasterBytes, RENDITION_SIZE, RENDITION_SIZE);
    lastRasterDigest = await sha256Bytes(rasterBytes);
    refreshPictureNote();
    evidencePre.textContent = JSON.stringify(
      {
        artifact: { app: "ai-generative", kind: "ai.generative", version: 1, mediaType: "application/json", body: proof.body },
        steps: proof.steps,
        modelDigest: proof.modelDigest,
        traceHash: proof.traceHash,
        artifactHash: proof.artifactHash,
        // The page's own measurement of the picture it drew: these bytes, this size.
        // It is NOT the artifact's media (this run has no PNG), and the note below
        // refers to this field rather than to a media block that is not there.
        rendition: { size: RENDITION_SIZE, raster: lastRasterDigest },
        correct: proof.correct
      },
      null,
      2
    );
    verdict.textContent = proof.correct ? `Ran here in ${took} ms. The replay agrees \u2014 this output is the committed model's, and anyone can recompute it.` : `Ran here in ${took} ms, and the replay DISAGREES with the run. That is a bug worth reporting.`;
    checkResult.textContent = "";
  } catch (error) {
    outputPre.textContent = "";
    evidencePre.textContent = "";
    verdict.textContent = error instanceof Error ? error.message : String(error);
  }
}
$("run").addEventListener("click", () => void run());
$("check").addEventListener("click", () => {
  const claimed = claimInput.value.trim();
  if (!claimed) {
    checkResult.textContent = "Paste a claimed output to check.";
    return;
  }
  const result = checkClaim(STARTER_MODEL, Number(seedInput.value), claimed, Number(stepsInput.value));
  checkResult.textContent = result.correct ? "MATCHES the committed model. The claim is true by recomputation \u2014 no signature needed to know the model produced it." : `DOES NOT MATCH. The committed model produces ${result.expected.length} tokens that differ from this claim.`;
});
void run();
async function loadBoundedFixture() {
  try {
    const response = await fetch("./bundle.json", { cache: "no-cache" });
    if (!response.ok) return null;
    const bundle = await response.json();
    const published = bundle.publications?.find((entry) => entry.app === "ai-bounded");
    const challenge = bundle.challenges?.find((entry) => entry.id === published?.challengeId);
    const spec = challenge?.spec;
    const generative = bundle.publications?.find((entry) => entry.app === "ai-generative");
    const genMedia = generative?.artifact?.body?.media ?? {};
    publishedRendition = genMedia.raster ? { raster: genMedia.raster, size: genMedia.size } : null;
    refreshPictureNote();
    if (!spec?.reference || !spec.metric || typeof spec.bound !== "number") return null;
    const media = published?.artifact?.body?.media ?? {};
    return {
      published: { raster: genMedia.raster, size: genMedia.size },
      reference: spec.reference,
      metric: spec.metric,
      bound: spec.bound,
      rendition: { width: media.width, height: media.height, rule: media.rule }
    };
  } catch {
    return null;
  }
}
function drawRaster(canvas, raster, width, height) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = context.createImageData(width, height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    image.data[pixel * 4] = raster[pixel * 3] ?? 0;
    image.data[pixel * 4 + 1] = raster[pixel * 3 + 1] ?? 0;
    image.data[pixel * 4 + 2] = raster[pixel * 3 + 2] ?? 0;
    image.data[pixel * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}
var picture = $("picture");
var pictureNote = $("picture-note");
var RENDITION_SIZE = 64;
var lastRasterDigest = null;
var publishedRendition = null;
function refreshPictureNote() {
  if (lastRasterDigest === null) return;
  const published = publishedRendition;
  if (published?.raster && published.size === RENDITION_SIZE) {
    pictureNote.textContent = published.raster === lastRasterDigest ? "This is the PUBLISHED raster \u2014 the rendition.raster digest in the evidence below is these exact bytes." : "This run's picture. Its digest differs from the published raster because the seed differs; the picture is still a function of the seed, not beside it.";
    return;
  }
  pictureNote.textContent = "This run's picture, re-derived from the model and seed above \u2014 the rendition.raster digest in the evidence below is these bytes.";
}
var boundedPicture = $("bounded-picture");
var boundedInput = $("reconstruction");
var boundedResult = $("bounded-result");
var boundedEvidence = $("bounded-evidence");
var boundedFixture = await loadBoundedFixture();
if (!boundedFixture) {
  boundedResult.textContent = "This page is not beside a mirror bundle, so there is no committed reference to measure against. Open it from the published mirror.";
} else {
  boundedResult.textContent = `Committed reference loaded from the bundle beside this page: ${boundedFixture.reference.length} values, ${boundedFixture.metric} within ${boundedFixture.bound}.`;
  boundedInput.placeholder = `e.g. ${boundedFixture.reference.slice(0, 4).join(", ")}, \u2026`;
}
$("check-bounded").addEventListener("click", () => {
  if (!boundedFixture) return;
  const parsed = boundedInput.value.split(/[\s,]+/).filter((token) => token.length > 0).map(Number);
  if (parsed.length === 0 || parsed.some((value) => !Number.isFinite(value))) {
    boundedResult.textContent = "Paste numbers (comma or space separated) to measure.";
    return;
  }
  try {
    const claim = checkBoundedClaim(boundedFixture.reference, parsed, boundedFixture.metric, boundedFixture.bound);
    if (claim.error) {
      boundedResult.textContent = claim.error;
      boundedEvidence.textContent = "";
      boundedPicture.width = 0;
      return;
    }
    boundedResult.textContent = claim.correct ? `WITHIN the bound: ${boundedFixture.metric} = ${claim.metricValue} (bound ${boundedFixture.bound}). The claim is true by recomputation.` : `OUTSIDE the bound: ${boundedFixture.metric} = ${claim.metricValue} (bound ${boundedFixture.bound}). The claim is false, and no signature can make it true.`;
    drawRaster(
      boundedPicture,
      renderBoundedPicture(boundedFixture.reference, parsed, boundedFixture.rendition),
      boundedFixture.rendition.width ?? boundedFixture.reference.length,
      boundedFixture.rendition.height ?? 152
    );
    void runBoundedProof(boundedFixture.reference, parsed, boundedFixture.metric, boundedFixture.bound).then((proof) => {
      boundedEvidence.textContent = JSON.stringify(proof, null, 2);
    });
  } catch (error) {
    boundedResult.textContent = error instanceof Error ? error.message : String(error);
  }
});
//# sourceMappingURL=ai.js.map
