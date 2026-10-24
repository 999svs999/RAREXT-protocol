import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import { createChallengeRegistry } from "../src/challenges.ts";
import {
  generate,
  verifyGenerativeReplay,
} from "../src/generative.ts";
import { verifyBoundedReconstruction } from "../src/bounded.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";

function seedById(id: string): Challenge {
  const challenge = createChallengeRegistry().get(id);
  if (!challenge) throw new Error(`seed challenge missing: ${id}`);
  return challenge;
}

function sampleArtifact(challenge: Challenge): Artifact {
  if (!challenge.sampleArtifact) throw new Error(`no sample artifact: ${challenge.id}`);
  return challenge.sampleArtifact;
}

test("AI seed challenges exist out of the box", () => {
  const registry = createChallengeRegistry();

  assert.ok(registry.get("gen-starter"));
  assert.ok(registry.get("bounded-starter"));
  assert.equal(registry.get("gen-starter")?.app, "ai-generative");
  assert.equal(registry.get("bounded-starter")?.app, "ai-bounded");
});

test("the generative seed's sample artifact replays correct", () => {
  const challenge = seedById("gen-starter");
  const artifact = sampleArtifact(challenge);
  const body = artifact.body as { model: Parameters<typeof generate>[0]; seed: number; output: string };

  assert.equal(artifact.app, "ai-generative");
  assert.equal(artifact.kind, "ai.generative");

  const replay = verifyGenerativeReplay(body, challenge.spec as { steps: number });
  assert.equal(replay.correct, true);
});

test("the bounded seed's sample artifact is within bound", () => {
  const challenge = seedById("bounded-starter");
  const artifact = sampleArtifact(challenge);
  const body = artifact.body as { values: number[] };

  assert.equal(artifact.app, "ai-bounded");
  assert.equal(artifact.kind, "ai.bounded");

  const check = verifyBoundedReconstruction(
    body,
    challenge.spec as { metric: "maxAbsError"; bound: number; reference: number[] },
  );
  if ("error" in check) throw new Error(check.error);
  assert.equal(check.correct, true);
  assert.equal(check.metricValue, 2);
});

test("the full loop: seed sample artifacts verify through the registry", async () => {
  const registry = createVerifierRegistry(fetch, null);

  const generative = await registry.verify(sampleArtifact(seedById("gen-starter")), seedById("gen-starter"));
  assert.equal(generative.correct, true);
  assert.equal(generative.representation, "generative");

  const bounded = await registry.verify(sampleArtifact(seedById("bounded-starter")), seedById("bounded-starter"));
  assert.equal(bounded.correct, true);
  assert.equal(bounded.representation, "bounded");
});

test("a tampered seed output fails the replay — the seed proves nothing by default", () => {
  const challenge = seedById("gen-starter");
  const artifact = sampleArtifact(challenge);
  const body = artifact.body as { model: Parameters<typeof generate>[0]; seed: number; output: string };

  const wrong = generate(body.model, body.seed, (challenge.spec as { steps: number }).steps + 1);
  const replay = verifyGenerativeReplay({ ...body, output: wrong }, challenge.spec as { steps: number });
  assert.equal(replay.correct, false);
});
