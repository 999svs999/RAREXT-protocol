import { createHash, randomUUID } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Artifact,
  Attestation,
  Challenge,
} from "../../../packages/core/src/index.ts";
import type { AppVerifier } from "./verifiers.ts";
import {
  bindClaim,
  hashValue,
  semanticsForChallenge,
  type ClaimOptions,
  type SemanticsRegistry,
} from "./semantics.ts";

/**
 * The first on-chain AI verifier: it does not trust a claimed output, it
 * replays it. An artifact declares a committed model (a deterministic
 * generator, digest-bound), a seed, and the output someone claims the model
 * produced. Verification recomputes the output from the digest-bound model
 * and the seed and compares — the attestation is about *provenance*, not
 * about the text being good. Larger model classes slot in later through the
 * `bounded` representation kind; this path proves the generative plumbing.
 */

const GENERATIVE_APP = "ai-generative";
const GENERATIVE_KIND = "ai.generative";

const GENERATIVE_VERIFIER_MANIFEST = {
  app: GENERATIVE_APP,
  version: 1,
  algorithm: "xorshift32-replay",
  representation: "generative",
} as const;

export function generativeVerifierHash(): string {
  return hashValue(GENERATIVE_VERIFIER_MANIFEST);
}

/**
 * A committed generative model. `kind` pins the replay algorithm; `params`
 * and `vocab` are part of the commitment — changing any of them changes the
 * model digest and therefore the attestation.
 */
export interface XorshiftModel {
  kind: "xorshift32";
  params: { a: number; b: number; c: number };
  vocab: string[];
}

/** Artifact body for `ai.generative`: a model, a seed, and the claimed output. */
export interface GenerativeBody {
  model: XorshiftModel;
  seed: number;
  output: string;
}

/** Challenge spec: how many tokens the model must generate. */
export interface GenerativeSpec {
  steps: number;
}

export const MAX_GENERATIVE_STEPS = 100_000;
export const MAX_VOCAB = 4096;

export function modelDigest(model: XorshiftModel): string {
  return createHash("sha256").update(canonicalize(model)).digest("hex");
}

function isXorshiftModel(value: unknown): value is XorshiftModel {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Partial<XorshiftModel>;
  if (model.kind !== "xorshift32") return false;
  const params = model.params as Partial<XorshiftModel["params"]> | undefined;
  if (!params) return false;
  return (
    Number.isInteger(params.a) && params.a! >= 1 && params.a! <= 31 &&
    Number.isInteger(params.b) && params.b! >= 1 && params.b! <= 31 &&
    Number.isInteger(params.c) && params.c! >= 1 && params.c! <= 31 &&
    Array.isArray(model.vocab) &&
    model.vocab.length >= 1 &&
    model.vocab.length <= MAX_VOCAB &&
    model.vocab.every((token) => typeof token === "string" && token.length > 0)
  );
}

export function isGenerativeBody(value: unknown): value is GenerativeBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<GenerativeBody>;
  return (
    isXorshiftModel(body.model) &&
    Number.isInteger(body.seed) &&
    body.seed! >= 0 &&
    body.seed! <= 0xffffffff &&
    typeof body.output === "string"
  );
}

export function isGenerativeSpec(value: unknown): value is GenerativeSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Partial<GenerativeSpec>;
  return (
    Number.isInteger(spec.steps) &&
    spec.steps! >= 1 &&
    spec.steps! <= MAX_GENERATIVE_STEPS
  );
}

/**
 * Replay the model deterministically. xorshift32, the canonical Marsaglia
 * form: x ^= x << a; x ^= x >>> b; x ^= x << c, all mod 2^32. The token at
 * each step is vocab[state % vocab.length].
 */
export function generate(model: XorshiftModel, seed: number, steps: number): string {
  const { a, b, c } = model.params;
  let state = seed >>> 0;
  let out = "";

  for (let i = 0; i < steps; i++) {
    state ^= (state << a) >>> 0;
    state ^= state >>> b;
    state ^= (state << c) >>> 0;
    state >>>= 0;
    out += model.vocab[state % model.vocab.length];
  }

  return out;
}

export interface GenerativeReplayResult {
  correct: boolean;
  expected: string;
  digest: string;
}

/** Pure replay check, exported for independent re-verification (web, SDK, tests). */
export function verifyGenerativeReplay(
  body: GenerativeBody,
  spec: GenerativeSpec,
): GenerativeReplayResult {
  const digest = modelDigest(body.model);
  const expected = generate(body.model, body.seed, spec.steps);
  return { correct: expected === body.output, expected, digest };
}

export function generativeVerifier(
  semantics: SemanticsRegistry | null,
): AppVerifier {
  return {
    id: GENERATIVE_APP,
    name: "Generative AI",
    version: "1",
    description:
      "Committed generative models verified by deterministic replay: the output must be exactly what the digest-bound model produces from the seed.",
    artifactKinds: [GENERATIVE_KIND],
    challengeCount: 0,
    verifier: "builtin",
    configured: true,
    url: null,
    supports: (artifact) =>
      artifact.app === GENERATIVE_APP && artifact.kind === GENERATIVE_KIND,
    verify: async (artifact, challenge) => {
      if (!isGenerativeBody(artifact.body)) {
        throw new Error("ai.generative artifact body must be { model, seed, output }");
      }

      if (!isGenerativeSpec(challenge.spec)) {
        throw new Error(`challenge ${challenge.id} is not a generative task`);
      }

      const body = artifact.body;
      const replay = verifyGenerativeReplay(body, challenge.spec);
      const bound = semantics
        ? semanticsForChallenge(semantics, challenge)
        : null;

      const trace = {
        modelDigest: replay.digest,
        seed: body.seed,
        steps: challenge.spec.steps,
        expected: replay.expected,
      };

      const attestation: Attestation = {
        id: randomUUID(),
        verifier: GENERATIVE_VERIFIER_MANIFEST.algorithm,
        app: GENERATIVE_APP,
        challengeId: challenge.id,
        taskId: challenge.id,
        circuitHash: hashValue(artifact),
        traceHash: hashValue(trace),
        correct: replay.correct,
        score: replay.correct ? 100 : 0,
        gateCount: challenge.spec.steps,
        semanticsId: bound?.id ?? `${GENERATIVE_APP}/${challenge.id}`,
        semanticsVersion: bound?.version ?? 1,
        semanticsHash: bound ? hashValue(bound) : "",
        claimKind: bound?.claimKind ?? "satisfies",
        representation: "generative",
        scope: null,
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        verifierHash: generativeVerifierHash(),
        createdAt: new Date().toISOString(),
      };

      return attestation;
    },
  };
}

/** Convenience wrapper mirroring the registry's verify-then-bind flow. */
export async function verifyGenerative(
  artifact: Artifact,
  challenge: Challenge,
  registry: SemanticsRegistry,
  options: ClaimOptions = {},
): Promise<{ attestation: Attestation } | { error: string }> {
  const verifier = generativeVerifier(registry);

  if (!verifier.supports(artifact, challenge)) {
    return { error: `verifier ${verifier.id} does not support artifact: ${artifact.kind}` };
  }

  return verifier
    .verify(artifact, challenge)
    .then((attestation) => bindClaim(attestation, challenge, registry, options));
}
