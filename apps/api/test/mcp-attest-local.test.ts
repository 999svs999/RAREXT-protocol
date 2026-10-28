import assert from "node:assert/strict";
import test from "node:test";

import type { Challenge } from "../../../packages/core/src/index.ts";
import { generate } from "../src/generative.ts";
import { attestAiLocally, attestLocalFromArgs } from "../../mcp/src/attest-local.ts";

/**
 * The MCP verb that MAKES an artifact instead of judging one.
 *
 * `rarext_verify_ai` lets an AI check someone else's artifact without trusting
 * the server. This is the half an AI needs to contribute: the artifact is
 * produced here — the committed model run from a seed, or a reconstruction
 * measured against the committed reference — and returned with the attestation
 * that says what was proved. No key, nothing published.
 */

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
  sampleArtifact: {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: { model, seed: 7, output: "" },
  },
} as Challenge;

const reference = [10, 20, 30, 40, 200, 255, 0, 128];

const boundedChallenge: Challenge = {
  id: "bounded-1",
  app: "ai-bounded",
  title: "Reconstruct within a bound",
  description: "Stay within the declared metric bound of the committed reference.",
  version: 1,
  spec: { metric: "maxAbsError", bound: 4, reference },
  semanticsId: "ai-bounded/bounded-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
} as Challenge;

const registryFor = (challenge: Challenge) => ({
  challenge: async (id: string): Promise<Challenge> => {
    assert.equal(id, challenge.id, "the verb asks the registry for the challenge it was given");
    return challenge;
  },
});

test("the generative verb runs the committed model and attests the run", async () => {
  const made = await attestAiLocally("gen-1", registryFor(generativeChallenge));

  // The output is the model's, computed here — not a claim about it.
  const body = made.artifact.body as { model: unknown; seed: number; output: string };
  assert.equal(body.seed, 7, "the challenge's own sample seed is used when none is given");
  assert.equal(body.output, generate(model, 7, 32), "the output is what the committed model produces");

  assert.equal(made.attestation.correct, true);
  assert.equal(made.attestation.verifier, "xorshift32-replay", "the RULE's name; no key is involved");
  assert.equal(made.attestation.representation, "generative");
  assert.equal(made.attestation.gateCount, 32);
  assert.equal(made.published, false, "nothing left this process");
  assert.equal(made.signed, false, "and this process holds no key");

  // The verdict comes from the same local verifier the checking verb uses, so
  // the artifact this returns is accepted by the check that will later judge it.
  assert.equal(made.verification.correct, true, "the local verifier agrees");
});

test("a caller's own seed and steps are honoured, and the claim follows them", async () => {
  const made = await attestAiLocally("gen-1", registryFor(generativeChallenge), { seed: 99, steps: 8 });
  const body = made.artifact.body as { seed: number; output: string };
  assert.equal(body.seed, 99);
  assert.equal(body.output, generate(model, 99, 8));
  assert.equal(made.attestation.gateCount, 8, "the record says how many steps were actually run");
  assert.equal(made.verification.correct, false, "8 steps is not what the challenge asks for, and the verdict says so");
});

test("the bounded verb measures the reconstruction against the committed reference", async () => {
  const inside = await attestAiLocally("bounded-1", registryFor(boundedChallenge), {
    values: [...reference],
  });
  assert.equal(inside.attestation.metricName, "maxAbsError");
  assert.equal(inside.attestation.metricValue, 0, "an exact reconstruction has no error");
  assert.equal(inside.attestation.correct, true);
  assert.equal(inside.verification.correct, true);

  // Outside the bound: the verb still SPEAKS — it reports a false claim rather
  // than hiding it, which is what makes the attestation worth reading.
  const outside = await attestAiLocally("bounded-1", registryFor(boundedChallenge), {
    values: reference.map((value) => value + 9),
  });
  assert.ok((outside.attestation.metricValue ?? 0) > 4, "the distance exceeds the bound");
  assert.equal(outside.attestation.correct, false, "and the record says so");
});

test("a bounded challenge without values, and an app this verb does not serve, both refuse", async () => {
  await assert.rejects(
    () => attestAiLocally("bounded-1", registryFor(boundedChallenge)),
    /supply the reconstruction's values/,
    "a bounded claim without a reconstruction is not something to guess at",
  );

  const logic = { ...generativeChallenge, id: "logic-1", app: "logic" } as Challenge;
  await assert.rejects(
    () => attestAiLocally("logic-1", registryFor(logic)),
    /this verb attests ai-generative and ai-bounded/,
  );
});

test("the argument boundary refuses what cannot be meant, by name", async () => {
  const registry = registryFor(generativeChallenge);

  // A seed arriving as a string is not a seed. Silently ignoring it would run a
  // DIFFERENT generation than the caller asked for, and report it as theirs.
  await assert.rejects(
    () => attestLocalFromArgs("gen-1", registry, { seed: "7" }),
    /seed must be a finite number/,
  );
  await assert.rejects(
    () => attestLocalFromArgs("gen-1", registry, { seed: Number.NaN }),
    /seed must be a finite number/,
  );
  await assert.rejects(
    () => attestLocalFromArgs("gen-1", registry, { steps: 1.5 }),
    /steps must be a non-negative integer/,
  );
  await assert.rejects(
    () => attestLocalFromArgs("bounded-1", registryFor(boundedChallenge), { values: 3 }),
    /values must be an array of finite numbers/,
  );
  await assert.rejects(
    () => attestLocalFromArgs("bounded-1", registryFor(boundedChallenge), { values: [1, 2, Number.NaN] }),
    /values must be an array of finite numbers/,
  );
});

test("a well-formed argument set goes straight through the boundary", async () => {
  const made = await attestLocalFromArgs("gen-1", registryFor(generativeChallenge), { seed: 5, steps: 4 });
  const body = made.artifact.body as { seed: number; output: string };
  assert.equal(body.seed, 5);
  assert.equal(body.output, generate(model, 5, 4), "the coerced values are the ones that ran");
  assert.equal(made.attestation.gateCount, 4);
});
