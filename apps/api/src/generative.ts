import { createHash, randomUUID } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";

import {
  generate,
  isGenerativeBody,
  isGenerativeMedia,
  isGenerativeSpec,
  renderRaster,
  MAX_GENERATIVE_OUTPUT_LENGTH,
  MAX_GENERATIVE_STEPS,
  MAX_GENERATIVE_TOKEN_LENGTH,
  MAX_VOCAB,
  verifyGenerativeReplay as replayGenerative,
  type GenerativeBody,
  type GenerativeSpec,
  type XorshiftModel,
} from "../../../packages/core/src/index.ts";
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

export {
  generate,
  isGenerativeBody,
  isGenerativeSpec,
  MAX_GENERATIVE_OUTPUT_LENGTH,
  MAX_GENERATIVE_STEPS,
  MAX_GENERATIVE_TOKEN_LENGTH,
  MAX_VOCAB,
};
export type { GenerativeBody, GenerativeSpec, XorshiftModel };

export function modelDigest(model: XorshiftModel): string {
  return createHash("sha256").update(canonicalize(model)).digest("hex");
}

/**
 * The first on-chain AI verifier: it does not trust a claimed output, it
 * replays it. An artifact declares a committed model (a deterministic
 * generator, digest-bound), a seed, and the output someone claims the model
 * produced. Verification recomputes the output from the digest-bound model
 * and the seed and compares — the attestation is about *provenance*, not
 * about the text being good. Larger model classes slot in later through the
 * `bounded` representation kind; this path proves the generative plumbing.
 */

/**
 * Does the rendition in this body hold up against the commitment? `null` means
 * no rendition was shipped. A malformed one throws: a shape that cannot be
 * checked must not be attested. A rendition whose raster does not re-derive
 * from the committed model and seed returns false — it is not this model's
 * picture, whatever the blob beside it happens to contain.
 */
function generativeRenditionHolds(body: GenerativeBody): boolean | null {
  if (body.media === undefined) return null;

  if (!isGenerativeMedia(body.media)) {
    throw new Error(
      "ai.generative media must be a committed rendition: { mediaType: image/png, rule, blob, raster, size, bytes }",
    );
  }

  const raster = renderRaster(body.model, body.seed, body.media.size);
  return createHash("sha256").update(raster).digest("hex") === body.media.raster;
}

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

export interface GenerativeReplayResult {
  correct: boolean;
  expected: string;
  digest: string;
}

/** Pure replay check with the digest attached (hashing is a server-side concern). */
export function verifyGenerativeReplay(
  body: GenerativeBody,
  spec: GenerativeSpec,
): GenerativeReplayResult {
  const replay = replayGenerative(body, spec);
  return { ...replay, digest: modelDigest(body.model) };
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

      // An artifact may ship a picture of its own output. That picture is a
      // function of the commitment, so the serving side has to check it too:
      // otherwise the attestation blesses a byte count while the image beside
      // it is anything at all. A malformed rendition is refused outright; a
      // rendition that is not the function of its own model makes the claim
      // false, because the claim covers the rendition as well as the text.
      const rendition = generativeRenditionHolds(body);

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
        correct: replay.correct && rendition !== false,
        score: replay.correct && rendition !== false ? 100 : 0,
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
