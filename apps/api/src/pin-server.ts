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

  server.listen(port, "127.0.0.1", () => {
    console.log(`pinning service on http://127.0.0.1:${port} (${directory})`);
  });
}
