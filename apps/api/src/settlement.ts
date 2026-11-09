import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  AgentSigner,
  publicKeyId,
  verifyPayload,
} from "../../../packages/agent-sdk/src/index.ts";
import { canonicalize } from "../../../packages/core/src/index.ts";

/**
 * The off-ledger half of a redemption: actually moving value out, against the
 * external reference the redeemer named. The node cannot move real money, so it
 * calls an adapter — a chain, an escrow, a bank — and records what that adapter
 * returned. The adapter is pluggable because the outside world is; the protocol's
 * job is to call it once, atomically, and bind its answer to the ledger fact.
 *
 * Binding is not the same as proving. To make the recorded movement attributable,
 * an adapter can sign the settlement payload with a key the node PINS
 * (`RAREXT_SETTLEMENT_KEY` / `AppOptions.settlementKey`). When a key is pinned,
 * the node refuses a settlement it cannot verify, so a misbehaving adapter cannot
 * invent a movement that the ledger then pays out against.
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
  /** Base64 signature over `settlementPayload(request, settlementId, detail)`. */
  signature?: string;
  /** The key that made the signature, so it can be checked without a key store. */
  publicKey?: unknown;
  /** The signature suite, when the key alone does not identify it. */
  suite?: string;
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
  /** The canonical commitment over every settlement fact, signed or not. */
  binding: string;
  /** The adapter's proof over `binding`, when it signed one. */
  signature: string | null;
  /** The adapter's public key, when it signed. */
  publicKey: unknown | null;
  /** The adapter's signature suite, when it signed. */
  suite: string | null;
  /** The key id the signature verifies under, when present. */
  signer: string | null;
  at: string;
}

export interface SettlementPayload {
  kind: "rarext.settlement-receipt.v1";
  redemptionId: string;
  keyId: string;
  amount: number;
  reference: string;
  settlementId: string;
  detail: string | null;
}

/**
 * The exact fields an adapter signs, and the node recomputes. One function so
 * the signer and the verifier cannot disagree about what the signature covers.
 */
export function settlementPayload(
  request: SettlementRequest,
  settlementId: string,
  detail: string | null = null,
): SettlementPayload {
  return {
    kind: "rarext.settlement-receipt.v1",
    redemptionId: request.redemptionId,
    keyId: request.keyId,
    amount: request.amount,
    reference: request.reference,
    settlementId,
    detail,
  };
}

/** A stable digest over the settlement facts, recorded on every receipt. */
export function settlementBinding(
  request: SettlementRequest,
  settlementId: string,
  detail: string | null = null,
): string {
  return createHash("sha256")
    .update(canonicalize(settlementPayload(request, settlementId, detail)))
    .digest("hex");
}

/**
 * Verify a recorded settlement receipt: the binding must recompute from the
 * receipt's own fields (so an edited amount/reference/settlementId is refused),
 * the signature must verify, and — when a key id is pinned — the signing key must
 * be that key. An unsigned receipt is not verified.
 */
export function verifySettlementReceipt(
  receipt: SettlementReceipt,
  expectedKeyId?: string | null,
): boolean {
  if (receipt.signature === null || typeof receipt.signature !== "string") return false;
  if (receipt.publicKey === null || typeof receipt.publicKey !== "object") return false;

  const request: SettlementRequest = {
    keyId: receipt.keyId,
    amount: receipt.amount,
    reference: receipt.reference,
    redemptionId: receipt.redemptionId,
  };
  if (settlementBinding(request, receipt.settlementId, receipt.detail) !== receipt.binding) {
    return false;
  }

  let ok = false;
  try {
    ok = verifyPayload(
      receipt.publicKey as never,
      settlementPayload(request, receipt.settlementId, receipt.detail),
      receipt.signature,
      typeof receipt.suite === "string" ? (receipt.suite as never) : undefined,
    );
  } catch {
    ok = false;
  }
  if (!ok) return false;

  if (receipt.signer !== null && publicKeyId(receipt.publicKey as never) !== receipt.signer) {
    return false;
  }
  return (
    expectedKeyId === undefined ||
    expectedKeyId === null ||
    publicKeyId(receipt.publicKey as never) === expectedKeyId
  );
}

/** Load the optional adapter signer a node uses to sign echo settlements. */
function readSettlementSigner(path: string): AgentSigner {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const privateKey =
    value.privateKey !== undefined ? (value.privateKey as never) : (value as never);
  return new AgentSigner(privateKey);
}

/**
 * A settlement adapter from the environment, so a node can be wired to one
 * without code: `RAREXT_SETTLEMENT=echo` records the movement by echoing the
 * reference (a placeholder for a chain/escrow), `fail` always refuses (for
 * testing the atomic refusal), and unset means ledger-only.
 *
 * `RAREXT_SETTLEMENT_KEY_FILE` makes the echo adapter SIGN its settlement with
 * that key, and `RAREXT_SETTLEMENT_KEY` is the key id the node pins when
 * verifying it.
 */
export function createSettlementFromEnv(
  env: Record<string, string | undefined>,
): SettlementAdapter | null {
  const kind = env.RAREXT_SETTLEMENT;
  if (kind === undefined || kind === "" || kind === "none") return null;
  if (kind === "echo") {
    const signer =
      env.RAREXT_SETTLEMENT_KEY_FILE === undefined || env.RAREXT_SETTLEMENT_KEY_FILE === ""
        ? null
        : readSettlementSigner(env.RAREXT_SETTLEMENT_KEY_FILE);
    return {
      name: "echo",
      async settle(request) {
        const settlementId = `echo:${request.reference}`;
        const detail = "echoed";
        if (signer === null) return { settlementId, detail };
        return {
          settlementId,
          detail,
          signature: signer.sign(settlementPayload(request, settlementId, detail)),
          publicKey: signer.publicKey,
          suite: signer.suite,
        };
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
