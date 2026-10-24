import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import { AI_SEMANTICS } from "../../../packages/core/src/index.ts";
import { createChallengeRegistry } from "../src/challenges.ts";
import {
  generativeVerifierHash,
  verifyGenerative,
} from "../src/generative.ts";
import { bindClaim, createSemanticsRegistry } from "../src/semantics.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";

const seeded = createChallengeRegistry().get("gen-starter");
if (!seeded) throw new Error("gen-starter seed missing");
const challenge: Challenge = seeded;

function artifactFor(output: string): Artifact {
  const body = (challenge.sampleArtifact as Artifact).body as {
    model: Parameters<typeof import("../src/generative.ts").generate>[0];
    seed: number;
    output: string;
  };
  return {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: { ...body, output },
  };
}

test("the registry binds gen-starter to the declared generative semantics", () => {
  const semantics = createSemanticsRegistry(() => [challenge]);

  const declared = semantics.get("ai-generative/gen-starter", 1);
  if (!declared) throw new Error("declared AI semantics missing from the registry");
  assert.equal(declared.claimKind, "generative");
  assert.equal(semantics.bindingFor(challenge), "ok");
});

test("the pinned verifier hash in semantics matches the live verifier", () => {
  const record = AI_SEMANTICS[0]!;
  assert.equal(record.verifierHash, generativeVerifierHash());
});

test("a verified generative artifact claims kind generative end to end", async () => {
  const challenges = [challenge];
  const semantics = createSemanticsRegistry(() => challenges);
  const registry = createVerifierRegistry(fetch, semantics);

  const sample = challenge.sampleArtifact as Artifact;
  const attestation = await registry.verify(sample, challenge);

  assert.equal(attestation.correct, true);
  assert.equal(attestation.representation, "generative");
  assert.equal(attestation.claimKind, "generative");
  assert.equal(attestation.semanticsId, "ai-generative/gen-starter");
  assert.equal(attestation.semanticsHash.length, 64);
  assert.equal(attestation.verifierHash, generativeVerifierHash());
});

test("a satisfied-claims alternative would be rejected: the meaning licenses only generative", async () => {
  const challenges = [challenge];
  const semantics = createSemanticsRegistry(() => challenges);

  const sample = challenge.sampleArtifact as Artifact;
  const result = await verifyGenerative(sample, challenge, semantics, {
    claimKind: "satisfies",
  });

  if (!("error" in result)) throw new Error("expected the binding to be rejected");
  assert.match(result.error, /licenses "generative" claims/);
});

test("the bounded starter binds to its declared meaning end to end", async () => {
  const bounded = createChallengeRegistry().get("bounded-starter");
  if (!bounded) throw new Error("bounded-starter seed missing");

  const challenges = [challenge, bounded];
  const semantics = createSemanticsRegistry(() => challenges);
  const registry = createVerifierRegistry(fetch, semantics);

  const sample = bounded.sampleArtifact as Artifact;
  const attestation = await registry.verify(sample, bounded);

  assert.equal(attestation.correct, true);
  assert.equal(attestation.representation, "bounded");
  assert.equal(attestation.claimKind, "bounded");
  assert.equal(attestation.semanticsId, "ai-bounded/bounded-starter");
  assert.equal(attestation.verifierHash, AI_SEMANTICS[1]!.verifierHash);
});

test("a satisfied-claims alternative is rejected for the bounded starter too", async () => {
  const bounded = createChallengeRegistry().get("bounded-starter");
  if (!bounded) throw new Error("bounded-starter seed missing");

  const challenges = [challenge, bounded];
  const semantics = createSemanticsRegistry(() => challenges);

  const sample = bounded.sampleArtifact as Artifact;
  const verifier = createVerifierRegistry(fetch, null);
  const attestation = await verifier.verify(sample, bounded);
  const bound = bindClaim(attestation, bounded, semantics, { claimKind: "satisfies" });

  assert.ok("error" in bound);
  assert.match(bound.error, /licenses "bounded" claims/);
});
