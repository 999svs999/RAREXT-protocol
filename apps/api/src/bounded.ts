import { createHash, randomUUID } from "node:crypto";

import {
  attestBoundedRun,
  boundedScore,
  computeBoundedMetric,
  isBoundedBody,
  isBoundedMedia,
  isBoundedSpec,
  maxAbsError,
  meanAbsError,
  renderBoundedRaster,
  verifyBoundedReconstruction as reconstructBounded,
  type BoundedBody,
  type BoundedMetric,
  type BoundedSpec,
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
  boundedScore,
  computeBoundedMetric,
  isBoundedBody,
  isBoundedSpec,
  maxAbsError,
  meanAbsError,
};
export type { BoundedBody, BoundedMetric, BoundedSpec };
export { MAX_BOUNDED_LENGTH } from "../../../packages/core/src/index.ts";

/** The registry's sha256: node's, over text or bytes. */
const sha256Of = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/** Pure metric check with the exact same contract as before the core hoist. */
export const verifyBoundedReconstruction = reconstructBounded;

/**
 * The second on-chain AI verifier: bounded verification. Where `ai-generative`
 * demands exact replay, `ai-bounded` accepts a lossy reconstruction — a
 * quantized model, a compressed embedding, a neural codec output — as long as
 * a declared metric against the committed reference stays within the declared
 * bound. This is the path real model classes take onto the chain: nobody can
 * hash-compare a float tensor regenerated on other hardware, but everyone can
 * agree that "maxAbsError <= 2 of 255" is a meaningful, checkable promise.
 *
 * The challenge spec carries the reference data (the ground truth commitment,
 * bound by its specHash in semantics) exactly the way logic specs carry truth
 * tables. The artifact carries the lossy reconstruction. Verification is a
 * pure metric computation — recomputable by anyone.
 */

const BOUNDED_APP = "ai-bounded";
const BOUNDED_KIND = "ai.bounded";

const BOUNDED_VERIFIER_MANIFEST = {
  app: BOUNDED_APP,
  version: 1,
  metrics: ["maxAbsError", "meanAbsError"],
  representation: "bounded",
} as const;

export function boundedVerifierHash(): string {
  return hashValue(BOUNDED_VERIFIER_MANIFEST);
}

export function boundedVerifier(
  semantics: SemanticsRegistry | null,
): AppVerifier {
  const verifier: AppVerifier = {
    id: BOUNDED_APP,
    name: "Bounded AI",
    version: "1",
    description:
      "Lossy AI reconstructions verified by declared metric bounds: the reconstruction must stay within the committed metric bound of the reference.",
    artifactKinds: [BOUNDED_KIND],
    challengeCount: 0,
    verifier: "builtin",
    configured: true,
    url: null,
    supports: (artifact) =>
      artifact.app === BOUNDED_APP && artifact.kind === BOUNDED_KIND,
    verify: async (artifact, challenge) => {
      if (!isBoundedBody(artifact.body)) {
        throw new Error("ai.bounded artifact body must be { values: number[] }");
      }

      if (!isBoundedSpec(challenge.spec)) {
        throw new Error(`challenge ${challenge.id} is not a bounded task`);
      }

      const body = artifact.body;

      // The metric check, the rendition check and the trace hash all happen
      // inside core's assembly now — one implementation, shared with any
      // resident that computes the same metric under the same bound. The
      // registry keeps what is its business: who it is, and which semantics this
      // challenge binds.
      const bound = semantics
        ? semanticsForChallenge(semantics, challenge)
        : null;

      const attestation = attestBoundedRun({
        artifact,
        body,
        spec: challenge.spec,
        app: BOUNDED_APP,
        challengeId: challenge.id,
        // The rule's name, not the operator's: an agent computing the same
        // metric under the same bound is running `bounded-metric-replay`.
        verifier: "bounded-metric-replay",
        verifierManifest: BOUNDED_VERIFIER_MANIFEST,
        bound: bound ? { id: bound.id, version: bound.version, claimKind: bound.claimKind } : null,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        sha256: sha256Of,
      });

      return attestation;
    },
  };

  return verifier;
}

/** Convenience wrapper mirroring the registry's verify-then-bind flow. */
export async function verifyBounded(
  artifact: Artifact,
  challenge: Challenge,
  registry: SemanticsRegistry,
  options: ClaimOptions = {},
): Promise<{ attestation: Attestation } | { error: string }> {
  const verifier = boundedVerifier(registry);

  if (!verifier.supports(artifact, challenge)) {
    return { error: `verifier ${verifier.id} does not support artifact: ${artifact.kind}` };
  }

  const attestation = await verifier.verify(artifact, challenge);
  return bindClaim(attestation, challenge, registry, options);
}
