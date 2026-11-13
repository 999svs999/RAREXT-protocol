import assert from "node:assert/strict";
import test from "node:test";

import { assessModelFit, formatBytes, hostCapabilityCommitment } from "../src/manifest.ts";
import type { HardwareRef, ModelRef } from "../src/types.ts";

const GIB = 1024 ** 3;

function model(sizeBytes: number | null): ModelRef {
  return {
    id: "test-model",
    family: null,
    parameters: null,
    quantization: "Q4_K_M",
    format: "gguf",
    sizeBytes,
    weightsDigest: null,
    contextLength: null,
  };
}

function hardware(memoryBytes: number | null): HardwareRef {
  return {
    backend: "cpu",
    device: null,
    memoryBytes,
    os: "test",
    arch: "test",
  };
}

test("assessModelFit says fits when the weights leave the default reserve", () => {
  const fit = assessModelFit(model(4 * GIB), hardware(16 * GIB));

  assert.equal(fit.verdict, "fits");
  assert.equal(fit.modelBytes, 4 * GIB);
  assert.equal(fit.memoryBytes, 16 * GIB);
  // 15% of 16 GiB = 2.4 GiB, larger than the 1 GiB floor. The reserve is
  // rounded down to a whole byte so the arithmetic is reproducible.
  assert.equal(fit.headroomBytes, 16 * GIB - 4 * GIB - Math.floor(16 * GIB * 0.15));
  assert.match(fit.note, /reserve/);
});

test("assessModelFit says tight when the weights fit but eat the reserve", () => {
  const fit = assessModelFit(model(14 * GIB), hardware(16 * GIB));

  assert.equal(fit.verdict, "tight");
  assert.ok(fit.headroomBytes !== null && fit.headroomBytes < 0);
});

test("assessModelFit says too-large when the weights exceed host memory", () => {
  const fit = assessModelFit(model(20 * GIB), hardware(16 * GIB));

  assert.equal(fit.verdict, "too-large");
  assert.match(fit.note, /stream from disk or offload/);
});

test("assessModelFit refuses to invent a verdict when either size is missing", () => {
  assert.equal(assessModelFit(model(null), hardware(16 * GIB)).verdict, "unknown");
  assert.equal(assessModelFit(model(4 * GIB), hardware(null)).verdict, "unknown");
  assert.equal(assessModelFit(model(null), hardware(null)).verdict, "unknown");
});

test("assessModelFit honours an explicit reserve", () => {
  const fit = assessModelFit(model(4 * GIB), hardware(16 * GIB), { reserveBytes: GIB });

  assert.equal(fit.verdict, "fits");
  assert.equal(fit.headroomBytes, 11 * GIB);
});

test("formatBytes keeps the sign and names the unit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(16 * GIB), "16.0 GiB");
  assert.equal(formatBytes(-GIB), "-1.0 GiB");
});

test("the host-capability commitment refuses a model the host cannot hold", () => {
  // 9 GiB of weights on an 8 GiB host: the engine reads the container whole, so
  // this is a refusal, not a warning.
  const tooLarge = hostCapabilityCommitment(model(9 * GIB), { memoryBytes: 8 * GIB });
  assert.equal(tooLarge.allowed, false);
  assert.equal(tooLarge.verdict, "too-large");
  assert.match(tooLarge.reason, /exceed this host's memory/);
  assert.match(tooLarge.reason, /RAREXT_ALLOW_OVERSIZE_MODEL=1/);

  // The override is deliberate, and it is what a streaming engine would use.
  assert.equal(hostCapabilityCommitment(model(9 * GIB), { memoryBytes: 8 * GIB }, { allowOversize: true }).allowed, true);
  assert.equal(hostCapabilityCommitment(model(9 * GIB), { memoryBytes: 8 * GIB }, { overrideEnv: "1" }).allowed, true);
  assert.equal(hostCapabilityCommitment(model(9 * GIB), { memoryBytes: 8 * GIB }, { overrideEnv: undefined }).allowed, false);

  // A model that fits, a tight one, and an unknown size are all allowed.
  assert.equal(hostCapabilityCommitment(model(1 * GIB), { memoryBytes: 16 * GIB }).allowed, true);
  const tight = hostCapabilityCommitment(model(7 * GIB), { memoryBytes: 8 * GIB });
  assert.equal(tight.verdict, "tight");
  assert.equal(tight.allowed, true, "tight is a warning, not a refusal");
  assert.equal(hostCapabilityCommitment(model(null), { memoryBytes: 16 * GIB }).verdict, "unknown");
});
