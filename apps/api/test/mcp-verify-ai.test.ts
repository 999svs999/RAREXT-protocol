import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import { generate } from "../src/generative.ts";
import { verifyAiLocally } from "../../mcp/src/verify-ai.ts";

const model = {
  kind: "xorshift32" as const,
  params: { a: 13, b: 17, c: 5 },
  vocab: ["alpha", "beta", "gamma", "delta"],
};

const generativeChallenge: Challenge = {
  id: "gen-1",
  app: "ai-generative",
  title: "Generate from a committed model",
  description: "Replay the digest-bound model from the seed and match the output.",
  version: 1,
  spec: { steps: 32 },
  semanticsId: "ai-generative/gen-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const reference = [10, 20, 30, 40, 200, 255, 0, 128];

const boundedChallenge: Challenge = {
  id: "bounded-1",
  app: "ai-bounded",
  title: "Reconstruct within a metric bound",
  description: "The lossy reconstruction must stay within the committed bound.",
  version: 1,
  spec: { metric: "maxAbsError", bound: 4, reference },
  semanticsId: "ai-bounded/bounded-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function registryWith(...challenges: Challenge[]) {
  const byId = new Map(challenges.map((challenge) => [challenge.id, challenge]));
  return {
    challenge: async (id: string) => {
      const challenge = byId.get(id);
      if (!challenge) throw new Error(`unknown challenge: ${id}`);
      return challenge;
    },
  };
}

function generativeArtifact(output: string, overrides: Record<string, unknown> = {}): Artifact {
  return {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: { model, seed: 42, output, ...overrides },
  };
}

function boundedArtifact(values: number[]): Artifact {
  return {
    app: "ai-bounded",
    kind: "ai.bounded",
    version: 1,
    mediaType: "application/json",
    body: { values },
  };
}

test("a correct generative output verifies locally with model evidence", async () => {
  const output = generate(model, 42, 32);
  const result = await verifyAiLocally("gen-1", generativeArtifact(output), registryWith(generativeChallenge));

  assert.equal(result.representation, "generative");
  assert.equal(result.correct, true);
  assert.equal(typeof result.modelDigest, "string");
  assert.match(result.modelDigest as string, /^[0-9a-f]{64}$/);
  assert.equal(result.seed, 42);
  assert.equal(result.steps, 32);
});

test("a tampered generative output fails locally without trusting anyone", async () => {
  const output = generate(model, 42, 32);
  const tampered = output.slice(0, -1) + (output.endsWith("a") ? "b" : "a");
  const result = await verifyAiLocally("gen-1", generativeArtifact(tampered), registryWith(generativeChallenge));

  assert.equal(result.representation, "generative");
  assert.equal(result.correct, false);
});

test("a within-bound reconstruction verifies locally with metric evidence", async () => {
  const reconstruction = reference.map((v) => v + 2);
  const result = await verifyAiLocally("bounded-1", boundedArtifact(reconstruction), registryWith(boundedChallenge));

  assert.equal(result.representation, "bounded");
  assert.equal(result.correct, true);
  assert.equal(result.metricName, "maxAbsError");
  assert.equal(result.metricValue, 2);
  assert.equal(result.bound, 4);
});

test("an over-bound reconstruction fails locally with the achieved metric", async () => {
  const bad = reference.map((v) => v + 10);
  const result = await verifyAiLocally("bounded-1", boundedArtifact(bad), registryWith(boundedChallenge));

  assert.equal(result.correct, false);
  assert.equal(result.metricValue, 10);
});

test("a length mismatch surfaces as an error, not a verdict", async () => {
  await assert.rejects(
    () => verifyAiLocally("bounded-1", boundedArtifact(reference.slice(0, 3)), registryWith(boundedChallenge)),
    /does not match reference length/,
  );
});

test("unsupported kinds and malformed bodies are rejected", async () => {
  await assert.rejects(
    () =>
      verifyAiLocally(
        "gen-1",
        { ...generativeArtifact("x"), kind: "logic.netlist" },
        registryWith(generativeChallenge),
      ),
    /does not support artifact kind/,
  );
  await assert.rejects(
    () =>
      verifyAiLocally(
        "gen-1",
        generativeArtifact("x", { model: { ...model, kind: "transformer" } }),
        registryWith(generativeChallenge),
      ),
    /body must be/,
  );
});

test("a generative body against a bounded challenge is rejected", async () => {
  await assert.rejects(
    () => verifyAiLocally("bounded-1", generativeArtifact(generate(model, 42, 32)), registryWith(boundedChallenge)),
    /is not a generative task/,
  );
});
