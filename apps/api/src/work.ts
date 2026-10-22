import { createHash } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { Challenge } from "../../../packages/core/src/index.ts";

/**
 * The action board: the verbs of the platform, and what each pays.
 *
 * This is the game's design. Every action the protocol knows about has a base
 * value, a unit, and a difficulty, and the payouts a player sees are the base
 * value scaled by the difficulty of the specific job. Nothing is minted on a
 * schedule: the work is paid by demand — a bounty on a challenge, a customer
 * paying for storage, the protocol's fee share for mirroring — so there is no
 * emission treadmill to collapse.
 */
export type ActionId =
  | "verify"
  | "store"
  | "mirror"
  | "relay"
  | "publish"
  | "remix"
  | "report";

export interface ActionDefinition {
  id: ActionId;
  label: string;
  unit: string;
  base: number;
  /** How much harder the job is than the base case, 1 being ordinary. */
  difficulty: number;
  description: string;
}

export const ACTIONS: ActionDefinition[] = [
  {
    id: "verify",
    label: "Verify a build",
    unit: "per verified attestation",
    base: 10,
    difficulty: 1,
    description:
      "Run a challenge's verifier over an artifact and hand back an attestation anybody can recompute.",
  },
  {
    id: "store",
    label: "Hold bytes",
    unit: "per byte-month",
    base: 1,
    difficulty: 1,
    description:
      "Keep a blob for a retention term and prove it later with a time-locked opening.",
  },
  {
    id: "mirror",
    label: "Mirror the registry",
    unit: "per anchored root mirrored",
    base: 25,
    difficulty: 1,
    description:
      "Serve a copy of the registry that rebuilds the anchored root, so the content outlives the operator.",
  },
  {
    id: "relay",
    label: "Relay an anchor",
    unit: "per anchor submitted to a chain",
    base: 15,
    difficulty: 2,
    description: "Submit an anchor to a chain and have it read back and confirmed.",
  },
  {
    id: "publish",
    label: "Publish a build",
    unit: "per published artifact",
    base: 5,
    difficulty: 1,
    description: "Publish a signed artifact that passes its challenge.",
  },
  {
    id: "remix",
    label: "Remix a build",
    unit: "per derivative",
    base: 20,
    difficulty: 1,
    description:
      "Build on someone else's verified work. The lineage records who made what from what.",
  },
  {
    id: "report",
    label: "Report a bad claim",
    unit: "per accepted revocation",
    base: 50,
    difficulty: 3,
    description:
      "Submit a signed revocation for a leaked capability or a compromised verifier.",
  },
];

export function actionFor(id: ActionId): ActionDefinition {
  const action = ACTIONS.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`unknown action: ${id}`);
  return action;
}

export interface WorkOrder {
  id: string;
  action: ActionId;
  app: string;
  challengeId: string;
  bounty: number;
  difficulty: number;
  unit: string;
  artifact: unknown;
  challenge: { id: string; app: string; spec: unknown };
  verifier: { id: string; hash: string; format: string; url: string } | null;
  expiresAt: string;
}

export interface WorkOrderArtifact {
  app: string;
  kind: string;
  version: number;
  mediaType: string;
  body: unknown;
}

function difficultyFor(challenge: Challenge): number {
  const spec = challenge.spec as { maxPlies?: number; referenceGateCount?: number };
  const plies = typeof spec.maxPlies === "number" ? spec.maxPlies : 1;
  const gates = typeof spec.referenceGateCount === "number" ? spec.referenceGateCount : 1;
  return Math.max(1, Math.round((plies + gates / 4) / 2));
}

/**
 * The work queue.
 *
 * A challenge that ships a sample artifact is a warm-up job: anybody can pick
 * it up, run the verifier, and be paid. The bounty is the challenge's own, or
 * the base value scaled by how hard the challenge is.
 */
export function workOrders(
  challenges: Challenge[],
  options: {
    verifiers?: Record<string, { id: string; hash: string; format: string; url: string }>;
    limit?: number;
  } = {},
): WorkOrder[] {
  const orders: WorkOrder[] = [];

  for (const challenge of challenges) {
    if (!challenge.sampleArtifact) continue;

    const difficulty = difficultyFor(challenge);
    const action = actionFor("verify");
    const bounty = Math.round(action.base * difficulty);

    orders.push({
      id: `${challenge.app}:${challenge.id}:sample`,
      action: "verify",
      app: challenge.app,
      challengeId: challenge.id,
      bounty,
      difficulty,
      unit: action.unit,
      artifact: challenge.sampleArtifact,
      challenge: { id: challenge.id, app: challenge.app, spec: challenge.spec },
      verifier: options.verifiers?.[challenge.app] ?? null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  const limit = options.limit ?? 50;
  return orders.slice(0, limit);
}

export interface Earnings {
  keyId: string;
  credits: number;
  byAction: Record<string, { credits: number; jobs: number }>;
  jobs: { id: string; action: ActionId; bounty: number; challengeId: string; at: string }[];
}

export interface CreditRecord {
  keyId: string;
  action: ActionId;
  bounty: number;
  challengeId: string;
  /** The artifact the credit was for, so the same work is never paid twice. */
  artifactHash: string;
  at: string;
}

export function summarizeEarnings(keyId: string, records: CreditRecord[]): Earnings {
  const byAction: Earnings["byAction"] = {};
  let credits = 0;

  for (const record of records) {
    if (record.keyId !== keyId) continue;
    credits += record.bounty;
    const entry = byAction[record.action] ?? { credits: 0, jobs: 0 };
    entry.credits += record.bounty;
    entry.jobs += 1;
    byAction[record.action] = entry;
  }

  return {
    keyId,
    credits,
    byAction,
    jobs: records
      .filter((record) => record.keyId === keyId)
      .map((record) => ({
        id: `${record.action}:${record.challengeId}:${record.at}`,
        action: record.action,
        bounty: record.bounty,
        challengeId: record.challengeId,
        at: record.at,
      })),
  };
}

/**
 * A worker's submission. The signature covers the whole submission, so a worker
 * cannot have its work attributed to somebody else, and the registry can check
 * that the attestation the worker handed back is the one the verifier produces.
 */
export interface VerificationSubmission {
  challengeId: string;
  artifact: unknown;
  attestation: {
    circuitHash: string;
    traceHash: string;
    correct: boolean;
    score: number;
    gateCount: number;
    proof: unknown;
  };
  worker: {
    keyId: string;
    publicKey: unknown;
    signature: string;
  };
}

export function submissionDigest(submission: VerificationSubmission): string {
  return createHash("sha256")
    .update(
      canonicalize({
        challengeId: submission.challengeId,
        artifact: submission.artifact,
        attestation: submission.attestation,
        worker: { keyId: submission.worker.keyId },
      }),
    )
    .digest("hex");
}