import { createHash, randomUUID } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Artifact,
  Attestation,
  Challenge,
} from "../../../packages/core/src/index.ts";
import type { AppVerifier } from "./verifiers.ts";
// Single source of truth for which generators may back a FUTURISTIC
// record — shared with the ship watchdog so the registry's rule and the
// watchdog's assumption cannot drift apart.
import vettedModels from "./vetted-models.json" with { type: "json" };

/**
 * The FUTURISTIC verifier: structural verification of the brand's published
 * media records. A `futuristic.video.v1` artifact carries the full provenance
 * of one pipeline run — the one-line prompt (never edited, per operator
 * doctrine), the Agnes model that generated it, where the video lives (R2 URL
 * + optional sha256 of the bytes), and every platform it was published to with
 * its platform-side id.
 *
 * Verification is deterministic and local: shape checks on every field. Anyone
 * can recompute the verdict from the artifact alone — the same rule the
 * registry's other verifiers follow. The author's signature (checked by the
 * publication path) carries integrity; this verifier carries structure.
 */

const FUTURISTIC_APP = "futuristic-video";
const FUTURISTIC_KIND = "futuristic.video.v1";

const FUTURISTIC_VERIFIER_MANIFEST = {
  app: FUTURISTIC_APP,
  version: 1,
  algorithm: "structural-record-check",
  representation: "exact",
} as const;

export const RUN_ID_PATTERN = /^\d{8}T\d{6}-[0-9a-f]{6}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLATFORMS = new Set(["youtube", "instagram", "facebook", "threads"]);
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Vetted generators, from the shared list. A record may only commit media from a
 * generator the operator has approved, and the model id must match that
 * generator: an open-ended rule ("any model id") would make the registry's claim
 * about a record meaningless.
 *
 * WIDENING this list only ADDS acceptable records, so it cannot invalidate an
 * already-anchored attestation — and it is deliberately NOT part of
 * FUTURISTIC_VERIFIER_MANIFEST, so the verifier hash does not move.
 * 2026-11-04 (operator go-ahead): added LTX, the pipeline's second free
 * generator, so FUTURISTIC content is no longer anchorable from one vendor only.
 */
export const VETTED_MODELS: Array<{ provider: string; re: RegExp }> = (
  vettedModels as { providers: Array<{ provider: string; pattern: string }> }
).providers.map(({ provider, pattern }) => ({ provider, re: new RegExp(pattern) }));

/** The vetted provider a model id belongs to, or null when it is not vetted. */
export function vettedProviderFor(model: unknown): string | null {
  if (typeof model !== "string") return null;
  for (const { provider, re } of VETTED_MODELS) {
    if (re.test(model)) return provider;
  }
  return null;
}

export interface FuturisticVideoBody {
  run_id: string;
  theme: string;
  prompt: string;
  model: string;
  duration_s: number;
  video: {
    sha256?: string;
    r2_url?: string;
    bytes?: number;
  };
  platforms: Array<{
    platform: string;
    url?: string;
    id?: string;
  }>;
  drive?: Record<string, string>;
}

/** Pure structural check — returns the list of violations (empty = holds). */
export function verifyFuturisticRecord(
  body: unknown,
): { ok: true; checks: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const b = body as Partial<FuturisticVideoBody> | null;

  if (typeof b !== "object" || b === null) {
    return { ok: false, errors: ["body must be an object"] };
  }

  if (typeof b.run_id !== "string" || !RUN_ID_PATTERN.test(b.run_id)) {
    errors.push("run_id must match YYYYMMDDTHHMMSS-6hex");
  }

  if (typeof b.theme !== "string" || b.theme.length < 1 || b.theme.length > 120) {
    errors.push("theme must be a 1..120 char string");
  }

  // The one-line prompt rule: never edited, never qualified — so it must BE
  // one line, and short enough to be one.
  if (typeof b.prompt !== "string" || b.prompt.length < 1 || b.prompt.length > 200) {
    errors.push("prompt must be a 1..200 char string");
  } else if (/\r|\n/.test(b.prompt)) {
    errors.push("prompt must be ONE line (operator doctrine)");
  }

  if (vettedProviderFor(b.model) === null) {
    errors.push(
      `model must be the id of a vetted generator (${VETTED_MODELS.map((m) => m.re.source).join(" | ")})`,
    );
  }

  if (typeof b.duration_s !== "number" || !Number.isFinite(b.duration_s) || b.duration_s < 2 || b.duration_s > 120) {
    errors.push("duration_s must be a finite number in [2, 120]");
  }

  if (typeof b.video !== "object" || b.video === null) {
    errors.push("video must be an object");
  } else {
    const v = b.video as FuturisticVideoBody["video"];
    if (v.sha256 !== undefined && (typeof v.sha256 !== "string" || !SHA256_PATTERN.test(v.sha256))) {
      errors.push("video.sha256 must be 64 lowercase hex chars when present");
    }
    if (v.r2_url !== undefined && (typeof v.r2_url !== "string" || !/^https:\/\/[^\s]+\.mp4$/.test(v.r2_url))) {
      errors.push("video.r2_url must be an https URL ending in .mp4 when present");
    }
    if (v.bytes !== undefined && (typeof v.bytes !== "number" || !Number.isInteger(v.bytes) || v.bytes < 1)) {
      errors.push("video.bytes must be a positive integer when present");
    }
  }

  if (!Array.isArray(b.platforms) || b.platforms.length < 1 || b.platforms.length > 4) {
    errors.push("platforms must be an array of 1..4 entries");
  } else {
    for (const [i, p] of b.platforms.entries()) {
      if (typeof p !== "object" || p === null || !PLATFORMS.has(p.platform)) {
        errors.push(`platforms[${i}].platform must be one of youtube|instagram|facebook|threads`);
        continue;
      }
      if (p.platform === "youtube") {
        if (typeof p.id !== "string" || !YOUTUBE_ID_PATTERN.test(p.id)) {
          errors.push(`platforms[${i}] (youtube) must carry an 11-char video id`);
        }
      } else if (typeof p.id !== "string" || p.id.length < 1) {
        errors.push(`platforms[${i}] (${p.platform}) must carry a non-empty id`);
      }
      if (p.url !== undefined && (typeof p.url !== "string" || !/^https:\/\//.test(p.url))) {
        errors.push(`platforms[${i}].url must be an https URL when present`);
      }
    }
  }

  if (b.drive !== undefined) {
    if (typeof b.drive !== "object" || b.drive === null) {
      errors.push("drive must be an object of name -> file id when present");
    } else {
      for (const [name, id] of Object.entries(b.drive)) {
        if (typeof id !== "string" || id.length < 10) {
          errors.push(`drive["${name}"] must be a plausible file id`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    checks: [
      "run_id",
      "theme",
      "prompt-one-line",
      "model",
      "duration",
      "video-commitment",
      `platforms:${b.platforms!.length}`,
    ],
  };
}

export function futuristicVideoVerifier(): AppVerifier {
  return {
    id: FUTURISTIC_APP,
    name: "FUTURISTIC video record",
    version: "1",
    description:
      "Structural verification of FUTURISTIC pipeline records: run id, one-line prompt doctrine, vetted-generator model, media commitment, and per-platform publication ids — all recomputable locally from the artifact.",
    artifactKinds: [FUTURISTIC_KIND],
    challengeCount: 0,
    verifier: "builtin",
    configured: true,
    url: null,
    supports: (artifact) =>
      artifact.app === FUTURISTIC_APP && artifact.kind === FUTURISTIC_KIND,
    verify: async (artifact: Artifact, challenge: Challenge): Promise<Attestation> => {
      const verdict = verifyFuturisticRecord(artifact.body);
      if (!verdict.ok) {
        throw new Error(`futuristic.video.v1 record failed structural checks: ${verdict.errors.join("; ")}`);
      }

      const body = artifact.body as FuturisticVideoBody;
      const sha256 = (value: string | Uint8Array): string =>
        createHash("sha256").update(value).digest("hex");

      const trace = {
        rule: FUTURISTIC_VERIFIER_MANIFEST.algorithm,
        run_id: body.run_id,
        theme: body.theme,
        promptDigest: sha256(body.prompt),
        model: body.model,
        duration_s: body.duration_s,
        videoDigest: body.video.sha256 ?? null,
        platforms: body.platforms.map((p) => `${p.platform}:${p.id ?? "?"}`),
        checks: verdict.checks,
      };

      const correct = true;

      return {
        id: randomUUID(),
        verifier: FUTURISTIC_VERIFIER_MANIFEST.algorithm,
        app: FUTURISTIC_APP,
        challengeId: challenge.id,
        taskId: challenge.id,
        circuitHash: sha256(canonicalize(artifact)),
        traceHash: sha256(canonicalize(trace)),
        correct,
        score: correct ? 1 : 0,
        gateCount: body.platforms.length,
        semanticsId: `${FUTURISTIC_APP}/${challenge.id}`,
        semanticsVersion: 1,
        semanticsHash: "",
        claimKind: "attests",
        representation: "exact",
        scope: null,
        verifierHash: sha256(canonicalize(FUTURISTIC_VERIFIER_MANIFEST)),
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        createdAt: new Date().toISOString(),
      };
    },
  };
}

/** The artifact kind constant, for publishers. */
export const FUTURISTIC_VIDEO_KIND = FUTURISTIC_KIND;
export const FUTURISTIC_VIDEO_APP = FUTURISTIC_APP;
