export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskRegistryEntry {
  handle: string;
  status: TaskStatus;
  app: string;
  challengeId: string;
  createdAt: string;
}

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
];

const MAX_FIELD_LENGTH = 200;

function readTextField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid task registry entry: ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`invalid task registry entry: ${field} must not be empty`);
  }
  if (trimmed.length > MAX_FIELD_LENGTH) {
    throw new Error(
      `invalid task registry entry: ${field} is longer than ${MAX_FIELD_LENGTH}`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(
      `invalid task registry entry: ${field} must not contain control characters`,
    );
  }
  return trimmed;
}

/**
 * The task registry is served by the API, so a value it accepts is a value it
 * publishes. Truthiness is not enough for that. Measured before this
 * validation, `register` accepted `status: "finished"`, `app: 5`,
 * `challengeId: {}`, `createdAt: "not-a-date"`, a whitespace handle and an
 * ARRAY handle. The array handle was the worst: a `Map` keys by identity, so
 * the entry appeared in `list()` and could never be fetched by handle — an
 * entry that exists and cannot be addressed.
 */
export class TracRegistryService {
  private readonly tasks = new Map<string, TaskRegistryEntry>();

  constructor(initialTasks: TaskRegistryEntry[] = []) {
    for (const task of initialTasks) {
      this.register(task);
    }
  }

  register(entry: TaskRegistryEntry): void {
    if (!entry || typeof entry !== "object") {
      throw new Error("invalid task registry entry: expected an object");
    }

    const handle = readTextField(entry.handle, "handle");
    const app = readTextField(entry.app, "app");
    const challengeId = readTextField(entry.challengeId, "challengeId");

    if (!TASK_STATUSES.includes(entry.status)) {
      throw new Error(
        `invalid task registry entry: status must be one of ${TASK_STATUSES.join(", ")}`,
      );
    }

    if (typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))) {
      throw new Error("invalid task registry entry: createdAt must be an ISO timestamp");
    }

    this.tasks.set(handle, {
      handle,
      status: entry.status,
      app,
      challengeId,
      createdAt: entry.createdAt,
    });
  }

  /**
   * Readers get a copy, not the live record. This surface is published as
   * read-only, and returning the stored object let one in-process consumer
   * rewrite what every other reader saw — measured: an entry read as `running`
   * became `completed` for everyone because a caller edited what `get` handed
   * back, and `failed` after another edited the `list()` entry.
   */
  get(handle: string): TaskRegistryEntry | null {
    const entry = this.tasks.get(handle);
    return entry ? Object.freeze({ ...entry }) : null;
  }

  list(): TaskRegistryEntry[] {
    return Array.from(this.tasks.values(), (entry) => Object.freeze({ ...entry }));
  }
}

export const defaultTracRegistry = new TracRegistryService();
