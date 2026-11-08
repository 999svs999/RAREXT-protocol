import { canonicalize } from "./canonical.ts";
import type { CreditRecordFields } from "./credits.ts";
import type { HashFn } from "./ai.ts";

/** Domain separation: a transfer's root can never be mistaken for another rule's output. */
export const TRANSFER_ROOT_DOMAIN = "rarext.credit-transfer.root.v1";

export const TRANSFER_KIND = "rarext.credit-transfer.v1";

/**
 * Moving credits between keys. A transfer is a signed instruction, not a
 * record a node writes down on trust: the payer authorizes the exact movement
 * (who, to whom, how much, once), and the ledger effect is the pair of records
 * the instruction implies. Whoever recomputes the ledger from the instructions
 * gets the same two records, which is what lets a transfer be audited without
 * trusting the node that recorded it.
 *
 * `nonce` is the payer's own freshness value: two transfers that differ only in
 * nonce are two movements, and the same signed instruction can never be applied
 * twice because its identity (the root) is a function of the nonce.
 */
export interface TransferInstruction {
  kind: typeof TRANSFER_KIND;
  from: string;
  to: string;
  amount: number;
  nonce: string;
  at: string;
}

/**
 * The one action a transfer leaves. It is deliberately not a work action: nobody
 * is paid to move value, and the board does not offer it as a job. It lives in
 * the same ledger and the same commitment as every other record.
 */
export const TRANSFER_ACTION = "transfer";

/** A transfer's identity, recomputed from the instruction itself. */
export function transferRoot(instruction: TransferInstruction, hash: HashFn): string {
  return hash(`${TRANSFER_ROOT_DOMAIN}\n${canonicalize(instruction)}`);
}

/** Structural checks, independent of any ledger. */
export function transferProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["a transfer must be an object"];
  }
  const transfer = value as Record<string, unknown>;
  if (transfer.kind !== TRANSFER_KIND) problems.push(`transfer.kind must be "${TRANSFER_KIND}"`);
  if (typeof transfer.from !== "string" || transfer.from.length === 0) {
    problems.push("transfer.from must be a non-empty key id");
  }
  if (typeof transfer.to !== "string" || transfer.to.length === 0) {
    problems.push("transfer.to must be a non-empty key id");
  }
  if (transfer.from === transfer.to) problems.push("a transfer must name two different keys");
  if (!Number.isSafeInteger(transfer.amount) || (transfer.amount as number) <= 0) {
    problems.push("transfer.amount must be a positive integer of credits");
  }
  if (typeof transfer.nonce !== "string" || transfer.nonce.length === 0) {
    problems.push("transfer.nonce must be a non-empty string");
  }
  if (typeof transfer.at !== "string" || Number.isNaN(Date.parse(transfer.at))) {
    problems.push("transfer.at must be an ISO timestamp");
  }
  return problems;
}

/**
 * The two ledger records a transfer leaves: a debit on the payer and a credit on
 * the payee, both naming the transfer's identity and carrying the same `at`, so
 * the pair is one movement rather than two unrelated entries. The two sum to
 * zero, which is what makes a ledger of them a conserved quantity and lets
 * {@link creditBalances} read a real balance out of it.
 */
export function transferRecords(instruction: TransferInstruction, hash: HashFn): CreditRecordFields[] {
  const id = transferRoot(instruction, hash);
  return [
    {
      keyId: instruction.from,
      action: TRANSFER_ACTION,
      bounty: -instruction.amount,
      challengeId: instruction.to,
      artifactHash: id,
      at: instruction.at,
    },
    {
      keyId: instruction.to,
      action: TRANSFER_ACTION,
      bounty: instruction.amount,
      challengeId: instruction.from,
      artifactHash: id,
      at: instruction.at,
    },
  ];
}

/** Every key's net position across a ledger: earned minus spent, transfers included. */
export function creditBalances(records: readonly CreditRecordFields[]): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const record of records) {
    balances[record.keyId] = (balances[record.keyId] ?? 0) + record.bounty;
  }
  return balances;
}

/**
 * The double-spend rule, stated over the whole ledger: no key may end up
 * overdrawn. Because a transfer is a debit and a credit that sum to zero, the
 * total is conserved, so an overdraft can only come from spending credits that
 * were never earned — the same credits spent twice. A node enforcing this at
 * write time and a reader recomputing it from the records agree, because it is a
 * function of the set, not the order.
 */
export function creditLedgerProblems(records: readonly CreditRecordFields[]): string[] {
  const balances = creditBalances(records);
  return Object.entries(balances)
    .filter(([, net]) => net < 0)
    .map(([keyId, net]) => `key ${keyId} is overdrawn by ${-net}`)
    .sort();
}
