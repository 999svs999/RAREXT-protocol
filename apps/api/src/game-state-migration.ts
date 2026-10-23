import { createHash } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { Challenge } from "../../../packages/core/src/index.ts";

import { migrateSnapshot } from "./migrations.ts";

export const GAME_STATE_MIGRATION_KIND = "rarext.game-state-migration";
export const GAME_STATE_MIGRATION_VERSION = 1;

export const DURABLE_GAME_STATE_COLLECTIONS = [
  "publications",
  "identities",
  "anchors",
  "identityLinks",
  "revocations",
  "credits",
  "rotations",
  "delegations",
] as const;

export type DurableGameStateCollection = (typeof DURABLE_GAME_STATE_COLLECTIONS)[number];

export interface GameStateCollectionPlan {
  name: DurableGameStateCollection;
  required: boolean;
  count: number;
  fields: string[];
  digest: string;
  description: string;
}

export interface GameStateDerivedPlan {
  name: "profiles" | "leaderboard" | "lineage" | "earnings";
  fields: string[];
  note: string;
}

export interface GameStateChallengePlan {
  captured: boolean;
  source: string | null;
  count: number;
  fields: string[];
  digest: string | null;
  note: string;
}

export interface GameStateMigrationGap {
  id: "active-builds" | "challenges" | "reputation" | "ratings" | "target-schema";
  blocking: true;
  detail: string;
}

export interface GameStateMigrationPlan {
  kind: typeof GAME_STATE_MIGRATION_KIND;
  version: typeof GAME_STATE_MIGRATION_VERSION;
  status: "deferred";
  mode: "no-op";
  source: string | null;
  generatedAt: string;
  sourceVersion: number;
  snapshotVersion: number;
  appliedMigrations: string[];
  sourceDigest: string;
  target: null;
  collections: GameStateCollectionPlan[];
  derived: GameStateDerivedPlan[];
  external: {
    challenges: GameStateChallengePlan;
  };
  unmanagedTopLevelFields: string[];
  gaps: GameStateMigrationGap[];
  checklist: string[];
  fallback: {
    action: "no-op";
    sourceMutated: false;
    targetWritten: false;
    note: string;
  };
}

export interface GameStateMigrationBundle extends GameStateMigrationPlan {
  snapshot: Record<string, unknown>;
  challenges: unknown[] | null;
}

export interface GameStateMigrationOptions {
  source?: string | null;
  generatedAt?: string;
  challenges?: unknown;
  challengeSource?: string | null;
}

interface CollectionRule {
  name: DurableGameStateCollection;
  required: boolean;
  description: string;
}

const COLLECTION_RULES: CollectionRule[] = [
  {
    name: "publications",
    required: true,
    description: "Signed build and publication records, including attestations and durability observations",
  },
  {
    name: "identities",
    required: false,
    description: "Registered handles, keys, algorithms, and creation timestamps",
  },
  {
    name: "anchors",
    required: false,
    description: "Merkle roots, publication ids, leaf versions, adapter references, and receipts",
  },
  {
    name: "identityLinks",
    required: false,
    description: "Proofs that link a registry handle to an external network identity",
  },
  {
    name: "revocations",
    required: false,
    description: "Signed do-not-trust records for capabilities, verifiers, and artifacts",
  },
  {
    name: "credits",
    required: false,
    description: "Per-action credit ledger records keyed by artifact hash",
  },
  {
    name: "rotations",
    required: false,
    description: "Signed key rotations that retire an old key and authorize a new one",
  },
  {
    name: "delegations",
    required: false,
    description: "Signed scoped publishing delegations with optional expiry",
  },
];

export const DERIVED_GAME_STATE: GameStateDerivedPlan[] = [
  {
    name: "profiles",
    fields: [
      "handle",
      "verified",
      "publications",
      "attestations",
      "bestScore",
      "totalScore",
      "createdAt",
      "lastPublishedAt",
    ],
    note: "Rebuilt from publications and identities; the profile is not stored in snapshot v2 and there is no reputation score.",
  },
  {
    name: "leaderboard",
    fields: ["rank", "buildId", "author", "app", "challengeId", "score", "gateCount", "createdAt"],
    note: "Derived from the current publication set; no separate ranking record exists.",
  },
  {
    name: "lineage",
    fields: ["build", "ancestors", "descendants"],
    note: "Derived from Publication.parentId; remixes are not a separate durable entity.",
  },
  {
    name: "earnings",
    fields: ["keyId", "credits", "byAction", "jobs"],
    note: "Summarized from credit records; the ledger records are the durable source.",
  },
];

export const GAME_STATE_GAPS: GameStateMigrationGap[] = [
  {
    id: "active-builds",
    blocking: true,
    detail:
      "publications is append-only build history. There is no persisted active, closed, or archived lifecycle field; feed and BuildSummary are derived views.",
  },
  {
    id: "challenges",
    blocking: true,
    detail:
      "Challenge definitions come from code seeds, RAREXT_CHALLENGES, and an in-memory sponsored registry. Snapshot v2 does not contain them, and sponsored challenges do not survive a restart.",
  },
  {
    id: "reputation",
    blocking: true,
    detail:
      "Profile counters are a reconstructible cache. docs/MARKET.md states that there is no reputation score, so a portable reputation needs new semantics and evidence rules.",
  },
  {
    id: "ratings",
    blocking: true,
    detail:
      "No rating, match result, or tournament record is defined or persisted. The Community tournament roadmap item is still unchecked.",
  },
  {
    id: "target-schema",
    blocking: true,
    detail:
      "No accepted appchain target schema exists. RFC 0016 defers the chain, so a field-by-field target mapping cannot be produced yet.",
  },
];

export const GAME_STATE_MIGRATION_CHECKLIST = [
  "Confirm the RFC 0016 decision gate holds for 90 consecutive days and a follow-up appchain RFC is accepted with a versioned target schema.",
  "Define and accept the target records for active-build lifecycle, challenge definitions, reputation, and ratings before moving any data.",
  "Record the source commit, snapshot version, generatedAt, source digest, and collection counts for the cutover.",
  "Put the API and every other writer behind maintenance; do not run a dual-write period for the first cutover.",
  "While the old API is still live, export the challenge registry from GET /v1/challenges and preserve the RAREXT_CHALLENGES source.",
  "Stop every writer, then create and verify a backup with npm run backup:create and npm run backup:verify.",
  "Run npm run plan:game-state with the frozen snapshot and challenge export; write both the plan and the preservation bundle.",
  "Restore the backup into a fresh directory and import the bundle into a staging target; compare source digests, counts, and every signed record.",
  "Re-verify publication, rotation, delegation, and revocation signatures in the target; do not recompute attestation scores or reputation from older verifier code.",
  "Compare feed, profile, leaderboard, lineage, and earnings output between the old registry and the target before switching clients.",
  "Keep the source registry and verified backup read-only after cutover. Rollback is safe only before the target accepts new writes.",
];

const CHALLENGE_NOTE =
  "Challenge definitions are external to snapshot v2. Export them from GET /v1/challenges before shutdown; the sponsored registry is in memory and is lost on restart.";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsOf(records: unknown[]): string[] {
  const fields = new Set<string>();

  for (const record of records) {
    if (!isRecord(record)) continue;
    for (const key of Object.keys(record)) fields.add(key);
  }

  return [...fields].sort();
}

function recordsFor(
  snapshot: Record<string, unknown>,
  name: DurableGameStateCollection,
  required: boolean,
): unknown[] {
  const value = snapshot[name];

  if (value === undefined) {
    if (required) throw new Error(`${name} must be an array`);
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }

  value.forEach((record, index) => {
    if (!isRecord(record)) {
      throw new Error(`${name}[${index}] must be an object`);
    }
  });

  return value;
}

function readChallenges(value: unknown): unknown[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.challenges)
      ? value.challenges
      : null;

  if (!list) {
    throw new Error("challenges must be an array or { challenges: [] }");
  }

  list.forEach((challenge, index) => {
    if (!isRecord(challenge)) {
      throw new Error(`challenges[${index}] must be an object`);
    }

    for (const field of ["id", "app", "title"] as const) {
      if (typeof challenge[field] !== "string" || challenge[field].length === 0) {
        throw new Error(`challenges[${index}].${field} must be a non-empty string`);
      }
    }

    if (typeof challenge.description !== "string") {
      throw new Error(`challenges[${index}].description must be a string`);
    }

    if (
      challenge.status !== undefined &&
      challenge.status !== "seed" &&
      challenge.status !== "configured" &&
      challenge.status !== "sponsored"
    ) {
      throw new Error(`challenges[${index}] has an invalid status`);
    }

    if (
      challenge.sponsor !== undefined &&
      challenge.sponsor !== null &&
      typeof challenge.sponsor !== "string"
    ) {
      throw new Error(`challenges[${index}] has an invalid sponsor`);
    }
  });

  return list;
}

function prepare(
  raw: unknown,
  options: GameStateMigrationOptions,
): {
  plan: GameStateMigrationPlan;
  snapshot: Record<string, unknown>;
  challenges: unknown[] | null;
} {
  const migrated = migrateSnapshot(raw);
  const snapshot = migrated.snapshot;
  const records = new Map<DurableGameStateCollection, unknown[]>();

  for (const rule of COLLECTION_RULES) {
    records.set(rule.name, recordsFor(snapshot, rule.name, rule.required));
  }

  const challenges =
    options.challenges === undefined ? null : readChallenges(options.challenges);
  const knownFields = new Set<string>([
    "version",
    ...DURABLE_GAME_STATE_COLLECTIONS,
  ]);
  const unmanagedTopLevelFields = Object.keys(snapshot)
    .filter((field) => !knownFields.has(field))
    .sort();

  const plan: GameStateMigrationPlan = {
    kind: GAME_STATE_MIGRATION_KIND,
    version: GAME_STATE_MIGRATION_VERSION,
    status: "deferred",
    mode: "no-op",
    source: options.source ?? null,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceVersion: migrated.from,
    snapshotVersion: snapshot.version,
    appliedMigrations: migrated.applied,
    sourceDigest: sha256(canonicalize(snapshot)),
    target: null,
    collections: COLLECTION_RULES.map((rule) => {
      const collection = records.get(rule.name) ?? [];
      return {
        name: rule.name,
        required: rule.required,
        count: collection.length,
        fields: fieldsOf(collection),
        digest: sha256(canonicalize(collection)),
        description: rule.description,
      };
    }),
    derived: DERIVED_GAME_STATE.map((item) => ({
      ...item,
      fields: [...item.fields],
    })),
    external: {
      challenges: {
        captured: challenges !== null,
        source: options.challengeSource ?? null,
        count: challenges?.length ?? 0,
        fields: fieldsOf(challenges ?? []),
        digest: challenges === null ? null : sha256(canonicalize(challenges)),
        note: CHALLENGE_NOTE,
      },
    },
    unmanagedTopLevelFields,
    gaps: GAME_STATE_GAPS.map((gap) => ({ ...gap })),
    checklist: [...GAME_STATE_MIGRATION_CHECKLIST],
    fallback: {
      action: "no-op",
      sourceMutated: false,
      targetWritten: false,
      note:
        "The snapshot remains authoritative. If the cutover is not approved, discard the plan and keep serving from the source registry.",
    },
  };

  return { plan, snapshot, challenges };
}

export function buildGameStateMigrationPlan(
  raw: unknown,
  options: GameStateMigrationOptions = {},
): GameStateMigrationPlan {
  return prepare(raw, options).plan;
}

export function buildGameStateMigrationBundle(
  raw: unknown,
  options: GameStateMigrationOptions = {},
): GameStateMigrationBundle {
  const prepared = prepare(raw, options);

  return {
    ...prepared.plan,
    snapshot: structuredClone(prepared.snapshot),
    challenges:
      prepared.challenges === null ? null : structuredClone(prepared.challenges),
  };
}

export function gameStateChallengeFields(): (keyof Challenge)[] {
  return [
    "id",
    "app",
    "title",
    "description",
    "version",
    "spec",
    "sampleArtifact",
    "semanticsId",
    "semanticsVersion",
    "createdAt",
    "status",
    "sponsor",
  ];
}
