import { existsSync, readFileSync } from "node:fs";

import { isBoundedSpec, tasks } from "../../../packages/core/src/index.ts";
import type { Challenge, SampleArtifact, Task } from "../../../packages/core/src/index.ts";
import { generate, type XorshiftModel } from "./generative.ts";

const SEED_CREATED_AT = "2026-01-01T00:00:00.000Z";

/** A challenge id is a name people type and quote; beyond this it is not one. */
export const MAX_CHALLENGE_ID_LENGTH = 200;

const SAMPLE_CIRCUITS: Record<string, { components: { id: string; type: string; inputs?: string[] }[] }> = {
  "half-adder": {
    components: [
      { id: "a", type: "INPUT" },
      { id: "b", type: "INPUT" },
      { id: "n3", type: "NAND", inputs: ["a", "b"] },
      { id: "n1", type: "NAND", inputs: ["a", "n3"] },
      { id: "n2", type: "NAND", inputs: ["b", "n3"] },
      { id: "n4", type: "NAND", inputs: ["n1", "n2"] },
      { id: "n5", type: "NAND", inputs: ["n3", "n3"] },
      { id: "sum", type: "OUTPUT", inputs: ["n4"] },
      { id: "carry", type: "OUTPUT", inputs: ["n5"] },
    ],
  },
};

export function challengeFromTask(task: Task): Challenge {
  const sample = SAMPLE_CIRCUITS[task.id];

  return {
    id: task.id,
    app: "logic",
    title: task.title,
    description: task.description,
    version: 1,
    spec: task,
    sampleArtifact: sample
      ? {
          app: "logic",
          kind: "logic.netlist",
          version: 1,
          mediaType: "application/json",
          body: sample,
        }
      : undefined,
    semanticsId: `logic/${task.id}`,
    semanticsVersion: 1,
    createdAt: SEED_CREATED_AT,
    status: "seed",
    sponsor: null,
  };
}

function asSampleArtifact(value: unknown): SampleArtifact | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Partial<SampleArtifact>;

  if (
    typeof record.app !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.mediaType !== "string" ||
    typeof record.version !== "number"
  ) {
    return undefined;
  }

  return {
    app: record.app,
    kind: record.kind,
    version: record.version,
    mediaType: record.mediaType,
    body: record.body ?? null,
  };
}

export function asChallenge(value: unknown): Challenge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("challenge must be a JSON object");
  }

  const challenge = value as Partial<Challenge>;

  // Refused, never normalized: an id with surrounding whitespace or no bound is a
  // different id depending on who read it, and silently trimming it would publish a
  // challenge under a name its author did not write.
  if (typeof challenge.id !== "string" || challenge.id.trim().length === 0) {
    throw new Error("challenge.id must be a non-empty string");
  }
  if (challenge.id !== challenge.id.trim()) {
    throw new Error(`challenge.id ${JSON.stringify(challenge.id)} has surrounding whitespace`);
  }
  if (challenge.id.length > MAX_CHALLENGE_ID_LENGTH) {
    throw new Error(
      `challenge ${challenge.id.slice(0, 24)}… has an id longer than ${MAX_CHALLENGE_ID_LENGTH} characters`,
    );
  }

  if (typeof challenge.app !== "string" || challenge.app.length === 0) {
    throw new Error(`challenge ${challenge.id} is missing an app`);
  }

  if (typeof challenge.title !== "string" || challenge.title.length === 0) {
    throw new Error(`challenge ${challenge.id} is missing a title`);
  }

  if (typeof challenge.description !== "string") {
    throw new Error(`challenge ${challenge.id} is missing a description`);
  }

  if (
    challenge.status !== undefined &&
    challenge.status !== "seed" &&
    challenge.status !== "configured" &&
    challenge.status !== "sponsored"
  ) {
    throw new Error(`challenge ${challenge.id} has an invalid status`);
  }

  if (
    challenge.sponsor !== undefined &&
    challenge.sponsor !== null &&
    typeof challenge.sponsor !== "string"
  ) {
    throw new Error(`challenge ${challenge.id} has an invalid sponsor`);
  }

  // The spec is what a verifier and a leaderboard row read, so the boundary refuses here
  // what the consumer would refuse later. For the bounded app the rule is CORE'S OWN
  // (isBoundedSpec) rather than a second copy of it: a boundary that re-implemented the
  // verifier's rule would drift from the verifier.
  if (challenge.spec !== undefined) {
    if (typeof challenge.spec !== "object" || challenge.spec === null || Array.isArray(challenge.spec)) {
      throw new Error(`challenge ${challenge.id} has a spec that is not an object`);
    }
    if (challenge.app === "ai-bounded" && !isBoundedSpec(challenge.spec)) {
      throw new Error(
        `challenge ${challenge.id} has a spec the bounded verifier would refuse ` +
          `(needs metric maxAbsError|meanAbsError, a finite non-negative bound, and a non-empty reference of finite numbers)`,
      );
    }
  }

  for (const [field, value] of [
    ["version", challenge.version],
    ["semanticsVersion", challenge.semanticsVersion],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`challenge ${challenge.id} has an invalid ${field}`);
    }
  }

  if (challenge.createdAt !== undefined) {
    if (typeof challenge.createdAt !== "string" || Number.isNaN(Date.parse(challenge.createdAt))) {
      throw new Error(`challenge ${challenge.id} has an unparseable createdAt`);
    }
  }

  return {
    id: challenge.id,
    app: challenge.app,
    title: challenge.title,
    description: challenge.description,
    version: typeof challenge.version === "number" ? challenge.version : 1,
    spec: challenge.spec,
    sampleArtifact: asSampleArtifact(challenge.sampleArtifact),
    semanticsId:
      typeof challenge.semanticsId === "string" && challenge.semanticsId.length > 0
        ? challenge.semanticsId
        : `${challenge.app}/${challenge.id}`,
    semanticsVersion:
      typeof challenge.semanticsVersion === "number" ? challenge.semanticsVersion : 1,
    createdAt:
      typeof challenge.createdAt === "string"
        ? challenge.createdAt
        : new Date().toISOString(),
    status: challenge.status ?? "configured",
    sponsor: typeof challenge.sponsor === "string" ? challenge.sponsor : null,
  };
}

function configuredChallenges(): Challenge[] {
  const source = process.env.RAREXT_CHALLENGES?.trim();

  if (!source) return [];

  let text = source;

  if (!source.startsWith("[") && !source.startsWith("{")) {
    if (!existsSync(source)) {
      throw new Error(`RAREXT_CHALLENGES file not found: ${source}`);
    }
    text = readFileSync(source, "utf8");
  }

  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "challenges" in parsed
      ? (parsed as { challenges: unknown }).challenges
      : null;

  if (!Array.isArray(list)) {
    throw new Error("RAREXT_CHALLENGES must be an array or { challenges: [] }");
  }

  return list.map(asChallenge);
}

export interface ChallengeRegistry {
  list(): Challenge[];
  get(id: string): Challenge | null;
}

/**
 * Built-in AI seeds, so an out-of-the-box node can accept and verify AI
 * publications without anyone configuring RAREXT_CHALLENGES. The generative
 * sample's output is computed by the same replay the verifier runs — the seed
 * cannot drift from the model the way a hand-pasted constant would.
 */
export const AI_SEED_MODEL: XorshiftModel = {
  kind: "xorshift32",
  params: { a: 13, b: 17, c: 5 },
  vocab: ["alpha", "beta", "gamma", "delta"],
};

const AI_SEED_STEPS = 32;
const AI_SEED_SEED = 42;
const AI_SEED_REFERENCE = [10, 20, 30, 40, 200, 255, 0, 128];
const AI_SEED_BOUND = 4;

function aiSeedChallenges(): Challenge[] {
  return [
    {
      id: "gen-starter",
      app: "ai-generative",
      title: "Generate from the committed starter model",
      description:
        "Replay the digest-bound starter model from the seed and match its output exactly.",
      version: 1,
      spec: { steps: AI_SEED_STEPS },
      sampleArtifact: {
        app: "ai-generative",
        kind: "ai.generative",
        version: 1,
        mediaType: "application/json",
        body: {
          model: AI_SEED_MODEL,
          seed: AI_SEED_SEED,
          output: generate(AI_SEED_MODEL, AI_SEED_SEED, AI_SEED_STEPS),
        },
      },
      semanticsId: "ai-generative/gen-starter",
      semanticsVersion: 1,
      createdAt: SEED_CREATED_AT,
      status: "seed",
      sponsor: null,
    },
    {
      id: "bounded-starter",
      app: "ai-bounded",
      title: "Reconstruct within the starter bound",
      description:
        "Return a reconstruction of the committed reference vector whose maxAbsError stays within 4.",
      version: 1,
      spec: { metric: "maxAbsError", bound: AI_SEED_BOUND, reference: AI_SEED_REFERENCE },
      sampleArtifact: {
        app: "ai-bounded",
        kind: "ai.bounded",
        version: 1,
        mediaType: "application/json",
        body: {
          values: AI_SEED_REFERENCE.map((v) => Math.min(255, v + 2)),
        },
      },
      semanticsId: "ai-bounded/bounded-starter",
      semanticsVersion: 1,
      createdAt: SEED_CREATED_AT,
      status: "seed",
      sponsor: null,
    },
  ];
}

export function createChallengeRegistry(): ChallengeRegistry {
  const registry = new Map<string, Challenge>();

  for (const task of tasks) {
    const challenge = challengeFromTask(task);
    registry.set(challenge.id, challenge);
  }

  for (const challenge of aiSeedChallenges()) {
    registry.set(challenge.id, challenge);
  }

  for (const challenge of configuredChallenges()) {
    registry.set(challenge.id, challenge);
  }

  return {
    list: () => [...registry.values()],
    get: (id) => registry.get(id) ?? null,
  };
}
