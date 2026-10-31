import {
  canonicalize,
  isBoundedMedia,
  isGenerativeMedia,
  leafPayload,
  renderBoundedRaster,
  renderRaster,
  verifyAiArtifact,
} from "../../../packages/core/src/index.ts";
import type { AiLocalVerification, Challenge, Publication } from "../../../packages/core/src/index.ts";

/**
 * The browser-side mirror verifier.
 *
 * A mirror is a copy, and a copy is worth nothing unless you can check it. This
 * recomputes the Merkle root of a bundle from the publications it contains and
 * compares it with the root the chain holds. The leaf shape comes from the same
 * module the registry uses, so the two cannot drift.
 */

export interface Bundle {
  manifest: {
    root: string;
    leafVersion: number;
    publications: { id: string; leaf: string }[];
  };
  publications: Publication[];
  /** Challenge specs are optional; a caller may supply them separately. */
  challenges?: Challenge[];
}

export interface BundleVerification {
  valid: boolean;
  root: string;
  computedRoot: string;
  publications: number;
  reason: string | null;
  /**
   * Per-publication AI representation evidence, as committed by leaf v4.
   * Every entry here is covered by the anchor: a mirror cannot have stripped
   * or inflated it without failing the root check above.
   */
  aiClaims: AiClaimSummary[];
}

export interface AiClaimSummary {
  publicationId: string;
  /** The representation kind the anchor committed, or null for pre-AI claims. */
  representation: "exact" | "bounded" | "generative" | null;
  correct: boolean;
  /** Bounded evidence: which metric was measured and the committed value. */
  metricName: string | null;
  metricValue: number | null;
  /** The bound from the challenge spec carried in the bundle, when supplied. */
  bound: number | null;
  /**
   * When the bundle carries the challenge spec for a bounded claim: the
   * committed metric value actually satisfies the bound.
   */
  withinBound: boolean | null;
  /**
   * When the bundle carries the challenge spec for this claim: the verdict
   * computed locally in this browser from the raw artifact data — replay for
   * generative, recomputed metric for bounded. Null when no usable spec was
   * supplied. This is the strongest check a mirror reader gets: it does not
   * trust the mirror, the anchor, or the attestation for the verdict.
   */
  local: { correct: boolean; metricValue?: number } | null;
  /**
   * Media rendition evidence. When an AI artifact ships a picture derived from
   * its commitment, this browser re-derives the raster from the committed
   * model and seed and hashes it — no trust in the uploaded file. When the
   * blob's bytes were supplied (a mirror's inline blobs), the blob digest is
   * checked too, so a substituted picture fails here.
   */
  media: AiMediaEvidence | null;
}

export interface AiMediaEvidence {
  /** Digest of the encoded picture as stored on the node. */
  blob: string;
  /** Digest of the raw raster the artifact committed. */
  raster: string;
  /** Generative renditions are square; bounded plots carry explicit geometry. */
  size: number | null;
  width: number | null;
  height: number | null;
  /** sha256 of the raster re-derived here from the committed model and seed. */
  reDerived: string | null;
  /** reDerived === raster: the picture really is a function of the commitment. */
  matches: boolean | null;
  /** sha256 of the supplied blob bytes === blob, when bytes were supplied. */
  blobMatches: boolean | null;
  /**
   * The artifact declared a rendition this reader cannot check — an
   * unimplemented rule, or a shape that is not a committed rendition. Reported
   * rather than dropped: "no picture" and "a picture I cannot verify" are
   * different facts, and only one of them is harmless.
   */
  unverifiable: true | null;
  /** Why the declared rendition could not be checked, when it could not. */
  reason: string | null;
}

/**
 * The server's verdict and the browser's own AI check must agree. A local
 * replay or metric failure is never hidden by a server that still says valid,
 * and a server rejection is never overridden by a local pass.
 */
export function localVerdict(
  serverValid: boolean,
  local: { correct: boolean } | null,
): boolean {
  return serverValid && (local?.correct ?? true);
}

/**
 * Challenge specs a reader can supply alongside a bundle: bounded claims use
 * `bound` (+ optionally the full spec with `metric` and `reference` for local
 * recomputation), generative claims use `steps` for a local replay.
 */
export interface ChallengeIndex {
  [challengeId: string]: {
    bound?: number;
    steps?: number;
    metric?: string;
    reference?: number[];
  } & Record<string, unknown>;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer-backed view: a derived raster may come back
  // as Uint8Array<ArrayBufferLike>, which WebCrypto's BufferSource rejects.
  const view = new Uint8Array(bytes.length);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPair(left: string, right: string): Promise<string> {
  return sha256Hex(left + right);
}

async function merkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return "";
  if (leaves.length === 1) return leaves[0]!;

  let level = [...leaves];

  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        await hashPair(level[index]!, level[index + 1] ?? level[index]!),
      );
    }
    level = next;
  }

  return level[0]!;
}

function localAiCheck(
  publication: Publication,
  spec: Record<string, unknown> | undefined,
): { correct: boolean; metricValue?: number } | null {
  if (!spec) return null;

  const representation = (publication.attestation as { representation?: string })
    .representation;

  // Generative: replay needs only the step count — the model, seed, and
  // claimed output travel inside the artifact.
  if (representation === "generative") {
    if (typeof spec.steps !== "number") return null;
    const challenge = {
      id: publication.challengeId,
      app: publication.app,
      title: "",
      description: "",
      version: 1,
      spec: { steps: spec.steps },
      semanticsId: "",
      semanticsVersion: 1,
      createdAt: "",
    };
    const result = verifyAiArtifact(publication.artifact, challenge);
    if ("error" in result) return null;
    return { correct: result.correct === true };
  }

  // Bounded: with metric + reference + bound the browser recomputes the
  // metric from the raw reconstruction instead of trusting the attestation.
  if (representation === "bounded") {
    if (
      (spec.metric !== "maxAbsError" && spec.metric !== "meanAbsError") ||
      !Array.isArray(spec.reference) ||
      typeof spec.bound !== "number"
    ) {
      return null;
    }
    const challenge = {
      id: publication.challengeId,
      app: publication.app,
      title: "",
      description: "",
      version: 1,
      spec: {
        metric: spec.metric,
        bound: spec.bound,
        reference: spec.reference,
      },
      semanticsId: "",
      semanticsVersion: 1,
      createdAt: "",
    };
    const result = verifyAiArtifact(publication.artifact, challenge);
    if ("error" in result) return null;
    return {
      correct: result.correct === true,
      metricValue: typeof result.metricValue === "number" ? result.metricValue : undefined,
    };
  }

  return null;
}

/**
 * Media evidence for one publication. The picture is derived, not trusted:
 * the raster comes from the committed model and seed, so the check is the same
 * shape as the generative replay — recompute, then compare. The blob digest
 * covers the encoded file, which is the part a node could swap.
 */
async function mediaFor(
  publication: Publication,
  spec: Record<string, unknown> | undefined,
  blobBytes: Uint8Array | undefined,
  representation: string | null,
): Promise<AiMediaEvidence | null> {
  const body = publication.artifact?.body as
    | { model?: unknown; seed?: unknown; values?: unknown; media?: unknown }
    | undefined;
  if (!body) return null;

  let raster: Uint8Array | null = null;
  let geometry: { size: number | null; width: number | null; height: number | null } = {
    size: null,
    width: null,
    height: null,
  };
  let media: { blob: string; raster: string } | null = null;

  // Generative: the picture is a function of the committed model and seed.
  if (typeof body.seed === "number" && isGenerativeMedia(body.media)) {
    media = body.media;
    geometry = { size: body.media.size, width: body.media.size, height: body.media.size };
    try {
      raster = renderRaster(
        body.model as Parameters<typeof renderRaster>[0],
        body.seed,
        body.media.size,
      );
    } catch {
      raster = null;
    }
  } else if (isBoundedMedia(body.media)) {
    // Bounded: the plot is a function of the committed reference and the
    // artifact's own reconstruction. Both sit inside the claim, so a reader
    // re-derives the measurement's picture instead of trusting the blob.
    media = body.media;
    geometry = { size: null, width: body.media.width, height: body.media.height };
    const reference = spec?.reference;
    if (Array.isArray(reference) && Array.isArray(body.values)) {
      try {
        raster = renderBoundedRaster(
          reference as number[],
          body.values as number[],
          body.media.width,
          body.media.height,
        );
      } catch {
        raster = null;
      }
    }
  }

  if (!media) {
    // A rendition was declared but is not one this build can check. Say so.
    if (body.media !== undefined && body.media !== null) {
      const shape = typeof body.media === "object" ? body.media as { rule?: unknown } : {};
      const rule = typeof shape.rule === "string" ? shape.rule : "an unknown rule";
      return {
        blob: "",
        raster: "",
        size: null,
        width: null,
        height: null,
        reDerived: null,
        matches: null,
        blobMatches: null,
        unverifiable: true,
        reason: `declared a ${representation ?? "unknown"} rendition under ${rule} that this reader cannot check`,
      };
    }
    return null;
  }

  let reDerived: string | null = null;
  if (raster) {
    try {
      reDerived = await sha256BytesHex(raster);
    } catch {
      reDerived = null;
    }
  }

  let blobMatches: boolean | null = null;
  if (blobBytes) {
    blobMatches = (await sha256BytesHex(blobBytes)) === media.blob;
  }

  return {
    blob: media.blob,
    raster: media.raster,
    size: geometry.size,
    width: geometry.width,
    height: geometry.height,
    reDerived,
    matches: reDerived === null ? null : reDerived === media.raster,
    blobMatches,
    unverifiable: null,
    reason: null,
  };
}

function base64ToBytes(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

async function aiClaimsFor(
  bundle: Bundle,
  challenges?: ChallengeIndex,
  media?: Record<string, string>,
): Promise<AiClaimSummary[]> {
  // The AI evidence is only meaningful when the anchor actually committed it.
  // Leaf v4 added representation/metric fields; on v2/v3 the same fields can
  // still appear on the JSON object, but they are outside the Merkle leaf, so
  // a mirror could edit them without changing the root. Do not surface them.
  const committed = bundle.manifest.leafVersion >= 4;

  const claims: AiClaimSummary[] = [];
  for (const publication of bundle.publications) {
    const attestation = publication.attestation as {
      representation?: "exact" | "bounded" | "generative";
      metricName?: string;
      metricValue?: number;
      correct?: boolean;
    };

    const representation = committed ? (attestation.representation ?? null) : null;
    const spec = challenges?.[publication.challengeId];
    const bound = typeof spec?.bound === "number" ? spec.bound : null;
    const metricValue =
      committed && typeof attestation.metricValue === "number"
        ? attestation.metricValue
        : null;
    const local = committed
      ? localAiCheck(publication, spec as Record<string, unknown> | undefined)
      : null;

    let mediaEvidence: AiMediaEvidence | null = null;

    if (committed) {
      const body = publication.artifact?.body as { media?: { blob?: unknown } } | undefined;
      if (body?.media !== undefined && body?.media !== null) {
        const hash = (body.media as { blob?: unknown }).blob;
        const encoded = typeof hash === "string" ? media?.[hash] : undefined;
        const bytes = typeof encoded === "string" ? base64ToBytes(encoded) : undefined;
        mediaEvidence = await mediaFor(
          publication,
          spec as Record<string, unknown> | undefined,
          bytes,
          representation,
        );
      }
    }

    claims.push({
      publicationId: publication.id,
      representation,
      correct: committed && attestation.correct === true,
      metricName: committed ? (attestation.metricName ?? null) : null,
      metricValue,
      bound,
      withinBound:
        representation === "bounded" && metricValue !== null && bound !== null
          ? metricValue <= bound
          : null,
      local,
      media: mediaEvidence,
    });
  }

  return claims;
}

export async function verifyBundle(
  bundle: Bundle,
  challenges?: ChallengeIndex,
  pinnedRoot?: string,
  media?: Record<string, string>,
): Promise<BundleVerification> {
  const leaves: string[] = [];

  for (const publication of bundle.publications) {
    leaves.push(
      await sha256Hex(
        canonicalize(leafPayload(publication, bundle.manifest.leafVersion)),
      ),
    );
  }

  const computedRoot = await merkleRoot(leaves);
  const listed = bundle.manifest.publications.map((entry) => entry.leaf);
  const listMatches = JSON.stringify(listed) === JSON.stringify(leaves);

  if (computedRoot !== bundle.manifest.root) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the publications in this bundle do not rebuild the anchored root",
      aiClaims: await aiClaimsFor(bundle, challenges, media),
    };
  }

  if (!listMatches) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the manifest leaf list does not match the publications",
      aiClaims: await aiClaimsFor(bundle, challenges, media),
    };
  }

  if (pinnedRoot && computedRoot !== pinnedRoot) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the bundle root does not match the pinned chain root",
      aiClaims: await aiClaimsFor(bundle, challenges, media),
    };
  }

  return {
    valid: true,
    root: bundle.manifest.root,
    computedRoot,
    publications: leaves.length,
    reason: null,
    aiClaims: await aiClaimsFor(bundle, challenges, media),
  };
}
