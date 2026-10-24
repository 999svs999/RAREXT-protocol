import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  canonicalize,
  findSemantics,
  LOGIC_SEMANTICS,
  semanticsRecord,
} from "../../../packages/core/src/index.ts";
import type {
  Attestation,
  Challenge,
  ClaimKind,
  ClaimScope,
  Semantics,
  SemanticsBinding,
} from "../../../packages/core/src/index.ts";

export const LOGIC_VERIFIER_MANIFEST = {
  algorithm: "nand-latch-simulator",
  app: "logic",
  artifactKind: "logic.netlist",
  version: 1,
} as const;

export function hashValue(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function specHash(spec: unknown): string {
  return hashValue(spec);
}

export function semanticsHash(semantics: Semantics): string {
  return hashValue(semantics);
}

export function logicVerifierHash(): string {
  return hashValue(LOGIC_VERIFIER_MANIFEST);
}

function asSemantics(value: unknown, fallbackApp: string): Semantics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("semantics must be a JSON object");
  }

  const record = value as Partial<Semantics>;

  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error("semantics.id must be a string");
  }

  if (typeof record.app !== "string" || record.app.length === 0) {
    throw new Error(`semantics ${record.id} is missing an app`);
  }

  const claimKind = record.claimKind ?? "satisfies";
  if (!["satisfies", "attests", "produces", "derives", "exact", "bounded", "generative"].includes(claimKind)) {
    throw new Error(`semantics ${record.id} has an unknown claim kind`);
  }

  return {
    id: record.id,
    app: record.app,
    version: typeof record.version === "number" ? record.version : 1,
    claimKind: claimKind as ClaimKind,
    title: typeof record.title === "string" ? record.title : record.id,
    summary: typeof record.summary === "string" ? record.summary : "",
    specHash: typeof record.specHash === "string" ? record.specHash : "",
    verifierHash:
      typeof record.verifierHash === "string" ? record.verifierHash : null,
    inputs: Array.isArray(record.inputs)
      ? record.inputs.filter((item): item is string => typeof item === "string")
      : [],
    outputs: Array.isArray(record.outputs)
      ? record.outputs.filter((item): item is string => typeof item === "string")
      : [],
    interpretation:
      typeof record.interpretation === "object" && record.interpretation !== null
        ? {
            doc: String(record.interpretation.doc ?? ""),
            owner: String(record.interpretation.owner ?? fallbackApp),
            reviewedAt: String(record.interpretation.reviewedAt ?? new Date().toISOString()),
          }
        : null,
    owner: typeof record.owner === "string" ? record.owner : fallbackApp,
    origin: record.origin === "declared" ? "declared" : "derived",
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
  };
}

function configuredSemantics(): Semantics[] {
  const source = process.env.RAREXT_SEMANTICS?.trim();
  if (!source) return [];

  let text = source;

  if (!source.startsWith("[") && !source.startsWith("{")) {
    if (!existsSync(source)) {
      throw new Error(`RAREXT_SEMANTICS file not found: ${source}`);
    }
    text = readFileSync(source, "utf8");
  }

  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "semantics" in parsed
      ? (parsed as { semantics: unknown }).semantics
      : null;

  if (!Array.isArray(list)) {
    throw new Error("RAREXT_SEMANTICS must be an array or { semantics: [] }");
  }

  return list.map((item) => asSemantics(item, "unknown"));
}

export interface SemanticsRegistry {
  list(): Semantics[];
  get(id: string, version?: number): Semantics | null;
  hashOf(semantics: Semantics): string;
  bindingFor(challenge: Challenge): SemanticsBinding;
}

export function createSemanticsRegistry(challenges: () => Challenge[]): SemanticsRegistry {
  const registry = new Map<string, Semantics>();

  for (const semantics of LOGIC_SEMANTICS) {
    registry.set(`${semantics.id}@${semantics.version}`, semantics);
  }

  for (const semantics of configuredSemantics()) {
    registry.set(`${semantics.id}@${semantics.version}`, semantics);
  }

  return {
    list: () => [...registry.values()],
    get: (id, version) => findSemantics([...registry.values()], id, version),
    hashOf: (semantics) => semanticsHash(semantics),
    bindingFor: (challenge) => {
      const semantics = findSemantics(
        [...registry.values()],
        challenge.semanticsId,
        challenge.semanticsVersion,
      );

      if (!semantics) return "missing";
      return semantics.specHash === specHash(challenge.spec) ? "ok" : "spec-mismatch";
    },
  };
}

export function semanticsForChallenge(
  registry: SemanticsRegistry,
  challenge: Challenge,
): Semantics {
  const declared = registry.get(challenge.semanticsId, challenge.semanticsVersion);

  if (declared) return declared;

  const derived: Semantics = {
    id: challenge.semanticsId,
    app: challenge.app,
    version: challenge.semanticsVersion,
    claimKind: "satisfies",
    title: challenge.title,
    summary: challenge.description,
    specHash: specHash(challenge.spec),
    verifierHash: null,
    inputs: [],
    outputs: [],
    interpretation: null,
    owner: challenge.app,
    origin: "derived",
    createdAt: challenge.createdAt,
  };

  return derived;
}

export function claimScope(value: unknown): ClaimScope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const scope: ClaimScope = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") scope[key] = item;
  }

  return Object.keys(scope).length > 0 ? scope : null;
}

export interface ClaimOptions {
  claimKind?: ClaimKind;
  scope?: ClaimScope | null;
}

export interface ClaimBindingError {
  error: string;
}

export function bindClaim(
  attestation: Attestation,
  challenge: Challenge,
  registry: SemanticsRegistry,
  options: ClaimOptions = {},
): { attestation: Attestation } | ClaimBindingError {
  const semantics = semanticsForChallenge(registry, challenge);
  const kind = options.claimKind ?? semantics.claimKind;

  if (kind !== semantics.claimKind) {
    return {
      error: `challenge ${challenge.id} is defined by ${semantics.id}@${semantics.version}, which licenses "${semantics.claimKind}" claims, not "${kind}"`,
    };
  }

  const scope = options.scope ?? null;
  const allowed = new Set([...semantics.inputs, ...semantics.outputs]);

  if (scope) {
    for (const key of Object.keys(scope)) {
      if (!allowed.has(key)) {
        return {
          error: `claim scope "${key}" is not part of ${semantics.id}@${semantics.version}`,
        };
      }
    }
  }

  return {
    attestation: {
      ...attestation,
      semanticsId: semantics.id,
      semanticsVersion: semantics.version,
      semanticsHash: semanticsHash(semantics),
      claimKind: kind,
      scope,
      verifierHash:
        attestation.verifierHash || semantics.verifierHash || hashValue(semantics),
    },
  };
}

export { semanticsRecord };
