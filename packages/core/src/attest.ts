import { canonicalize } from "./canonical.ts";
import { score } from "./scoring.ts";
import { simulate } from "./simulator.ts";
import type {
  Attestation,
  Circuit,
  ClaimKind,
  ClaimScope,
  CryptoProfile,
  ProofKind,
  SignatureSuite,
  Task,
} from "./types.ts";

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

/** Hash of the run's trace, computed the one way both sides compute it. */
export function traceHashOf(
  circuit: Circuit,
  task: Task,
  sha256: (value: string) => string,
): string {
  const trace = task.cases.map((testCase) => {
    const run = simulate(circuit, testCase.inputs);
    return {
      outputs: run.outputs,
      values: run.values,
      settled: run.settled,
      iterations: run.iterations,
      trace: run.trace,
    };
  });

  return sha256(canonicalize(trace));
}

/**
 * Assemble an attestation for a run — the verifier's record of what it computed.
 *
 * This lived in the registry (`apps/api/src/attest.ts`), which made attesting a
 * thing only a server could do: a resident with no server could replay a claim
 * and not make one, so "AI lives on RAREXT" stopped at the registry's door. The
 * run itself was always pure — a circuit, a task, `simulate` — so the assembly is
 * here, where the run is.
 *
 * Everything the registry used to read from its surroundings is a parameter now:
 * the verifier's NAME is the caller's (a resident attests as itself, and says so),
 * the clock is the caller's, the id is the caller's, and the hash is injected so
 * core keeps no crypto dependency. What remains is arithmetic and the canonical
 * form of the trace — the part that must be identical on both sides, or a
 * resident's attestation and the registry's would not describe the same run.
 */
export function attestRun(input: {
  circuit: Circuit;
  task: Task;
  binding: AttestationBinding;
  /** Who is asserting this: the registry, or the agent that ran it. */
  verifier: string;
  id: string;
  createdAt: string;
  sha256: (value: string) => string;
}): Attestation {
  const result = score(input.circuit, input.task);

  return {
    id: input.id,
    verifier: input.verifier,
    taskId: input.task.id,
    circuitHash: input.sha256(canonicalize(input.circuit)),
    traceHash: traceHashOf(input.circuit, input.task, input.sha256),
    correct: result.correct,
    score: result.score,
    gateCount: result.gateCount,
    semanticsId: input.binding.semanticsId,
    semanticsVersion: input.binding.semanticsVersion,
    semanticsHash: input.binding.semanticsHash,
    claimKind: input.binding.claimKind,
    scope: input.binding.scope,
    verifierHash: input.binding.verifierHash,
    proofKind: input.binding.proofKind,
    signatureAlgorithm: input.binding.signatureAlgorithm,
    cryptoProfile: input.binding.cryptoProfile,
    createdAt: input.createdAt,
  };
}
