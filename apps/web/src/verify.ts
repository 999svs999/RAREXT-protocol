import {
  canonicalize,
  isGenerativeMedia,
  leafPayload,
  renderRaster,
  verifyAiArtifact,
} from "@rarext/core";
import type { AiLocalVerification, Publication } from "@rarext/core";

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
  size: number;
  /** sha256 of the raster re-derived here from the committed model and seed. */
  reDerived: string | null;
  /** reDerived === raster: the picture really is a function of the commitment. */
  matches: boolean | null;
  /** sha256 of the supplied blob bytes === blob, when bytes were supplied. */
  blobMatches: boolean | null;
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
  blobBytes: Uint8Array | undefined,
): Promise<AiMediaEvidence | null> {
  const body = publication.artifact?.body as { model?: unknown; seed?: unknown; media?: unknown } | undefined;
  if (!body || typeof body.seed !== "number" || !isGenerativeMedia(body.media)) {
    return null;
  }
  const media = body.media;

  let reDerived: string | null = null;
  try {
    const raster = renderRaster(
      body.model as Parameters<typeof renderRaster>[0],
      body.seed,
      media.size,
    );
    reDerived = await sha256BytesHex(raster);
  } catch {
    reDerived = null;
  }

  let blobMatches: boolean | null = null;
  if (blobBytes) {
    blobMatches = (await sha256BytesHex(blobBytes)) === media.blob;
  }

  return {
    blob: media.blob,
    raster: media.raster,
    size: media.size,
    reDerived,
    matches: reDerived === null ? null : reDerived === media.raster,
    blobMatches,
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
      const hash = body?.media?.blob;
      if (typeof hash === "string") {
        const encoded = media?.[hash];
        const bytes = typeof encoded === "string" ? base64ToBytes(encoded) : undefined;
        mediaEvidence = await mediaFor(publication, bytes);
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
