import { createHash, randomUUID } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Artifact,
  Attestation,
  Challenge,
} from "../../../packages/core/src/index.ts";
import type { AppVerifier } from "./verifiers.ts";

/**
 * The FUTURISTIC *site* verifier: structural verification of a record that
 * pins the brand's public web presence — the canonical URL, the pages that make
 * it up, and the SHA-256 of each page's bytes as deployed.
 *
 * Verification is deterministic and local (shape checks only), the same rule
 * every verifier in this registry follows: anyone can recompute the verdict from
 * the artifact alone. Deliberately NOT in the verifier: re-fetching the live
 * URLs. A verifier that reaches the network is not deterministic and would
 * re-brand live-byte checking as structure. The pinned digests make the check
 * possible anywhere; the checker that recomputes bytes against the live origin
 * is a separate, explicit step.
 */

const FUTURISTIC_SITE_APP = "futuristic-site";
const FUTURISTIC_SITE_KIND = "futuristic.site.v1";

const FUTURISTIC_SITE_VERIFIER_MANIFEST = {
  app: FUTURISTIC_SITE_APP,
  version: 1,
  algorithm: "structural-site-record-check",
  representation: "exact",
} as const;

/** Everything brand-specific about a site-record verifier. All four manifest
 *  fields are committed to by verifierHash, so they are part of the record. */
export interface SiteRecordConfig {
  app: string;
  kind: string;
  name: string;
  description: string;
  manifest: { app: string; version: number; algorithm: string; representation: "exact" };
}

export const FUTURISTIC_SITE_CONFIG: SiteRecordConfig = {
  app: FUTURISTIC_SITE_APP,
  kind: FUTURISTIC_SITE_KIND,
  name: "FUTURISTIC site record",
  description:
    "Structural verification of the FUTURISTIC brand site record: canonical origin, page digests as deployed, and the media (film) it serves — recomputable locally from the artifact. Live-byte checking against the origin is an explicit external step, not part of this verdict.",
  manifest: FUTURISTIC_SITE_VERIFIER_MANIFEST,
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/;
const MAX_PAGES = 32;
const MAX_MEDIA = 8;

export interface FuturisticSitePage {
  path: string;
  sha256: string;
  bytes: number;
}

export interface FuturisticSiteBody {
  site: string;
  title: string;
  published_at: string;
  generator: string;
  revision?: string;
  pages: FuturisticSitePage[];
  media?: Array<{ url: string; sha256: string; bytes: number }>;
}

function isIsoDate(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 10) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/** Pure structural check — returns the list of violations (empty = holds). */
export function verifySiteRecord(
  body: unknown,
): { ok: true; checks: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const b = body as Partial<FuturisticSiteBody> | null;

  if (typeof b !== "object" || b === null) {
    return { ok: false, errors: ["body must be an object"] };
  }

  // Canonical origin — the one URL every other reference resolves against.
  if (typeof b.site !== "string" || !/^https:\/\/[^\s/]+\/$/.test(b.site)) {
    errors.push("site must be an https origin URL ending in /");
  } else if (b.site.length > 200) {
    errors.push("site must be <= 200 chars");
  }

  if (typeof b.title !== "string" || b.title.length < 1 || b.title.length > 200) {
    errors.push("title must be a 1..200 char string");
  }

  if (!isIsoDate(b.published_at)) {
    errors.push("published_at must be an ISO-8601 timestamp");
  }

  if (typeof b.generator !== "string" || b.generator.length < 1 || b.generator.length > 120) {
    errors.push("generator must be a 1..120 char string");
  }

  if (b.revision !== undefined && (typeof b.revision !== "string" || !REVISION_PATTERN.test(b.revision))) {
    errors.push("revision must be 7..64 lowercase hex chars when present");
  }

  if (!Array.isArray(b.pages) || b.pages.length < 1 || b.pages.length > MAX_PAGES) {
    errors.push(`pages must be an array of 1..${MAX_PAGES} entries`);
  } else {
    const seen = new Set<string>();
    for (const [i, p] of b.pages.entries()) {
      if (typeof p !== "object" || p === null) {
        errors.push(`pages[${i}] must be an object`);
        continue;
      }
      if (typeof p.path !== "string" || !p.path.startsWith("/") || p.path.includes("..")) {
        errors.push(`pages[${i}].path must start with / and not traverse`);
        continue;
      }
      if (seen.has(p.path)) errors.push(`pages[${i}].path is duplicated: ${p.path}`);
      seen.add(p.path);
      if (typeof p.sha256 !== "string" || !SHA256_PATTERN.test(p.sha256)) {
        errors.push(`pages[${i}].sha256 must be 64 lowercase hex chars`);
      }
      if (typeof p.bytes !== "number" || !Number.isInteger(p.bytes) || p.bytes < 1) {
        errors.push(`pages[${i}].bytes must be a positive integer`);
      }
    }
  }

  if (b.media !== undefined) {
    if (!Array.isArray(b.media) || b.media.length > MAX_MEDIA) {
      errors.push(`media must be an array of at most ${MAX_MEDIA} entries when present`);
    } else {
      for (const [i, m] of b.media.entries()) {
        if (typeof m !== "object" || m === null) {
          errors.push(`media[${i}] must be an object`);
          continue;
        }
        if (typeof m.url !== "string" || !/^https:\/\//.test(m.url)) {
          errors.push(`media[${i}].url must be an https URL`);
        }
        if (typeof m.sha256 !== "string" || !SHA256_PATTERN.test(m.sha256)) {
          errors.push(`media[${i}].sha256 must be 64 lowercase hex chars`);
        }
        if (typeof m.bytes !== "number" || !Number.isInteger(m.bytes) || m.bytes < 1) {
          errors.push(`media[${i}].bytes must be a positive integer`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const bytes = b.pages!.reduce((a, p) => a + p.bytes, 0);
  return {
    ok: true,
    checks: [
      "site-origin",
      "title",
      "published-at",
      "generator",
      ...(b.revision ? ["revision"] : []),
      `pages:${b.pages!.length}`,
      `bytes:${bytes}`,
      ...(b.media && b.media.length ? [`media:${b.media.length}`] : []),
    ],
  };
}

/** The old name, kept as an alias so the generic rename breaks nothing. */
export const verifyFuturisticSiteRecord = verifySiteRecord;

/**
 * Build a site-record verifier for a brand.
 *
 * The check itself is structural and brand-agnostic — origin, page digests,
 * media — so every brand on the protocol shares one implementation and only the
 * app/kind/manifest differ. Anchored records commit to the manifest via
 * verifierHash, which is why the parameterisation is exact rather than
 * approximate: FUTURISTIC's config is value-identical to the hard-coded
 * constants it replaced.
 */
export function siteRecordVerifier(cfg: SiteRecordConfig = FUTURISTIC_SITE_CONFIG): AppVerifier {
  return {
    id: cfg.app,
    name: cfg.name,
    version: "1",
    description: cfg.description,
    artifactKinds: [cfg.kind],
    challengeCount: 0,
    verifier: "builtin",
    configured: true,
    url: null,
    supports: (artifact) =>
      artifact.app === cfg.app && artifact.kind === cfg.kind,
    verify: async (artifact: Artifact, challenge: Challenge): Promise<Attestation> => {
      const verdict = verifySiteRecord(artifact.body);
      if (!verdict.ok) {
        throw new Error(`${cfg.kind} record failed structural checks: ${verdict.errors.join("; ")}`);
      }

      const body = artifact.body as FuturisticSiteBody;
      const sha256 = (value: string | Uint8Array): string =>
        createHash("sha256").update(value).digest("hex");
      const bytes = body.pages.reduce((a, p) => a + p.bytes, 0);

      const trace = {
        rule: FUTURISTIC_SITE_VERIFIER_MANIFEST.algorithm,
        site: body.site,
        titleDigest: sha256(body.title),
        published_at: body.published_at,
        generator: body.generator,
        revision: body.revision ?? null,
        pages: body.pages.map((p) => `${p.path}:${p.sha256.slice(0, 12)}`),
        bytesTotal: bytes,
        media: (body.media ?? []).map((m) => m.url),
        checks: verdict.checks,
      };

      const correct = true;

      return {
        id: randomUUID(),
        verifier: cfg.manifest.algorithm,
        app: cfg.app,
        challengeId: challenge.id,
        taskId: challenge.id,
        circuitHash: sha256(canonicalize(artifact)),
        traceHash: sha256(canonicalize(trace)),
        correct,
        score: correct ? 1 : 0,
        gateCount: body.pages.length,
        semanticsId: `${cfg.app}/${challenge.id}`,
        semanticsVersion: 1,
        semanticsHash: "",
        claimKind: "attests",
        representation: "exact",
        scope: null,
        verifierHash: sha256(canonicalize(cfg.manifest)),
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        createdAt: new Date().toISOString(),
      };
    },
  };
}

export const FUTURISTIC_SITE_KIND_EXPORT = FUTURISTIC_SITE_KIND;
export const FUTURISTIC_SITE_APP_EXPORT = FUTURISTIC_SITE_APP;

export function futuristicSiteVerifier(): AppVerifier {
  return siteRecordVerifier(FUTURISTIC_SITE_CONFIG);
}
