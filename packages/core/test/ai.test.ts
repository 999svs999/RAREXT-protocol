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
