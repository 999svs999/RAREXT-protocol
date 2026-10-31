import assert from "node:assert/strict";
import test from "node:test";

import type { Challenge } from "../../../packages/core/src/index.ts";
import { createHash } from "node:crypto";

import {
  BOUNDED_RASTER_HEIGHT,
  BOUNDED_RASTER_RULE,
  BOUNDED_RASTER_SCALE,
  boundedRenditionHolds,
  generativeRenditionHolds,
} from "../../../packages/core/src/index.ts";
import { encodePngRaster } from "../../../packages/agent-sdk/src/png.ts";
import { renderRaster } from "../../../packages/core/src/index.ts";
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

test("a caller can ship a rendition, and the verifier that judges it accepts it", async () => {
  const made = await attestAiLocally("gen-1", registryFor(generativeChallenge), { rendition: 32 });
  const body = made.artifact.body as { model: never; seed: number; media?: Record<string, unknown> };

  assert.ok(body.media, "the artifact carries a rendition when one was asked for");
  const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

  // The registry's OWN check decides it — not arithmetic written for this test.
  assert.equal(generativeRenditionHolds(body as never, sha256), true);
  assert.equal(body.media!.raster, sha256(renderRaster(body.model, body.seed, 32)));
  assert.equal(body.media!.blob, sha256(encodePngRaster(renderRaster(body.model, body.seed, 32), 32)));
  assert.equal(body.media!.size, 32);

  // And the local verifier — the one that will later JUDGE this artifact — accepts it.
  assert.equal(made.verification.correct, true, "the verifier that judges the artifact accepts its picture");
  assert.equal(made.signed, false, "still no key, still nothing published");
});

test("no rendition asked for means none shipped", async () => {
  const made = await attestAiLocally("gen-1", registryFor(generativeChallenge));
  assert.equal((made.artifact.body as { media?: unknown }).media, undefined);
});

test("the rendition argument is a boundary, not a suggestion", async () => {
  const registry = registryFor(generativeChallenge);
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ rendition: 0 }, /positive integer/],
    [{ rendition: 2.5 }, /positive integer/],
    [{ rendition: -8 }, /positive integer/],
    // A string is now refused as a SHAPE problem rather than an integer one: the
    // argument accepts two forms, so "not a number" no longer means "not an integer".
    [{ rendition: "64" }, /pixel size or a \{ width, height \} shape/],
    [{ rendition: 513 }, /at most 512/],
  ];
  for (const [args, pattern] of refused) {
    await assert.rejects(() => attestLocalFromArgs("gen-1", registry, args), pattern);
  }
  // And the largest allowed size still works, so the cap is at the boundary the
  // message names rather than somewhere short of it.
  const biggest = await attestLocalFromArgs("gen-1", registry, { rendition: 512 });
  assert.equal((biggest.artifact.body as { media?: { size?: number } }).media?.size, 512);
});

test("a caller can ship a LOSSY strip, and the verifier that judges it accepts it", async () => {
  const values = [10, 20, 30, 40, 200, 255, 0, 128];
  const made = await attestAiLocally("bounded-1", registryFor(boundedChallenge), { values, rendition: {} });
  const body = made.artifact.body as { values: number[]; media?: Record<string, number | string> };
  const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

  assert.ok(body.media, "the artifact carries a strip when one was asked for");
  // The width is the RULE's: one lane per value at its scale — not a count a caller
  // picks, and not the pixel size the generative shape uses.
  assert.equal(body.media.width, reference.length * BOUNDED_RASTER_SCALE);
  assert.equal(body.media.height, BOUNDED_RASTER_HEIGHT);
  assert.equal(body.media.rule, BOUNDED_RASTER_RULE);

  // The registry's OWN check decides it, and the local verifier accepts the artifact.
  assert.equal(boundedRenditionHolds(body as never, boundedChallenge.spec as never, sha256), true);
  assert.equal(made.verification.correct, true, "the verifier that judges the artifact accepts its strip");
});

test("the two rendition shapes are not interchangeable", async () => {
  const values = [10, 20, 30, 40, 200, 255, 0, 128];
  await assert.rejects(
    () => attestLocalFromArgs("bounded-1", registryFor(boundedChallenge), { values, rendition: 64 }),
    /is lossy: its rendition is a \{ width, height \} strip, not a 64-pixel size/,
  );
  await assert.rejects(
    () => attestLocalFromArgs("gen-1", registryFor(generativeChallenge), { rendition: { width: 128 } }),
    /is generative: its rendition is a pixel size/,
  );
});

test("the strip shape is a boundary in its own right", async () => {
  const values = [10, 20, 30, 40, 200, 255, 0, 128];
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ rendition: { width: 0 } }, /rendition\.width must be an integer/],
    [{ rendition: { height: 2.5 } }, /rendition\.height must be an integer/],
    [{ rendition: { width: 513 } }, /rendition\.width must be an integer/],
    [{ rendition: {} }, /supply size, width or height/],
    [{ rendition: "big" }, /pixel size or a \{ width, height \} shape/],
  ];
  for (const [args, pattern] of refused) {
    await assert.rejects(() => attestLocalFromArgs("bounded-1", registryFor(boundedChallenge), { values, ...args }), pattern);
  }
  // The rule's own shape, asked for explicitly, still works.
  const shaped = await attestLocalFromArgs("bounded-1", registryFor(boundedChallenge), { values, rendition: { width: 128 } });
  assert.equal((shaped.artifact.body as { media?: { width?: number } }).media?.width, 128);
});

test("the MCP's maker and the SDK's maker build the same evidence for the same run", async () => {
  // A THIRD pair of makers after the page/core pins: the MCP's attestAiLocally and the
  // SDK's selfPublishGenerative both assemble a generative run — the MCP without keys, the
  // SDK signed and self-published. If either assembly changes its body, artifact, or trace
  // construction, the two must disagree HERE, on the day it is made, not when a verifier
  // somewhere accepts one maker's artifact and refuses the other's.
  const { AgentSigner, generateAgentKeypair, selfPublishGenerative } = await import(
    "../../../packages/agent-sdk/src/index.ts"
  );
  const seed = 20261031 % 2147483647;

  const mcp = await attestAiLocally(
    generativeChallenge.id,
    { challenge: async () => generativeChallenge },
    { seed },
  );

  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const made = selfPublishGenerative(signer, {
    author: "resident",
    title: "the pin",
    model: model as never,
    seed,
    challenge: generativeChallenge as never,
    binding: { id: "ai-generative/gen-1", version: 1, claimKind: "satisfies" as never },
  });

  assert.equal(
    mcp.attestation.traceHash,
    made.attestation.traceHash,
    "the MCP's and the SDK's makers must build the same trace for the same model, seed, and steps",
  );
  assert.equal(
    mcp.attestation.circuitHash,
    made.attestation.circuitHash,
    "the MCP's and the SDK's makers must hash the same artifact for the same run",
  );
  assert.equal(mcp.verification.correct, true);
  assert.equal(made.attestation.correct, true);
});

test("the MCP's bounded maker and the SDK's bounded maker build the same evidence for the same run", async () => {
  // The bounded twin of the generative pin: the MCP's attestAiLocally and the SDK's
  // selfPublishBounded both assemble a bounded run from the same values. A change to either
  // body, artifact, or trace construction must fail here, on the day it is made.
  const { AgentSigner, generateAgentKeypair, selfPublishBounded } = await import(
    "../../../packages/agent-sdk/src/index.ts"
  );
  const values = [11, 21, 29, 44, 198, 251, 3, 124];

  const mcp = await attestAiLocally("bounded-1", registryFor(boundedChallenge), { values });

  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const made = selfPublishBounded(signer, {
    author: "resident",
    title: "the bounded pin",
    values,
    challenge: boundedChallenge as never,
    binding: { id: "ai-bounded/bounded-1", version: 1, claimKind: "satisfies" as never },
  });

  assert.equal(
    mcp.attestation.traceHash,
    made.attestation.traceHash,
    "the MCP's and the SDK's bounded makers must build the same trace for the same values",
  );
  assert.equal(
    mcp.attestation.circuitHash,
    made.attestation.circuitHash,
    "the MCP's and the SDK's bounded makers must hash the same artifact for the same values",
  );
  assert.equal(mcp.verification.correct, true);
  assert.equal(made.attestation.correct, true);
});
