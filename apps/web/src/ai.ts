import {
  MAX_GENERATIVE_STEPS,
  canonicalize,
  generate,
  verifyGenerativeReplay,
} from "@rarext/core";
import type { GenerativeBody, GenerativeSpec, XorshiftModel } from "@rarext/core";

/**
 * The AI proof, made in a browser — no server, no install, no key.
 *
 * core is dependency-free and hash-injected precisely so it can run here: the
 * server passes node's sha256, an agent passes its own, and this page passes
 * WebCrypto's. The POINT of that arrangement is what this module is for — a
 * visitor can run the committed model on their own machine, see the evidence an
 * attestation would carry, and check somebody else's claimed output against the
 * same rule the registry used. The digest is the test: if the browser's WebCrypto
 * and node's createHash disagreed about any of it, "anyone can recompute this"
 * would be a slogan instead of a property.
 *
 * Nothing here signs. A signature is an identity claim, and this page has no key —
 * making one is the SDK's `selfPublishGenerative(signer, …)`, which produces the
 * publication. This produces the PROOF that publication would carry.
 */

/** The committed starter model: the same numbers the published bundle was generated with. */
export const STARTER_MODEL: XorshiftModel = {
  kind: "xorshift32",
  params: { a: 13, b: 17, c: 5 },
  vocab: ["alpha", "beta", "gamma", "delta"],
};

/** The seed and steps of the committed starter run. */
export const STARTER_SEED = 42;
export const STARTER_STEPS = 32;

/** sha256, the browser's way — the same bytes in, the same hex out. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface BrowserProof {
  /** The artifact body an attestation would cover: `{ model, seed, output }`. */
  body: GenerativeBody;
  steps: number;
  /** sha256 of the canonical model — the same value the SDK reports for this model. */
  modelDigest: string;
  /** sha256 of the canonical trace, built exactly as `attestRun` builds it. */
  traceHash: string;
  /** sha256 of the canonical artifact. */
  artifactHash: string;
  /** The replay verdict, computed here rather than taken on trust. */
  correct: boolean;
}

export interface BrowserRun {
  output: string;
  proof: BrowserProof;
}

/**
 * Run the committed model in this browser and assemble the evidence.
 *
 * The steps are bounded by core's own cap, refused BY NAME rather than clamped: a
 * page that silently generated fewer tokens than asked would be reporting somebody
 * else's run as the visitor's.
 */
export async function runCommittedModel(
  model: XorshiftModel,
  seed: number,
  steps: number = STARTER_STEPS,
): Promise<BrowserRun> {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new Error("steps must be a non-negative integer");
  }
  if (steps > MAX_GENERATIVE_STEPS) {
    throw new Error(`steps must not exceed ${MAX_GENERATIVE_STEPS}`);
  }
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new Error("seed must be a finite number");
  }

  const output = generate(model, seed, steps);
  const body: GenerativeBody = { model, seed, output };
  const replay = verifyGenerativeReplay(body, { steps } as GenerativeSpec);

  const modelDigest = await sha256Hex(canonicalize(model));
  const trace = { modelDigest, seed, steps, expected: replay.expected };
  const artifact = {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body,
  };

  return {
    output,
    proof: {
      body,
      steps,
      modelDigest,
      traceHash: await sha256Hex(canonicalize(trace)),
      artifactHash: await sha256Hex(canonicalize(artifact)),
      correct: replay.correct,
    },
  };
}

/**
 * Check a claimed output against the committed model — the visitor's side of the
 * exchange, and the half that makes the claim worth anything.
 */
export function checkClaim(
  model: XorshiftModel,
  seed: number,
  output: string,
  steps: number,
): { correct: boolean; expected: string } {
  return verifyGenerativeReplay({ model, seed, output }, { steps } as GenerativeSpec);
}
