import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createHash } from "node:crypto";
import { canonicalize, generativeRenditionHolds, renderRaster } from "@rarext/core";
import {
  AgentSigner,
  encodePngRaster,
  generateAgentKeypair,
  replayBundleAi,
  selfPublishGenerative,
  verifyBundle,
  verifyPayload,
} from "../src/index.ts";

/**
 * An AI output made and proved offline: the agent runs the committed model
 * itself, attests the run under its own verifier name, signs it, and assembles
 * the bundle — then the claim replays from the bundle alone.
 *
 * The model, seed and steps are the ones the PUBLISHED bundle was generated
 * with, so the strongest assertion is available and is made here: the agent's
 * local run reproduces the registry's published output byte for byte. That is
 * what "AI lives on RAREXT" means concretely — the artifact is portable because
 * the computation is, not because anyone vouches for it.
 */

interface CommittedBundle {
  publications: Array<{
    app?: string;
    artifact: { body: { model: unknown; seed: number; output: string } };
  }>;
  challenges: Array<{ id: string }>;
  semantics: Array<{ id: string }>;
}

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as CommittedBundle;
const published = committed.publications.find((entry) => entry.app === "ai-generative")!;
const model = published.artifact.body.model;
const seed = published.artifact.body.seed;

// The committed records the published claim itself was made under: a resident
// that claims the same rule carries the same challenge and semantics, so the
// comparison against the published output is apples to apples.
const challenge = committed.challenges.find((entry) => entry.id === "gen-starter")!;
const semantics = committed.semantics.filter((entry) => entry.id === "ai-generative/gen-starter");

const binding = { id: "ai-generative/gen-starter", version: 1, claimKind: "generative" as const };

test("the agent's own run reproduces the PUBLISHED output, and the claim replays from the bundle", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const made = selfPublishGenerative(
    signer,
    {
      author: "resident",
      title: "The starter model, run here",
      model: model as never,
      seed,
      challenge: challenge as never,
      semantics: semantics as never,
      binding,
      createdAt: "2026-10-28T00:00:00.000Z",
    },
  );

  // 1. The run is the run: same model, same seed, same steps, same output as the
  //    registry published — computed here, not copied from it.
  const ran = generatedOutput(made.publication);
  assert.equal(
    ran,
    published.artifact.body.output,
    "the local run reproduces the published output exactly",
  );

  // 2. The attestation is the agent's own, and the run it records is correct.
  assert.equal(
    made.attestation.verifier,
    "xorshift32-replay",
    "the attestation names the RULE that ran; who ran it is the signature",
  );
  assert.equal(made.attestation.correct, true);
  assert.equal(made.attestation.representation, "generative");
  assert.equal(made.attestation.claimKind, "generative");
  assert.equal(made.attestation.app, "ai-generative");
  assert.equal(made.attestation.gateCount, 32, "the steps are the record's gate count");

  // 3. The signature is over this payload, under the agent's own key.
  assert.ok(made.publication.signature, "a signature exists");
  assert.equal(
    verifyPayload(signer.publicKey, made.payload, made.publication.signature!, signer.suite),
    true,
    "the record is signed by this agent, over this payload",
  );

  // 4. And the claim is checkable by anyone holding only the bundle.
  const verification = verifyBundle(made.bundle);
  assert.equal(verification.valid, true, verification.reason ?? undefined);

  const replay = replayBundleAi(JSON.parse(JSON.stringify(made.bundle)));
  assert.equal(replay.claims.length, 1, "the bundle carries one AI claim");
  assert.equal(replay.claims[0]!.correct, true, "and it replays CORRECT by recomputation");
  assert.equal(replay.root, made.bundle.manifest.root, "tied to the bundle's own root");
});

test("an output that is not the model's is refused, however well it is attested", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const made = selfPublishGenerative(signer, {
    author: "resident",
    title: "forged",
    model: model as never,
    seed,
    challenge: challenge as never,
    semantics: semantics as never,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  // Swap the output for something the model never produced, leaving the
  // attestation and the signature in place — the shape of a lie about a
  // generation.
  const forged = JSON.parse(JSON.stringify(made.bundle)) as typeof made.bundle;
  const body = forged.publications[0]!.artifact.body as { output: string };
  body.output = `${body.output.slice(0, -4)}zzzz`;

  const replay = replayBundleAi(forged);
  assert.equal(replay.claims.length, 1);
  assert.equal(
    replay.claims[0]!.correct,
    false,
    "the output is not the committed model's, so the claim is false — the signature cannot make it true",
  );
});

function generatedOutput(publication: { artifact: { body: unknown } }): string {
  return (publication.artifact.body as { output: string }).output;
}

test("the SDK refuses to make a record with nonsense in it", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const call = (overrides: Record<string, unknown>) =>
    selfPublishGenerative(signer, {
      author: "resident",
      title: "nonsense",
      model: model as never,
      seed,
      challenge: challenge as never,
      semantics: semantics as never,
      binding,
      createdAt: "2026-10-28T00:00:00.000Z",
      ...overrides,
    } as never);

  // Each of these was ACCEPTED before this boundary existed, and each produced a
  // signed record with the nonsense field visible in it.
  assert.throws(() => call({ steps: -3 }), /steps must be a non-negative integer/, "a negative gate count is not a run");
  assert.throws(() => call({ steps: 2.5 }), /steps must be a non-negative integer/, "nor is a fractional one");
  assert.throws(() => call({ seed: Number.NaN }), /seed must be a finite number/, "and a NaN seed produced an output, which is worse than refusing");
  assert.throws(() => call({ seed: "42" }), /seed must be a finite number/, "a string seed is not a seed");
  assert.throws(
    () => call({ steps: 1_000_000_000 }),
    /must not exceed/,
    "an enormous step count would materialise gigabytes from a model: a denial of service wearing the shape of a parameter",
  );

  // The boundary is not a blanket: zero steps is a legitimate (if useless) run,
  // and the smallest real one still works.
  const zero = call({ steps: 0 });
  assert.equal(zero.attestation.gateCount, 0);
});

test("a resident can ship a rendition, and it is a function of the commitment", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

  const made = selfPublishGenerative(signer, {
    author: "resident",
    title: "with a picture",
    model: model as never,
    seed,
    challenge: challenge as never,
    semantics: semantics as never,
    binding,
    rendition: 64,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  const body = made.publication.artifact.body as { media?: Record<string, unknown> };
  assert.ok(body.media, "the artifact carries a rendition");

  // The RENDITION CHECK the registry runs accepts it — the picture is this
  // artifact's own, re-derived from the committed model and seed.
  assert.equal(
    generativeRenditionHolds(body as never, sha256),
    true,
    "the raster re-derives from the commitment, so the claim covers the picture too",
  );

  // The PNG is one encoding of that raster, and both digests are recorded.
  const raster = made.publication.artifact.body as { media: { raster: string; blob: string; size: number; bytes: number } };
  const rasterBytes = renderRaster(model as never, seed, 64);
  assert.equal(raster.media.raster, sha256(rasterBytes), "the raster digest is the commitment");
  const png = encodePngRaster(rasterBytes, 64);
  assert.equal(raster.media.blob, sha256(png), "the blob digest is the PNG a mirror would serve");
  assert.equal(raster.media.bytes, png.length);

  // And a picture that is not this artifact's makes the claim false.
  const forged = { ...body, media: { ...(body.media as object), raster: "0".repeat(64) } };
  assert.equal(generativeRenditionHolds(forged as never, sha256), false);
});

test("without a rendition the artifact stays lean, as before", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const made = selfPublishGenerative(signer, {
    author: "resident",
    title: "values only",
    model: model as never,
    seed,
    challenge: challenge as never,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  });
  const body = made.publication.artifact.body as { media?: unknown };
  assert.equal(body.media, undefined, "no rendition asked for, none shipped");
});
