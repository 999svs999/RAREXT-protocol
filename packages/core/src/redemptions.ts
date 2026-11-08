import { canonicalize } from "./canonical.ts";
import type { CreditRecordFields } from "./credits.ts";
import type { HashFn } from "./ai.ts";

/** Domain separation: a redemption's root can never be mistaken for another rule's output. */
export const REDEMPTION_ROOT_DOMAIN = "rarext.credit-redemption.root.v1";

export const REDEMPTION_KIND = "rarext.credit-redemption.v1";

/** The one action a redemption leaves. Like `transfer`, it is not a work action. */
export const REDEEM_ACTION = "redeem";

/**
 * Moving credits OFF the ledger.
 *
 * A transfer keeps value inside the ledger — a debit and a credit that sum to
 * zero. A redemption is the other half of a cash-out: the redeemer authorizes
 * the ledger to REMOVE `amount` credits and names the external settlement it is
 * against (`reference`), so the removal is bound to the thing that paid out. The
 * ledger itself does not move real value — it cannot, and pretending otherwise
 * would be a lie — but it records, with the same double-spend guarantees as a
 * transfer, that these credits left circulation against that reference.
 *
 * `reference` is a commitment to the off-ledger settlement (a chain transaction
 * id, an escrow id, a bank reference). `nonce` is the redeemer's freshness value:
 * the same signed instruction can never be applied twice because its identity is
 * a function of the nonce.
 */
export interface RedemptionInstruction {
  kind: typeof REDEMPTION_KIND;
  from: string;
  amount: number;
  reference: string;
  nonce: string;
  at: string;
}

/** A redemption's identity, recomputed from the instruction itself. */
export function redemptionRoot(instruction: RedemptionInstruction, hash: HashFn): string {
  return hash(`${REDEMPTION_ROOT_DOMAIN}\n${canonicalize(instruction)}`);
}

/** Structural checks, independent of any ledger. */
export function redemptionProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["a redemption must be an object"];
  }
  const redemption = value as Record<string, unknown>;
  if (redemption.kind !== REDEMPTION_KIND) {
    problems.push(`redemption.kind must be "${REDEMPTION_KIND}"`);
  }
  if (typeof redemption.from !== "string" || redemption.from.length === 0) {
    problems.push("redemption.from must be a non-empty key id");
  }
  if (!Number.isSafeInteger(redemption.amount) || (redemption.amount as number) <= 0) {
    problems.push("redemption.amount must be a positive integer of credits");
  }
  if (typeof redemption.reference !== "string" || redemption.reference.length === 0) {
    problems.push("redemption.reference must be a non-empty external reference");
  }
  if (typeof redemption.nonce !== "string" || redemption.nonce.length === 0) {
    problems.push("redemption.nonce must be a non-empty string");
  }
  if (typeof redemption.at !== "string" || Number.isNaN(Date.parse(redemption.at))) {
    problems.push("redemption.at must be an ISO timestamp");
  }
  return problems;
}

/**
 * The single ledger record a redemption leaves: a debit on the redeemer with no
 * matching credit. That asymmetry is the point — it is what removes value from
 * the ledger — and it is why the no-overdraft rule is also the double-spend
 * rule: a redeemer can only remove credits it holds, and cannot remove them
 * twice because the first removal is already in the balance.
 */
export function redemptionRecords(instruction: RedemptionInstruction, hash: HashFn): CreditRecordFields[] {
  return [
    {
      keyId: instruction.from,
      action: REDEEM_ACTION,
      bounty: -instruction.amount,
      challengeId: instruction.reference,
      artifactHash: redemptionRoot(instruction, hash),
      at: instruction.at,
    },
  ];
}

/**
 * The credits still in circulation: the ledger total. A transfer leaves it
 * unchanged (a zero-sum pair); a redemption lowers it by exactly the amount
 * removed — which is what "off the ledger" means, stated as a number anyone can
 * recompute.
 */
export function creditSupply(records: readonly CreditRecordFields[]): number {
  return records.reduce((total, record) => total + record.bounty, 0);
}
