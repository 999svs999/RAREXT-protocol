import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import {
  MAX_GENERATIVE_STEPS,
  generate,
  generativeVerifierHash,
  isGenerativeBody,
  isGenerativeSpec,
  modelDigest,
  verifyGenerative,
  verifyGenerativeReplay,
} from "../src/generative.ts";
import { createSemanticsRegistry } from "../src/semantics.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";

const model = {
  kind: "xorshift32" as const,
  params: { a: 13, b: 17, c: 5 },
  vocab: ["alpha", "beta", "gamma", "delta"],
};

const challenge: Challenge = {
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

function artifactFor(output: string, overrides: Record<string, unknown> = {}): Artifact {
  return {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: { model, seed: 42, output, ...overrides },
  };
}

const validOutput = generate(model, 42, 32);

test("generation is deterministic and seed-sensitive", () => {
  assert.equal(generate(model, 42, 32), validOutput);
  assert.equal(generate(model, 42, 32), generate(model, 42, 32));
  assert.notEqual(generate(model, 43, 32), validOutput);
  // Single-char vocab: one token per step, so the prefix property is direct.
  const chars = { ...model, vocab: ["a", "b", "c", "d"] };
  assert.equal(generate(chars, 42, 4).length, 4);
  assert.equal(generate(chars, 42, 8).slice(0, 4), generate(chars, 42, 4));
});

test("model digest binds every parameter", () => {
  const base = modelDigest(model);
  assert.equal(modelDigest({ ...model }), base);
  assert.notEqual(
    modelDigest({ ...model, params: { a: 13, b: 17, c: 6 } }),
    base,
  );
  assert.notEqual(
    modelDigest({ ...model, vocab: ["alpha", "beta", "gamma", "epsilon"] }),
    base,
  );
  assert.notEqual(modelDigest({ ...model, seed: 1 } as never), base);
});

test("registry verifies a correct replay as generative", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const attestation = await registry.verify(artifactFor(validOutput), challenge);

  assert.equal(attestation.app, "ai-generative");
  assert.equal(attestation.correct, true);
  assert.equal(attestation.score, 100);
  assert.equal(attestation.representation, "generative");
  assert.equal(attestation.proofKind, "recomputable");
  assert.equal(attestation.gateCount, 32);
  assert.equal(attestation.verifierHash, generativeVerifierHash());
  assert.match(attestation.traceHash, /^[0-9a-f]{64}$/);
});

test("registry exposes the generative app", () => {
  const registry = createVerifierRegistry(fetch, null);
  const app = registry.get("ai-generative");

  if (!app) throw new Error("ai-generative verifier not registered");
  assert.equal(app.name, "Generative AI");
  assert.deepEqual(app.artifactKinds, ["ai.generative"]);
});

test("a tampered output fails replay", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const tampered = validOutput.slice(0, -1) + (validOutput.endsWith("a") ? "b" : "a");
  const attestation = await registry.verify(artifactFor(tampered), challenge);

  assert.equal(attestation.correct, false);
  assert.equal(attestation.score, 0);
  assert.equal(attestation.representation, "generative");
});

test("a tampered seed fails replay", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const attestation = await registry.verify(artifactFor(validOutput, { seed: 43 }), challenge);

  assert.equal(attestation.correct, false);
});

test("a swapped vocab changes the model commitment and fails replay", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const swapped = artifactFor(validOutput, {
    model: { ...model, vocab: ["alpha", "beta", "gamma", "epsilon"] },
  });
  const attestation = await registry.verify(swapped, challenge);

  assert.equal(attestation.correct, false);
  assert.notEqual(
    modelDigest((swapped.body as { model: typeof model }).model),
    modelDigest(model),
  );
});

test("verifyGenerative binds the claim and preserves the representation", async () => {
  const challenges = [challenge];
  const semantics = createSemanticsRegistry(() => challenges);
  const result = await verifyGenerative(artifactFor(validOutput), challenge, semantics);

  if ("error" in result) throw new Error(result.error);
  const attestation = result.attestation;
  assert.equal(attestation.correct, true);
  assert.equal(attestation.representation, "generative");
  assert.equal(attestation.semanticsId, challenge.semanticsId);
  assert.ok(attestation.verifierHash.length > 0);
});

test("malformed artifacts and specs are rejected", () => {
  assert.equal(isGenerativeBody({ model: { ...model, kind: "transformer" }, seed: 1, output: "" }), false);
  assert.equal(isGenerativeBody({ model, seed: -1, output: "" }), false);
  assert.equal(isGenerativeBody({ model, seed: 42, output: 7 }), false);
  assert.equal(isGenerativeSpec({ steps: 0 }), false);
  assert.equal(isGenerativeSpec({ steps: MAX_GENERATIVE_STEPS + 1 }), false);
  assert.equal(isGenerativeSpec({ steps: 1 }), true);
});

test("wrong app or kind is not supported", async () => {
  const registry = createVerifierRegistry(fetch, null);
  const wrong: Artifact = { ...artifactFor(validOutput), kind: "logic.netlist" };

  await assert.rejects(
    () => registry.verify(wrong, challenge),
    /does not support artifact kind/,
  );
});

test("replay is pure and independent of the verifier instance", () => {
  const a = verifyGenerativeReplay(artifactFor(validOutput).body as never, { steps: 32 });
  const b = verifyGenerativeReplay(artifactFor(validOutput).body as never, { steps: 32 });

  assert.equal(a.correct, true);
  assert.equal(a.digest, b.digest);
  assert.equal(a.expected, b.expected);
});
