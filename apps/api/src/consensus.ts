import { canonicalize } from "../../../packages/core/src/index.ts";
import type { Anchor } from "../../../packages/core/src/index.ts";

import { sha256 } from "./attest.ts";
import {
  asPublicKey,
  keyId,
  suiteFor,
  verifyPayload,
} from "./identity.ts";
import { merkleRoot } from "./merkle.ts";
import type { RarextStore } from "./store.ts";

export const CONSENSUS_SETTLEMENT_MIN_ENV = "CONSENSUS_SETTLEMENT_MIN";
export const CONSENSUS_CHAIN_ID = "rarext-anchor-audit-v1";
export const CONSENSUS_STATE_KIND = "rarext.consensus.state";
export const CONSENSUS_VALIDATION_KIND = "rarext.consensus.validation";
export const CONSENSUS_PROOF_KIND = "rarext.consensus.anchor-proof";

export type SettlementStatus =
  | "unconfigured"
  | "below-threshold"
  | "at-threshold"
  | "above-threshold";

export interface SettlementView {
  source: "anchor-audit-trail";
  status: SettlementStatus;
  valid: boolean;
  volume: number;
  minimum: number | null;
  remainingToExceed: number | null;
  productionDataPending: boolean;
  liveGating: boolean;
  note: string;
}

export interface ConsensusHead {
  height: number;
  hash: string;
  stateRoot: string;
  anchorId: string | null;
  anchorRoot: string | null;
  createdAt: string | null;
}

export interface ConsensusState {
  kind: typeof CONSENSUS_STATE_KIND;
  version: 1;
  chainId: string;
  asOf: string;
  stateRoot: string;
  head: ConsensusHead;
  settlement: SettlementView;
  audit: {
    source: "anchor-audit-trail";
    anchors: number;
    publications: number;
    confirmedAnchors: number;
    references: string[];
  };
}

export interface ConsensusAnchorProof {
  kind: typeof CONSENSUS_PROOF_KIND;
  version: 1;
  chainId: string;
  height: number;
  head: string;
  stateRoot: string;
  anchorId: string;
  root: string;
  issuedAt: string;
}

export interface ConsensusValidation {
  kind: typeof CONSENSUS_VALIDATION_KIND;
  version: 1;
  valid: boolean;
  reason: string | null;
  proof: ConsensusAnchorProof;
  signature: {
    valid: boolean;
    keyId: string;
    suite: string | null;
  };
  anchor: {
    found: boolean;
    matches: boolean;
    publications: number | null;
  };
  chain: {
    id: string;
    height: number;
    head: string;
    expectedHead: string | null;
    headMatches: boolean;
    anchorIncluded: boolean;
    currentHeight: number;
    currentHead: string;
  };
  settlement: SettlementView;
}

export interface ConsensusOptions {
  /** Omit to read CONSENSUS_SETTLEMENT_MIN; null disables the gate. */
  settlementMinimum?: number | null;
}

export interface ConsensusService {
  readonly chainId: string;
  readonly minimum: number | null;
  state(): ConsensusState;
  validate(input: unknown): ConsensusValidation;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function asMinimum(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error("settlement minimum must be a non-negative integer");
  }
  return value;
}

export function parseSettlementMinimum(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${CONSENSUS_SETTLEMENT_MIN_ENV} must be a non-negative integer`);
  }

  return asMinimum(Number(raw.trim()));
}

/**
 * The gate is strict: reaching the minimum is not enough. This keeps "at
 * threshold" distinct from "above threshold" in the API and in the fixture.
 */
export function settlementGate(
  volume: number,
  minimum: number | null,
): SettlementView {
  if (!Number.isSafeInteger(volume) || volume < 0) {
    throw new Error("settlement volume must be a non-negative integer");
  }

  if (minimum === null) {
    return {
      source: "anchor-audit-trail",
      status: "unconfigured",
      valid: false,
      volume,
      minimum: null,
      remainingToExceed: null,
      productionDataPending: true,
      liveGating: false,
      note: `${CONSENSUS_SETTLEMENT_MIN_ENV} is unset; the gate is not configured and live gating is deferred.`,
    };
  }

  const status: SettlementStatus =
    volume < minimum
      ? "below-threshold"
      : volume === minimum
        ? "at-threshold"
        : "above-threshold";

  return {
    source: "anchor-audit-trail",
    status,
    valid: status === "above-threshold",
    volume,
    minimum,
    remainingToExceed:
      status === "above-threshold" ? 0 : minimum - volume + 1,
    productionDataPending: true,
    liveGating: false,
    note: "Volume is the cumulative count of anchored roots in the audit trail. Production settlement data is pending, so this gate is not live enforcement.",
  };
}

function orderedAnchors(store: RarextStore): Anchor[] {
  return store
    .listAnchors()
    .slice()
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

function headAt(
  anchors: Anchor[],
  height: number,
  chainId: string,
): ConsensusHead {
  if (!Number.isSafeInteger(height) || height < 0 || height > anchors.length) {
    throw new Error("consensus height is out of range");
  }

  const prefix = anchors.slice(0, height);
  const stateRoot = merkleRoot(prefix.map((anchor) => anchor.root));
  const latest = prefix[prefix.length - 1] ?? null;

  return {
    height,
    hash: sha256(
      canonicalize({
        kind: "rarext.consensus.head",
        version: 1,
        chainId,
        height,
        stateRoot,
        anchorId: latest?.id ?? null,
        anchorRoot: latest?.root ?? null,
        createdAt: latest?.createdAt ?? null,
      }),
    ),
    stateRoot,
    anchorId: latest?.id ?? null,
    anchorRoot: latest?.root ?? null,
    createdAt: latest?.createdAt ?? null,
  };
}

function confirmedAnchor(anchor: Anchor): boolean {
  return anchor.receipts.some((receipt) => {
    const candidate = receipt as { confirmed?: unknown };
    return receipt.status === "ok" && candidate.confirmed === true;
  });
}

function asAnchorProof(value: unknown): ConsensusAnchorProof {
  const record = asRecord(value, "proof");

  if (record.kind !== CONSENSUS_PROOF_KIND) {
    throw new Error(`proof.kind must be ${CONSENSUS_PROOF_KIND}`);
  }
  if (record.version !== 1) {
    throw new Error("proof.version must be 1");
  }
  if (typeof record.chainId !== "string" || record.chainId.length === 0) {
    throw new Error("proof.chainId must be a non-empty string");
  }
  if (
    typeof record.height !== "number" ||
    !Number.isSafeInteger(record.height) ||
    record.height < 1
  ) {
    throw new Error("proof.height must be a positive integer");
  }
  if (typeof record.anchorId !== "string" || record.anchorId.length === 0) {
    throw new Error("proof.anchorId must be a non-empty string");
  }
  if (typeof record.issuedAt !== "string" || !Number.isFinite(Date.parse(record.issuedAt))) {
    throw new Error("proof.issuedAt must be an ISO timestamp");
  }

  return {
    kind: CONSENSUS_PROOF_KIND,
    version: 1,
    chainId: record.chainId,
    height: record.height,
    head: asDigest(record.head, "proof.head"),
    stateRoot: asDigest(record.stateRoot, "proof.stateRoot"),
    anchorId: record.anchorId,
    root: asDigest(record.root, "proof.root"),
    issuedAt: record.issuedAt,
  };
}

function failureReason(input: {
  signatureValid: boolean;
  found: boolean;
  matches: boolean;
  chainValid: boolean;
  settlement: SettlementView;
}): string | null {
  if (!input.signatureValid) return "signature-invalid";
  if (!input.found) return "anchor-not-found";
  if (!input.matches) return "anchor-root-mismatch";
  if (!input.chainValid) return "chain-proof-mismatch";
  if (input.settlement.status === "unconfigured") return "settlement-unconfigured";
  if (input.settlement.status === "at-threshold") return "settlement-at-threshold";
  if (input.settlement.status === "below-threshold") return "settlement-below-threshold";
  return null;
}

export function createConsensusService(
  store: RarextStore,
  options: ConsensusOptions = {},
): ConsensusService {
  const minimum =
    options.settlementMinimum !== undefined
      ? options.settlementMinimum === null
        ? null
        : asMinimum(options.settlementMinimum)
      : parseSettlementMinimum(process.env[CONSENSUS_SETTLEMENT_MIN_ENV]);

  function trail(): { anchors: Anchor[]; head: ConsensusHead } {
    const anchors = orderedAnchors(store);
    return { anchors, head: headAt(anchors, anchors.length, CONSENSUS_CHAIN_ID) };
  }

  function state(): ConsensusState {
    const { anchors, head } = trail();

    return {
      kind: CONSENSUS_STATE_KIND,
      version: 1,
      chainId: CONSENSUS_CHAIN_ID,
      asOf: new Date().toISOString(),
      stateRoot: head.stateRoot,
      head,
      settlement: settlementGate(anchors.length, minimum),
      audit: {
        source: "anchor-audit-trail",
        anchors: anchors.length,
        publications: anchors.reduce(
          (total, anchor) => total + anchor.publicationIds.length,
          0,
        ),
        confirmedAnchors: anchors.filter(confirmedAnchor).length,
        references: [
          "rfcs/0017-game-native-state-migration.md",
          "contracts/AUDIT.md",
        ],
      },
    };
  }

  function validate(input: unknown): ConsensusValidation {
    const body = asRecord(input, "body");
    const proof = asAnchorProof(body.proof);
    if (typeof body.signature !== "string") {
      throw new Error("signature must be a base64 string");
    }

    const publicKey = asPublicKey(body.publicKey);
    const { anchors, head: currentHead } = trail();
    const index = anchors.findIndex((anchor) => anchor.id === proof.anchorId);
    const stored = index >= 0 ? anchors[index] : null;
    const found = stored !== null;
    const matches = found && stored.root === proof.root;
    const heightValid = proof.height >= 1 && proof.height <= anchors.length;
    const anchorIncluded =
      heightValid && index >= 0 && index < proof.height;
    const expected =
      heightValid ? headAt(anchors, proof.height, CONSENSUS_CHAIN_ID) : null;
    const headMatches =
      expected !== null &&
      expected.hash === proof.head &&
      expected.stateRoot === proof.stateRoot;
    const chainValid =
      proof.chainId === CONSENSUS_CHAIN_ID &&
      heightValid &&
      anchorIncluded &&
      headMatches;
    const signatureValid = verifyPayload(publicKey, proof, body.signature);
    const settlement = settlementGate(anchors.length, minimum);
    const reason = failureReason({
      signatureValid,
      found,
      matches,
      chainValid,
      settlement,
    });

    return {
      kind: CONSENSUS_VALIDATION_KIND,
      version: 1,
      valid:
        signatureValid &&
        found &&
        matches &&
        chainValid &&
        settlement.valid,
      reason,
      proof,
      signature: {
        valid: signatureValid,
        keyId: keyId(publicKey),
        suite: suiteFor(publicKey),
      },
      anchor: {
        found,
        matches,
        publications: stored?.publicationIds.length ?? null,
      },
      chain: {
        id: CONSENSUS_CHAIN_ID,
        height: proof.height,
        head: proof.head,
        expectedHead: expected?.hash ?? null,
        headMatches,
        anchorIncluded,
        currentHeight: currentHead.height,
        currentHead: currentHead.hash,
      },
      settlement,
    };
  }

  return {
    chainId: CONSENSUS_CHAIN_ID,
    minimum,
    state,
    validate,
  };
}
