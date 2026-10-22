import { createHash, randomUUID } from "node:crypto";

import { canonicalize, score, simulate } from "../../../packages/core/src/index.ts";
import type {
  Attestation,
  Circuit,
  ClaimKind,
  ClaimScope,
  CryptoProfile,
  ProofKind,
  SignatureSuite,
  Task,
} from "../../../packages/core/src/index.ts";

const VERIFIER = process.env.RAREXT_VERIFIER ?? "rarext-v0";

export interface AttestationBinding {
  semanticsId: string;
  semanticsVersion: number;
  semanticsHash: string;
  claimKind: ClaimKind;
  scope: ClaimScope | null;
  verifierHash: string;
  proofKind: ProofKind;
  signatureAlgorithm: SignatureSuite;
  cryptoProfile: CryptoProfile;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function attest(
  circuit: Circuit,
  task: Task,
  binding: AttestationBinding,
): Attestation {
  const result = score(circuit, task);
  const runs = task.cases.map((testCase) => simulate(circuit, testCase.inputs));

  const trace = runs.map((run) => ({
    outputs: run.outputs,
    values: run.values,
    settled: run.settled,
    iterations: run.iterations,
    trace: run.trace,
  }));

  return {
    id: randomUUID(),
    verifier: VERIFIER,
    taskId: task.id,
    circuitHash: sha256(canonicalize(circuit)),
    traceHash: sha256(canonicalize(trace)),
    correct: result.correct,
    score: result.score,
    gateCount: result.gateCount,
    semanticsId: binding.semanticsId,
    semanticsVersion: binding.semanticsVersion,
    semanticsHash: binding.semanticsHash,
    claimKind: binding.claimKind,
    scope: binding.scope,
    verifierHash: binding.verifierHash,
    proofKind: binding.proofKind,
    signatureAlgorithm: binding.signatureAlgorithm,
    cryptoProfile: binding.cryptoProfile,
    createdAt: new Date().toISOString(),
  };
}

export interface VerificationResult {
  valid: boolean;
  attestation: Attestation;
  recomputed: Attestation;
}

export function verify(
  circuit: Circuit,
  task: Task,
  attestation: Attestation,
  binding: AttestationBinding,
): VerificationResult {
  const recomputed = attest(circuit, task, binding);

  const valid =
    recomputed.circuitHash === attestation.circuitHash &&
    recomputed.traceHash === attestation.traceHash &&
    recomputed.score === attestation.score &&
    recomputed.gateCount === attestation.gateCount &&
    recomputed.correct === attestation.correct &&
    recomputed.semanticsId === attestation.semanticsId &&
    recomputed.semanticsVersion === attestation.semanticsVersion &&
    recomputed.semanticsHash === attestation.semanticsHash &&
    recomputed.claimKind === attestation.claimKind &&
    recomputed.verifierHash === attestation.verifierHash;

  return { valid, attestation, recomputed };
}
