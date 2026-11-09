import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  AgentSigner,
  publicKeyId,
  verifyPayload,
} from "../../../packages/agent-sdk/src/index.ts";
import {
  canonicalize,
  merkleProof,
  merkleRoot,
  sha256Hex,
  verifyProof,
} from "../../../packages/core/src/index.ts";
import type { Sha256 } from "../../../packages/core/src/index.ts";

/** node:crypto as the byte hasher the core Merkle rules take. */
const sha256Bytes: Sha256 = (bytes: Uint8Array) =>
  new Uint8Array(createHash("sha256").update(Buffer.from(bytes)).digest());

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
  /**
   * A proof that the movement is INCLUDED in the external ledger's signed state.
   * Optional at this layer; the node can require it by pinning the external
   * ledger's key, at which point a receipt without one is refused.
   */
  inclusion?: SettlementInclusion | null;
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
  /** The external-ledger inclusion proof, when the adapter produced one. */
  inclusion: SettlementInclusion | null;
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

/** Domain separation, so a settlement leaf can never be mistaken for another rule. */
export const SETTLEMENT_LEAF_DOMAIN = "rarext.settlement.leaf.v1";

/** The leaf one settlement contributes to the external ledger's Merkle state. */
export function settlementLeaf(binding: string): string {
  return sha256Hex(sha256Bytes, `${SETTLEMENT_LEAF_DOMAIN}\n${binding}`);
}

/**
 * A signed external-ledger checkpoint: the state root the ledger stood at when
 * it recorded the movement, and the height it was issued at. The height is what
 * makes freshness checkable — an old, still-valid checkpoint must not be
 * replayed for a new redemption.
 */
export interface SettlementCheckpoint {
  kind: "rarext.settlement-checkpoint.v1";
  /** The external ledger's own name. */
  ledger: string;
  height: number;
  /** The Merkle root of the ledger's settlement leaves at `height`. */
  root: string;
  issuedAt: string;
  signature: string;
  publicKey: unknown;
  suite: string;
}

/** The exact fields the external ledger signs, and the node recomputes. */
export interface SettlementCheckpointPayload {
  kind: "rarext.settlement-checkpoint.v1";
  ledger: string;
  height: number;
  root: string;
  issuedAt: string;
}

export function settlementCheckpointPayload(
  checkpoint: SettlementCheckpoint,
): SettlementCheckpointPayload {
  return {
    kind: "rarext.settlement-checkpoint.v1",
    ledger: checkpoint.ledger,
    height: checkpoint.height,
    root: checkpoint.root,
    issuedAt: checkpoint.issuedAt,
  };
}

/** A Merkle inclusion proof for one settlement, against a signed checkpoint. */
export interface SettlementInclusion {
  /** The proved leaf: `settlementLeaf(receipt.binding)`. */
  leaf: string;
  index: number;
  path: string[];
  checkpoint: SettlementCheckpoint;
}

/**
 * Verify that a settlement binding is INCLUDED in a signed external-ledger
 * checkpoint. Four things must hold: the leaf recomputes from the binding, the
 * Merkle path leads to the checkpoint root, the checkpoint's signature verifies,
 * and (when pinned) the signer is the external ledger's key. `minHeight` refuses
 * a stale checkpoint replayed for a new redemption.
 */
export function verifySettlementInclusion(
  binding: string,
  inclusion: SettlementInclusion | null | undefined,
  expectedLedgerKeyId?: string | null,
  minHeight = 0,
): boolean {
  if (inclusion === null || inclusion === undefined || typeof inclusion !== "object") return false;
  const checkpoint = inclusion.checkpoint as SettlementCheckpoint | undefined;
  if (checkpoint === undefined || checkpoint.kind !== "rarext.settlement-checkpoint.v1") return false;
  if (typeof checkpoint.ledger !== "string" || checkpoint.ledger === "") return false;
  if (!Number.isSafeInteger(checkpoint.height) || checkpoint.height < minHeight) return false;
  if (typeof checkpoint.root !== "string" || !/^[0-9a-f]{64}$/.test(checkpoint.root)) return false;
  if (typeof checkpoint.issuedAt !== "string") return false;

  // The proved leaf must BE this settlement, not some other movement.
  if (inclusion.leaf !== settlementLeaf(binding)) return false;
  if (!Number.isSafeInteger(inclusion.index) || inclusion.index < 0) return false;
  if (!Array.isArray(inclusion.path)) return false;
  if (inclusion.path.some((sibling) => typeof sibling !== "string" || !/^[0-9a-f]{64}$/.test(sibling))) {
    return false;
  }
  if (!verifyProof(inclusion.leaf, inclusion.path, checkpoint.root, inclusion.index, sha256Bytes)) {
    return false;
  }

  // The checkpoint must be the external ledger's own signed state.
  if (checkpoint.publicKey === null || typeof checkpoint.publicKey !== "object") return false;
  if (typeof checkpoint.signature !== "string") return false;
  let signed = false;
  try {
    signed = verifyPayload(
      checkpoint.publicKey as never,
      settlementCheckpointPayload(checkpoint),
      checkpoint.signature,
      typeof checkpoint.suite === "string" ? (checkpoint.suite as never) : undefined,
    );
  } catch {
    signed = false;
  }
  if (!signed) return false;

  if (expectedLedgerKeyId !== undefined && expectedLedgerKeyId !== null) {
    if (publicKeyId(checkpoint.publicKey as never) !== expectedLedgerKeyId) return false;
  }
  return true;
}

/** The Merkle root of a settlement-leaf set, using the same rules the proof does. */
export function settlementMerkleRoot(leaves: string[]): string {
  return merkleRoot(leaves, sha256Bytes);
}

/** A Merkle path for one settlement leaf, using the same rules the proof does. */
export function settlementMerkleProof(leaves: string[], index: number): string[] {
  return merkleProof(leaves, index, sha256Bytes);
}

/**
 * Build a signed inclusion proof for one settlement. The default is a one-leaf
 * tree (the honest shape for a single movement); a caller with a real ledger
 * passes `leaves`/`index` so the proof is against the whole state.
 */
export function buildSettlementInclusion(input: {
  binding: string;
  ledger: string;
  height: number;
  signer: AgentSigner;
  issuedAt?: string;
  leaves?: string[];
  index?: number;
}): SettlementInclusion {
  const leaf = settlementLeaf(input.binding);
  const leaves = input.leaves ?? [leaf];
  const index = input.index ?? leaves.indexOf(leaf);
  if (index === -1 || leaves[index] !== leaf) {
    throw new Error("the settlement leaf is not in the leaf set at the given index");
  }
  const root = settlementMerkleRoot(leaves);
  const payload: SettlementCheckpointPayload = {
    kind: "rarext.settlement-checkpoint.v1",
    ledger: input.ledger,
    height: input.height,
    root,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  return {
    leaf,
    index,
    path: settlementMerkleProof(leaves, index),
    checkpoint: {
      ...payload,
      signature: input.signer.sign(payload),
      publicKey: input.signer.publicKey,
      suite: input.signer.suite,
    },
  };
}

/**
 * Verify a recorded settlement receipt: the binding must recompute from the
 * receipt's own fields (so an edited amount/reference/settlementId is refused),
 * the signature must verify, and — when a key id is pinned — the signing key must
 * be that key. An unsigned receipt is not verified.
 *
 * When an external-ledger key is pinned (`ledgerKeyId`), the receipt must ALSO
 * carry an inclusion proof: the settlement is a leaf in a checkpoint signed by
 * that key, at height ≥ `minHeight`. That turns "the adapter claimed it" into
 * "the external ledger recorded it, and here is the proof".
 */
export function verifySettlementReceipt(
  receipt: SettlementReceipt,
  expectedKeyId?: string | null,
  options?: { ledgerKeyId?: string | null; minHeight?: number },
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
  if (
    expectedKeyId !== undefined &&
    expectedKeyId !== null &&
    publicKeyId(receipt.publicKey as never) !== expectedKeyId
  ) {
    return false;
  }

  // An inclusion proof is checked whenever one is present, and is REQUIRED when
  // the external ledger's key is pinned.
  const ledgerKeyId = options?.ledgerKeyId ?? null;
  const minHeight = options?.minHeight ?? 0;
  if (ledgerKeyId !== null || (receipt.inclusion ?? null) !== null) {
    if (!verifySettlementInclusion(receipt.binding, receipt.inclusion ?? null, ledgerKeyId, minHeight)) {
      return false;
    }
  }
  return true;
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
 *
 * `RAREXT_SETTLEMENT_LEDGER_KEY_FILE` makes the echo adapter also build an
 * INCLUSION PROOF into a signed external-ledger checkpoint, and
 * `RAREXT_SETTLEMENT_LEDGER_KEY` is the key id the node pins for it. The
 * checkpoint's ledger name and height come from `RAREXT_SETTLEMENT_LEDGER` and
 * `RAREXT_SETTLEMENT_LEDGER_HEIGHT`.
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
    const ledgerSigner =
      env.RAREXT_SETTLEMENT_LEDGER_KEY_FILE === undefined ||
      env.RAREXT_SETTLEMENT_LEDGER_KEY_FILE === ""
        ? null
        : readSettlementSigner(env.RAREXT_SETTLEMENT_LEDGER_KEY_FILE);
    const ledger = env.RAREXT_SETTLEMENT_LEDGER ?? "echo";
    const height = Number(env.RAREXT_SETTLEMENT_LEDGER_HEIGHT ?? "1");
    const checkpointHeight = Number.isSafeInteger(height) && height >= 1 ? height : 1;
    return {
      name: "echo",
      async settle(request) {
        const settlementId = `echo:${request.reference}`;
        const detail = "echoed";
        const binding = settlementBinding(request, settlementId, detail);
        if (signer === null) return { settlementId, detail };
        return {
          settlementId,
          detail,
          signature: signer.sign(settlementPayload(request, settlementId, detail)),
          publicKey: signer.publicKey,
          suite: signer.suite,
          ...(ledgerSigner === null
            ? {}
            : {
                inclusion: buildSettlementInclusion({
                  binding,
                  ledger,
                  height: checkpointHeight,
                  signer: ledgerSigner,
                }),
              }),
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
