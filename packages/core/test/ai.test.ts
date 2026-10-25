import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Challenge } from "../src/types.ts";
import {
  boundedScore,
  computeBoundedMetric,
  generate,
  isBoundedBody,
  isBoundedSpec,
  isGenerativeBody,
  isGenerativeSpec,
  maxAbsError,
  MAX_GENERATIVE_OUTPUT_LENGTH,
  MAX_GENERATIVE_TOKEN_LENGTH,
  meanAbsError,
  verifyAiArtifact,
  verifyBoundedReconstruction,
  verifyGenerativeReplay,
  BOUNDED_RASTER_GAIN,
  BOUNDED_RASTER_HEIGHT,
  BOUNDED_RASTER_RULE,
  BOUNDED_RASTER_SCALE,
  isBoundedMedia,
  isGenerativeMedia,
  RASTER_RULE,
  renderBoundedRaster,
  renderRaster,
} from "../src/ai.ts";

const model = {
  kind: "xorshift32" as const,
  params: { a: 13, b: 17, c: 5 },
  vocab: ["alpha", "beta", "gamma", "delta"],
};

const reference = [10, 20, 30, 40, 200, 255, 0, 128];

const boundedChallenge: Challenge = {
  id: "bounded-1",
  app: "ai-bounded",
  title: "t",
  description: "d",
  version: 1,
  spec: { metric: "maxAbsError", bound: 4, reference },
  semanticsId: "ai-bounded/bounded-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function boundedArtifact(values: number[]): Artifact {
  return {
    app: "ai-bounded",
    kind: "ai.bounded",
    version: 1,
    mediaType: "application/json",
    body: { values },
  };
}

test("core owns the generative replay math", () => {
  const output = generate(model, 42, 32);
  assert.equal(output, generate(model, 42, 32));
  assert.notEqual(output, generate(model, 43, 32));
  assert.equal(verifyGenerativeReplay({ model, seed: 42, output }, { steps: 32 }).correct, true);
  assert.equal(verifyGenerativeReplay({ model, seed: 42, output: output + "x" }, { steps: 32 }).correct, false);
  assert.equal(isGenerativeBody({ model, seed: 42, output }), true);
  assert.equal(isGenerativeSpec({ steps: 32 }), true);
  assert.equal(isGenerativeSpec({ steps: 0 }), false);
});

test("replay refuses oversized tokens and outputs before generating", () => {
  const longToken = "x".repeat(MAX_GENERATIVE_TOKEN_LENGTH + 1);
  assert.equal(
    isGenerativeBody({ model: { ...model, vocab: [longToken] }, seed: 42, output: "" }),
    false,
  );

  const output = generate(model, 42, 32);
  assert.equal(
    isGenerativeBody({
      model,
      seed: 42,
      output: "x".repeat(MAX_GENERATIVE_OUTPUT_LENGTH + 1),
    }),
    false,
  );

  // A model whose longest token multiplied by the step count exceeds the output
  // bound is refused without materializing the string.
  const wide = { ...model, vocab: ["x".repeat(MAX_GENERATIVE_TOKEN_LENGTH)] };
  const replay = verifyGenerativeReplay(
    { model: wide, seed: 42, output },
    { steps: MAX_GENERATIVE_OUTPUT_LENGTH / MAX_GENERATIVE_TOKEN_LENGTH + 1 },
  );
  assert.deepEqual(replay, { correct: false, expected: "" });
});

test("core owns the bounded metric math", () => {
  assert.equal(maxAbsError([11, 20, 28], [10, 20, 30]), 2);
  assert.equal(meanAbsError([11, 21], [10, 20]), 1);
  assert.equal(computeBoundedMetric("meanAbsError", [11, 21], [10, 20]), 1);
  assert.equal(boundedScore(0, 4), 100);
  assert.equal(boundedScore(4, 4), 1);
  assert.equal(boundedScore(5, 4), 0);

  const check = verifyBoundedReconstruction(
    { values: reference.map((v) => v + 2) },
    boundedChallenge.spec as Parameters<typeof verifyBoundedReconstruction>[1],
  );
  assert.ok(!("error" in check));
  assert.equal(check.correct, true);
  assert.equal(check.metricValue, 2);

  assert.equal(isBoundedBody({ values: [1, NaN] }), false);
  assert.equal(isBoundedSpec({ metric: "cosine", bound: 1, reference }), false);
});

test("verifyAiArtifact dispatches by kind and reports errors", () => {
  const good = verifyAiArtifact(boundedArtifact(reference.map((v) => v + 1)), boundedChallenge);
  assert.ok(!("error" in good));
  assert.equal(good.representation, "bounded");
  assert.equal(good.correct, true);
  assert.equal(good.metricValue, 1);
  assert.equal(good.bound, 4);

  const lengthError = verifyAiArtifact(boundedArtifact([1, 2, 3]), boundedChallenge);
  assert.ok("error" in lengthError);
  assert.match(lengthError.error, /does not match reference length/);

  const wrongKind = verifyAiArtifact(
    { ...boundedArtifact(reference), kind: "logic.netlist" },
    boundedChallenge,
  );
  assert.ok("error" in wrongKind);
  assert.match(wrongKind.error, /not a locally verifiable AI claim/);
});

test("renderRaster is a pure function of the commitment", () => {
  const model = { kind: "xorshift32" as const, params: { a: 13, b: 17, c: 5 }, vocab: ["alpha"] };
  const first = renderRaster(model, 42, 16);
  const again = renderRaster(model, 42, 16);
  assert.equal(first.length, 16 * 16 * 3);
  assert.deepEqual(Array.from(first), Array.from(again));

  // A different seed is a different picture; the same model with a different
  // recurrence is too. Nothing else can move it.
  assert.notDeepEqual(Array.from(first), Array.from(renderRaster(model, 43, 16)));
  const other = { kind: "xorshift32" as const, params: { a: 13, b: 17, c: 7 }, vocab: ["alpha"] };
  assert.notDeepEqual(Array.from(first), Array.from(renderRaster(other, 42, 16)));
});

test("renderRaster follows the documented rule literally", () => {
  // Rule xorshift32-image-v1, spelled out: step the recurrence, emit the low
  // byte, row-major R,G,B. Reimplemented here from the paragraph in ai.ts.
  const model = { kind: "xorshift32" as const, params: { a: 13, b: 17, c: 5 }, vocab: ["x"] };
  const size = 3;
  const expected = [];
  let state = 7 >>> 0;
  for (let i = 0; i < size * size * 3; i++) {
    state ^= (state << 13) >>> 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    expected.push(state & 0xff);
  }
  assert.deepEqual(Array.from(renderRaster(model, 7, size)), expected);
});

test("renderRaster refuses malformed input rather than inventing a picture", () => {
  const model = { kind: "xorshift32" as const, params: { a: 13, b: 17, c: 5 }, vocab: ["x"] };
  assert.throws(() => renderRaster(model, 42, 0));
  assert.throws(() => renderRaster(model, 42, 513));
  assert.throws(() => renderRaster(model, 42, 1.5));
  assert.throws(() => renderRaster({ kind: "other" } as never, 42, 8));
});

test("isGenerativeMedia accepts a well-formed commitment and nothing sloppier", () => {
  const media = {
    mediaType: "image/png" as const,
    rule: RASTER_RULE,
    blob: "a".repeat(64),
    raster: "b".repeat(64),
    size: 64,
    bytes: 1234,
  };
  assert.equal(isGenerativeMedia(media), true);
  assert.equal(isGenerativeMedia({ ...media, rule: "hand-drawn-v2" }), false);
  assert.equal(isGenerativeMedia({ ...media, raster: "not-a-digest" }), false);
  assert.equal(isGenerativeMedia({ ...media, size: 0 }), false);
  assert.equal(isGenerativeMedia({ ...media, mediaType: "image/svg+xml" }), false);
  assert.equal(isGenerativeMedia(null), false);
});

test("renderBoundedRaster plots the committed measurement deterministically", () => {
  const reference = [10, 20, 30, 40, 200, 255, 0, 128];
  const reconstruction = reference.map((v) => Math.min(255, v + 2));
  const width = reference.length * BOUNDED_RASTER_SCALE;

  const first = renderBoundedRaster(reference, reconstruction);
  assert.equal(first.length, width * BOUNDED_RASTER_HEIGHT * 3);
  assert.deepEqual(
    Array.from(first),
    Array.from(renderBoundedRaster(reference, reconstruction)),
  );

  // The reference lane is the reference value as grey.
  assert.equal(first[(0 * width + 0) * 3], 10);
  // The error lane is |difference| * gain, in red only.
  const laneTwoStart = 2 * (48 + 4);
  const errorOffset = ((laneTwoStart + 1) * width + 0) * 3;
  assert.equal(first[errorOffset], 2 * BOUNDED_RASTER_GAIN);
  assert.equal(first[errorOffset + 1], 0);
  assert.equal(first[errorOffset + 2], 0);

  // A different reconstruction is a different picture.
  const shifted = reconstruction.map((v, i) => (i === 0 ? v + 16 : v));
  assert.notDeepEqual(Array.from(first), Array.from(renderBoundedRaster(reference, shifted)));
});

test("renderBoundedRaster refuses a mismatched pair instead of guessing", () => {
  assert.throws(() => renderBoundedRaster([1, 2, 3], [1, 2]));
  assert.throws(() => renderBoundedRaster([], []));
  assert.throws(() => renderBoundedRaster([1], [1], 0));
});

test("isBoundedMedia accepts the plotted rendition and nothing sloppier", () => {
  const media = {
    mediaType: "image/png" as const,
    rule: BOUNDED_RASTER_RULE,
    blob: "c".repeat(64),
    raster: "d".repeat(64),
    width: 128,
    height: BOUNDED_RASTER_HEIGHT,
    bytes: 512,
  };
  assert.equal(isBoundedMedia(media), true);
  assert.equal(isBoundedMedia({ ...media, rule: "bounded-strip-v2" }), false);
  assert.equal(isBoundedMedia({ ...media, height: 0 }), false);
  assert.equal(isBoundedMedia({ ...media, raster: "zz" }), false);
  assert.equal(isBoundedMedia(undefined), false);
});
