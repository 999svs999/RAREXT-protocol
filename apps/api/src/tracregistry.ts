export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskRegistryEntry {
  handle: string;
  status: TaskStatus;
  app: string;
  challengeId: string;
  createdAt: string;
}

export class TracRegistryService {
  private readonly tasks = new Map<string, TaskRegistryEntry>();

  constructor(initialTasks: TaskRegistryEntry[] = []) {
    for (const task of initialTasks) {
      this.register(task);
    }
  }

  register(entry: TaskRegistryEntry): void {
    if (!entry.handle || !entry.status || !entry.app || !entry.challengeId || !entry.createdAt) {
      throw new Error("invalid task registry entry fields");
    }
    this.tasks.set(entry.handle, entry);
  }

  get(handle: string): TaskRegistryEntry | null {
    return this.tasks.get(handle) ?? null;
  }

  list(): TaskRegistryEntry[] {
    return Array.from(this.tasks.values());
  }
}

export const defaultTracRegistry = new TracRegistryService();
