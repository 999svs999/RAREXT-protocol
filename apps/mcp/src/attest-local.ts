import { createHash, randomUUID } from "node:crypto";

import {
  attestBoundedRun,
  attestGenerativeRun,
  canonicalize,
  generate,
  isGenerativeBody,
  isBoundedBody,
  type Attestation,
  type Artifact,
  type BoundedBody,
  type BoundedSpec,
  type Challenge,
  type ClaimKind,
  type GenerativeBody,
  type GenerativeSpec,
  type XorshiftModel,
} from "../../../packages/core/src/index.ts";
import { verifyAiLocally } from "./verify-ai.ts";
import type { AiLocalVerification } from "../../../packages/core/src/index.ts";

/**
 * Make AND prove, locally, behind the `rarext_attest_local` MCP verb.
 *
 * `rarext_verify_ai` lets an AI have someone ELSE's artifact checked without
 * trusting the server. This is the other half, and the one an AI needs to
 * contribute: it produces the artifact itself — runs the committed generative
 * model from a seed, or measures a reconstruction against the committed
 * reference — and returns the attestation that says what was proved.
 *
 * Nothing leaves the process and no key is involved: this is a LOCAL attestation,
 * carrying the RULE's name (`xorshift32-replay`, `bounded-metric-replay`) because
 * that is the rule that ran. An agent that wants its own identity on the record
 * signs it with its own key afterwards — which is the one thing an MCP server
 * must never do on its behalf.
 *
 * The verdict comes from `verifyAiLocally`, the same path the verification verb
 * uses, so the artifact this returns is accepted by the check that will later
 * judge it — one verifier, not two that agree by luck.
 */

export interface LocalAttestation {
  artifact: Artifact;
  attestation: Attestation;
  verification: AiLocalVerification;
  /** Nothing was published, and nothing was signed: this process holds no key. */
  published: false;
  signed: false;
}

export interface AttestLocalInput {
  /** The seed to generate from; defaults to the challenge's own sample seed. */
  seed?: number;
  /** Steps to generate; defaults to what the challenge asks for. */
  steps?: number;
  /** The reconstruction, for a bounded challenge. */
  values?: number[];
  /** The committed model; defaults to the challenge's sample model. */
  model?: XorshiftModel;
  /** The semantics binding to record; null when there is none to claim. */
  binding?: { id: string; version: number; claimKind: ClaimKind } | null;
}

const sha256Of = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export async function attestAiLocally(
  challengeId: string,
  registry: { challenge(id: string): Promise<Challenge> },
  input: AttestLocalInput = {},
): Promise<LocalAttestation> {
  const challenge = await registry.challenge(challengeId);
  const app = challenge.app;
  const binding = input.binding ?? null;
  const createdAt = new Date().toISOString();

  if (app === "ai-generative") {
    // The committed model is the challenge's own, unless the caller names one:
    // an agent that generates from a different model has answered a different
    // question, and the replay will say so.
    const sample = challenge.sampleArtifact?.body as { model?: XorshiftModel; seed?: number } | undefined;
    const model = input.model ?? sample?.model;
    if (!model) throw new Error(`challenge ${challengeId} carries no committed model to run`);

    const steps = input.steps ?? (challenge.spec as { steps?: number }).steps ?? 0;
    const seed = input.seed ?? sample?.seed ?? 0;

    const output = generate(model, seed, steps);
    const body: GenerativeBody = { model, seed, output };
    const artifact: Artifact = {
      app,
      kind: "ai.generative",
      version: 1,
      mediaType: "application/json",
      body,
    };

    const attestation = attestGenerativeRun({
      artifact,
      body,
      spec: { steps } as GenerativeSpec,
      app,
      challengeId,
      verifier: "xorshift32-replay",
      verifierManifest: { app, version: 1, algorithm: "xorshift32-replay", representation: "generative" },
      bound: binding,
      id: randomUUID(),
      createdAt,
      sha256: sha256Of,
    });

    return {
      artifact,
      attestation,
      verification: await verifyAiLocally(challengeId, artifact, registry),
      published: false,
      signed: false,
    };
  }

  if (app === "ai-bounded") {
    if (!input.values) {
      throw new Error(`challenge ${challengeId} is bounded: supply the reconstruction's values`);
    }
    const body: BoundedBody = { values: input.values };
    const artifact: Artifact = {
      app,
      kind: "ai.bounded",
      version: 1,
      mediaType: "application/json",
      body,
    };

    const attestation = attestBoundedRun({
      artifact,
      body,
      spec: challenge.spec as BoundedSpec,
      app,
      challengeId,
      verifier: "bounded-metric-replay",
      verifierManifest: { app, version: 1, metrics: ["maxAbsError", "meanAbsError"], representation: "bounded" },
      bound: binding,
      id: randomUUID(),
      createdAt,
      sha256: sha256Of,
    });

    return {
      artifact,
      attestation,
      verification: await verifyAiLocally(challengeId, artifact, registry),
      published: false,
      signed: false,
    };
  }

  throw new Error(`challenge ${challengeId} is ${app}: this verb attests ai-generative and ai-bounded`);
}

/** Exported for the server, so the verb and this module cannot state different sets. */
export const ATTEST_LOCAL_APPS = ["ai-generative", "ai-bounded"] as const;

/** A tiny guard used by the server's dispatch to keep the two lists honest. */
export function supportsAttestLocal(app: string): boolean {
  return (ATTEST_LOCAL_APPS as readonly string[]).includes(app);
}

export { isGenerativeBody, isBoundedBody, canonicalize };

/**
 * Turn untrusted MCP arguments into the typed input, refusing what cannot be
 * meant rather than quietly dropping it.
 *
 * This boundary is where a client's JSON becomes something a proof is made from,
 * so it is the part most worth holding still: a `seed` that arrives as the string
 * "7", or `values` that arrives as a number instead of a list, must not be
 * silently ignored — an agent that asked for a specific run and got a different
 * one has been lied to by omission. Anything present but unusable refuses by name,
 * and the server's dispatch is a one-liner through this function so the coercion
 * under test is the coercion in production.
 */
export async function attestLocalFromArgs(
  challengeId: string,
  registry: { challenge(id: string): Promise<Challenge> },
  args: Record<string, unknown>,
): Promise<LocalAttestation> {
  // `async` for a reason that is not stylistic: a validation failure must REJECT,
  // not throw before the promise exists. A caller awaiting this (or chaining
  // .catch) would otherwise get an unhandled synchronous throw — the boundary
  // refusing in a way its own signature says it cannot.
  const input: AttestLocalInput = {};

  if (args.seed !== undefined) {
    if (typeof args.seed !== "number" || !Number.isFinite(args.seed)) {
      throw new Error("seed must be a finite number");
    }
    input.seed = args.seed;
  }

  if (args.steps !== undefined) {
    if (typeof args.steps !== "number" || !Number.isInteger(args.steps) || args.steps < 0) {
      throw new Error("steps must be a non-negative integer");
    }
    input.steps = args.steps;
  }

  if (args.values !== undefined) {
    if (!Array.isArray(args.values) || !args.values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("values must be an array of finite numbers");
    }
    input.values = args.values as number[];
  }

  return attestAiLocally(challengeId, registry, input);
}
