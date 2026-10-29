import type { Artifact, Attestation, Challenge, ClaimKind } from "./types.ts";
import { canonicalize } from "./canonical.ts";

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
  /**
   * Optional media rendition, additive like the generative one: a plot of the
   * committed reference against this reconstruction, with the error amplified
   * so the committed bound is something a reader can see rather than take on
   * faith. Bodies without it verify exactly as before.
   */
  media?: BoundedMedia;
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

/**
 * Renditions for the bounded class. The generative rule draws a picture from a
 * model; this one draws a picture of the measurement. Two lanes show the
 * committed reference and the artifact's reconstruction side by side, and a
 * third lane shows the absolute error amplified by a fixed gain, so a
 * reconstruction inside a tight bound looks almost blank and a violation
 * glows. The picture is a pure function of (reference, reconstruction, gain,
 * geometry) — all of which the commitment already covers — so a reader can
 * re-derive it and compare digests.
 *
 * Rule id `bounded-strip-v1`, spelled out:
 *   columns = reference.length, scaled to `SCALE` pixels each
 *   lane 0: reference[i] as grey (v,v,v)
 *   lane 1: reconstruction[i] as grey (v,v,v)
 *   lane 2: min(255, |reference[i] - reconstruction[i]| * ERROR_GAIN) in red
 *   lanes are separated by a 4-pixel black gutter; lanes beyond the data are
 *   filled black
 */
export const BOUNDED_RASTER_RULE = "bounded-strip-v1";
export const BOUNDED_RASTER_SCALE = 16;
export const BOUNDED_RASTER_LANE = 48;
export const BOUNDED_RASTER_GUTTER = 4;
export const BOUNDED_RASTER_GAIN = 32;
export const MAX_BOUNDED_RASTER_WIDTH = 4096;

export interface BoundedMedia {
  mediaType: "image/png";
  rule: string;
  blob: string;
  raster: string;
  width: number;
  height: number;
  bytes: number;
}

export function isBoundedMedia(value: unknown): value is BoundedMedia {
  if (typeof value !== "object" || value === null) return false;
  const media = value as Partial<BoundedMedia>;
  return (
    media.mediaType === "image/png" &&
    media.rule === BOUNDED_RASTER_RULE &&
    typeof media.blob === "string" &&
    /^[0-9a-f]{64}$/.test(media.blob) &&
    typeof media.raster === "string" &&
    /^[0-9a-f]{64}$/.test(media.raster) &&
    Number.isInteger(media.width) &&
    media.width! >= 1 &&
    media.width! <= MAX_BOUNDED_RASTER_WIDTH &&
    Number.isInteger(media.height) &&
    media.height! >= 1 &&
    media.height! <= MAX_BOUNDED_RASTER_WIDTH &&
    Number.isInteger(media.bytes) &&
    media.bytes! >= 1
  );
}

export const BOUNDED_RASTER_HEIGHT =
  3 * BOUNDED_RASTER_LANE + 2 * BOUNDED_RASTER_GUTTER;

/** Pure, deterministic plot of the committed measurement — see the rule above. */
export function renderBoundedRaster(
  reference: number[],
  reconstruction: number[],
  width?: number,
  height: number = BOUNDED_RASTER_HEIGHT,
): Uint8Array {
  if (!Array.isArray(reference) || reference.length < 1) {
    throw new Error("renderBoundedRaster: reference must be a non-empty array");
  }
  if (!Array.isArray(reconstruction) || reconstruction.length !== reference.length) {
    throw new Error("renderBoundedRaster: reconstruction must match the reference length");
  }
  if (reference.length > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: at most ${MAX_BOUNDED_RASTER_WIDTH} values`);
  }

  const w = width ?? reference.length * BOUNDED_RASTER_SCALE;
  if (!Number.isInteger(w) || w < 1 || w > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: width must be 1..${MAX_BOUNDED_RASTER_WIDTH}`);
  }
  if (!Number.isInteger(height) || height < 1 || height > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: height must be 1..${MAX_BOUNDED_RASTER_WIDTH}`);
  }

  const raster = new Uint8Array(w * height * 3);
  const lane = BOUNDED_RASTER_LANE;
  const gutter = BOUNDED_RASTER_GUTTER;
  const laneStarts = [0, lane + gutter, 2 * (lane + gutter)];

  for (let x = 0; x < w; x++) {
    const index = Math.min(
      reference.length - 1,
      Math.floor((x * reference.length) / w),
    );
    const grey = clampByte(reference[index]!);
    const reconstructionGrey = clampByte(reconstruction[index]!);
    const error = clampByte(Math.abs(reference[index]! - reconstruction[index]!) * BOUNDED_RASTER_GAIN);

    for (let y = 0; y < height; y++) {
      const offset = (y * w + x) * 3;
      let r = 0;
      let g = 0;
      let b = 0;

      if (y < lane) {
        r = g = b = grey;
      } else if (y < lane + gutter) {
        // gutter stays black
      } else if (y < laneStarts[1]! + lane) {
        r = g = b = reconstructionGrey;
      } else if (y < laneStarts[1]! + lane + gutter) {
        // gutter stays black
      } else if (y < laneStarts[2]! + lane) {
        r = error;
      }

      raster[offset] = r;
      raster[offset + 1] = g;
      raster[offset + 2] = b;
    }
  }

  return raster;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

/**
 * A sha256, injected: core keeps no crypto dependency. It accepts bytes as well
 * as strings because a rendition is hashed as a raster, not as text.
 */
export type HashFn = (value: string | Uint8Array) => string;

/** The digest a committed model is bound by — the one both sides compute. */
export function modelDigestOf(model: XorshiftModel, sha256: HashFn): string {
  return sha256(canonicalize(model));
}

/**
 * Does the rendition in this body hold up against the commitment? `null` means
 * no rendition was shipped. A malformed one throws: a shape that cannot be
 * checked must not be attested. A rendition whose raster does not re-derive
 * from the committed model and seed returns false — it is not this model's
 * picture, whatever the blob beside it happens to contain.
 */
export function generativeRenditionHolds(body: GenerativeBody, sha256: HashFn): boolean | null {
  if (body.media === undefined) return null;

  if (!isGenerativeMedia(body.media)) {
    throw new Error(
      "ai.generative media must be a committed rendition: { mediaType: image/png, rule, blob, raster, size, bytes }",
    );
  }

  const raster = renderRaster(body.model, body.seed, body.media.size);
  return sha256(raster) === body.media.raster;
}

/**
 * Attest a generative run — the record of what the replay proved.
 *
 * This lived inside the registry's verifier, so a resident could replay a
 * generative claim and never make one: "AI lives on RAREXT" stopped at the
 * registry's door for exactly the artifacts the vision is about. The replay was
 * always pure — a committed model, a seed, a claimed output, recomputed — so the
 * assembly is here, where the replay is.
 *
 * What the registry used to read from its surroundings is a parameter: the
 * verifier's NAME and the hash of ITS manifest (an agent attesting as itself
 * says so, and is hashed as itself), the semantics binding, the clock, the id
 * and the hash function. `representation` and `claimKind` describe what was
 * proved, and the claim covers the rendition as well as the text: an artifact
 * that shipped a picture of its own output is refused when the picture is not
 * that model's, because otherwise the attestation would bless one field while
 * the field beside it was anything at all.
 */
export function attestGenerativeRun(input: {
  artifact: Artifact;
  body: GenerativeBody;
  spec: GenerativeSpec;
  /** The app whose rule was replayed, and the challenge this run answers. */
  app: string;
  challengeId: string;
  /** Who is asserting this: the registry, or the agent that ran it. */
  verifier: string;
  /** The verifier's own manifest, hashed as its identity. */
  verifierManifest: unknown;
  /** The semantics binding, or null when there is none to bind. */
  bound: { id: string; version: number; claimKind: ClaimKind } | null;
  id: string;
  createdAt: string;
  sha256: HashFn;
}): Attestation {
  const replay = verifyGenerativeReplay(input.body, input.spec);
  const digest = modelDigestOf(input.body.model, input.sha256);
  const rendition = generativeRenditionHolds(input.body, input.sha256);
  const correct = replay.correct && rendition !== false;

  const trace = {
    modelDigest: digest,
    seed: input.body.seed,
    steps: input.spec.steps,
    expected: replay.expected,
  };

  return {
    id: input.id,
    verifier: input.verifier,
    app: input.app,
    challengeId: input.challengeId,
    taskId: input.challengeId,
    circuitHash: input.sha256(canonicalize(input.artifact)),
    traceHash: input.sha256(canonicalize(trace)),
    correct,
    score: correct ? 100 : 0,
    gateCount: input.spec.steps,
    semanticsId: input.bound?.id ?? `ai-generative/${input.challengeId}`,
    semanticsVersion: input.bound?.version ?? 1,
    semanticsHash: input.bound ? input.sha256(canonicalize(input.bound)) : "",
    claimKind: input.bound?.claimKind ?? "satisfies",
    representation: "generative",
    scope: null,
    proofKind: "recomputable",
    signatureAlgorithm: "ecdsa-p256",
    cryptoProfile: "classical",
    verifierHash: input.sha256(canonicalize(input.verifierManifest)),
    createdAt: input.createdAt,
  };
}

/**
 * Does the plotted rendition hold up against the committed reference and this
 * artifact's own reconstruction? `null` means no rendition was shipped. A picture
 * taken from anywhere else makes the claim false rather than being quietly
 * blessed.
 */
export function boundedRenditionHolds(
  body: BoundedBody,
  spec: BoundedSpec,
  sha256: HashFn,
): boolean | null {
  if (body.media === undefined) return null;

  if (!isBoundedMedia(body.media)) {
    throw new Error(
      "ai.bounded media must be a committed rendition: { mediaType: image/png, rule, blob, raster, width, height, bytes }",
    );
  }

  const raster = renderBoundedRaster(spec.reference, body.values, body.media.width, body.media.height);
  return sha256(raster) === body.media.raster;
}

/**
 * Attest a bounded run — the record of what the metric computation proved.
 *
 * The second representation, beside `attestGenerativeRun`, and here for the same
 * reason: the assembly lived in the registry, so an agent with no server could
 * replay a bounded claim and never make one. This is the representation real
 * model classes take onto the chain — nobody can hash-compare a float tensor
 * regenerated on other hardware, but everyone can agree that "maxAbsError <= 2 of
 * 255" is a meaningful, checkable promise — so leaving it registry-only would
 * have left most real AI outside the vision.
 *
 * As with the generative assembly: the verifier's name and manifest are the
 * caller's (and describe the RULE, not the runner — an agent computing the same
 * metric under the same bound is running the same rule), the semantics binding,
 * the clock, the id and the hash are parameters, and the claim covers the
 * rendition as well as the values.
 */
export function attestBoundedRun(input: {
  artifact: Artifact;
  body: BoundedBody;
  spec: BoundedSpec;
  app: string;
  challengeId: string;
  verifier: string;
  verifierManifest: unknown;
  bound: { id: string; version: number; claimKind: ClaimKind } | null;
  id: string;
  createdAt: string;
  sha256: HashFn;
}): Attestation {
  const check = verifyBoundedReconstruction(input.body, input.spec);
  if ("error" in check) {
    throw new Error(check.error);
  }

  const rendition = boundedRenditionHolds(input.body, input.spec, input.sha256);
  const correct = check.correct && rendition !== false;

  const trace = {
    metric: input.spec.metric,
    metricValue: check.metricValue,
    bound: input.spec.bound,
    referenceDigest: input.sha256(canonicalize(input.spec.reference)),
    reconstructionDigest: input.sha256(canonicalize(input.body.values)),
  };

  return {
    id: input.id,
    verifier: input.verifier,
    app: input.app,
    challengeId: input.challengeId,
    taskId: input.challengeId,
    circuitHash: input.sha256(canonicalize(input.artifact)),
    traceHash: input.sha256(canonicalize(trace)),
    correct,
    score: correct ? boundedScore(check.metricValue, input.spec.bound) : 0,
    gateCount: input.body.values.length,
    semanticsId: input.bound?.id ?? `${input.app}/${input.challengeId}`,
    semanticsVersion: input.bound?.version ?? 1,
    semanticsHash: input.bound ? input.sha256(canonicalize(input.bound)) : "",
    claimKind: input.bound?.claimKind ?? "satisfies",
    representation: "bounded",
    metricName: input.spec.metric,
    metricValue: check.metricValue,
    scope: null,
    proofKind: "recomputable",
    signatureAlgorithm: "ecdsa-p256",
    cryptoProfile: "classical",
    verifierHash: input.sha256(canonicalize(input.verifierManifest)),
    createdAt: input.createdAt,
  };
}

/**
 * The ONE assembly of a generative rendition.
 *
 * A rendition is a raster rendered from the commitment, the PNG that encodes it, and
 * the digests of both. Three surfaces ship renditions (the SDK for a resident, the MCP
 * verb for an agent's tooling, the registry's own publisher) and a second copy of this
 * mapping anywhere is a second rule: the fields, the rule name, which digest covers
 * what. The encoder and the hash arrive as arguments so core keeps its two invariants —
 * no hashing dependency, no compression dependency.
 */
export function renditionFor(
  model: XorshiftModel,
  seed: number,
  size: number,
  deps: {
    encodePng: (raster: Uint8Array, size: number) => Uint8Array;
    sha256: (bytes: Uint8Array) => string;
  },
): GenerativeMedia {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`renditionFor: size must be a positive integer, got ${String(size)}`);
  }
  const raster = renderRaster(model, seed, size);
  const png = deps.encodePng(raster, size);
  return {
    mediaType: "image/png",
    rule: RASTER_RULE,
    blob: deps.sha256(png),
    raster: deps.sha256(raster),
    size,
    bytes: png.length,
  };
}
