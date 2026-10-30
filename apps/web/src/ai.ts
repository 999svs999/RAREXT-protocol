import {
  MAX_BOUNDED_LENGTH,
  MAX_GENERATIVE_STEPS,
  boundedScore,
  canonicalize,
  generate,
  verifyBoundedReconstruction,
  verifyGenerativeReplay,
} from "@rarext/core";
import {
  BOUNDED_RASTER_HEIGHT,
  parseSemanticsCommitmentArtifact,
  BOUNDED_RASTER_RULE,
  RASTER_RULE,
  renderBoundedRaster,
  renderRaster,
} from "@rarext/core";
import type {
  BoundedBody,
  BoundedMetric,
  BoundedSpec,
  GenerativeBody,
  GenerativeSpec,
  XorshiftModel,
} from "@rarext/core";

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

/** The same digest for bytes: a raster is hashed as bytes, never as a hex string. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
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

/**
 * The LOSSY half, in the browser: the representation real model classes take,
 * where nobody can hash-compare a float tensor regenerated on other hardware and
 * the claim is a DISTANCE instead.
 *
 * The evidence is built with the same field names the registry's own assembly
 * uses (`metric`, `metricValue`, `bound`, `referenceDigest`,
 * `reconstructionDigest`), so a visitor who computes the trace hash here gets the
 * number an attestation would carry — and the suite asserts that against node's.
 */
export interface BoundedProof {
  body: BoundedBody;
  metric: BoundedMetric;
  metricValue: number;
  bound: number;
  correct: boolean;
  score: number;
  referenceDigest: string;
  reconstructionDigest: string;
  traceHash: string;
  artifactHash: string;
}

export async function runBoundedProof(
  reference: number[],
  values: number[],
  metric: BoundedMetric,
  bound: number,
): Promise<BoundedProof> {
  if (!Array.isArray(values) || !values.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error("values must be an array of finite numbers");
  }
  if (values.length > MAX_BOUNDED_LENGTH) {
    throw new Error(`values must not exceed ${MAX_BOUNDED_LENGTH} entries`);
  }
  if (typeof bound !== "number" || !Number.isFinite(bound)) {
    throw new Error("bound must be a finite number");
  }

  const body: BoundedBody = { values };
  const spec: BoundedSpec = { metric, bound, reference };
  const check = verifyBoundedReconstruction(body, spec);
  if ("error" in check) {
    throw new Error(check.error);
  }

  const referenceDigest = await sha256Hex(canonicalize(reference));
  const reconstructionDigest = await sha256Hex(canonicalize(values));
  const trace = {
    metric,
    metricValue: check.metricValue,
    bound,
    referenceDigest,
    reconstructionDigest,
  };
  const artifact = {
    app: "ai-bounded",
    kind: "ai.bounded",
    version: 1,
    mediaType: "application/json",
    body,
  };

  return {
    body,
    metric,
    metricValue: check.metricValue,
    bound,
    correct: check.correct,
    score: check.correct ? boundedScore(check.metricValue, bound) : 0,
    referenceDigest,
    reconstructionDigest,
    traceHash: await sha256Hex(canonicalize(trace)),
    artifactHash: await sha256Hex(canonicalize(artifact)),
  };
}

/** The visitor's half of a lossy claim: recompute the distance, locally. */
export function checkBoundedClaim(
  reference: number[],
  values: number[],
  metric: BoundedMetric,
  bound: number,
): { correct: boolean; metricValue?: number; error?: string } {
  const check = verifyBoundedReconstruction({ values }, { metric, bound, reference });
  return "error" in check ? { correct: false, error: check.error } : { correct: check.correct, metricValue: check.metricValue };
}

/**
 * The picture a generative run's evidence commits to, rendered from the commitment
 * itself — the model and seed inside the body — so the page draws what the artifact
 * recorded rather than a picture beside it. It refuses a rule this page does not
 * implement: a page that draws something for an unknown rule is inventing evidence,
 * not showing it.
 */
export function renderProofPicture(
  body: { model: XorshiftModel; seed: number; media?: { rule?: string } },
  size: number,
): Uint8Array {
  if (body.media?.rule && body.media.rule !== RASTER_RULE) {
    throw new Error(`renderProofPicture: this page does not implement the rendition rule ${String(body.media.rule)}`);
  }
  return renderRaster(body.model, body.seed, size);
}

/** The picture a lossy claim's evidence commits to: reference against reconstruction. */
export function renderBoundedPicture(
  reference: number[],
  values: number[],
  size: { width?: number; height?: number; rule?: string } = {},
): Uint8Array {
  if (size.rule && size.rule !== BOUNDED_RASTER_RULE) {
    throw new Error(`renderBoundedPicture: this page does not implement the rendition rule ${size.rule}`);
  }
  return renderBoundedRaster(reference, values, size.width, size.height ?? BOUNDED_RASTER_HEIGHT);
}

/**
 * What the bundle BESIDE the page says, parsed once and testably.
 *
 * The two halves are separate fields on purpose. The picture note and the lossy
 * form have nothing to do with each other: reading the published raster out of the
 * LOSSY publication — which does not carry one — made the note go quiet while the
 * picture still drew, and only loading the page in a browser showed it. As separate
 * fields that mistake cannot be expressed: `picture` comes from the generative
 * edition, `lossy` from the bounded one, and either may be absent alone.
 */
export interface PublishedFixture {
  /** The rendition the published GENERATIVE edition recorded, if the bundle carries one. */
  picture: { raster?: string; size?: number };
  /** The lossy half of the page, if this bundle carries a committed reference. */
  lossy: {
    reference: number[];
    metric: BoundedMetric;
    bound: number;
    /** The PUBLISHED reconstruction's own values, when the publication carries them: the
     *  half that makes the claim checkable on arrival instead of only on a paste. */
    values?: number[];
    /** The digest the publication committed to for its rendition — the link between the
     *  values above and the published bytes. */
    committedRaster?: string;
    rendition: { width?: number; height?: number; rule?: string };
  } | null;
}

type BundleShape = {
  publications?: Array<{
    app?: string;
    challengeId?: string;
    artifact?: {
      body?: {
        media?: { width?: number; height?: number; rule?: string; raster?: string; size?: number };
        // The bounded publication's own reconstruction values: the real bundle carries
        // them, and leaving them out of this type is how the page could have checked a
        // pasted guess but never the published claim.
        values?: number[];
      };
    };
  }>;
  challenges?: Array<{ id?: string; spec?: { metric?: string; bound?: number; reference?: number[] } }>;
};

export function fixtureFromBundle(value: unknown): PublishedFixture | null {
  if (typeof value !== "object" || value === null) return null;
  const bundle = value as BundleShape;

  const generative = bundle.publications?.find((entry) => entry?.app === "ai-generative");
  const genMedia = generative?.artifact?.body?.media ?? {};
  const picture = typeof genMedia.raster === "string" ? { raster: genMedia.raster, size: genMedia.size } : {};

  const bounded = bundle.publications?.find((entry) => entry?.app === "ai-bounded");
  const challenge = bundle.challenges?.find((entry) => entry?.id === bounded?.challengeId);
  const spec = challenge?.spec;
  if (!Array.isArray(spec?.reference) || typeof spec.metric !== "string" || typeof spec.bound !== "number") {
    return { picture, lossy: null };
  }

  const body = bounded?.artifact?.body ?? {};
  const media = body.media ?? {};
  return {
    picture,
    lossy: {
      reference: spec.reference,
      metric: spec.metric as BoundedMetric,
      bound: spec.bound,
      // The publication's OWN reconstruction values and the digest it committed to for
      // them. Without these the page can only check a hand-pasted guess; with them the
      // published claim is checkable the moment the page loads.
      values: Array.isArray(body.values) ? body.values : undefined,
      committedRaster: typeof media.raster === "string" ? media.raster : undefined,
      rendition: { width: media.width, height: media.height, rule: media.rule },
    },
  };
}

/**
 * Re-verify the PUBLISHED lossy claim — the bounded analogue of checking the picture.
 *
 * Both halves, from the visitor's browser and nothing else: the metric the published
 * reconstruction measures against the committed reference, and whether those same values
 * re-render to the digest the publication committed to. The hasher is awaited because the
 * browser's only hasher is async; a synchronous call here would compare a digest against a
 * Promise and call a true claim false.
 */
export interface PublishedBoundedCheck {
  metricValue: number | null;
  within: boolean;
  renditionMatches: boolean | null;
}

export async function verifyPublishedBoundedRendition(lossy: {
  reference: number[];
  metric: BoundedMetric;
  bound: number;
  values?: number[];
  committedRaster?: string;
  rendition: { width?: number; height?: number };
}): Promise<PublishedBoundedCheck | null> {
  if (!lossy.values || lossy.values.length === 0) return null;
  const claim = checkBoundedClaim(lossy.reference, lossy.values, lossy.metric, lossy.bound);
  if (claim.error) return null;

  let renditionMatches: boolean | null = null;
  if (lossy.committedRaster && lossy.rendition.width && lossy.rendition.height) {
    const raster = renderBoundedPicture(lossy.reference, lossy.values, {
      width: lossy.rendition.width,
      height: lossy.rendition.height,
    } as never);
    renditionMatches = (await sha256Bytes(raster)) === lossy.committedRaster;
  }
  return { metricValue: claim.metricValue ?? null, within: claim.correct, renditionMatches };
}

/**
 * Re-derive a PUBLISHED artifact's rendition from the commitment inside it.
 *
 * The gallery verifies a served blob against the digest the bundle records, which
 * proves the bytes are the bundle's — not that the picture is the one the AI claim
 * commits to. This does the other half, in the visitor's browser: render the raster
 * from the artifact's own model/seed (generative) or from the committed reference
 * against the artifact's values (lossy), and compare the digest to the one the
 * artifact records. A mirror can serve bytes; only the artifact can say which
 * picture they are.
 */
export interface PublishedRenditionCheck {
  /** The digest the artifact records for its picture. */
  recorded: string;
  /** The digest of the raster re-derived here, or null when the artifact's rule is not implemented. */
  derived: string | null;
  /** True only when both exist and agree. */
  matches: boolean;
  /** Why no comparison happened, when the rule is unknown or the request is malformed. */
  reason?: string;
}

export async function verifyPublishedRendition(input: {
  app?: string;
  body: any;
  challenge?: { spec?: { reference?: number[] } };
}): Promise<PublishedRenditionCheck> {
  const media = input.body?.media;
  const recorded = typeof media?.raster === "string" ? media.raster : "";
  if (!recorded) return { recorded: "", derived: null, matches: false, reason: "the artifact records no raster" };

  try {
    let raster: Uint8Array;
    if (media.rule === RASTER_RULE) {
      if (!input.body?.model || typeof input.body.seed !== "number" || typeof media.size !== "number") {
        return { recorded, derived: null, matches: false, reason: "the artifact does not carry a usable model, seed and size" };
      }
      raster = renderRaster(input.body.model, input.body.seed, media.size);
    } else if (media.rule === BOUNDED_RASTER_RULE) {
      const reference = input.challenge?.spec?.reference;
      if (!Array.isArray(reference) || !Array.isArray(input.body?.values)) {
        return { recorded, derived: null, matches: false, reason: "the artifact's challenge does not carry the committed reference" };
      }
      raster = renderBoundedRaster(
        reference,
        input.body.values,
        media.width,
        media.height ?? BOUNDED_RASTER_HEIGHT,
      );
    } else {
      return { recorded, derived: null, matches: false, reason: `this page does not implement the rule ${String(media.rule)}` };
    }
    const derived = await sha256Bytes(raster);
    return { recorded, derived, matches: derived === recorded };
  } catch (error) {
    return {
      recorded,
      derived: null,
      matches: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether a bundle's semantics commitment covers the records the bundle carries.
 *
 * The registry anchors its meanings (RFC 0003's question 1), and until a page shows it,
 * only a test knows. Returns null when the bundle records NO commitment — which is a
 * different statement from "its commitment is wrong", and the difference matters: one is
 * an artifact that never made the claim, the other is an artifact whose claim failed.
 */
export interface SemanticsCommitmentStatus {
  committed: number;
  matched: number;
  missing: string[];
}

export async function semanticsCommitmentHolds(
  bundle: {
    publications?: Array<{ artifact?: unknown }>;
    semantics?: Array<{ id: string; version: number }>;
  },
  // ASYNC, because the only hasher a browser has is async (crypto.subtle). A synchronous
  // signature here would compare a digest against a Promise and report every record as
  // missing — which is exactly what happened, and no test using node's synchronous
  // createHash could see it.
  sha256: (value: string) => Promise<string> | string,
): Promise<SemanticsCommitmentStatus | null> {
  let digests: Record<string, string> | null = null;
  for (const publication of bundle.publications ?? []) {
    const parsed = parseSemanticsCommitmentArtifact((publication?.artifact ?? {}) as never);
    if (parsed) {
      digests = parsed.digests;
      break;
    }
  }
  if (!digests) return null;

  const missing: string[] = [];
  let matched = 0;
  for (const record of bundle.semantics ?? []) {
    const key = `${record.id}@${record.version}`;
    const digest = await semanticsRecordDigestAsync(record as never, sha256);
    if (digests[key] === digest) matched += 1;
    else missing.push(key);
  }
  return { committed: Object.keys(digests).length, matched, missing };
}

/** The commitment's digest for one record, with the hasher awaited — core's own
 *  semanticsRecordDigest is synchronous and would compare a digest against a Promise
 *  when handed the browser's async hasher. */
export async function semanticsRecordDigestAsync(
  record: unknown,
  sha256: (value: string) => Promise<string> | string,
): Promise<string> {
  return await sha256(canonicalize(record));
}
