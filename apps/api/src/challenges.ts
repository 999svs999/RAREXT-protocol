import { existsSync, readFileSync } from "node:fs";

import { tasks } from "../../../packages/core/src/index.ts";
import type { Challenge, Task } from "../../../packages/core/src/index.ts";

const SEED_CREATED_AT = "2026-01-01T00:00:00.000Z";

export function challengeFromTask(task: Task): Challenge {
  return {
    id: task.id,
    app: "logic",
    title: task.title,
    description: task.description,
    version: 1,
    spec: task,
    semanticsId: `logic/${task.id}`,
    semanticsVersion: 1,
    createdAt: SEED_CREATED_AT,
  };
}

function asChallenge(value: unknown): Challenge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("challenge must be a JSON object");
  }

  const challenge = value as Partial<Challenge>;

  if (typeof challenge.id !== "string" || challenge.id.length === 0) {
    throw new Error("challenge.id must be a string");
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

  return {
    id: challenge.id,
    app: challenge.app,
    title: challenge.title,
    description: challenge.description,
    version: typeof challenge.version === "number" ? challenge.version : 1,
    spec: challenge.spec,
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

export function createChallengeRegistry(): ChallengeRegistry {
  const registry = new Map<string, Challenge>();

  for (const task of tasks) {
    const challenge = challengeFromTask(task);
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
