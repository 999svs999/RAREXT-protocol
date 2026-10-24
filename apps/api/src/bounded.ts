import { randomUUID } from "node:crypto";

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

export type BoundedMetric = "maxAbsError" | "meanAbsError";

/** Artifact body for `ai.bounded`: the lossy reconstruction of the reference. */
export interface BoundedBody {
  values: number[];
  /** Optional codec label — descriptive only, never trusted for correctness. */
  codec?: string;
}

/** Challenge spec: the committed reference, the metric, and the bound. */
export interface BoundedSpec {
  metric: BoundedMetric;
  /** Maximum allowed metric value; the reconstruction must be at least this good. */
  bound: number;
  /** Ground-truth vector the artifact is reconstructed from. */
  reference: number[];
}

export const MAX_BOUNDED_LENGTH = 1 << 20;

export function isBoundedBody(value: unknown): value is BoundedBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<BoundedBody>;
  return (
    Array.isArray(body.values) &&
    body.values.length >= 1 &&
    body.values.length <= MAX_BOUNDED_LENGTH &&
    body.values.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

export function isBoundedSpec(value: unknown): value is BoundedSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Partial<BoundedSpec>;
  return (
    (spec.metric === "maxAbsError" || spec.metric === "meanAbsError") &&
    typeof spec.bound === "number" &&
    Number.isFinite(spec.bound) &&
    spec.bound >= 0 &&
    Array.isArray(spec.reference) &&
    spec.reference.length >= 1 &&
    spec.reference.length <= MAX_BOUNDED_LENGTH &&
    spec.reference.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** L∞ distance: the largest per-element absolute error. */
export function maxAbsError(values: number[], reference: number[]): number {
  let max = 0;
  for (let i = 0; i < reference.length; i++) {
    const err = Math.abs(values[i] - reference[i]);
    if (err > max) max = err;
  }
  return max;
}

/** L1 distance normalized by length: the mean per-element absolute error. */
export function meanAbsError(values: number[], reference: number[]): number {
  let sum = 0;
  for (let i = 0; i < reference.length; i++) {
    sum += Math.abs(values[i] - reference[i]);
  }
  return sum / reference.length;
}

export function computeBoundedMetric(
  metric: BoundedMetric,
  values: number[],
  reference: number[],
): number {
  return metric === "maxAbsError"
    ? maxAbsError(values, reference)
    : meanAbsError(values, reference);
}

export interface BoundedCheck {
  correct: boolean;
  metricValue: number;
}

/** Pure metric check, exported for independent re-verification (web, SDK, tests). */
export function verifyBoundedReconstruction(
  body: BoundedBody,
  spec: BoundedSpec,
): BoundedCheck | { error: string } {
  if (body.values.length !== spec.reference.length) {
    return {
      error: `reconstruction length ${body.values.length} does not match reference length ${spec.reference.length}`,
    };
  }

  const metricValue = computeBoundedMetric(spec.metric, body.values, spec.reference);
  return { correct: metricValue <= spec.bound, metricValue };
}

/** Graded score: perfect reconstruction scores 100, at-bound scores 1, over-bound 0. */
export function boundedScore(metricValue: number, bound: number): number {
  if (!(metricValue <= bound)) return 0;
  if (bound === 0) return metricValue === 0 ? 100 : 0;
  const ratio = metricValue / bound;
  return Math.max(1, Math.round(100 * (1 - ratio)));
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
      const check = verifyBoundedReconstruction(body, challenge.spec);

      if ("error" in check) {
        throw new Error(check.error);
      }

      const bound = semantics
        ? semanticsForChallenge(semantics, challenge)
        : null;

      const trace = {
        metric: challenge.spec.metric,
        metricValue: check.metricValue,
        bound: challenge.spec.bound,
        referenceDigest: hashValue(challenge.spec.reference),
        reconstructionDigest: hashValue(body.values),
      };

      const attestation: Attestation = {
        id: randomUUID(),
        verifier: "bounded-metric-replay",
        app: BOUNDED_APP,
        challengeId: challenge.id,
        taskId: challenge.id,
        circuitHash: hashValue(artifact),
        traceHash: hashValue(trace),
        correct: check.correct,
        score: boundedScore(check.metricValue, challenge.spec.bound),
        gateCount: body.values.length,
        semanticsId: bound?.id ?? `${BOUNDED_APP}/${challenge.id}`,
        semanticsVersion: bound?.version ?? 1,
        semanticsHash: bound ? hashValue(bound) : "",
        claimKind: bound?.claimKind ?? "satisfies",
        representation: "bounded",
        metricName: challenge.spec.metric,
        metricValue: check.metricValue,
        scope: null,
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        verifierHash: boundedVerifierHash(),
        createdAt: new Date().toISOString(),
      };

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
