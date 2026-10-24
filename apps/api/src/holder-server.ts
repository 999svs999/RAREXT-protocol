import { createHash, randomUUID, timingSafeEqual, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

import {
  MAX_CHALLENGE_NONCE,
  responseFromLeaves,
  SHARD_CHUNK_BYTES,
} from "./durability.ts";
import { merkleProof } from "./merkle.ts";
import { destructiveGcAllowed } from "./net.ts";
import { BlobStore, sha256Bytes } from "./storage.ts";

const MAX_BODY = 32 * 1024 * 1024;
const MAX_RAW_BODY = 8 * 1024 * 1024 * 1024;

export interface HolderServerOptions {
  id: string;
  directory: string;
  /** When set, requests must carry `Authorization: Bearer <token>`. Supports multiple tokens for rotation. */
  token?: string | string[];
  tokens?: string[];
  /** Maximum total stored bytes across all shards. */
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

const MAX_CACHED_LEAVES = 262_144;
const MAX_CACHE_ENTRIES = 64;

const GC_CANDIDATES_FILE = "_gc-candidates.json";
const DEFAULT_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24h

interface GcCandidate {
  storedAs: string;
  firstSeen: number; // epoch ms
}

function loadGcCandidates(directory: string): Map<string, GcCandidate> {
  const path = join(directory, GC_CANDIDATES_FILE);
  if (!existsSync(path)) return new Map();
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as GcCandidate[];
    return new Map(data.map((c) => [c.storedAs, c]));
  } catch {
    return new Map();
  }
}

function saveGcCandidates(directory: string, candidates: Map<string, GcCandidate>): void {
  const path = join(directory, GC_CANDIDATES_FILE);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify([...candidates.values()], null, 2));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Remove `*.tmp` leftovers from an interrupted write or index save. The store
 * only adopts names that are a 64-char digest, so a temp file is never a shard
 * and never referenced; it is safe to delete. Returns the number removed.
 */
function purgeTempFiles(directory: string, isActive?: (name: string) => boolean): number {
  if (!existsSync(directory)) return 0;

  let removed = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = entry.name;

    // A directory or other non-file is not an interrupted write and must not
    // be recursively deleted by a sweep.
    if (!entry.isFile() || !name.endsWith(".tmp")) continue;
    if (isActive?.(name)) continue;

    try {
      rmSync(join(directory, name), { force: true });
      removed += 1;
    } catch {
      // A file another process is still holding; leave it for the next sweep.
    }
  }

  return removed;
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

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
): void {
  const payload =
    type === "application/json" ? JSON.stringify(body) : (body as Buffer);

  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"] ?? "0");

  if (declared > MAX_BODY) throw new Error("request body is too large");

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY) throw new Error("request body is too large");

    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = text ? JSON.parse(text) : {};

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be an object");
  }

  return parsed as Record<string, unknown>;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * A failed write is a server problem (disk full, read-only directory, or a
 * quota the holder cannot enforce), not a client problem. It is reported as a
 * 5xx so a caller retries or repairs instead of resending the same bytes.
 */
function writeFailure(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : "write failed";
  const code =
    error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
      ? ((error as NodeJS.ErrnoException).code as string)
      : "";

  if (code === "ENOSPC" || /no space left/.test(message)) {
    return { status: 507, message: "insufficient storage: disk full" };
  }
  if (code === "EACCES" || code === "EPERM" || /read-only|permission/.test(message)) {
    return { status: 500, message: `holder directory is not writable: ${message}` };
  }
  return { status: 500, message };
}

async function fileLeaves(path: string): Promise<string[]> {
  const leaves: string[] = [];
  let carry = Buffer.alloc(0);

  for await (const chunk of createReadStream(path, { highWaterMark: SHARD_CHUNK_BYTES })) {
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let offset = 0;

    while (data.length - offset >= SHARD_CHUNK_BYTES) {
      leaves.push(sha256Bytes(data.subarray(offset, offset + SHARD_CHUNK_BYTES)));
      offset += SHARD_CHUNK_BYTES;
    }

    carry = data.subarray(offset);
  }

  if (carry.length > 0) leaves.push(sha256Bytes(carry));

  return leaves.length > 0 ? leaves : [sha256Bytes(new Uint8Array())];
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of createReadStream(path, { start, end })) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/**
 * A minimal HTTP holder: it stores shard bytes, answers nonce-bound leaf
 * challenges, and never learns which blob a shard belongs to.
 */
export function createHolderServer(options: HolderServerOptions) {
  const store = new BlobStore(options.directory);
  const leafCache = new Map<string, { leaves: string[]; size: number }>();
  let cachedLeaves = 0;
  const tokenConfig = options.tokens ?? options.token;

  // A shard with an in-flight read is not collectable. The raw stream may
  // survive an unlink through its open fd, but the leaves/challenge path opens
  // the file lazily and would race a delete, so GC defers any shard with a
  // reader until the read closes.
  const activeReads = new Map<string, number>();
  // Raw uploads stream into `_upload.*.tmp` and rename only at the end. GC is
  // synchronous but an upload is not, so a sweep must skip a temp file whose
  // writer is still alive or the rename would fail with ENOENT.
  const activeTemps = new Set<string>();

  function beginRead(hash: string): void {
    activeReads.set(hash, (activeReads.get(hash) ?? 0) + 1);
  }

  function endRead(hash: string): void {
    const remaining = (activeReads.get(hash) ?? 1) - 1;

    if (remaining <= 0) activeReads.delete(hash);
    else activeReads.set(hash, remaining);
  }

  // A crash can leave `_upload.*.tmp` or `<hash>.*.tmp` files behind. No upload
  // is in flight during startup or a synchronous GC pass, so any leftover temp
  // file is dead weight that would otherwise sit on disk forever.
  const purgedTemp = purgeTempFiles(options.directory);
  if (purgedTemp > 0) {
    console.log(`RAREXT holder ${options.id} removed ${purgedTemp} stale temp file(s)`);
  }

  const rateLimiter = options.maxRequestsPerWindow
    ? new RateLimiter(options.maxRequestsPerWindow, options.windowMs ?? 60_000)
    : null;
  const tokenCount = parseTokens(tokenConfig).length;

  function forgetLeaves(storedAs: string): void {
    const cached = leafCache.get(storedAs);
    if (!cached) return;

    leafCache.delete(storedAs);
    cachedLeaves -= cached.leaves.length * 64;
  }

  function cacheLeaves(storedAs: string, leaves: string[], size: number): string[] {
    const cost = leaves.length * 64;

    if (leaves.length <= MAX_CACHED_LEAVES && cachedLeaves + cost <= MAX_CACHED_LEAVES * 64) {
      leafCache.set(storedAs, { leaves, size });
      cachedLeaves += cost;

      while (leafCache.size > MAX_CACHE_ENTRIES) {
        const [oldest, oldLeaves] = leafCache.entries().next().value as [
          string,
          { leaves: string[]; size: number },
        ];
        leafCache.delete(oldest);
        cachedLeaves -= oldLeaves.leaves.length * 64;
      }
    }

    return leaves;
  }

  async function leavesForFile(storedAs: string): Promise<string[] | null> {
    // A GC pass or DELETE must not leave a cached proof behind: a shard that no
    // longer exists on disk cannot answer a challenge. On a hit, confirm the
    // file is still there and the same size before trusting the cache.
    const cached = leafCache.get(storedAs);
    const path = store.filePath(storedAs);

    if (!path) {
      forgetLeaves(storedAs);
      return null;
    }

    if (cached) {
      if (statSync(path).size === cached.size) return cached.leaves;
      forgetLeaves(storedAs);
    }

    // The leaves are computed over the on-disk bytes, but only after proving
    // those bytes still hash to `storedAs`. A corrupted or truncated file would
    // otherwise produce a valid-looking Merkle proof over the wrong bytes, and
    // the ledger's audit would record the shard as live when it is not.
    const found = store.get(storedAs);
    if (!found) return null;

    return cacheLeaves(storedAs, await fileLeaves(path), found.bytes.length);
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://holder");
      const parts = url.pathname.split("/").filter(Boolean);

      if (rateLimiter && !rateLimiter.check()) {
        send(res, 429, { error: "too many requests: rate limit exceeded" });
        return;
      }

      if (url.pathname === "/v1/holder/gc/scan" && req.method === "POST") {
        if (!authorized(req, tokenConfig)) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
        const body = await readJson(req);
        const referenced = body.referenced;
        if (!Array.isArray(referenced) || !referenced.every(isHash)) {
          send(res, 400, { error: "referenced must be an array of sha256 hashes" });
          return;
        }
        const graceMs = typeof body.gracePeriodMs === "number" && body.gracePeriodMs >= 0
          ? body.gracePeriodMs
          : DEFAULT_GC_GRACE_PERIOD_MS;
        const dryRun = body.dryRun !== false;

        if (!dryRun && !destructiveGcAllowed(req, tokenCount)) {
          send(res, 403, {
            error: "destructive GC requires a holder token or a loopback client",
          });
          return;
        }

        const referencedSet = new Set(referenced);
        const allShards = store.list();
        const candidates = loadGcCandidates(options.directory);
        const now = Date.now();
        const toDelete: GcCandidate[] = [];
        const deferred: string[] = [];
        const stillReferenced: string[] = [];

        for (const shard of allShards) {
          if (referencedSet.has(shard.hash)) {
            stillReferenced.push(shard.hash);
            candidates.delete(shard.hash);
          } else {
            const existing = candidates.get(shard.hash);
            if (!existing) {
              candidates.set(shard.hash, { storedAs: shard.hash, firstSeen: now });
              if (graceMs === 0) {
                toDelete.push({ storedAs: shard.hash, firstSeen: now });
              }
            } else if (now - existing.firstSeen >= graceMs) {
              toDelete.push(existing);
            }
          }
        }

        // A shard being read right now is a live reference for this pass. Keep
        // its candidate entry (so the grace clock does not restart) but do not
        // unlink it: the leaves/challenge path may still be opening the file.
        const deletable = toDelete.filter((c) => {
          if (!activeReads.has(c.storedAs)) return true;
          deferred.push(c.storedAs);
          return false;
        });

        const purgedThisPass = purgeTempFiles(
          options.directory,
          (name) => activeTemps.has(name),
        );

        let deletedCount = 0;

        if (!dryRun) {
          for (const c of deletable) {
            if (!store.remove(c.storedAs)) continue;
            forgetLeaves(c.storedAs);
            candidates.delete(c.storedAs);
            deletedCount += 1;
          }
          saveGcCandidates(options.directory, candidates);
        }

        send(res, 200, {
          holder: options.id,
          scanned: allShards.length,
          referenced: stillReferenced.length,
          candidates: candidates.size,
          deleted: deletedCount,
          deferred: deferred.length,
          deferredShards: deferred,
          purgedTemp: purgedThisPass,
          wouldDelete: deletable.map((c) => c.storedAs),
          dryRun,
          gracePeriodMs: graceMs,
        });
        return;
      }

      if (url.pathname === "/v1/holder/gc/candidates" && req.method === "GET") {
        if (!authorized(req, tokenConfig)) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
        const candidates = loadGcCandidates(options.directory);
        send(res, 200, {
          holder: options.id,
          candidates: [...candidates.values()].map((c) => ({
            storedAs: c.storedAs,
            firstSeen: new Date(c.firstSeen).toISOString(),
            ageMs: Date.now() - c.firstSeen,
          })),
        });
        return;
      }

      if (url.pathname === "/v1/holder/gc/reset" && req.method === "POST") {
        if (!authorized(req, tokenConfig)) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
        if (!destructiveGcAllowed(req, tokenCount)) {
          send(res, 403, {
            error: "destructive GC requires a holder token or a loopback client",
          });
          return;
        }
        rmSync(join(options.directory, GC_CANDIDATES_FILE), { force: true });
        send(res, 200, { holder: options.id, reset: true });
        return;
      }

      if (!authorized(req, tokenConfig)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/holder") {
        const shards = store.list();

        send(res, 200, {
          id: options.id,
          version: 1,
          shards: shards.length,
          bytes: shards.reduce((sum, shard) => sum + shard.size, 0),
        });
        return;
      }

      if (url.pathname === "/v1/holder/shards") {
        if (req.method === "GET") {
          send(res, 200, {
            id: options.id,
            shards: store.list().map((shard) => ({
              storedAs: shard.hash,
              size: shard.size,
              createdAt: shard.createdAt,
            })),
          });
          return;
        }

        if (req.method === "POST") {
          const body = await readJson(req);
          const content = body.content;

          if (typeof content !== "string" || content.length === 0) {
            send(res, 400, { error: "content must be base64 text" });
            return;
          }

          const bytes = Buffer.from(content, "base64");
          if (bytes.length === 0) {
            send(res, 400, { error: "content decoded to zero bytes" });
            return;
          }

          if (options.maxBytes !== undefined) {
            const currentBytes = store.list().reduce((sum, shard) => sum + shard.size, 0);
            if (currentBytes + bytes.length > options.maxBytes) {
              send(res, 507, { error: "insufficient storage: byte quota exceeded" });
              return;
            }
          }

          try {
            const record = store.put(bytes);
            send(res, 201, { storedAs: record.hash, size: record.size });
          } catch (error) {
            const failure = writeFailure(error);
            send(res, failure.status, { error: failure.message });
          }
          return;
        }
      }

      if (
        parts.length === 5 &&
        parts[0] === "v1" &&
        parts[1] === "holder" &&
        parts[2] === "shards" &&
        parts[4] === "raw"
      ) {
        const hash = parts[3]!;

        if (!isHash(hash)) {
          send(res, 400, { error: "storedAs must be a sha256 hex digest" });
          return;
        }

        const path = store.filePath(hash);

        if (req.method === "HEAD") {
          if (!path) {
            res.writeHead(404);
            res.end();
            return;
          }

          res.writeHead(200, { "content-length": String(statSync(path).size) });
          res.end();
          return;
        }

        if (req.method === "GET") {
          if (!path) {
            send(res, 404, { error: "unknown shard" });
            return;
          }

          beginRead(hash);
          try {
            res.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": String(statSync(path).size),
            });
            await pipeline(createReadStream(path), res);
          } finally {
            endRead(hash);
          }
          return;
        }

        if (req.method === "PUT") {
          const length = Number(req.headers["content-length"] ?? "0");

          if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_RAW_BODY) {
            send(res, 400, { error: "raw upload needs a valid content-length" });
            return;
          }

          if (options.maxBytes !== undefined) {
            const currentBytes = store.list().reduce((sum, shard) => sum + shard.size, 0);
            if (currentBytes + length > options.maxBytes) {
              send(res, 507, { error: "insufficient storage: byte quota exceeded" });
              return;
            }
          }

          const temporaryName = `_upload.${randomUUID()}.tmp`;
          const temporary = join(options.directory, temporaryName);
          const hasher = createHash("sha256");
          let received = 0;

          activeTemps.add(temporaryName);
          try {
            await pipeline(
              req,
              new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  received += chunk.length;
                  hasher.update(chunk);
                  callback(null, chunk);
                },
              }),
              createWriteStream(temporary, { flags: "wx" }),
            );

            if (received !== length) throw new Error("upload length does not match content-length");

            const digest = hasher.digest("hex");
            if (digest !== hash) throw new Error("upload hash does not match storedAs");

            try {
              const record = store.putFile(temporary, hash, length);
              send(res, 201, { storedAs: record.hash, size: record.size });
            } catch (error) {
              const failure = writeFailure(error);
              send(res, failure.status, { error: failure.message });
            }
          } catch (error) {
            rmSync(temporary, { force: true });
            if (!res.headersSent) {
              // A length or hash mismatch is the caller's bytes being wrong, a
              // 400. An I/O failure landing the rename is a holder problem.
              if (
                error instanceof Error &&
                /upload length does not match|upload hash does not match/.test(error.message)
              ) {
                send(res, 400, { error: error.message });
              } else {
                const failure = writeFailure(error);
                send(res, failure.status, { error: failure.message });
              }
            }
          } finally {
            activeTemps.delete(temporaryName);
          }
          return;
        }
      }

      if (parts.length === 4 && parts[0] === "v1" && parts[1] === "holder" && parts[2] === "shards") {
        const hash = parts[3]!;

        if (req.method === "HEAD") {
          res.writeHead(isHash(hash) && store.has(hash) ? 200 : 404);
          res.end();
          return;
        }

        if (req.method === "GET") {
          const found = isHash(hash) ? store.get(hash) : null;

          if (!found) {
            send(res, 404, { error: "unknown shard" });
            return;
          }

          send(res, 200, {
            storedAs: found.record.hash,
            size: found.record.size,
            content: found.bytes.toString("base64"),
          });
          return;
        }

        if (req.method === "DELETE") {
          if (!destructiveGcAllowed(req, tokenCount)) {
            send(res, 403, {
              error: "deleting a shard requires a holder token or a loopback client",
            });
            return;
          }
          const removed = isHash(hash) && store.remove(hash);
          if (removed) forgetLeaves(hash);
          res.writeHead(removed ? 204 : 404);
          res.end();
          return;
        }
      }

      if (
        parts.length === 6 &&
        parts[0] === "v1" &&
        parts[1] === "holder" &&
        parts[2] === "shards" &&
        parts[4] === "leaves"
      ) {
        const hash = parts[3]!;
        const index = Number(parts[5]);

        if (req.method !== "GET") {
          send(res, 405, { error: "method not allowed" });
          return;
        }

        const path = isHash(hash) ? store.filePath(hash) : null;

        if (!path) {
          send(res, 404, { error: "unknown shard" });
          return;
        }

        beginRead(hash);
        try {
          const leaves = await leavesForFile(hash);

          if (!leaves) {
            send(res, 404, { error: "unknown shard" });
            return;
          }

          if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
            send(res, 404, { error: "leaf index is out of range" });
            return;
          }

          const start = index * SHARD_CHUNK_BYTES;
          const bytes = await readRange(path, start, start + SHARD_CHUNK_BYTES - 1);
          send(res, 200, {
            index,
            bytes: bytes.toString("base64"),
            proof: merkleProof(leaves, index),
          });
        } finally {
          endRead(hash);
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/holder/challenge") {
        const body = await readJson(req);
        const storedAs = body.storedAs;
        const leafIndex = body.leafIndex;
        const nonce = body.nonce;

        if (
          !isHash(storedAs) ||
          !Number.isInteger(leafIndex) ||
          (leafIndex as number) < 0 ||
          typeof nonce !== "string" ||
          nonce.length === 0 ||
          nonce.length > MAX_CHALLENGE_NONCE
        ) {
          send(res, 400, { error: "storedAs, leafIndex, and a bounded nonce are required" });
          return;
        }

        beginRead(storedAs);
        try {
          const leaves = await leavesForFile(storedAs);
          if (!leaves) {
            send(res, 404, { error: "unknown shard" });
            return;
          }

          const response = responseFromLeaves(leaves, leafIndex as number, nonce);

          if (!response) {
            send(res, 404, { error: "leaf index is out of range" });
            return;
          }

          send(res, 200, response);
        } finally {
          endRead(storedAs);
        }
        return;
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 400, {
        error: error instanceof Error ? error.message : "bad request",
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.env.RAREXT_HOLDER_ID ?? `holder-${randomUUID().slice(0, 8)}`;
  const directory = process.env.RAREXT_HOLDER_DIR ?? ".data/holder";
  const port = Number(process.env.RAREXT_HOLDER_PORT ?? 9600);
  const host = process.env.RAREXT_HOLDER_HOST ?? "127.0.0.1";
  const token = process.env.RAREXT_HOLDER_TOKEN || undefined;
  const maxBytes = process.env.RAREXT_HOLDER_MAX_BYTES ? Number(process.env.RAREXT_HOLDER_MAX_BYTES) : undefined;
  const maxRequestsPerWindow = process.env.RAREXT_HOLDER_MAX_REQUESTS ? Number(process.env.RAREXT_HOLDER_MAX_REQUESTS) : undefined;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";

  if (!loopback && !token) {
    throw new Error("refusing to bind a holder beyond loopback without RAREXT_HOLDER_TOKEN");
  }

  createHolderServer({ id, directory, token, maxBytes, maxRequestsPerWindow }).listen(port, host, () => {
    console.log(`RAREXT holder ${id} listening on http://${host}:${port}`);
  });
}
