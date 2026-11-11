import { publicKeyId, verifyPayload } from "../../../packages/agent-sdk/src/index.ts";

import { comparableCompletion } from "./completion.ts";
import { canonicalDigest } from "./digest.ts";
import { verifyProviderQuote } from "./model-bundle.ts";
import type { DeterminismClaim, ModelRunSpec, ReplayWitness } from "./types.ts";

/**
 * Engine arithmetic is not proven by a single run. A provider can produce any
 * output and call it deterministic, and a decode trace it writes is only its own
 * word. The protocol closes part of that gap with a DETERMINISM CLASS and an
 * independent WITNESS:
 *
 * - the deployment commits `determinism: "deterministic-replay"` (with a trace
 *   and a replay envelope required);
 * - a run claiming that class must carry a second, independently recorded run —
 *   a witness — whose decode trace (native token ids or an engine token+logprob
 *   judgment) matches the run TOKEN-FOR-TOKEN;
 * - the witness is signed by the provider that produced it, so the recorder
 *   cannot fabricate a matching second run;
 * - the witness provider must be independent of every provider that produced the
 *   run, so one operator cannot corroborate itself.
 *
 * What this proves: the claim is backed by a second signed execution that decoded
 * the same tokens, not by an assertion. What it does not prove: that the engine's
 * arithmetic is reproducible on any machine. A witness raises the cost of a lie
 * from one signature to two independent ones; a bit-for-bit proof needs hardware
 * and an engine that exposes its arithmetic, which the protocol cannot supply.
 */

export const DETERMINISM_KIND = "rarext.determinism.v1";
export const REPLAY_WITNESS_KIND = "rarext.replay-witness.v1";

interface DecodeTrace {
  kind: "rarext.decode-trace.v1" | "rarext.judgment.v1" | "rarext.output-trace.v1";
  tokens: Array<number | string>;
  logprobs?: number[];
  /** Present on an output trace: a digest of the exact completion text. */
  outputDigest?: string;
  digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

/**
 * The decode trace a response carries, validated and returned, or null. One
 * function for the run and the witness so "matches token-for-token" means the
 * same thing on both sides.
 */
export function decodeTraceOf(body: unknown): DecodeTrace | null {
  const trace = isRecord(body) && isRecord(body.rarext_trace) ? body.rarext_trace : null;
  if (trace === null) return null;

  if (trace.kind === "rarext.decode-trace.v1") {
    if (
      !Array.isArray(trace.tokens) ||
      trace.tokens.length === 0 ||
      !trace.tokens.every((token) => Number.isSafeInteger(token))
    ) {
      return null;
    }
  } else if (trace.kind === "rarext.judgment.v1") {
    if (
      !Array.isArray(trace.tokens) ||
      trace.tokens.length === 0 ||
      !trace.tokens.every((token) => typeof token === "string") ||
      !Array.isArray(trace.logprobs) ||
      trace.logprobs.length !== trace.tokens.length ||
      !trace.logprobs.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return null;
    }
  } else if (trace.kind === "rarext.output-trace.v1") {
    // An engine that hides its token ids still commits a digest of its output.
    if (typeof trace.outputDigest !== "string" || !/^[0-9a-f]{64}$/.test(trace.outputDigest)) {
      return null;
    }
  } else {
    return null;
  }

  const { digest, ...covered } = trace;
  if (typeof digest !== "string" || digest !== canonicalDigest(covered)) return null;

  return {
    kind: trace.kind,
    tokens: Array.isArray(trace.tokens) ? (trace.tokens as Array<number | string>) : [],
    ...(trace.kind === "rarext.judgment.v1" ? { logprobs: trace.logprobs as number[] } : {}),
    ...(trace.kind === "rarext.output-trace.v1" ? { outputDigest: trace.outputDigest as string } : {}),
    digest,
  };
}

/** Do two traces decode exactly the same tokens (and logprobs, for a judgment)? */
export function tracesMatch(a: DecodeTrace, b: DecodeTrace): boolean {
  if (a.kind !== b.kind) return false;
  // An output trace compares the exact completion digest, not tokens.
  if (a.kind === "rarext.output-trace.v1") return a.outputDigest === b.outputDigest;
  if (a.tokens.length !== b.tokens.length) return false;
  if (!a.tokens.every((token, index) => token === b.tokens[index])) return false;
  if (a.kind !== "rarext.judgment.v1") return true;
  const left = a.logprobs ?? [];
  const right = b.logprobs ?? [];
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

/** Everything about the run that a witness must share or differ from. */
export interface WitnessContext {
  /** The run's exact request body. */
  request: unknown;
  /** The run's exact response body. */
  response: unknown;
  /** The engine fingerprint the run committed, when any. */
  engine: string | null;
  /** The bundle digest the run committed, when any. */
  bundle: string | null;
  /** Every provider endpoint that produced the run. */
  endpoints: string[];
  /** Every operator key id that produced the run. */
  operators: string[];
  /** Every machine that produced the run. */
  machines: string[];
}

/**
 * Verify a witness against the run it corroborates, returning the first problem
 * or null. This is the rule the gateway checks before recording and the verifier
 * recomputes: shared request, token-for-token trace, provider signature, and
 * independence from the run's own providers.
 */
export function replayWitnessProblem(context: WitnessContext, witness: unknown): string | null {
  if (!isRecord(witness) || witness.kind !== REPLAY_WITNESS_KIND) {
    return "the witness is not a rarext.replay-witness.v1";
  }
  const provider = isRecord(witness.provider) ? witness.provider : null;
  if (provider === null || typeof provider.endpoint !== "string" || !/^https?:\/\//.test(provider.endpoint)) {
    return "the witness does not name a valid provider endpoint";
  }
  const witnessEndpoint = normalizeEndpoint(provider.endpoint);
  const runEndpoints = context.endpoints.map(normalizeEndpoint);
  if (runEndpoints.includes(witnessEndpoint)) {
    return "the witness provider is one of the run's own providers, not an independent second run";
  }

  if (canonicalDigest(witness.request) !== canonicalDigest(context.request)) {
    return "the witness run did not send the same request as the run";
  }

  const runTrace = decodeTraceOf(context.response);
  if (runTrace === null) return "the run carries no valid decode trace to corroborate";
  const witnessTrace = decodeTraceOf(witness.response);
  if (witnessTrace === null) return "the witness carries no valid decode trace";
  if (!tracesMatch(runTrace, witnessTrace)) {
    return "the witness decode trace diverged from the run trace";
  }

  const receipt = isRecord(witness.receipt) ? witness.receipt : null;
  if (receipt === null || receipt.kind !== "rarext.response-receipt.v1") {
    return "the witness has no provider response receipt";
  }
  if (receipt.request !== canonicalDigest(witness.request)) {
    return "the witness receipt does not bind the witness request";
  }
  if (!isRecord(witness.response)) return "the witness response is not an object";
  if (receipt.response !== canonicalDigest(comparableCompletion(witness.response))) {
    return "the witness receipt does not bind the witness response (trace included)";
  }
  if (!isRecord(receipt.publicKey) || typeof receipt.signature !== "string") {
    return "the witness receipt is unsigned";
  }
  if (context.engine !== null && receipt.engine !== context.engine) {
    return "the witness ran on an engine other than the pinned engine";
  }
  if (context.bundle !== null && receipt.bundle !== context.bundle) {
    return "the witness ran on a bundle other than the committed bundle";
  }

  const payload = {
    kind: receipt.kind,
    request: receipt.request,
    response: receipt.response,
    ...(receipt.attestation === undefined ? {} : { attestation: receipt.attestation }),
    ...(receipt.engine === undefined ? {} : { engine: receipt.engine }),
    ...(receipt.bundle === undefined ? {} : { bundle: receipt.bundle }),
  };
  let signed = false;
  try {
    signed = verifyPayload(
      receipt.publicKey as never,
      payload,
      receipt.signature,
      typeof receipt.suite === "string" ? (receipt.suite as never) : undefined,
    );
  } catch {
    signed = false;
  }
  if (!signed) return "the witness receipt signature does not verify";

  const signer = publicKeyId(receipt.publicKey as never);
  const claimedOperator =
    typeof provider.operator === "string" && provider.operator !== "" ? provider.operator : null;
  if (claimedOperator !== null && claimedOperator !== signer) {
    return "the witness names an operator that did not sign its receipt";
  }
  if (context.operators.includes(signer)) {
    return "the witness signer is one of the run's own operators, not independent";
  }
  if (typeof provider.machine === "string" && provider.machine !== "") {
    if (context.machines.includes(provider.machine)) {
      return "the witness machine is one of the run's own machines, not independent";
    }
    // A witness that claims a machine must back it with its OWN signed quote —
    // the machine is only independent if it is attested, not typed.
    const attestation = provider.attestation;
    if (
      !isRecord(attestation) ||
      typeof attestation.machine !== "string" ||
      attestation.machine !== provider.machine ||
      verifyProviderQuote(attestation) === null
    ) {
      return "the witness claims a machine its own signed quote does not attest";
    }
  }

  return null;
}

/** Build a witness from a second provider's signed response. */
export function makeReplayWitness(input: {
  endpoint: string;
  operator?: string | null;
  machine?: string | null;
  attestation?: unknown;
  request: unknown;
  response: unknown;
  receipt: unknown;
  recordedAt?: string;
}): ReplayWitness {
  const receipt = input.receipt;
  const derived =
    isRecord(receipt) && isRecord(receipt.publicKey)
      ? publicKeyId(receipt.publicKey as never)
      : null;
  return {
    kind: REPLAY_WITNESS_KIND,
    provider: {
      endpoint: input.endpoint,
      operator: input.operator ?? derived,
      machine: input.machine ?? null,
      ...(input.attestation === undefined || input.attestation === null
        ? {}
        : { attestation: input.attestation as never }),
    },
    request: input.request,
    response: input.response,
    receipt: input.receipt,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
}

/** Read the run's provider set out of a transcript body. */
function witnessContextFromBody(body: Record<string, unknown>): WitnessContext {
  const request = isRecord(body.request) ? body.request : {};
  const response = isRecord(body.response) ? body.response : {};
  const engine = isRecord(body.engine) ? body.engine : {};
  const bundle = isRecord(body.bundle) ? body.bundle : null;
  const providers: Array<Record<string, unknown>> = [];
  if (isRecord(body.provider)) providers.push(body.provider);
  if (isRecord(body.quorum) && Array.isArray(body.quorum.providers)) {
    for (const entry of body.quorum.providers) if (isRecord(entry)) providers.push(entry);
  }
  const strings = (field: string): string[] =>
    providers
      .map((entry) => entry[field])
      .filter((value): value is string => typeof value === "string" && value !== "");
  return {
    request: request.body,
    response: response.body,
    engine: typeof engine.fingerprint === "string" ? engine.fingerprint : null,
    bundle: bundle !== null && typeof bundle.digest === "string" ? bundle.digest : null,
    endpoints: strings("endpoint"),
    operators: strings("operator"),
    machines: strings("machine"),
  };
}

/**
 * The determinism rule a run must satisfy for a challenge. Returns a reason on
 * failure, null on success. When the challenge commits no class, a run may not
 * claim one: evidence cannot be attached to a challenge that did not ask for it.
 */
export function verifyDeterminismClaim(
  body: unknown,
  spec: ModelRunSpec,
): { ok: boolean; reason: string | null } {
  if (!isRecord(body)) return { ok: false, reason: "the run body is not an object" };
  const claim = body.determinism;

  if (spec.determinism === undefined) {
    return claim === undefined
      ? { ok: true, reason: null }
      : { ok: false, reason: "the run claims a determinism class the challenge did not commit" };
  }

  if (!isRecord(claim) || claim.kind !== DETERMINISM_KIND || claim.class !== spec.determinism) {
    return { ok: false, reason: "the run carries no matching determinism claim" };
  }

  const sampling = isRecord(body.sampling) ? body.sampling : {};
  if (sampling.temperature !== 0 || sampling.seed === null || !Number.isSafeInteger(sampling.seed)) {
    return { ok: false, reason: "a deterministic-replay run must fix temperature 0 and an integer seed" };
  }
  if (body.replay === null || body.replay === undefined) {
    return { ok: false, reason: "a deterministic-replay run needs a replay envelope" };
  }

  const context = witnessContextFromBody(body);
  const problem = replayWitnessProblem(context, claim.witness);
  return problem === null ? { ok: true, reason: null } : { ok: false, reason: problem };
}

/** A cheap label check: the supported class names. */
export function isDeterminismClass(value: unknown): value is DeterminismClaim["class"] {
  return value === "deterministic-replay";
}
