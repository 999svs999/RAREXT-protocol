import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalDigest } from "../src/digest.ts";
import { RunLedger } from "../src/ledger.ts";
import {
  buildDeployment,
  commitDeployment,
  hardwareFromHost,
  normalizeEndpoint,
  validateDeployment,
} from "../src/manifest.ts";
import { challengeFor } from "../src/publisher.ts";
import {
  createRunBody,
  runArtifact,
  runRecordFor,
  verifyLedger,
  verifyRunBody,
  verifyRunRecord,
} from "../src/transcript.ts";
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

function deployment(): DeploymentCommitment {
  return commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromHost("cpu", "test host"),
      createdAt: "2026-11-06T00:00:00.000Z",
    }),
  );
}

function runBody(manifest: DeploymentCommitment) {
  return createRunBody({
    deployment: manifest,
    api: "openai",
    request: {
      model: manifest.model.id,
      messages: [{ role: "user", content: "Reply with exactly: AI lives on RAREXT" }],
      temperature: 0,
      seed: 42,
    },
    response: {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: manifest.model.id,
      choices: [
        { index: 0, message: { role: "assistant", content: "AI lives on RAREXT" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    sampling: { temperature: 0, topP: null, seed: 42, maxTokens: 32 },
    startedAt: "2026-11-06T00:00:01.000Z",
    completedAt: "2026-11-06T00:00:02.000Z",
    previous: null,
  });
}

test("a deployment digest is stable and independent of JSON key order", () => {
  const manifest = deployment();
  const reordered = JSON.parse(
    JSON.stringify({
      ...manifest,
      digest: undefined,
    }),
  ) as Record<string, unknown>;

  assert.equal(manifest.digest.length, 64);
  assert.equal(canonicalDigest(reordered), manifest.digest);
  assert.deepEqual(validateDeployment({ ...manifest, digest: undefined }), []);
});

test("manifest validation names every broken field", () => {
  const broken = {
    kind: "not-a-manifest",
    id: "",
    engine: { name: "wat", endpoint: "ftp://x", version: 3 },
    model: {},
    hardware: {},
    apis: [],
    createdAt: "nope",
  };
  const errors = validateDeployment(broken);
  assert.ok(errors.length >= 6);
  assert.ok(errors.some((error) => error.includes("manifest.kind")));
  assert.ok(errors.some((error) => error.includes("engine.name")));
});

test("endpoint normalisation accepts root, /v1 and scheme-less spellings", () => {
  assert.equal(normalizeEndpoint("127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeEndpoint("http://127.0.0.1:8000/v1/"), "http://127.0.0.1:8000");
});

test("a transcript verifies against the challenge that committed the deployment", () => {
  const manifest = deployment();
  const body = runBody(manifest);
  const challenge = challengeFor(manifest);
  const spec = runSpecFromChallenge(challenge);

  const result = verifyRunBody(body, spec);
  assert.equal(result.correct, true);
  assert.equal(result.score, 100);
  assert.equal(result.details.transcriptDigest, canonicalDigest(body));
  assert.equal(result.details.replayable, true);
  assert.ok(result.details.checks.includes("response.textDigest"));

  const artifact = runArtifact(body);
  const verdict = verifyModelRunArtifact(artifact, challenge);
  assert.equal(verdict.correct, true);
  assert.equal(verdict.representation, "exact");
  assert.equal(verdict.gateCount, result.details.checks.length);
});

test("every part of the transcript is load-bearing", () => {
  const manifest = deployment();
  const body = runBody(manifest);
  const spec = runSpecFromChallenge(challengeFor(manifest));

  const tamperedText = structuredClone(body);
  tamperedText.response.text = "AI lives somewhere else";
  assert.equal(verifyRunBody(tamperedText, spec).correct, false);

  const tamperedDigest = structuredClone(body);
  tamperedDigest.response.digest = "0".repeat(64);
  assert.equal(verifyRunBody(tamperedDigest, spec).correct, false);

  const tamperedDeployment = structuredClone(body);
  tamperedDeployment.deployment.digest = "1".repeat(64);
  assert.equal(verifyRunBody(tamperedDeployment, spec).correct, false);

  const tamperedWeights = structuredClone(body);
  tamperedWeights.model.weightsDigest = "sha256:deadbeef";
  assert.equal(verifyRunBody(tamperedWeights, spec).correct, false);

  const tamperedBytes = structuredClone(body);
  tamperedBytes.request.bytes += 1;
  assert.equal(verifyRunBody(tamperedBytes, spec).correct, false);
});

test("a transcript produced for one deployment is refused by another challenge", () => {
  const first = deployment();
  const second = commitDeployment(
    buildDeployment({
      probe: { ...probe, model: { ...probe.model, id: "qwen3:8b" } },
      hardware: hardwareFromHost("cpu", "test host"),
      createdAt: "2026-11-06T00:00:00.000Z",
    }),
  );
  const body = runBody(first);
  const result = verifyRunBody(body, runSpecFromChallenge(challengeFor(second)));
  assert.equal(result.correct, false);
  assert.match(result.error ?? "", /deployment\.digest/);
});

test("the append-only ledger recomputes and detects an edited or removed record", () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-runtime-ledger-"));
  try {
    const manifest = deployment();
    const ledger = new RunLedger(dir);
    const first = runBody(manifest);
    ledger.append(first);

    const secondBase = runBody(manifest);
    const second = { ...secondBase, previous: ledger.head() };
    ledger.append(second);

    const verification = ledger.verify();
    assert.equal(verification.ok, true);
    assert.equal(verification.count, 2);

    const path = join(dir, "runs.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");

    // Removing the first record breaks the second record's `previous` link.
    writeFileSync(path, `${lines[1]}\n`);
    const missing = verifyLedger(
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0].reason, /previous link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run record's digest covers its body, so a swapped body is visible", () => {
  const manifest = deployment();
  const body = runBody(manifest);
  const record = runRecordFor(body);
  assert.equal(verifyRunRecord(record), true);

  const swapped = { ...record, body: { ...body, previous: "a".repeat(64) } };
  assert.equal(verifyRunRecord(swapped), false);
});
