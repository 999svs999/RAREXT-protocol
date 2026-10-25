import type { Artifact, Challenge } from "./types.ts";

/**
 * The pure AI representation math every surface shares: the API verifiers,
 * the MCP verb, the agent SDK, and eventually browser tools. Deliberately
 * dependency-free and hash-free — core must bundle in the browser, so any
 * digest is a caller concern (node:crypto on servers, WebCrypto in browsers).
 *
 * Two representation kinds live here:
 *
 * - `generative`: does this output come from the committed model and seed?
 *   Answered by deterministic replay — the only proof of provenance that
 *   survives an untrusted network.
 * - `bounded`: is this reconstruction within the promised distance of the
 *   committed reference? Answered by a pure metric computation. This is the
 *   path real model classes take on-chain, because nobody can hash-compare
 *   a float tensor regenerated on other hardware.
 */

export type AiRepresentation = "exact" | "bounded" | "generative";

/** A committed generative model. v1 ships the xorshift32 class. */
export interface XorshiftModel {
  kind: "xorshift32";
  params: { a: number; b: number; c: number };
  vocab: string[];
}

export interface GenerativeBody {
  model: XorshiftModel;
  seed: number;
  output: string;
  /**
   * Optional media rendition. Additive: bodies without it verify exactly as
   * before, and the claim's digest already covers whatever is present here.
   */
  media?: GenerativeMedia;
}

export interface GenerativeSpec {
  steps: number;
}

export const MAX_GENERATIVE_STEPS = 100_000;
export const MAX_VOCAB = 4096;
/** Longest single vocabulary token admitted to a committed model. */
export const MAX_GENERATIVE_TOKEN_LENGTH = 256;
/** Largest output a replay may materialize, in UTF-16 code units. */
export const MAX_GENERATIVE_OUTPUT_LENGTH = 1 << 20;

function replayOutputBound(model: XorshiftModel, steps: number): number {
  let longest = 0;
  for (const token of model.vocab) {
    if (token.length > longest) longest = token.length;
  }
  return longest * steps;
}

export function isXorshiftModel(value: unknown): value is XorshiftModel {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Partial<XorshiftModel>;
  if (model.kind !== "xorshift32") return false;
  const params = model.params as Partial<XorshiftModel["params"]> | undefined;
  if (!params) return false;
  return (
    Number.isInteger(params.a) && params.a! >= 1 && params.a! <= 31 &&
    Number.isInteger(params.b) && params.b! >= 1 && params.b! <= 31 &&
    Number.isInteger(params.c) && params.c! >= 1 && params.c! <= 31 &&
    Array.isArray(model.vocab) &&
    model.vocab.length >= 1 &&
    model.vocab.length <= MAX_VOCAB &&
    model.vocab.every(
      (token) =>
        typeof token === "string" &&
        token.length > 0 &&
        token.length <= MAX_GENERATIVE_TOKEN_LENGTH,
    )
  );
}

export function isGenerativeBody(value: unknown): value is GenerativeBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<GenerativeBody>;
  return (
    isXorshiftModel(body.model) &&
    Number.isInteger(body.seed) &&
    body.seed! >= 0 &&
    body.seed! <= 0xffffffff &&
    typeof body.output === "string" &&
    body.output.length <= MAX_GENERATIVE_OUTPUT_LENGTH
  );
}

export function isGenerativeSpec(value: unknown): value is GenerativeSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Partial<GenerativeSpec>;
  return (
    Number.isInteger(spec.steps) &&
    spec.steps! >= 1 &&
    spec.steps! <= MAX_GENERATIVE_STEPS
  );
}

/**
 * Replay the model deterministically. xorshift32, the canonical Marsaglia
 * form: x ^= x << a; x ^= x >>> b; x ^= x << c, all mod 2^32. The token at
 * each step is vocab[state % vocab.length].
 */
export function generate(model: XorshiftModel, seed: number, steps: number): string {
  const { a, b, c } = model.params;
  let state = seed >>> 0;
  let out = "";

  for (let i = 0; i < steps; i++) {
    state ^= (state << a) >>> 0;
    state ^= state >>> b;
    state ^= (state << c) >>> 0;
    state >>>= 0;
    out += model.vocab[state % model.vocab.length];
  }

  return out;
}

export interface GenerativeReplay {
  correct: boolean;
  expected: string;
}

/** Pure replay check. The model digest is the caller's hashing concern. */
export function verifyGenerativeReplay(
  body: GenerativeBody,
  spec: GenerativeSpec,
): GenerativeReplay {
  // Reject malformed or oversized inputs before replay materializes anything.
  // The token cap in the body validator and this output bound are what keep a
  // single request from turning a tiny model into an arbitrarily large string.
  if (!isGenerativeBody(body) || !isGenerativeSpec(spec)) {
    return { correct: false, expected: "" };
  }

  if (replayOutputBound(body.model, spec.steps) > MAX_GENERATIVE_OUTPUT_LENGTH) {
    return { correct: false, expected: "" };
  }

  const expected = generate(body.model, body.seed, spec.steps);
  return { correct: expected === body.output, expected };
}

export type BoundedMetric = "maxAbsError" | "meanAbsError";

export interface BoundedBody {
  values: number[];
  /** Optional codec label — descriptive only, never trusted for correctness. */
  codec?: string;
}

export interface BoundedSpec {
  metric: BoundedMetric;
  /** Maximum allowed metric value; the reconstruction must be at least this good. */
  bound: number;
  /** Ground-truth vector the artifact is reconstructed from. */
  reference: number[];
}

export const MAX_BOUNDED_LENGTH = 1 << 20;

export function isBoundedBody(value: unknown): value is BoundedBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<BoundedBody>;
  return (
    Array.isArray(body.values) &&
    body.values.length >= 1 &&
    body.values.length <= MAX_BOUNDED_LENGTH &&
    body.values.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

export function isBoundedSpec(value: unknown): value is BoundedSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Partial<BoundedSpec>;
  return (
    (spec.metric === "maxAbsError" || spec.metric === "meanAbsError") &&
    typeof spec.bound === "number" &&
    Number.isFinite(spec.bound) &&
    spec.bound >= 0 &&
    Array.isArray(spec.reference) &&
    spec.reference.length >= 1 &&
    spec.reference.length <= MAX_BOUNDED_LENGTH &&
    spec.reference.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** L∞ distance: the largest per-element absolute error. */
export function maxAbsError(values: number[], reference: number[]): number {
  let max = 0;
  for (let i = 0; i < reference.length; i++) {
    const err = Math.abs(values[i] - reference[i]);
    if (err > max) max = err;
  }
  return max;
}

/** L1 distance normalized by length: the mean per-element absolute error. */
export function meanAbsError(values: number[], reference: number[]): number {
  let sum = 0;
  for (let i = 0; i < reference.length; i++) {
    sum += Math.abs(values[i] - reference[i]);
  }
  return sum / reference.length;
}

export function computeBoundedMetric(
  metric: BoundedMetric,
  values: number[],
  reference: number[],
): number {
  return metric === "maxAbsError"
    ? maxAbsError(values, reference)
    : meanAbsError(values, reference);
}

export interface BoundedCheck {
  correct: boolean;
  metricValue: number;
}

/** Pure metric check, exported for independent re-verification. */
export function verifyBoundedReconstruction(
  body: BoundedBody,
  spec: BoundedSpec,
): BoundedCheck | { error: string } {
  if (body.values.length !== spec.reference.length) {
    return {
      error: `reconstruction length ${body.values.length} does not match reference length ${spec.reference.length}`,
    };
  }

  const metricValue = computeBoundedMetric(spec.metric, body.values, spec.reference);
  return { correct: metricValue <= spec.bound, metricValue };
}

/** Graded score: perfect reconstruction scores 100, at-bound scores 1, over-bound 0. */
export function boundedScore(metricValue: number, bound: number): number {
  if (!(metricValue <= bound)) return 0;
  if (bound === 0) return metricValue === 0 ? 100 : 0;
  const ratio = metricValue / bound;
  return Math.max(1, Math.round(100 * (1 - ratio)));
}

export interface AiLocalVerification {
  representation: "generative" | "bounded";
  correct: boolean;
  /** Generative evidence. */
  seed?: number;
  steps?: number;
  /** Bounded evidence. */
  metricName?: string;
  metricValue?: number;
  bound?: number;
}

/**
 * Local, trust-minimized AI verification over an artifact + its challenge:
 * the verdict is computed from the pure math above — the server's word is
 * never trusted for the outcome. Returns the representation, the verdict,
 * and the evidence; a `{ error }` means the artifact/challenge pair does not
 * describe a verifiable AI claim.
 */
export function verifyAiArtifact(
  artifact: Artifact,
  challenge: Challenge,
): AiLocalVerification | { error: string } {
  if (artifact.app === "ai-generative" && artifact.kind === "ai.generative") {
    if (!isGenerativeBody(artifact.body)) {
      return { error: "ai.generative artifact body must be { model, seed, output }" };
    }
    if (!isGenerativeSpec(challenge.spec)) {
      return { error: `challenge ${challenge.id} is not a generative task` };
    }

    const replay = verifyGenerativeReplay(artifact.body, challenge.spec);
    return {
      representation: "generative",
      correct: replay.correct,
      seed: artifact.body.seed,
      steps: challenge.spec.steps,
    };
  }

  if (artifact.app === "ai-bounded" && artifact.kind === "ai.bounded") {
    if (!isBoundedBody(artifact.body)) {
      return { error: "ai.bounded artifact body must be { values: number[] }" };
    }
    if (!isBoundedSpec(challenge.spec)) {
      return { error: `challenge ${challenge.id} is not a bounded task` };
    }

    const check = verifyBoundedReconstruction(artifact.body, challenge.spec);
    if ("error" in check) return check;

    return {
      representation: "bounded",
      correct: check.correct,
      metricName: challenge.spec.metric,
      metricValue: check.metricValue,
      bound: challenge.spec.bound,
    };
  }

  return { error: `artifact kind ${artifact.kind} is not a locally verifiable AI claim` };
}

/**
 * Media renditions. An AI artifact may ship a picture beside its output, and
 * that picture is *derived*, not chosen: it is a pure function of the
 * committed model, the seed, and the side length. Nothing in the derivation
 * reads a clock, a file, or a random source, so anyone holding the artifact
 * can re-derive the exact bytes. That is what makes it a commitment rather
 * than an illustration.
 *
 * The rule, id `xorshift32-image-v1`, is deliberately small enough to
 * reimplement in a paragraph:
 *   1. state = seed (mod 2^32)
 *   2. repeat size*size*3 times: step the xorshift recurrence, then emit the
 *      low byte of the state; the emitted bytes fill the raster row-major as
 *      R,G,B per pixel.
 * The raster digest is taken over those raw bytes, so it does not depend on
 * any PNG encoder. The stored blob is one valid PNG encoding of the same
 * raster; its digest is recorded separately.
 */
export const RASTER_RULE = "xorshift32-image-v1";
export const MAX_RASTER_SIZE = 512;

export interface GenerativeMedia {
  mediaType: "image/png";
  rule: string;
  blob: string;
  raster: string;
  size: number;
  bytes: number;
}

export function isGenerativeMedia(value: unknown): value is GenerativeMedia {
  if (typeof value !== "object" || value === null) return false;
  const media = value as Partial<GenerativeMedia>;
  return (
    media.mediaType === "image/png" &&
    media.rule === RASTER_RULE &&
    typeof media.blob === "string" &&
    /^[0-9a-f]{64}$/.test(media.blob) &&
    typeof media.raster === "string" &&
    /^[0-9a-f]{64}$/.test(media.raster) &&
    Number.isInteger(media.size) &&
    media.size! >= 1 &&
    media.size! <= MAX_RASTER_SIZE &&
    Number.isInteger(media.bytes) &&
    media.bytes! >= 1
  );
}

/** Pure, deterministic raster derivation — see the rule above. */
export function renderRaster(
  model: XorshiftModel,
  seed: number,
  size: number,
): Uint8Array {
  if (!isXorshiftModel(model)) throw new Error("renderRaster: malformed model");
  if (!Number.isInteger(size) || size < 1 || size > MAX_RASTER_SIZE) {
    throw new Error(`renderRaster: size must be 1..${MAX_RASTER_SIZE}`);
  }

  const { a, b, c } = model.params;
  let state = seed >>> 0;
  const out = new Uint8Array(size * size * 3);

  for (let i = 0; i < out.length; i++) {
    state ^= (state << a) >>> 0;
    state ^= state >>> b;
    state ^= (state << c) >>> 0;
    state >>>= 0;
    out[i] = state & 0xff;
  }

  return out;
}
