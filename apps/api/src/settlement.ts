import { createHash } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";

/**
 * The off-ledger half of a redemption: actually moving value out, against the
 * external reference the redeemer named. The node cannot move real money, so it
 * calls an adapter — a chain, an escrow, a bank — and records what that adapter
 * returned. The adapter is pluggable because the outside world is; the protocol's
 * job is to call it once, atomically, and bind its answer to the ledger fact.
 */
export interface SettlementRequest {
  /** The key whose credits are being redeemed. */
  keyId: string;
  /** Credits removed from the ledger. */
  amount: number;
  /** The external reference the redeemer committed. */
  reference: string;
  /** The redemption identity (its credit-record artifactHash). */
  redemptionId: string;
}

export interface SettlementResult {
  /** The adapter's own id for the movement (a tx hash, an escrow id). */
  settlementId: string;
  /** Anything else the adapter wants recorded. */
  detail?: string;
}

export interface SettlementAdapter {
  name: string;
  /**
   * Move the value. Throwing REFUSES the redemption: the node must not remove
   * credits it could not settle.
   */
  settle(request: SettlementRequest): Promise<SettlementResult>;
}

/** A receipt the node stores for one settled redemption. */
export interface SettlementReceipt {
  redemptionId: string;
  keyId: string;
  amount: number;
  reference: string;
  adapter: string;
  settlementId: string;
  detail: string | null;
  at: string;
}

/**
 * A settlement adapter from the environment, so a node can be wired to one
 * without code: `RAREXT_SETTLEMENT=echo` records the movement by echoing the
 * reference (a placeholder for a chain/escrow), `fail` always refuses (for
 * testing the atomic refusal), and unset means ledger-only.
 */
export function createSettlementFromEnv(
  env: Record<string, string | undefined>,
): SettlementAdapter | null {
  const kind = env.RAREXT_SETTLEMENT;
  if (kind === undefined || kind === "" || kind === "none") return null;
  if (kind === "echo") {
    return {
      name: "echo",
      async settle(request) {
        return { settlementId: `echo:${request.reference}`, detail: "echoed" };
      },
    };
  }
  if (kind === "fail") {
    return {
      name: "fail",
      async settle() {
        throw new Error("RAREXT_SETTLEMENT=fail");
      },
    };
  }
  throw new Error(`unknown RAREXT_SETTLEMENT: ${kind}`);
}

/** A stable id for a settlement request, so an adapter can dedupe its own work. */
export function settlementRequestId(request: SettlementRequest): string {
  return createHash("sha256")
    .update(canonicalize({ reference: request.reference, keyId: request.keyId, redemptionId: request.redemptionId }))
    .digest("hex");
}
