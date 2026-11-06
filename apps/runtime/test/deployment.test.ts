import assert from "node:assert/strict";
import test from "node:test";

import { deploymentArtifact, verifyDeploymentBody } from "../src/transcript.ts";
import { buildDeployment, commitDeployment, hardwareFromHost } from "../src/manifest.ts";
import { challengeFor } from "../src/publisher.ts";
import { runSpecFromChallenge, verifyModelRunArtifact } from "../src/verifier.ts";
import type { DeploymentCommitment, EngineProbe } from "../src/types.ts";

const probe: EngineProbe = {
  engine: { name: "ollama", version: "0.23.2", endpoint: "http://127.0.0.1:11434" },
  model: {
    id: "qwen2.5:0.5b",
    family: "qwen2",
    parameters: "494M",
    quantization: "Q4_K_M",
    format: "gguf",
    sizeBytes: 397821319,
    weightsDigest: "sha256:a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67",
    contextLength: null,
  },
  apis: ["openai", "anthropic"],
  models: [],
};

function deployment(id = "qwen2.5:0.5b"): DeploymentCommitment {
  return commitDeployment(
    buildDeployment({
      probe: id === probe.model.id ? probe : { ...probe, model: { ...probe.model, id } },
      hardware: hardwareFromHost("cpu", "test host"),
      createdAt: "2026-11-06T00:00:00.000Z",
    }),
  );
}

test("a deployment manifest verifies against the challenge that commits it", () => {
  const manifest = deployment();
  const result = verifyDeploymentBody(manifest, runSpecFromChallenge(challengeFor(manifest)));

  assert.equal(result.correct, true);
  assert.equal(result.score, 100);
  assert.equal(result.details.deploymentDigest, manifest.digest);
  assert.equal(result.details.modelId, manifest.model.id);
  assert.equal(result.details.weightsDigest, manifest.model.weightsDigest);
  assert.equal(result.details.engine, "ollama");
  assert.ok(result.details.checks.includes("digest.recomputed"));
});

test("a deployment whose manifest changed after its digest is refused", () => {
  const manifest = deployment();
  const tampered = structuredClone(manifest);
  tampered.hardware.backend = "cuda";

  const result = verifyDeploymentBody(tampered, runSpecFromChallenge(challengeFor(manifest)));

  assert.equal(result.correct, false);
  assert.match(result.error ?? "", /digest\.recomputed/);
});

test("a deployment published under another model's challenge is refused", () => {
  const manifest = deployment();
  const other = deployment("other:1b");

  const result = verifyDeploymentBody(manifest, runSpecFromChallenge(challengeFor(other)));

  assert.equal(result.correct, false);
  assert.match(result.error ?? "", /deployment\.digest/);
  assert.match(result.error ?? "", /model\.id/);
});

test("the verifier dispatches a deployment artifact as a model card", () => {
  const manifest = deployment();
  const verdict = verifyModelRunArtifact(deploymentArtifact(manifest), challengeFor(manifest));

  assert.equal(verdict.correct, true);
  assert.equal(verdict.representation, "exact");
  assert.equal(verdict.gateCount, verifyDeploymentBody(manifest, runSpecFromChallenge(challengeFor(manifest))).details.checks.length);
});
