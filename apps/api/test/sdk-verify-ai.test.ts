import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import { generate } from "../src/generative.ts";
import { RarextClient } from "../../../packages/agent-sdk/src/index.ts";

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

function clientWith(challenge: Challenge): RarextClient {
  const client = new RarextClient({ baseUrl: "http://127.0.0.1:1" });
  // Stub the transport-level method: verifyAi must fetch the challenge but
  // compute the verdict locally from core math.
  (client as unknown as { challenge: (id: string) => Promise<Challenge> }).challenge =
    async (id: string) => {
      if (id !== challenge.id) throw new Error(`unknown challenge: ${id}`);
      return challenge;
    };
  return client;
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

test("client.verifyAi checks a bounded claim locally with metric evidence", async () => {
  const client = clientWith(boundedChallenge);
  const result = await client.verifyAi("bounded-1", boundedArtifact(reference.map((v) => v + 2)));

  assert.equal(result.representation, "bounded");
  assert.equal(result.correct, true);
  assert.equal(result.metricName, "maxAbsError");
  assert.equal(result.metricValue, 2);
  assert.equal(result.bound, 4);
});

test("client.verifyAi attaches the model digest for generative claims", async () => {
  const genChallenge: Challenge = {
    ...boundedChallenge,
    id: "gen-1",
    app: "ai-generative",
    spec: { steps: 16 },
  };
  const client = clientWith(genChallenge);

  const artifact: Artifact = {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: { model, seed: 42, output: generate(model, 42, 16) },
  };

  const result = await client.verifyAi("gen-1", artifact);
  assert.equal(result.representation, "generative");
  assert.equal(result.correct, true);
  assert.match(result.modelDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(result.steps, 16);
});

test("client.verifyAi throws on an unverifiable pair instead of trusting the server", async () => {
  const client = clientWith(boundedChallenge);

  await assert.rejects(
    () =>
      client.verifyAi("bounded-1", {
        ...boundedArtifact(reference),
        kind: "logic.netlist",
      }),
    /not a locally verifiable AI claim/,
  );
});
