import assert from "node:assert/strict";
import test from "node:test";

import { discoverBundle, verifiedRemoteDeployments } from "../src/discovery.ts";
import { buildDeployment, commitDeployment, hardwareFromCloud, hardwareFromHost } from "../src/manifest.ts";
import { challengeFor } from "../src/publisher.ts";
import { createRunBody } from "../src/transcript.ts";
import type { DeploymentCommitment, EngineProbe, ModelRunBody } from "../src/types.ts";

const probe: EngineProbe = {
  engine: { name: "openai-compatible", version: "1", endpoint: "https://api.example.com" },
  model: {
    id: "cloud-model",
    family: "test",
    parameters: "7B",
    quantization: "FP8",
    format: "safetensors",
    sizeBytes: null,
    weightsDigest: null,
    contextLength: 8192,
  },
  apis: ["openai", "anthropic"],
  models: [],
};

const deployment: DeploymentCommitment = commitDeployment(
  buildDeployment({
    probe,
    hardware: hardwareFromHost("cpu", "test host"),
    createdAt: "2026-11-07T00:00:00.000Z",
  }),
);
const challenge = challengeFor(deployment);

const remoteDeployment: DeploymentCommitment = commitDeployment(
  buildDeployment({
    probe: {
      ...probe,
      engine: { name: "openai-compatible", version: "1", endpoint: "https://cloud.example.com" },
    },
    hardware: hardwareFromCloud("https://cloud.example.com"),
    placement: "remote",
    labels: { execution: "cloud", upstreamApi: "openai", upstreamAuth: "bearer" },
    createdAt: "2026-11-07T00:00:00.000Z",
  }),
);
const remoteChallenge = challengeFor(remoteDeployment);

function runBody(): ModelRunBody {
  return createRunBody({
    deployment,
    api: "openai",
    request: { model: deployment.model.id, messages: [{ role: "user", content: "hello" }] },
    response: {
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    sampling: { temperature: 0, topP: null, seed: 1, maxTokens: 8 },
    startedAt: "2026-11-07T00:00:00.000Z",
    completedAt: "2026-11-07T00:00:01.000Z",
    previous: null,
  });
}

function bundle(run = runBody()) {
  return {
    manifest: { root: "a".repeat(64), leafVersion: 3 },
    challenges: [challenge],
    publications: [
      {
        id: "card-1",
        challengeId: challenge.id,
        attestation: { correct: true, representation: "exact" },
        artifact: { kind: "ai.model-deployment", body: deployment },
      },
      {
        id: "run-1",
        challengeId: challenge.id,
        attestation: { correct: true, representation: "exact" },
        artifact: { kind: "ai.model-run", body: run },
      },
    ],
  };
}

test("discover recomputes every card and run in a bundle without a server", () => {
  const report = discoverBundle(bundle());

  assert.equal(report.ok, true);
  assert.equal(report.root, "a".repeat(64));
  assert.equal(report.leafVersion, 3);
  assert.equal(report.cards.length, 1);
  assert.equal(report.cards[0]?.deploymentDigest, deployment.digest);
  assert.equal(report.cards[0]?.verified, true);
  assert.equal(report.cards[0]?.attested, true);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0]?.modelId, deployment.model.id);
  assert.equal(report.runs[0]?.verified, true);
  assert.equal(report.runs[0]?.attested, true);
});

test("discover refuses a run edited after publication, even when its old attestation says exact", () => {
  const run = runBody();
  run.response.text = "tampered";
  const report = discoverBundle(bundle(run));

  assert.equal(report.ok, false);
  assert.equal(report.runs[0]?.verified, false);
  assert.equal(report.runs[0]?.attested, true);
  assert.match(report.runs[0]?.error ?? "", /response\.text/);
});

test("discover reports a publication whose challenge is not in the bundle", () => {
  const tampered = bundle();
  tampered.publications[1]!.challengeId = "missing-challenge";
  const report = discoverBundle(tampered);

  assert.equal(report.ok, false);
  assert.equal(report.runs[0]?.verified, false);
  assert.match(report.runs[0]?.error ?? "", /not in the bundle/);
});

test("discover refuses an empty bundle rather than calling it verified", () => {
  const report = discoverBundle({
    manifest: { root: "b".repeat(64), leafVersion: 1 },
    publications: [],
    challenges: [],
  });

  assert.equal(report.ok, false);
  assert.equal(report.cards.length, 0);
  assert.equal(report.runs.length, 0);
});

test("discover reports a non-object bundle as an error", () => {
  const report = discoverBundle(null);
  assert.equal(report.ok, false);
  assert.match(report.error ?? "", /bundle must be an object/);
});

function mixedBundle() {
  return {
    manifest: { root: "c".repeat(64), leafVersion: 4 },
    challenges: [challenge, remoteChallenge],
    publications: [
      {
        id: "card-1",
        challengeId: challenge.id,
        attestation: { correct: true, representation: "exact" },
        artifact: { kind: "ai.model-deployment", body: deployment },
      },
      {
        id: "run-1",
        challengeId: challenge.id,
        attestation: { correct: true, representation: "exact" },
        artifact: { kind: "ai.model-run", body: runBody() },
      },
      {
        id: "remote-card",
        challengeId: remoteChallenge.id,
        attestation: { correct: true, representation: "exact" },
        artifact: { kind: "ai.model-deployment", body: remoteDeployment },
      },
    ],
  };
}

test("a verified remote card is adoptable without a local deployment", () => {
  const { deployments, error } = verifiedRemoteDeployments(mixedBundle());

  assert.equal(error, null);
  assert.equal(deployments.length, 1);
  assert.equal(deployments[0]?.card.deploymentId, remoteDeployment.id);
  assert.equal(deployments[0]?.deployment.digest, remoteDeployment.digest);
  assert.equal(deployments[0]?.deployment.placement, "remote");
  assert.equal(deployments[0]?.deployment.model.id, remoteDeployment.model.id);
});

test("a tampered remote card is never adopted", () => {
  const tampered = mixedBundle();
  const body = tampered.publications[2]!.artifact.body as typeof remoteDeployment;
  body.model.id = "swapped-model";

  const { deployments, error } = verifiedRemoteDeployments(tampered);
  assert.equal(deployments.length, 0);
  assert.match(error ?? "", /no verified remote model card/);
});

test("a local-only bundle yields no remote card to serve", () => {
  const { deployments, error } = verifiedRemoteDeployments(bundle());
  assert.equal(deployments.length, 0);
  assert.match(error ?? "", /no verified remote model card/);
});
