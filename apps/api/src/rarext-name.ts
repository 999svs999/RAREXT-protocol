import { createHash, randomUUID } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Artifact,
  Attestation,
  Challenge,
} from "../../../packages/core/src/index.ts";
import type { AppVerifier } from "./verifiers.ts";

/**
 * The RAREXT name binding: a human name bound to the identity key that owns it.
 *
 * A name resolves to an IDENTITY, not to a root — anchoring a `name -> root`
 * binding would change the root it names, and no fixed point exists. Instead the
 * record proves "this name is claimed by this key", the same key that signs the
 * brand's publications, so a client resolves `rar.<name>` by finding the latest
 * anchored bundle authored by that key and then verifying whatever it fetched.
 * Uniqueness is not assumed: two records claiming one name with DIFFERENT keys
 * is a collision a resolver must refuse, never silently pick from.
 */

const NAME_APP = "rarext-name";
const NAME_KIND = "rarext.name.v1";

const NAME_VERIFIER_MANIFEST = {
  app: NAME_APP,
  version: 1,
  algorithm: "structural-name-record-check",
  representation: "exact",
} as const;

export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TARGET_KINDS = new Set(["site", "registry", "mirror", "gallery"]);
const MAX_TARGETS = 8;

export interface RarextNameTarget {
  kind: string;
  url: string;
}

export interface RarextNameBody {
  name: string;
  identityKey: string;
  targets: RarextNameTarget[];
  note?: string;
}

/** Pure structural check — returns the list of violations (empty = holds). */
export function verifyRarextNameRecord(
  body: unknown,
): { ok: true; checks: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const b = body as Partial<RarextNameBody> | null;

  if (typeof b !== "object" || b === null) {
    return { ok: false, errors: ["body must be an object"] };
  }

  if (typeof b.name !== "string" || !NAME_PATTERN.test(b.name)) {
    errors.push("name must be lowercase alphanumerics/dashes, 2..64 chars, no leading/trailing dash");
  }

  if (typeof b.identityKey !== "string" || !SHA256_PATTERN.test(b.identityKey)) {
    errors.push("identityKey must be 64 lowercase hex chars");
  }

  if (!Array.isArray(b.targets) || b.targets.length < 1 || b.targets.length > MAX_TARGETS) {
    errors.push(`targets must be an array of 1..${MAX_TARGETS} entries`);
  } else {
    for (const [i, t] of b.targets.entries()) {
      if (typeof t !== "object" || t === null) {
        errors.push(`targets[${i}] must be an object`);
        continue;
      }
      if (typeof t.kind !== "string" || !TARGET_KINDS.has(t.kind)) {
        errors.push(`targets[${i}].kind must be one of site|registry|mirror|gallery`);
        continue;
      }
      if (typeof t.url !== "string" || !/^https:\/\//.test(t.url)) {
        errors.push(`targets[${i}].url must be an https URL`);
      }
    }
  }

  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 280)) {
    errors.push("note must be a string of at most 280 chars when present");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    checks: [
      "name",
      "identity-key",
      `targets:${b.targets!.length}`,
      `kinds:${[...new Set(b.targets!.map((t) => t.kind))].sort().join("+")}`,
    ],
  };
}

export function rarextNameVerifier(): AppVerifier {
  return {
    id: NAME_APP,
    name: "RAREXT name binding",
    version: "1",
    description:
      "Structural verification of a name binding: a lowercase name claimed by an identity key, with the https targets it resolves to. Deterministic and local; uniqueness across records is a resolver concern, not a verifier one.",
    artifactKinds: [NAME_KIND],
    challengeCount: 0,
    verifier: "builtin",
    configured: true,
    url: null,
    supports: (artifact) => artifact.app === NAME_APP && artifact.kind === NAME_KIND,
    verify: async (artifact: Artifact, challenge: Challenge): Promise<Attestation> => {
      const verdict = verifyRarextNameRecord(artifact.body);
      if (!verdict.ok) {
        throw new Error(`rarext.name.v1 record failed structural checks: ${verdict.errors.join("; ")}`);
      }

      const body = artifact.body as RarextNameBody;
      const sha256 = (value: string | Uint8Array): string =>
        createHash("sha256").update(value).digest("hex");

      const trace = {
        rule: NAME_VERIFIER_MANIFEST.algorithm,
        name: body.name,
        identityKey: body.identityKey,
        targets: body.targets.map((t) => `${t.kind}:${t.url}`),
        note: body.note ?? null,
        checks: verdict.checks,
      };

      const correct = true;

      return {
        id: randomUUID(),
        verifier: NAME_VERIFIER_MANIFEST.algorithm,
        app: NAME_APP,
        challengeId: challenge.id,
        taskId: challenge.id,
        circuitHash: sha256(canonicalize(artifact)),
        traceHash: sha256(canonicalize(trace)),
        correct,
        score: correct ? 1 : 0,
        gateCount: body.targets.length,
        semanticsId: `${NAME_APP}/${challenge.id}`,
        semanticsVersion: 1,
        semanticsHash: "",
        claimKind: "attests",
        representation: "exact",
        scope: null,
        verifierHash: sha256(canonicalize(NAME_VERIFIER_MANIFEST)),
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        createdAt: new Date().toISOString(),
      };
    },
  };
}

export const RAREXT_NAME_KIND = NAME_KIND;
export const RAREXT_NAME_APP = NAME_APP;
