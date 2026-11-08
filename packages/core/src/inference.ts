import { creditLedgerRoot } from "./credits.ts";
import type { CreditRecordFields } from "./credits.ts";
import type { HashFn } from "./ai.ts";

/**
 * The ledger action a model completion pays. It is a PAID action, unlike the
 * zero-bounty receipt classes: the buyer's demand is the run itself, and the
 * operator that answered is paid for the compute it actually did.
 */
export const INFER_ACTION = "infer";

/**
 * One provider's answer, as the run records it. Only the digest and the
 * operator identity matter here: the ledger pays the DISTINCT operators whose
 * digest equals the answer the run carries, so an operator cannot be paid twice
 * for the same run by running several endpoints.
 */
export interface InferenceQuorumProvider {
  /** Where the provider answered, when known. Not part of the payment. */
  endpoint?: string;
  /** canonical sha256 of the response this provider returned. */
  responseDigest: string;
  /** The operator identity the provider committed in its card, if any. */
  operator?: string | null;
}

export interface InferenceCreditInput {
  providers: readonly InferenceQuorumProvider[];
  /** canonical digest of the response the run carries (the agreed answer). */
  responseDigest: string;
  /** The deployment the run is under; the credit's `challengeId`. */
  deploymentDigest: string;
  /** When the run completed; the credit's `at`. */
  completedAt: string;
  /** Credits each distinct agreeing operator earns. */
  bounty: number;
}

/**
 * The credit records a completed quorum run pays.
 *
 * This is a DERIVATION, not a record a node keeps: every field is a function of
 * the run's own evidence (which operators answered, and whether their answer was
 * the one the run carries) plus the bounty the deployment committed. That is what
 * lets the SAME function run at the gateway that recorded the run and in the
 * verifier that recomputes the transcript — a second implementation of "who got
 * paid" is how two clients come to disagree about money.
 *
 * Only operators whose recorded digest equals the run's chosen response are paid:
 * a dissenter did work but did not answer the question the run attests, so it is
 * evidence, not a payee. A provider with no committed operator identity cannot be
 * paid, because there is no key to pay.
 */
export function inferenceCreditRecords(input: InferenceCreditInput): CreditRecordFields[] {
  if (!Number.isSafeInteger(input.bounty) || input.bounty <= 0) {
    throw new Error("inference bounty must be a positive integer");
  }

  const operators = new Set<string>();
  for (const provider of input.providers) {
    if (provider.responseDigest !== input.responseDigest) continue;
    if (typeof provider.operator === "string" && provider.operator !== "") {
      operators.add(provider.operator);
    }
  }

  return [...operators].sort().map((keyId) => ({
    keyId,
    action: INFER_ACTION,
    bounty: input.bounty,
    challengeId: input.deploymentDigest,
    artifactHash: input.responseDigest,
    at: input.completedAt,
  }));
}

/**
 * The commitment over a run's payments. The gateway publishes it in the run and
 * the verifier recomputes it, so the ledger is a fact about the transcript and
 * not the recorder's word.
 */
export function inferenceCreditLedgerRoot(input: InferenceCreditInput, hash: HashFn): string {
  return creditLedgerRoot(inferenceCreditRecords(input), hash);
}
