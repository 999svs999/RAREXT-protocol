import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { cidV1Raw } from "./adapters/content.ts";
import { GcScheduler, PinGc } from "./gc-schedule.ts";
import { destructiveGcAllowed } from "./net.ts";

const MAX_CONTENT = 32 * 1024 * 1024;
const MAX_PUBLICATION_IDS = 100;
const MAX_ID_LENGTH = 200;
const MAX_ROOT_LENGTH = 2048;
const CID_PATTERN = /^b[a-z2-7]{20,200}$/;

export interface PinRecord {
  cid: string;
  bytes: number;
  root: string | null;
  publicationIds: string[];
  pinnedAt: string;
}

export interface PinInput {
  cid: string;
  content: Uint8Array;
  root?: string | null;
  publicationIds?: string[];
}

/**
 * A small pinning service for the content adapter: it accepts the bundle bytes,
 * checks that the claimed CID is the CID of those bytes, and stores them under
 * that name. No daemon, no network dependency; a directory and an HTTP surface.
 */
export class PinStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  private paths(cid: string): { content: string; metadata: string } {
    if (!CID_PATTERN.test(cid)) throw new Error("cid is not a base32 CIDv1");
    return {
      content: join(this.directory, `${cid}.bin`),
      metadata: join(this.directory, `${cid}.json`),
    };
  }

  put(input: PinInput): PinRecord {
    if (!CID_PATTERN.test(input.cid)) throw new Error("cid is not a base32 CIDv1");
    if (input.content.length === 0) throw new Error("content must not be empty");
    if (input.content.length > MAX_CONTENT) throw new Error("content is too large");
    if (input.root !== undefined && input.root !== null) {
      if (typeof input.root !== "string" || input.root.length > MAX_ROOT_LENGTH) {
        throw new Error("root must be a bounded string or null");
      }
    }

    const publicationIds = input.publicationIds ?? [];

    if (
      !Array.isArray(publicationIds) ||
      publicationIds.length > MAX_PUBLICATION_IDS ||
      publicationIds.some(
        (value) => typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH,
      )
    ) {
      throw new Error("publicationIds must be a bounded list of non-empty strings");
    }

    const computed = cidV1Raw(input.content);
    if (computed !== input.cid) throw new Error("cid does not match the content");

    const paths = this.paths(input.cid);
    const existing = this.get(input.cid);
    if (existing) return existing;

    const record: PinRecord = {
      cid: input.cid,
      bytes: input.content.length,
      root: input.root ?? null,
      publicationIds,
      pinnedAt: new Date().toISOString(),
    };
    const contentTemporary = `${paths.content}.${randomUUID()}.tmp`;
    const metadataTemporary = `${paths.metadata}.${randomUUID()}.tmp`;
    const contentCreated = !existsSync(paths.content);

    try {
      writeFileSync(contentTemporary, input.content);
      renameSync(contentTemporary, paths.content);
      writeFileSync(metadataTemporary, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(metadataTemporary, paths.metadata);
    } catch (error) {
      if (contentCreated) rmSync(paths.content, { force: true });
      throw error;
    } finally {
      rmSync(contentTemporary, { force: true });
      rmSync(metadataTemporary, { force: true });
    }

    return record;
  }

  private readRecord(cid: string): { record: PinRecord; bytes: Uint8Array } | null {
    const paths = this.paths(cid);
    if (!existsSync(paths.metadata) || !existsSync(paths.content)) return null;

    const value = JSON.parse(readFileSync(paths.metadata, "utf8")) as unknown;

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("pin metadata is not an object");
    }

    const record = value as Partial<PinRecord>;
    const bytes = new Uint8Array(readFileSync(paths.content));

    if (record.cid !== cid) throw new Error("pin metadata names another cid");
    if (!Number.isInteger(record.bytes) || record.bytes !== bytes.length) {
      throw new Error("pin metadata size does not match its content");
    }
    if (record.root !== null && (typeof record.root !== "string" || record.root.length > MAX_ROOT_LENGTH)) {
      throw new Error("pin metadata root is invalid");
    }
    if (
      !Array.isArray(record.publicationIds) ||
      record.publicationIds.length > MAX_PUBLICATION_IDS ||
      record.publicationIds.some(
        (entry) => typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ID_LENGTH,
      )
    ) {
      throw new Error("pin metadata publicationIds are invalid");
    }
    if (typeof record.pinnedAt !== "string" || Number.isNaN(Date.parse(record.pinnedAt))) {
      throw new Error("pin metadata pinnedAt is invalid");
    }
    if (cidV1Raw(bytes) !== cid) throw new Error("pin content does not match its cid");

    return { record: record as PinRecord, bytes };
  }

  get(cid: string): PinRecord | null {
    return this.readRecord(cid)?.record ?? null;
  }

  content(cid: string): Uint8Array | null {
    return this.readRecord(cid)?.bytes ?? null;
  }

  has(cid: string): boolean {
    return this.get(cid) !== null;
  }

  list(): PinRecord[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const cid = name.slice(0, -".json".length);

        if (!CID_PATTERN.test(cid)) return null;

        try {
          return this.get(cid);
        } catch {
          return null;
        }
      })
      .filter((record): record is PinRecord => record !== null)
      .sort((left, right) => right.pinnedAt.localeCompare(left.pinnedAt));
  }

  remove(cid: string): boolean {
    const paths = this.paths(cid);

    if (!existsSync(paths.metadata) && !existsSync(paths.content)) return false;

    rmSync(paths.metadata, { force: true });
    rmSync(paths.content, { force: true });
    return true;
  }

  /**
   * Reap structural orphans and, when the caller supplies a reference set,
   * pins nothing references. A pin with `publicationIds` is a live hold and is
   * never collected that way. `dryRun` defaults to true.
   *
   * `put`, `remove`, and this pass are synchronous, so two calls in one
   * process cannot interleave and a read never races an unlink.
   */
  gc(options: {
    referenced?: Iterable<string>;
    gracePeriodMs?: number;
    dryRun?: boolean;
    now?: number;
  } = {}): {
    scanned: number;
    referenced: number;
    held: number;
    candidates: number;
    deleted: number;
    orphanContent: number;
    orphanMetadata: number;
    purgedTemp: number;
    wouldDelete: string[];
    dryRun: boolean;
    gracePeriodMs: number;
  } {
    const referenced = options.referenced
      ? new Set([...options.referenced].filter((cid) => CID_PATTERN.test(cid)))
      : null;
    const gracePeriodMs = options.gracePeriodMs ?? 24 * 60 * 60 * 1000;
    const dryRun = options.dryRun !== false;
    const now = options.now ?? Date.now();
    const candidates = this.loadGcCandidates();
    const names = readdirSync(this.directory);
    const metadata = new Set<string>();
    const content = new Set<string>();

    for (const name of names) {
      if (name.endsWith(".json")) {
        const cid = name.slice(0, -".json".length);
        if (CID_PATTERN.test(cid)) metadata.add(cid);
      } else if (name.endsWith(".bin")) {
        const cid = name.slice(0, -".bin".length);
        if (CID_PATTERN.test(cid)) content.add(cid);
      }
    }

    const wouldDelete: string[] = [];
    const orphanMetadata = new Set<string>();
    const orphanContent = new Set<string>();
    let referencedCount = 0;
    let held = 0;

    const consider = (cid: string): void => {
      const existing = candidates.get(cid);

      if (!existing) {
        candidates.set(cid, { cid, firstSeen: now });
        if (gracePeriodMs === 0) wouldDelete.push(cid);
      } else if (now - existing.firstSeen >= gracePeriodMs) {
        wouldDelete.push(cid);
      }
    };

    for (const cid of metadata) {
      let record: PinRecord | null = null;

      try {
        record = this.get(cid);
      } catch {
        // A corrupt metadata/content pair is unusable and is an orphan.
        record = null;
      }

      if (!record) {
        orphanMetadata.add(cid);
        consider(cid);
        continue;
      }

      if (referenced && !referenced.has(cid)) {
        if (record.publicationIds.length > 0) {
          held += 1;
          candidates.delete(cid);
          continue;
        }
        consider(cid);
      } else {
        referencedCount += 1;
        candidates.delete(cid);
      }
    }

    for (const cid of content) {
      if (metadata.has(cid)) continue;
      orphanContent.add(cid);
      consider(cid);
    }

    for (const cid of [...candidates.keys()]) {
      if (!metadata.has(cid) && !content.has(cid)) candidates.delete(cid);
    }

    let deleted = 0;
    let removedContent = 0;
    let removedMetadata = 0;

    if (!dryRun) {
      for (const cid of wouldDelete) {
        const hasMetadata = metadata.has(cid);
        const hasContent = content.has(cid);

        if (hasMetadata && hasContent) {
          let record: PinRecord | null = null;

          try {
            record = this.get(cid);
          } catch {
            record = null;
          }

          const protectedPin =
            record && (record.publicationIds.length > 0 || (referenced?.has(cid) ?? false));
          if (protectedPin) {
            candidates.delete(cid);
            continue;
          }
          this.remove(cid);
          deleted += 1;
        } else {
          const paths = this.paths(cid);
          if (hasMetadata) {
            rmSync(paths.metadata, { force: true });
            removedMetadata += 1;
          }
          if (hasContent) {
            rmSync(paths.content, { force: true });
            removedContent += 1;
          }
        }

        candidates.delete(cid);
      }
    }

    this.saveGcCandidates(candidates);

    return {
      scanned: metadata.size,
      referenced: referencedCount,
      held,
      candidates: candidates.size,
      deleted,
      orphanContent: orphanContent.size,
      orphanMetadata: orphanMetadata.size,
      purgedTemp: this.purgeTempFiles(),
      wouldDelete,
      dryRun,
      gracePeriodMs,
    };
  }

  private gcCandidatesPath(): string {
    return join(this.directory, "_pin-gc-candidates.json");
  }

  private loadGcCandidates(): Map<string, { cid: string; firstSeen: number }> {
    const path = this.gcCandidatesPath();
    if (!existsSync(path)) return new Map();

    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        cid?: unknown;
        firstSeen?: unknown;
      }[];
      const candidates = new Map<string, { cid: string; firstSeen: number }>();

      for (const entry of parsed) {
        if (
          typeof entry.cid === "string" &&
          CID_PATTERN.test(entry.cid) &&
          typeof entry.firstSeen === "number" &&
          Number.isFinite(entry.firstSeen)
        ) {
          candidates.set(entry.cid, { cid: entry.cid, firstSeen: entry.firstSeen });
        }
      }

      return candidates;
    } catch {
      return new Map();
    }
  }

  private saveGcCandidates(candidates: Map<string, { cid: string; firstSeen: number }>): void {
    const path = this.gcCandidatesPath();
    const temporary = `${path}.${randomUUID()}.tmp`;

    try {
      writeFileSync(temporary, JSON.stringify([...candidates.values()], null, 2));
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private purgeTempFiles(): number {
    let removed = 0;

    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".tmp")) continue;

      try {
        rmSync(join(this.directory, name), { force: true });
        removed += 1;
      } catch {
        // Another handle still holds it; leave it for the next sweep.
      }
    }

    return removed;
  }
}

function parseTokens(tokenConfig?: string | string[]): string[] {
  if (!tokenConfig) return [];
  if (Array.isArray(tokenConfig)) {
    return tokenConfig.flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
  }
  return tokenConfig.split(",").map((t) => t.trim()).filter(Boolean);
}

function authorized(req: IncomingMessage, tokenConfig?: string | string[]): boolean {
  const tokens = parseTokens(tokenConfig);
  if (tokens.length === 0) return true;

  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header, "utf8");

  for (const token of tokens) {
    const wanted = Buffer.from(`Bearer ${token}`, "utf8");
    if (given.length === wanted.length && timingSafeEqual(given, wanted)) {
      return true;
    }
  }

  return false;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"] ?? "0");
  const limit = Math.ceil(MAX_CONTENT * 4 / 3) + 4096;

  if (declared > limit) throw new Error("request body is too large");

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body is too large");
    chunks.push(chunk as Buffer);
  }

  const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }

  return value as Record<string, unknown>;
}

export interface PinServerOptions {
  /** When set, every request except /health must carry a bearer token. Supports multiple tokens for rotation. */
  token?: string | string[];
  tokens?: string[];
  /** Maximum total stored bytes across all pins. */
  maxBytes?: number;
  /** Maximum requests allowed in `windowMs`. */
  maxRequestsPerWindow?: number;
  windowMs?: number;
}

export class RateLimiter {
  private requests: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  check(now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    while (this.requests.length > 0 && this.requests[0]! <= cutoff) {
      this.requests.shift();
    }
    if (this.requests.length >= this.max) {
      return false;
    }
    this.requests.push(now);
    return true;
  }
}

export function createPinServer(store: PinStore, options: PinServerOptions = {}) {
  const tokenConfig = options.tokens ?? options.token;
  const tokenCount = parseTokens(tokenConfig).length;
  const rateLimiter = options.maxRequestsPerWindow
    ? new RateLimiter(options.maxRequestsPerWindow, options.windowMs ?? 60_000)
    : null;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { ok: true, pins: store.list().length });
        return;
      }

      if (rateLimiter && !rateLimiter.check()) {
        send(res, 429, { error: "too many requests: rate limit exceeded" });
        return;
      }

      if (!authorized(req, tokenConfig)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      if (url.pathname === "/v1/pins") {
        if (req.method === "GET") {
          send(res, 200, store.list());
          return;
        }

        if (req.method === "POST") {
          const body = await readBody(req);
          const cid = body.cid;
          const content = body.content;

          if (typeof cid !== "string" || typeof content !== "string") {
            send(res, 400, { error: "cid and base64 content are required" });
            return;
          }

          if (content.length > Math.ceil(MAX_CONTENT * 4 / 3) + 4) {
            send(res, 400, { error: "content is too large" });
            return;
          }

          const decoded = Uint8Array.from(Buffer.from(content, "base64"));
          if (options.maxBytes !== undefined) {
            const currentBytes = store.list().reduce((sum, pin) => sum + pin.bytes, 0);
            if (currentBytes + decoded.length > options.maxBytes) {
              send(res, 507, { error: "insufficient storage: byte quota exceeded" });
              return;
            }
          }

          try {
            const record = store.put({
              cid,
              content: decoded,
              root: typeof body.root === "string" ? body.root : null,
              publicationIds: Array.isArray(body.publicationIds)
                ? body.publicationIds.filter((value): value is string => typeof value === "string")
                : [],
            });

            send(res, 201, { ...record, reference: `pin:${record.cid}` });
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : "pin refused" });
          }
          return;
        }

        send(res, 405, { error: "method not allowed" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/pins/gc") {
        const body = await readBody(req);
        const referenced = body.referenced;

        if (
          referenced !== undefined &&
          (!Array.isArray(referenced) ||
            !referenced.every((cid) => typeof cid === "string" && CID_PATTERN.test(cid)))
        ) {
          send(res, 400, { error: "referenced must be an array of CIDs" });
          return;
        }

        const gracePeriodMs =
          typeof body.gracePeriodMs === "number" && body.gracePeriodMs >= 0
            ? body.gracePeriodMs
            : undefined;
        const dryRun = body.dryRun !== false;

        if (!dryRun && !destructiveGcAllowed(req, tokenCount)) {
          send(res, 403, {
            error: "destructive GC requires a pin token or a loopback client",
          });
          return;
        }

        send(
          res,
          200,
          store.gc({
            referenced: referenced as string[] | undefined,
            gracePeriodMs,
            dryRun,
          }),
        );
        return;
      }

      const parts = url.pathname.split("/").filter(Boolean);

      if (parts[0] === "v1" && parts[1] === "pins" && parts[2]) {
        const cid = parts[2];

        if (req.method === "GET") {
          const record = store.get(cid);
          const content = store.content(cid);

          if (!record || !content) {
            send(res, 404, { error: "pin not found" });
            return;
          }

          send(res, 200, { ...record, content: Buffer.from(content).toString("base64") });
          return;
        }

        if (req.method === "DELETE") {
          if (store.remove(cid)) {
            res.writeHead(204).end();
          } else {
            send(res, 404, { error: "pin not found" });
          }
          return;
        }
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "bad request" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.RAREXT_PIN_DIR ?? ".data/pins";
  const port = Number(process.env.RAREXT_PIN_PORT ?? "9700");
  const token = process.env.RAREXT_PIN_TOKEN || undefined;
  const maxBytes = process.env.RAREXT_PIN_MAX_BYTES ? Number(process.env.RAREXT_PIN_MAX_BYTES) : undefined;
  const maxRequestsPerWindow = process.env.RAREXT_PIN_MAX_REQUESTS ? Number(process.env.RAREXT_PIN_MAX_REQUESTS) : undefined;
  const store = new PinStore(directory);
  const server = createPinServer(store, { token, maxBytes, maxRequestsPerWindow });

  const gcIntervalMs = Number(process.env.RAREXT_PIN_GC_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
  const gcGracePeriodMs = Number(process.env.RAREXT_PIN_GC_GRACE_MS ?? 24 * 60 * 60 * 1000);
  const gcDryRun = process.env.RAREXT_PIN_GC_DRY_RUN !== "false";
  const pinGc = new PinGc({
    pins: store,
    gracePeriodMs: gcGracePeriodMs,
    dryRun: gcDryRun,
  });
  const gcScheduler = gcIntervalMs > 0
    ? new GcScheduler({
      run: () => pinGc.run(),
      intervalMs: gcIntervalMs,
      onRun: (run) => {
        console.log(
          `pin gc: dryRun=${run.dryRun} deleted=${run.pins.deleted} ` +
            `candidates=${run.pins.candidates}`,
        );
      },
      onError: (error) => {
        console.error(`pin gc failed: ${error instanceof Error ? error.message : error}`);
      },
    })
    : null;

  server.listen(port, "127.0.0.1", () => {
    console.log(`pinning service on http://127.0.0.1:${port} (${directory})`);

    if (gcScheduler) {
      gcScheduler.start();
      console.log(
        `pin gc every ${Math.round(gcIntervalMs / 1000)}s ` +
          `(dryRun=${gcDryRun}, grace ${Math.round(gcGracePeriodMs / 1000)}s)`,
      );
    } else {
      console.log("pin gc disabled: RAREXT_PIN_GC_INTERVAL_MS=0");
    }
  });

  function shutdown(signal: string): void {
    console.log(`${signal}: shutting down`);
    gcScheduler?.stop();
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
