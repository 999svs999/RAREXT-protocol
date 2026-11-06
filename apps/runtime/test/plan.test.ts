import assert from "node:assert/strict";
import test from "node:test";

import { assessModelFit, formatBytes } from "../src/manifest.ts";
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
