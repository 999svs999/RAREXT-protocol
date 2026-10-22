import { canonicalize } from "../../../packages/core/src/index.ts";

/**
 * The browser worker.
 *
 * It pulls work from the registry, runs the portable verifier for that job in
 * this tab, and hands back an attestation. The registry recomputes the same
 * verdict and only pays if the two agree, so a worker cannot be trusted and
 * does not have to be.
 *
 * The verifier module is fetched by its hash, and the same bytes run here and
 * on the server. One implementation, one verdict.
 */

export interface WorkAction {
  id: string;
  label: string;
  unit: string;
  base: number;
  difficulty: number;
  description: string;
}

export interface WorkOrder {
  id: string;
  action: string;
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

export interface WorkBoard {
  actions: WorkAction[];
  orders: WorkOrder[];
  earnings: {
    keyId: string;
    credits: number;
    byAction: Record<string, { credits: number; jobs: number }>;
    jobs: { id: string; action: string; bounty: number; challengeId: string; at: string }[];
  } | null;
}

export interface WorkerIdentity {
  keyId: string;
  publicKey: JsonWebKeyLike;
  privateKey: JsonWebKeyLike;
}

type JsonWebKeyLike = Record<string, string | boolean | undefined>;

interface VerifierModule {
  verify(artifact: unknown, challenge: unknown): {
    correct: boolean;
    score: number;
    gateCount: number;
    proof: unknown;
    details?: unknown;
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function submissionDigest(submission: {
  challengeId: string;
  artifact: unknown;
  attestation: { circuitHash: string; traceHash: string; correct: boolean; score: number; gateCount: number; proof: unknown };
  worker: { keyId: string };
}): Promise<string> {
  return sha256Hex(
    canonicalize({
      challengeId: submission.challengeId,
      artifact: submission.artifact,
      attestation: submission.attestation,
      worker: { keyId: submission.worker.keyId },
    }),
  );
}

async function signDigest(
  digest: string,
  privateKey: JsonWebKeyLike,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKey as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(digest),
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export interface WorkResult {
  orderId: string;
  challengeId: string;
  bounty: number;
  accepted: boolean;
  error: string | null;
  correct: boolean;
  score: number;
}

export interface WorkOptions {
  baseUrl?: string;
  identity: WorkerIdentity;
  onProgress?: (result: WorkResult) => void;
  limit?: number;
}

/**
 * Take work and submit it.
 *
 * Every job is attempted with the portable verifier for its app. A job whose
 * app has no portable verifier is skipped rather than faked.
 */
export async function runWork(options: WorkOptions): Promise<WorkResult[]> {
  const base = options.baseUrl ?? "";
  const results: WorkResult[] = [];

  const board = (await (
    await fetch(`${base}/v1/work?keyId=${encodeURIComponent(options.identity.keyId)}`)
  ).json()) as WorkBoard;

  const limit = options.limit ?? 3;

  for (const order of board.orders.slice(0, limit)) {
    const result: WorkResult = {
      orderId: order.id,
      challengeId: order.challengeId,
      bounty: order.bounty,
      accepted: false,
      error: null,
      correct: false,
      score: 0,
    };

    try {
      if (!order.verifier) {
        result.error = "no portable verifier for this app yet";
        results.push(result);
        options.onProgress?.(result);
        continue;
      }

      const module = (await import(
        /* @vite-ignore */ `${base}${order.verifier.url}`
      )) as VerifierModule;

      const outcome = module.verify(order.artifact, order.challenge);

      const circuitHash = await sha256Hex(canonicalize(order.artifact));
      const traceHash = await sha256Hex(canonicalize(outcome.proof));

      const submission = {
        challengeId: order.challengeId,
        artifact: order.artifact,
        attestation: {
          circuitHash,
          traceHash,
          correct: outcome.correct,
          score: outcome.score,
          gateCount: outcome.gateCount,
          proof: outcome.proof,
        },
        worker: { keyId: options.identity.keyId },
      };

      const digest = await submissionDigest(submission);
      const signature = await signDigest(digest, options.identity.privateKey);

      const response = await fetch(`${base}/v1/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...submission,
          worker: {
            keyId: options.identity.keyId,
            publicKey: options.identity.publicKey,
            signature,
          },
        }),
      });

      const payload = (await response.json()) as {
        accepted?: boolean;
        error?: string;
        bounty?: number;
      };

      result.accepted = response.ok && payload.accepted === true;
      result.error = payload.error ?? null;
      result.correct = outcome.correct;
      result.score = outcome.score;
      result.bounty = payload.bounty ?? order.bounty;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    results.push(result);
    options.onProgress?.(result);
  }

  return results;
}
