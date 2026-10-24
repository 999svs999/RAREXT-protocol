import {
  type DurabilityHolder,
  type DurabilityLedger,
  type DurabilityReport,
} from "./durability.ts";

export interface SchedulerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChallengeRunRepair {
  blobHash: string;
  filled: number;
  readBytes: number;
  writtenBytes: number;
}

export interface ChallengeRun {
  /** When the run started, as an ISO timestamp. */
  startedAt: string;
  finishedAt: string;
  intervalMs: number;
  blobs: string[];
  audits: DurabilityReport[];
  /** Blobs the challenges found under-replicated, before any repair. */
  underReplicated: string[];
  /** Shards rebuilt and re-placed during this run. */
  repairs: ChallengeRunRepair[];
  repairErrors: {
    blobHash: string;
    error: string;
    attempts: number;
    retryAt: string;
  }[];
  /** Under-replicated blobs whose repair is waiting out a failure backoff. */
  repairDeferred: {
    blobHash: string;
    attempts: number;
    retryAt: string;
  }[];
  errors: { blobHash: string; error: string }[];
}

export interface ChallengeScheduleState {
  running: boolean;
  intervalMs: number;
  startedAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runs: number;
  lastRun: ChallengeRun | null;
}

export interface ChallengeScheduleOptions {
  ledger: DurabilityLedger;
  holders: () => DurabilityHolder[] | Promise<DurabilityHolder[]>;
  intervalMs?: number;
  historyLimit?: number;
  timers?: SchedulerTimers;
  now?: () => number;
  /** Rebuild and re-place shards that a challenge found missing. Off by default. */
  repair?: boolean;
  /**
   * Delay after a failed repair before the blob is attempted again. It doubles
   * per consecutive failure up to `maxRepairBackoffMs`, so a holder that keeps
   * rejecting writes cannot turn every scheduled run into another repair storm.
   */
  repairBackoffMs?: number;
  /** Ceiling for the exponential repair backoff. Defaults to six hours. */
  maxRepairBackoffMs?: number;
  onRun?: (run: ChallengeRun) => void;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HISTORY = 20;
const DEFAULT_REPAIR_BACKOFF_MS = 60 * 1000;
const DEFAULT_MAX_REPAIR_BACKOFF_MS = 6 * 60 * 60 * 1000;

const systemTimers: SchedulerTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Fires retention challenges on its own. The ledger knows what to challenge and
 * who holds it; this schedule only decides *when*. A run never overlaps the
 * previous one: if a challenge is still in flight when the timer fires, that
 * tick is skipped and the next one is scheduled after it finishes.
 */
export class ChallengeScheduler {
  readonly intervalMs: number;
  private readonly ledger: DurabilityLedger;
  private readonly holders: ChallengeScheduleOptions["holders"];
  private readonly timers: SchedulerTimers;
  private readonly clock: () => number;
  private readonly historyLimit: number;
  private readonly repair: boolean;
  private readonly repairBackoffMs: number;
  private readonly maxRepairBackoffMs: number;
  private readonly repairFailures = new Map<
    string,
    { attempts: number; retryAt: number }
  >();
  private readonly onRun: ChallengeScheduleOptions["onRun"];
  private readonly runs: ChallengeRun[] = [];
  private startedAt: number | null = null;
  private nextAt: number | null = null;
  private timer: unknown = null;
  private current: Promise<ChallengeRun> | null = null;

  constructor(options: ChallengeScheduleOptions) {
    this.ledger = options.ledger;
    this.holders = options.holders;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timers = options.timers ?? systemTimers;
    this.clock = options.now ?? Date.now;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY;
    this.repair = options.repair ?? false;
    this.repairBackoffMs = options.repairBackoffMs ?? DEFAULT_REPAIR_BACKOFF_MS;
    this.maxRepairBackoffMs =
      options.maxRepairBackoffMs ?? DEFAULT_MAX_REPAIR_BACKOFF_MS;
    this.onRun = options.onRun;

    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive number");
    }

    if (!Number.isFinite(this.repairBackoffMs) || this.repairBackoffMs <= 0) {
      throw new Error("repairBackoffMs must be a positive number");
    }

    if (
      !Number.isFinite(this.maxRepairBackoffMs) ||
      this.maxRepairBackoffMs < this.repairBackoffMs
    ) {
      throw new Error("maxRepairBackoffMs must be at least repairBackoffMs");
    }
  }

  start(): void {
    if (this.startedAt !== null) return;

    this.startedAt = this.clock();
    this.schedule(this.intervalMs);
  }

  stop(): void {
    this.startedAt = null;
    this.nextAt = null;

    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get state(): ChallengeScheduleState {
    const last = this.runs.at(-1) ?? null;

    return {
      running: this.startedAt !== null,
      intervalMs: this.intervalMs,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      nextRunAt: this.nextAt === null ? null : new Date(this.nextAt).toISOString(),
      lastRunAt: last ? last.startedAt : null,
      runs: this.runs.length,
      lastRun: last,
    };
  }

  /**
   * Runs every placed blob now. Concurrent calls share the same run; an
   * operator cannot accidentally double-load the holders from two requests.
   */
  runNow(): Promise<ChallengeRun> {
    if (this.current) return this.current;

    this.current = this.execute().finally(() => {
      this.current = null;
    });

    return this.current;
  }

  private schedule(delay: number): void {
    this.nextAt = this.clock() + delay;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.nextAt = null;

      void this.runNow()
        .catch(() => undefined)
        .finally(() => {
          if (this.startedAt !== null) this.schedule(this.intervalMs);
        });
    }, delay);
  }

  private async execute(): Promise<ChallengeRun> {
    const startedAt = this.clock();
    const holders = await this.holders();
    const blobs: string[] = [];
    const audits: DurabilityReport[] = [];
    const errors: { blobHash: string; error: string }[] = [];

    for (const placement of this.ledger.list()) {
      blobs.push(placement.blobHash);

      try {
        await this.ledger.challenge(placement.blobHash, holders);
        audits.push(this.ledger.audit(placement.blobHash));
      } catch (error) {
        errors.push({
          blobHash: placement.blobHash,
          error: error instanceof Error ? error.message : "challenge failed",
        });
      }
    }

    for (const audit of audits) {
      if (audit.status === "ok") this.repairFailures.delete(audit.blobHash);
    }

    const underReplicated = audits
      .filter((audit) => audit.status === "under-replicated")
      .map((audit) => audit.blobHash);
    const repairs: ChallengeRunRepair[] = [];
    const repairErrors: ChallengeRun["repairErrors"] = [];
    const repairDeferred: ChallengeRun["repairDeferred"] = [];

    if (this.repair) {
      for (const blobHash of underReplicated) {
        const now = this.clock();
        const previous = this.repairFailures.get(blobHash);

        if (previous && now < previous.retryAt) {
          repairDeferred.push({
            blobHash,
            attempts: previous.attempts,
            retryAt: new Date(previous.retryAt).toISOString(),
          });
          continue;
        }

        try {
          const outcome = await this.ledger.repair(blobHash, holders);

          this.repairFailures.delete(blobHash);

          if (outcome.filled > 0) {
            repairs.push({
              blobHash,
              filled: outcome.filled,
              readBytes: outcome.readBytes,
              writtenBytes: outcome.writtenBytes,
            });

            // A rebuilt shard is unproven until someone asks for a proof.
            await this.ledger.challenge(blobHash, holders);

            const index = audits.findIndex((audit) => audit.blobHash === blobHash);
            audits[index] = this.ledger.audit(blobHash);
          }
        } catch (error) {
          const attempts = (previous?.attempts ?? 0) + 1;
          const delay = Math.min(
            this.repairBackoffMs * 2 ** (attempts - 1),
            this.maxRepairBackoffMs,
          );
          const retryAt = this.clock() + delay;

          this.repairFailures.set(blobHash, { attempts, retryAt });
          repairErrors.push({
            blobHash,
            error: error instanceof Error ? error.message : "repair failed",
            attempts,
            retryAt: new Date(retryAt).toISOString(),
          });
        }
      }
    }

    const run: ChallengeRun = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(this.clock()).toISOString(),
      intervalMs: this.intervalMs,
      blobs,
      audits,
      underReplicated,
      repairs,
      repairErrors,
      repairDeferred,
      errors,
    };

    this.runs.push(run);
    while (this.runs.length > this.historyLimit) this.runs.shift();

    try {
      this.onRun?.(run);
    } catch {
      // A failing observer must not stop the schedule.
    }

    return run;
  }
}
