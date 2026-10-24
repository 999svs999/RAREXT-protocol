import type { Publication } from "../../../packages/core/src/index.ts";

import type { DurabilityLedger, GcResult } from "./durability.ts";
import type { SchedulerTimers } from "./durability-schedule.ts";
import type { PinStore } from "./pin-server.ts";
import type { BlobStore } from "./storage.ts";

const HASH = /^[0-9a-f]{64}$/;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

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
 * Blob hashes named by a storage manifest in any publication. A manifest is the
 * only thing that makes a node blob referenced: a blob uploaded but never
 * published, or a manifest that was replaced, is a candidate for collection.
 */
export function referencedBlobHashes(publications: Publication[]): Set<string> {
  const referenced = new Set<string>();

  for (const publication of publications) {
    const body = publication.artifact?.body as { blobs?: unknown } | undefined;
    if (!Array.isArray(body?.blobs)) continue;

    for (const entry of body.blobs) {
      if (typeof entry !== "object" || entry === null) continue;
      const hash = (entry as { hash?: unknown }).hash;
      if (typeof hash === "string" && HASH.test(hash)) referenced.add(hash);
    }
  }

  return referenced;
}

export type BlobGcResult = ReturnType<BlobStore["gc"]>;

export interface NodeGcRun {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  gracePeriodMs: number;
  blobs: BlobGcResult;
  holders: GcResult[];
}

export interface NodeGcOptions {
  store: { listPublications(): Publication[] };
  blobs: BlobStore;
  ledger: DurabilityLedger;
  holderUrls?: Map<string, string>;
  token?: string;
  fetch?: typeof fetch;
  gracePeriodMs?: number;
  dryRun?: boolean;
  now?: () => number;
}

/**
 * One node-wide collection pass over both stores the API owns: holder shards
 * (through the durability ledger's placements) and node blobs (through the
 * publication manifests). Pins live in their own process and have their own
 * pass.
 *
 * `dryRun` defaults to true. A run reports candidates on the first pass and
 * deletes them only after `gracePeriodMs`, so a caller that forgets to inspect
 * the first run does not lose data.
 */
export class NodeGc {
  readonly gracePeriodMs: number;
  readonly dryRun: boolean;
  private readonly store: NodeGcOptions["store"];
  private readonly blobs: BlobStore;
  private readonly ledger: DurabilityLedger;
  private readonly holderUrls: Map<string, string>;
  private readonly token: string | undefined;
  private readonly callFetch: typeof fetch;
  private readonly clock: () => number;

  constructor(options: NodeGcOptions) {
    this.store = options.store;
    this.blobs = options.blobs;
    this.ledger = options.ledger;
    this.holderUrls = options.holderUrls ?? new Map();
    this.token = options.token;
    this.callFetch = options.fetch ?? fetch;
    this.clock = options.now ?? Date.now;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_MS;
    this.dryRun = options.dryRun ?? true;

    if (!Number.isFinite(this.gracePeriodMs) || this.gracePeriodMs < 0) {
      throw new Error("gracePeriodMs must be a non-negative number");
    }
  }

  async run(): Promise<NodeGcRun> {
    const startedAt = new Date(this.clock()).toISOString();
    const referenced = referencedBlobHashes(this.store.listPublications());

    let holders: GcResult[] = [];
    if (this.holderUrls.size > 0) {
      holders = await this.ledger.gcWithUrls(this.holderUrls, {
        gracePeriodMs: this.gracePeriodMs,
        dryRun: this.dryRun,
        fetch: this.callFetch,
        token: this.token,
      });
    }

    const blobs = this.blobs.gc({
      referenced,
      gracePeriodMs: this.gracePeriodMs,
      dryRun: this.dryRun,
      now: this.clock(),
    });

    return {
      startedAt,
      finishedAt: new Date(this.clock()).toISOString(),
      dryRun: this.dryRun,
      gracePeriodMs: this.gracePeriodMs,
      blobs,
      holders,
    };
  }
}

export interface PinGcRun {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  gracePeriodMs: number;
  pins: ReturnType<PinStore["gc"]>;
}

export interface PinGcOptions {
  pins: PinStore;
  gracePeriodMs?: number;
  dryRun?: boolean;
  now?: () => number;
}

/**
 * Structural pin collection. Pins with `publicationIds` are holds, and pins
 * whose retention term is live are held, so this pass is safe without an
 * external reference set: it reaps content without metadata, metadata without
 * content, and corrupt pairs only.
 */
export class PinGc {
  readonly gracePeriodMs: number;
  readonly dryRun: boolean;
  private readonly pins: PinStore;
  private readonly clock: () => number;

  constructor(options: PinGcOptions) {
    this.pins = options.pins;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_MS;
    this.dryRun = options.dryRun ?? true;
    this.clock = options.now ?? Date.now;

    if (!Number.isFinite(this.gracePeriodMs) || this.gracePeriodMs < 0) {
      throw new Error("gracePeriodMs must be a non-negative number");
    }
  }

  run(): PinGcRun {
    const startedAt = new Date(this.clock()).toISOString();

    return {
      startedAt,
      finishedAt: new Date(this.clock()).toISOString(),
      dryRun: this.dryRun,
      gracePeriodMs: this.gracePeriodMs,
      pins: this.pins.gc({
        gracePeriodMs: this.gracePeriodMs,
        dryRun: this.dryRun,
        now: this.clock(),
      }),
    };
  }
}

export interface GcSchedulerOptions<T> {
  run: () => T | Promise<T>;
  intervalMs?: number;
  timers?: SchedulerTimers;
  now?: () => number;
  onRun?: (result: T) => void;
  onError?: (error: unknown) => void;
}

export interface GcScheduleState<T> {
  running: boolean;
  intervalMs: number;
  startedAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runs: number;
  lastRun: T | null;
  lastError: string | null;
}

/**
 * Fires a collection pass on its own. A pass never overlaps the previous one:
 * a tick during a pass is skipped and the next tick is scheduled after it.
 * Errors are recorded and do not stop the schedule.
 */
export class GcScheduler<T> {
  readonly intervalMs: number;
  private readonly run: GcSchedulerOptions<T>["run"];
  private readonly timers: SchedulerTimers;
  private readonly clock: () => number;
  private readonly onRun: GcSchedulerOptions<T>["onRun"];
  private readonly onError: GcSchedulerOptions<T>["onError"];
  private startedAt: number | null = null;
  private nextAt: number | null = null;
  private timer: unknown = null;
  private current: Promise<T> | null = null;
  private runs = 0;
  private lastRunAt: number | null = null;
  private lastRun: T | null = null;
  private lastError: string | null = null;

  constructor(options: GcSchedulerOptions<T>) {
    this.run = options.run;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timers = options.timers ?? systemTimers;
    this.clock = options.now ?? Date.now;
    this.onRun = options.onRun;
    this.onError = options.onError;

    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive number");
    }
  }

  get state(): GcScheduleState<T> {
    return {
      running: this.startedAt !== null,
      intervalMs: this.intervalMs,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      nextRunAt: this.nextAt === null ? null : new Date(this.nextAt).toISOString(),
      lastRunAt: this.lastRunAt === null ? null : new Date(this.lastRunAt).toISOString(),
      runs: this.runs,
      lastRun: this.lastRun,
      lastError: this.lastError,
    };
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

  /** Runs one pass now. Returns null when a pass is already in flight. */
  async runOnce(): Promise<T | null> {
    if (this.current) return null;

    const current = (async () => this.run())();

    this.current = current;

    try {
      const result = await current;
      this.runs += 1;
      this.lastRunAt = this.clock();
      this.lastRun = result;
      this.lastError = null;
      this.onRun?.(result);
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "GC run failed";
      this.onError?.(error);
      return null;
    } finally {
      this.current = null;
    }
  }

  private schedule(delay: number): void {
    this.nextAt = this.clock() + delay;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.nextAt = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.startedAt === null) return;

    if (this.current) {
      this.schedule(this.intervalMs);
      return;
    }

    await this.runOnce();

    if (this.startedAt !== null && this.timer === null) this.schedule(this.intervalMs);
  }
}
