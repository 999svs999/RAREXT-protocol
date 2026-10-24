import { canonicalize, leafPayload } from "@rarext/core";
import type { Publication } from "@rarext/core";

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
}

export interface ChallengeIndex {
  [challengeId: string]: { bound?: number } & Record<string, unknown>;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

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

function aiClaimsFor(
  bundle: Bundle,
  challenges?: ChallengeIndex,
): AiClaimSummary[] {
  return bundle.publications.map((publication) => {
    const attestation = publication.attestation as {
      representation?: "exact" | "bounded" | "generative";
      metricName?: string;
      metricValue?: number;
      correct?: boolean;
    };

    const representation = attestation.representation ?? null;
    const spec = challenges?.[publication.challengeId];
    const bound = typeof spec?.bound === "number" ? spec.bound : null;
    const metricValue =
      typeof attestation.metricValue === "number" ? attestation.metricValue : null;

    return {
      publicationId: publication.id,
      representation,
      correct: attestation.correct === true,
      metricName: attestation.metricName ?? null,
      metricValue,
      bound,
      withinBound:
        representation === "bounded" && metricValue !== null && bound !== null
          ? metricValue <= bound
          : null,
    };
  });
}

export async function verifyBundle(
  bundle: Bundle,
  challenges?: ChallengeIndex,
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
      aiClaims: aiClaimsFor(bundle, challenges),
    };
  }

  if (!listMatches) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the manifest leaf list does not match the publications",
      aiClaims: aiClaimsFor(bundle, challenges),
    };
  }

  return {
    valid: true,
    root: bundle.manifest.root,
    computedRoot,
    publications: leaves.length,
    reason: null,
    aiClaims: aiClaimsFor(bundle, challenges),
  };
}
