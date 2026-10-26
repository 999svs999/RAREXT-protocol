import { createHash, randomBytes as randomBytesNode } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { decodeBytes, encodeBytes, verifyShard, type ErasureShard } from "./erasure.ts";
import { decodeShardsToFile, reencodeStreamedShard, type StreamedPlacement } from "./erasure-stream.ts";
import type { SealedMetadata } from "./sealed-encryption.ts";
import { merkleProof, merkleRoot, verifyProof } from "./merkle.ts";
import { BlobStore, sha256Bytes } from "./storage.ts";
import type { DurabilityTier } from "../../../packages/core/src/index.ts";

export type { DurabilityTier };

/**
 * Durability is a claim about *holders*, not about a directory. This module
 * places erasure shards on independent holders, challenges them for possession,
 * counts the ones that answered, and rebuilds what was lost.
 *
 * A holder is anything that can put, get, and answer a challenge: a directory
 * here, another machine over HTTP, an agent with a store. Every method is async
 * so the same ledger runs against all of them.
 */

export const SHARD_CHUNK_BYTES = 4096;

export interface HolderChallenge {
  storedAs: string;
  leafIndex: number;
  nonce: string;
}

export const MAX_CHALLENGE_NONCE = 200;

export interface DurabilityHolder {
  readonly id: string;
  put(bytes: Uint8Array): Promise<string>;
  get(storedAs: string): Promise<Uint8Array | null>;
  remove(storedAs: string): Promise<boolean>;
  has(storedAs: string): Promise<boolean>;
  respond(challenge: HolderChallenge): Promise<ChallengeResponse | null>;
  /** Upload a shard file without holding it in memory. `storedAs` is its SHA-256. */
  putFile?(path: string, storedAs: string): Promise<string>;
  /** Download a shard to a file, verifying `storedAs`, without buffering it whole. */
  getFile?(storedAs: string, path: string): Promise<boolean>;
}

export interface ShardPlacement {
  index: number;
  holder: string;
  /** The shard digest: identity plus code parameters. */
  digest: string;
  /** The content hash inside the holder's store. */
  storedAs: string;
  size: number;
  leaves: number;
  /** Merkle root over the leaf hashes of the shard bytes. */
  root: string;
}

export interface Placement {
  blobHash: string;
  dataShards: number;
  parityShards: number;
  /** Length of the stored payload, in bytes. For a sealed placement this is ciphertext. */
  length: number;
  tier: DurabilityTier;
  required: number;
  shards: ShardPlacement[];
  createdAt: string;
  /**
   * Present when the payload was encrypted before erasure coding. The blob hash,
   * shard digests, and Merkle roots all cover ciphertext.
   */
  sealed?: SealedMetadata;
  /**
   * Present when the payload was encoded as independent fixed-size chunks by
   * `encodeFileToShards` rather than as one in-memory block set.
   */
  streamed?: StreamedMeta;
}

export interface StreamedMeta {
  version: 1;
  paddedLength: number;
  chunkBytes: number;
  chunks: number;
  chunkDigests: string[];
}

export interface ChallengeResponse {
  index: number;
  leaf: string;
  proof: string[];
  nonce: string;
  digest: string;
}

export interface ChallengeOutcome {
  index: number;
  holder: string;
  ok: boolean;
  reason: "ok" | "holder-missing" | "shard-missing" | "bad-proof" | "rejected";
}

/**
 * A holder refused the request because the bearer token was missing, wrong, or
 * expired. The ledger can distinguish this from a genuinely absent holder, so
 * an operator sees a token typo instead of every shard reading as lost.
 */
export class HolderRejectedError extends Error {
  readonly holder: string;
  readonly status: number;

  constructor(holder: string, status: number, what: string) {
    super(`holder ${holder} rejected ${what}: ${status}`);
    this.holder = holder;
    this.status = status;
  }
}

export interface DurabilityReport {
  blobHash: string;
  tier: DurabilityTier;
  required: number;
  live: number;
  /** Whether any shard has been challenged at least once. */
  challenged: boolean;
  status: "ok" | "under-replicated";
  shards: {
    index: number;
    holder: string;
    size: number;
    ok: boolean;
    misses: number;
    lastSuccess: string | null;
  }[];
}

export interface RepairOutcome {
  filled: number;
  readBytes: number;
  writtenBytes: number;
  placement: Placement;
}

interface Witness {
  holder: string;
  lastSuccess: number | null;
  lastFailure: number | null;
  misses: number;
}

export interface DurabilityOptions {
  now?: () => number;
  windowMs?: number;
  random?: (upper: number) => number;
  /**
   * Maximum number of placements retained in memory. The oldest placement (and
   * its witness state) is evicted when the limit is exceeded. This bounds a
   * long-lived client that keeps placing new blobs; it does not delete shards
   * from holders. Defaults to unlimited for backwards compatibility.
   */
  maxPlacements?: number;
  /**
   * How long a repair may hold its in-memory lease. A placement has no
   * time-based expiry of its own, but a repair that takes too long, or whose
   * placement is forgotten or replaced while it is reading, must not commit.
   * The check is repeated before the commit, so a slow repair fails closed
   * instead of moving a placement nobody is looking after. Defaults to 30 min.
   */
  repairLeaseMs?: number;
}

export function requiredHolders(
  tier: DurabilityTier,
  shards: { dataShards: number; parityShards: number },
): number {
  const { dataShards, parityShards } = shards;

  if (!Number.isInteger(dataShards) || dataShards < 1) {
    throw new Error("data shards must be an integer of at least 1");
  }

  if (!Number.isInteger(parityShards) || parityShards < 0) {
    throw new Error("parity shards must be an integer of at least 0");
  }

  if (tier === "ephemeral") return 1;
  if (tier === "pinned") return dataShards + 1;
  return dataShards + parityShards;
}

export function directoryHolder(id: string, directory: string): DurabilityHolder {
  const store = new BlobStore(directory);

  return {
    id,
    put: async (bytes) => store.put(bytes).hash,
    putFile: async (path, storedAs) => {
      const temporary = join(directory, `.import.${randomBytesNode(6).toString("hex")}.tmp`);
      copyFileSync(path, temporary);
      return store.putFile(temporary, storedAs, statSync(path).size).hash;
    },
    getFile: async (storedAs, path) => {
      const source = store.filePath(storedAs);
      if (!source) return false;
      copyFileSync(source, path);
      return true;
    },
    get: async (storedAs) => store.get(storedAs)?.bytes ?? null,
    remove: async (storedAs) => store.remove(storedAs),
    has: async (storedAs) => store.has(storedAs),
    respond: async ({ storedAs, leafIndex, nonce }) => {
      const bytes = store.get(storedAs)?.bytes;

      return bytes ? respondToChallenge(bytes, leafIndex, nonce) : null;
    },
  };
}

/**
 * A holder on another machine. The wire protocol is in rfcs/0005.
 */
export function httpHolder(
  id: string,
  baseUrl: string,
  options: {
    fetch?: typeof fetch;
    token?: string;
    timeoutMs?: number;
    /**
     * Total wall-clock budget for a raw shard download, including a holder that
     * sends headers and then trickles bytes. `timeoutMs` only bounds socket
     * inactivity. Defaults to 120 s so a large shard on a slow link is not
     * dropped, while a stalled body still has a finite deadline.
     */
    readTimeoutMs?: number;
  } = {},
): DurabilityHolder {
  const base = baseUrl.replace(/\/+$/, "");
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const readTimeoutMs = options.readTimeoutMs ?? 120_000;
  const headers: Record<string, string> = options.token
    ? { authorization: `Bearer ${options.token}` }
    : {};

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    return call(url, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  async function expect(response: Response, what: string): Promise<Response> {
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new HolderRejectedError(id, response.status, what);
      }
      // Any other non-ok status is a holder failure, not a recoverable state.
      throw new Error(`holder ${id} failed ${what}: ${response.status}`);
    }

    return response;
  }

  function raw(
    method: string,
    path: string,
    options: { bodyPath?: string; bodyLength?: number } = {},
  ): Promise<import("node:http").IncomingMessage> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${base}${path}`);
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = send(
        url,
        {
          method,
          headers: {
            ...headers,
            ...(options.bodyLength !== undefined
              ? { "content-length": String(options.bodyLength), "content-type": "application/octet-stream" }
              : {}),
          },
        },
        resolve,
      );

      outgoing.setTimeout(timeoutMs, () => {
        outgoing.destroy(new Error(`holder ${id} ${method} timed out`));
      });
      outgoing.on("error", reject);

      if (options.bodyPath) {
        pipeline(createReadStream(options.bodyPath), outgoing).catch(reject);
      } else {
        outgoing.end();
      }
    });
  }

  async function discard(response: import("node:http").IncomingMessage): Promise<void> {
    for await (const _chunk of response) {
      // Drain the response so the socket can be reused.
    }
  }

  async function json(response: Response, what: string, limit: number): Promise<unknown> {
    const declared = Number(response.headers.get("content-length") ?? "0");

    if (declared > limit) {
      throw new Error(`holder ${id} ${what} response is too large`);
    }

    const text = await response.text();

    if (Buffer.byteLength(text) > limit) {
      throw new Error(`holder ${id} ${what} response is too large`);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`holder ${id} ${what} returned invalid JSON`);
    }
  }

  return {
    id,
    async putFile(path, storedAs) {
      if (!/^[0-9a-f]{64}$/.test(storedAs)) throw new Error(`invalid storedAs for ${id}`);
      const response = await raw("PUT", `/v1/holder/shards/${storedAs}/raw`, {
        bodyPath: path,
        bodyLength: statSync(path).size,
      });

      if (response.statusCode !== 201) {
        await discard(response);
        // A non-201 is a placement failure, not a recoverable error: a 5xx
        // (e.g. the holder's quota), and equally a missing status when the
        // socket died before the head arrived, must fail the placement
        // loudly rather than let it retry quietly with fewer shards.
        throw new Error(`holder ${id} failed putFile: ${response.statusCode ?? "no status"}`);
      }


      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { storedAs?: unknown }).storedAs !== "string" ||
        (value as { storedAs: string }).storedAs !== storedAs
      ) {
        throw new Error(`holder ${id} returned an invalid storedAs`);
      }

      return storedAs;
    },
    async getFile(storedAs, path) {
      if (!/^[0-9a-f]{64}$/.test(storedAs)) return false;

      const response = await raw("GET", `/v1/holder/shards/${storedAs}/raw`);

      if (response.statusCode === 404) {
        await discard(response);
        return false;
      }

      if (response.statusCode === 401 || response.statusCode === 403) {
        await discard(response);
        throw new HolderRejectedError(id, response.statusCode, "getFile");
      }

      if (response.statusCode !== 200) {
        await discard(response);
        // If the holder returns a non-200 status for GET, it indicates a server-side
        // issue or a configuration problem. This should be treated as a retrieval
        // failure.
        throw new Error(`holder ${id} failed getFile: ${response.statusCode}`);
      }

      const temporary = `${path}.${randomBytesNode(6).toString("hex")}.tmp`;
      const hasher = createHash("sha256");
      let deadline: NodeJS.Timeout | null = null;

      try {
        deadline = setTimeout(() => {
          response.destroy(new Error(`holder ${id} GET read timed out after ${readTimeoutMs}ms`));
        }, readTimeoutMs);
        deadline.unref();

        await pipeline(
          response,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hasher.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(temporary, { flags: "wx" }),
        );

        const digest = hasher.digest("hex");
        if (digest !== storedAs) throw new Error(`holder ${id} returned bytes that do not match ${storedAs}`);

        renameSync(temporary, path);
        return true;
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    },
    async put(bytes) {
      const response = await expect(
        await request(`${base}/v1/holder/shards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: Buffer.from(bytes).toString("base64") }),
        }),
        "put",
      );
      const value = await json(response, "put", 4096);

      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { storedAs?: unknown }).storedAs !== "string" ||
        !/^[0-9a-f]{64}$/.test((value as { storedAs: string }).storedAs)
      ) {
        throw new Error(`holder ${id} returned an invalid storedAs`);
      }

      return (value as { storedAs: string }).storedAs;
    },
    async get(storedAs) {
      if (!/^[0-9a-f]{64}$/.test(storedAs)) return null;

      const response = await request(`${base}/v1/holder/shards/${storedAs}`);

      if (response.status === 404) return null;

      await expect(response, "get");
      const value = await json(response, "get", 48 * 1024 * 1024);

      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { content?: unknown }).content !== "string"
      ) {
        throw new Error(`holder ${id} returned invalid shard content`);
      }

      const bytes = Uint8Array.from(Buffer.from((value as { content: string }).content, "base64"));

      if (sha256Bytes(bytes) !== storedAs) {
        throw new Error(`holder ${id} returned bytes that do not match ${storedAs}`);
      }

      return bytes;
    },
    async remove(storedAs) {
      if (!/^[0-9a-f]{64}$/.test(storedAs)) return false;

      const response = await request(`${base}/v1/holder/shards/${storedAs}`, {
        method: "DELETE",
      });

      return response.ok;
    },
    async has(storedAs) {
      if (!/^[0-9a-f]{64}$/.test(storedAs)) return false;

      const response = await request(`${base}/v1/holder/shards/${storedAs}`, {
        method: "HEAD",
      });

      return response.ok;
    },
    async respond(challenge) {
      const response = await request(`${base}/v1/holder/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(challenge),
      });

      if (response.status === 404) return null;

      await expect(response, "challenge");
      const value = await json(response, "challenge", 256 * 1024);

      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`holder ${id} returned an invalid challenge response`);
      }

      return value as ChallengeResponse;
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

export function chunkLeaves(bytes: Uint8Array): string[] {
  const leaves: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += SHARD_CHUNK_BYTES) {
    leaves.push(sha256Bytes(bytes.subarray(offset, offset + SHARD_CHUNK_BYTES)));
  }

  return leaves.length > 0 ? leaves : [sha256Bytes(new Uint8Array())];
}

function nonceBinding(nonce: string, leaf: string): string {
  return sha256Bytes(Buffer.from(`${nonce}:${leaf}`, "utf8"));
}

/**
 * Answer a challenge for one leaf. The leaf and its path prove possession
 * against the committed root; the nonce binding proves the answer was computed
 * after the challenge and cannot be replayed.
 */
export function respondToChallenge(
  bytes: Uint8Array,
  leafIndex: number,
  nonce: string,
): ChallengeResponse | null {
  return responseFromLeaves(chunkLeaves(bytes), leafIndex, nonce);
}

/** Answer from an already-computed leaf set; lets a holder cache the tree. */
export function responseFromLeaves(
  leaves: string[],
  leafIndex: number,
  nonce: string,
): ChallengeResponse | null {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    return null;
  }

  const leaf = leaves[leafIndex]!;

  return {
    index: leafIndex,
    leaf,
    proof: merkleProof(leaves, leafIndex),
    nonce,
    digest: nonceBinding(nonce, leaf),
  };
}

const HEX_64 = /^[0-9a-f]{64}$/;

const DEFAULT_RETRIEVAL_CONCURRENCY = 4;
const MAX_FAILURE_NOTE = 200;

function failureNote(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_FAILURE_NOTE ? `${text.slice(0, MAX_FAILURE_NOTE)}...` : text;
}

/**
 * Download up to `needed` distinct shards with bounded parallelism. Every
 * attempt gets its own file, and a holder failure is recorded rather than
 * aborting the whole read: parity shards are the retry budget across holders.
 *
 * The worker pool stops scheduling once `needed` downloads succeed. Requests
 * already in flight are awaited so their temporary files are cleaned before the
 * caller removes the work directory; that bounds work to
 * `ceil(shards / concurrency)` attempt rounds, not one timeout per shard.
 */
async function downloadShards(
  shards: ShardPlacement[],
  byId: Map<string, DurabilityHolder>,
  working: string,
  needed: number,
  concurrency: number,
): Promise<{ downloaded: { index: number; path: string }[]; failures: string[] }> {
  const ordered = [...shards].sort((left, right) => left.index - right.index);
  const downloaded: { index: number; path: string }[] = [];
  const failures: string[] = [];
  let next = 0;
  let enough = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (enough) return;

      const position = next;
      next += 1;

      if (position >= ordered.length) return;

      const shard = ordered[position]!;
      const holder = byId.get(shard.holder);

      if (!holder) {
        failures.push(`shard ${shard.index}: holder ${shard.holder} is not configured`);
        continue;
      }

      const path = join(working, `${shard.index}-${shard.storedAs}`);

      try {
        const ok = holder.getFile
          ? await holder.getFile(shard.storedAs, path)
          : await (async () => {
            const bytes = await holder.get(shard.storedAs);
            if (!bytes) return false;
            writeFileSync(path, bytes);
            return true;
          })();

        if (ok) {
          downloaded.push({ index: shard.index, path });
          if (downloaded.length >= needed) enough = true;
        } else {
          failures.push(`shard ${shard.index} on ${holder.id}: shard not found`);
        }
      } catch (error) {
        rmSync(path, { force: true });
        failures.push(`shard ${shard.index} on ${holder.id}: ${failureNote(error)}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ordered.length) }, () => worker()),
  );

  // Two workers can finish at the same moment after the threshold is reached.
  // Keep exactly k, remove any extra file from a caller-supplied work directory,
  // and decode a deterministic index order.
  const kept = downloaded.sort((left, right) => left.index - right.index).slice(0, needed);

  for (const extra of downloaded.slice(needed)) {
    rmSync(extra.path, { force: true });
  }

  return { downloaded: kept, failures };
}

export function verifyChallengeResponse(
  shard: ShardPlacement,
  response: ChallengeResponse,
  expected?: HolderChallenge,
): boolean {
  if (!response || typeof response !== "object") return false;
  if (!Number.isInteger(response.index) || response.index < 0) return false;
  if (response.index >= shard.leaves) return false;
  if (typeof response.nonce !== "string" || response.nonce.length === 0) return false;
  if (response.nonce.length > MAX_CHALLENGE_NONCE) return false;
  if (typeof response.leaf !== "string" || !HEX_64.test(response.leaf)) return false;
  if (typeof response.digest !== "string" || !HEX_64.test(response.digest)) return false;
  if (response.digest !== nonceBinding(response.nonce, response.leaf)) return false;
  if (!Array.isArray(response.proof)) return false;

  // A proof has exactly one sibling per tree level. Rejecting an overlong list
  // before hashing keeps a holder from making the verifier do arbitrary work.
  const depth = Math.ceil(Math.log2(Math.max(1, shard.leaves)));
  if (response.proof.length !== depth) return false;
  if (!response.proof.every((value) => typeof value === "string" && HEX_64.test(value))) {
    return false;
  }

  if (expected) {
    if (response.index !== expected.leafIndex) return false;
    if (response.nonce !== expected.nonce) return false;
  }

  return verifyProof(response.leaf, response.proof, shard.root, response.index);
}

export class DurabilityLedger {
  private readonly placements = new Map<string, Placement>();
  private readonly witnesses = new Map<string, Map<number, Witness>>();
  /** One in-flight repair at a time: a second caller joins the first instead of double-writing. */
  private readonly inFlightRepairs = new Map<string, Promise<RepairOutcome>>();
  private readonly now: () => number;
  readonly windowMs: number;
  private readonly random: (upper: number) => number;
  private readonly maxPlacements: number;
  private readonly repairLeaseMs: number;

  constructor(options: DurabilityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
    this.random =
      options.random ?? ((upper) => Math.floor(Math.random() * upper));

    if (
      options.maxPlacements !== undefined &&
      (!Number.isInteger(options.maxPlacements) || options.maxPlacements < 1)
    ) {
      throw new Error("maxPlacements must be a positive integer");
    }

    if (
      options.repairLeaseMs !== undefined &&
      (!Number.isFinite(options.repairLeaseMs) || options.repairLeaseMs <= 0)
    ) {
      throw new Error("repairLeaseMs must be a positive number");
    }

    this.maxPlacements = options.maxPlacements ?? Number.POSITIVE_INFINITY;
    this.repairLeaseMs = options.repairLeaseMs ?? 30 * 60 * 1000;
  }

  /**
   * A repair holds an in-memory lease for one placement object. Placements do
   * not expire on a clock, so the lease is how a forgotten, evicted, or
   * replaced placement is detected after the repair has awaited holders. The
   * time bound stops a repair that hangs on a slow holder from committing into
   * a placement the rest of the node has already moved past.
   */
  private assertRepairLease(
    blobHash: string,
    placement: Placement,
    expiresAt: number,
    stage: string,
  ): void {
    if (this.placements.get(blobHash) !== placement) {
      throw new Error(
        `cannot repair ${blobHash}: the placement is no longer current (forgotten or replaced during ${stage})`,
      );
    }

    if (this.now() > expiresAt) {
      throw new Error(
        `cannot repair ${blobHash}: the repair lease expired during ${stage}`,
      );
    }
  }

  private remember(blobHash: string, placement: Placement, witnesses: Map<number, Witness>): void {
    this.placements.delete(blobHash);
    this.placements.set(blobHash, placement);
    this.witnesses.delete(blobHash);
    this.witnesses.set(blobHash, witnesses);

    while (this.placements.size > this.maxPlacements) {
      const oldest = this.placements.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.placements.delete(oldest);
      this.witnesses.delete(oldest);
    }
  }

  /** Drop a placement and its witness state without touching holder shards. */
  forget(blobHash: string): boolean {
    this.witnesses.delete(blobHash);
    return this.placements.delete(blobHash);
  }

  get(blobHash: string): Placement | null {
    return this.placements.get(blobHash) ?? null;
  }

  /** Every placement this ledger can challenge. */
  list(): Placement[] {
    return [...this.placements.values()];
  }

  /** Writes the map into the ledger so a published record can be rebuilt. */
  adopt(placement: Placement): Placement {
    this.remember(
      placement.blobHash,
      placement,
      new Map(
        placement.shards.map((shard) => [
          shard.index,
          {
            holder: shard.holder,
            lastSuccess: null,
            lastFailure: null,
            misses: 0,
          },
        ]),
      ),
    );

    return placement;
  }

  async place(
    shards: ErasureShard[],
    holders: DurabilityHolder[],
    tier: DurabilityTier,
    options: { sealed?: SealedMetadata } = {},
  ): Promise<Placement> {
    const first = shards[0];

    if (!first) throw new Error("at least one shard is required");

    const { dataShards, parityShards, payloadDigest } = first;
    const total = dataShards + parityShards;

    if (shards.length !== total) {
      throw new Error(`expected ${total} shards, got ${shards.length}`);
    }

    if (new Set(shards.map((shard) => shard.index)).size !== total) {
      throw new Error("shard indices must be unique");
    }

    const covered = [...shards.map((shard) => shard.index)].sort((left, right) => left - right);

    if (covered.some((value, position) => value !== position)) {
      throw new Error("shard indices must cover 0 through n-1");
    }

    for (const shard of shards) {
      if (!verifyShard(shard)) throw new Error(`invalid shard ${shard.index}`);
      if (
        shard.dataShards !== dataShards ||
        shard.parityShards !== parityShards ||
        shard.payloadDigest !== payloadDigest
      ) {
        throw new Error(`shard ${shard.index} belongs to another set`);
      }
    }

    if (new Set(holders.map((holder) => holder.id)).size !== holders.length) {
      throw new Error("holder ids must be unique");
    }

    const required = requiredHolders(tier, { dataShards, parityShards });

    if (required > total) {
      throw new Error(`${tier} needs ${required} shards but the code has ${total}`);
    }

    if (holders.length < total) {
      // This check ensures that we have enough distinct holders to store all shards.
      // If not, placement is impossible and must be reported loudly.
      throw new Error(`need ${total} distinct holders, have ${holders.length}`);
    }

    const ordered = [...holders].sort((left, right) => left.id.localeCompare(right.id));
    const offset = Number.parseInt(payloadDigest.slice(0, 8), 16) % ordered.length;
    const chosen = [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(0, total);

    const placement: Placement = {
      blobHash: payloadDigest,
      dataShards,
      parityShards,
      length: first.length,
      tier,
      required,
      shards: [],
      createdAt: new Date(this.now()).toISOString(),
      ...(options.sealed ? { sealed: options.sealed } : {}),
    };

    const witnesses = new Map<number, Witness>();

    for (const shard of shards) {
      const holder = chosen[shard.index]!;
      const storedAs = await holder.put(shard.bytes);

      if (!/^[0-9a-f]{64}$/.test(storedAs)) {
        // Format only, deliberately NOT equality with the shard digest: the
        // returned name is a LOCATOR, and integrity is enforced when the bytes
        // are read back (httpHolder hashes the response against this name, so a
        // wrong name fails loudly at retrieval). Asserting equality here would
        // refuse holders that name files by their own digest of received bytes.
        throw new Error(`holder ${holder.id} returned an invalid storedAs`);
      }

      const leaves = chunkLeaves(shard.bytes);

      placement.shards.push({
        index: shard.index,
        holder: holder.id,
        digest: shard.digest,
        storedAs,
        size: shard.bytes.length,
        leaves: leaves.length,
        root: merkleRoot(leaves),
      });

      witnesses.set(shard.index, {
        holder: holder.id,
        lastSuccess: null,
        lastFailure: null,
        misses: 0,
      });
    }

    placement.shards.sort((left, right) => left.index - right.index);

    this.remember(payloadDigest, placement, witnesses);

    return placement;
  }

  /**
   * Place a file-backed shard set produced by `encodeFileToShards`. Each shard is
   * uploaded as a file so neither side buffers a whole shard for a large blob.
   * Challenge, audit, and GC are the same as an in-memory placement; repair is
   * bounded by the chunk size.
   */
  async placeStreamed(
    streamed: StreamedPlacement,
    holders: DurabilityHolder[],
    tier: DurabilityTier,
    options: { sealed?: SealedMetadata } = {},
  ): Promise<Placement> {
    const { dataShards, parityShards, chunkBytes, chunks, paddedLength, length, payloadDigest } = streamed;
    const total = dataShards + parityShards;

    if (streamed.version !== 1) throw new Error("unsupported streamed placement version");
    if (!Number.isInteger(dataShards) || dataShards < 1) throw new Error("dataShards must be at least 1");
    if (!Number.isInteger(parityShards) || parityShards < 0) throw new Error("parityShards must be non-negative");
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes % (dataShards * SHARD_CHUNK_BYTES) !== 0) {
      throw new Error("chunkBytes must be a positive multiple of dataShards * 4096");
    }
    if (!Number.isInteger(chunks) || chunks < 1) throw new Error("chunks must be a positive integer");
    if (!Number.isInteger(length) || length < 0 || length > paddedLength) {
      throw new Error("length does not fit the padded length");
    }
    if (!Number.isInteger(paddedLength) || paddedLength < 0) throw new Error("paddedLength is invalid");
    if (!Array.isArray(streamed.chunkDigests) || streamed.chunkDigests.length !== chunks) {
      throw new Error("chunkDigests does not match the chunk count");
    }
    if (!streamed.chunkDigests.every((digest) => HEX_64.test(digest))) {
      throw new Error("chunkDigests must be sha256 hex values");
    }
    if (!HEX_64.test(payloadDigest)) throw new Error("payloadDigest must be a sha256 hex value");
    if (!Array.isArray(streamed.shards) || streamed.shards.length !== total) {
      throw new Error(`expected ${total} shards, got ${streamed.shards?.length}`);
    }

    const covered = [...streamed.shards.map((shard) => shard.index)].sort((left, right) => left - right);

    if (covered.some((value, position) => value !== position)) {
      throw new Error("shard indices must cover 0 through n-1");
    }

    const shardBytes = paddedLength / dataShards;

    if (!Number.isInteger(shardBytes) || shardBytes < 0) throw new Error("paddedLength is not divisible by k");

    for (const shard of streamed.shards) {
      if (!HEX_64.test(shard.root) || !HEX_64.test(shard.sha256)) {
        throw new Error(`shard ${shard.index} has a malformed digest`);
      }
      if (!Number.isInteger(shard.bytes) || shard.bytes !== shardBytes) {
        throw new Error(`shard ${shard.index} size does not match the padded length`);
      }
      if (!Number.isInteger(shard.leaves) || shard.leaves !== Math.max(1, Math.ceil(shard.bytes / SHARD_CHUNK_BYTES))) {
        throw new Error(`shard ${shard.index} leaf count is invalid`);
      }
      if (!Number.isInteger(statSync(shard.path).size) || statSync(shard.path).size !== shard.bytes) {
        throw new Error(`shard ${shard.index} file size does not match its record`);
      }
      if ((await sha256File(shard.path)) !== shard.sha256) {
        throw new Error(`shard ${shard.index} file does not match its sha256`);
      }
    }

    if (new Set(holders.map((holder) => holder.id)).size !== holders.length) {
      throw new Error("holder ids must be unique");
    }

    const required = requiredHolders(tier, { dataShards, parityShards });

    if (required > total) throw new Error(`${tier} needs ${required} shards but the code has ${total}`);
    if (holders.length < total) throw new Error(`need ${total} distinct holders, have ${holders.length}`);

    const ordered = [...holders].sort((left, right) => left.id.localeCompare(right.id));
    const offset = Number.parseInt(payloadDigest.slice(0, 8), 16) % ordered.length;
    const chosen = [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(0, total);

    const placement: Placement = {
      blobHash: payloadDigest,
      dataShards,
      parityShards,
      length,
      tier,
      required,
      shards: [],
      createdAt: new Date(this.now()).toISOString(),
      streamed: { version: 1, paddedLength, chunkBytes, chunks, chunkDigests: [...streamed.chunkDigests] },
      ...(options.sealed ? { sealed: options.sealed } : {}),
    };

    const witnesses = new Map<number, Witness>();

    for (const shard of streamed.shards) {
      const holder = chosen[shard.index]!;
      const storedAs = holder.putFile
        ? await holder.putFile(shard.path, shard.sha256)
        : await holder.put(Uint8Array.from(readFileSync(shard.path)));

      if (!HEX_64.test(storedAs)) {
        // Format only, deliberately NOT equality: `shard.sha256` is the
        // pre-repair digest, while the holder names the file after the bytes
        // it actually received — a rebuilt shard may differ from the record,
        // so asserting equality here would refuse honest repairs. The place
        // path (where the digest IS known before upload) does assert equality.
        throw new Error(`holder ${holder.id} returned an invalid storedAs`);
      }

      placement.shards.push({
        index: shard.index,
        holder: holder.id,
        digest: shard.sha256,
        storedAs,
        size: shard.bytes,
        leaves: shard.leaves,
        root: shard.root,
      });

      witnesses.set(shard.index, {
        holder: holder.id,
        lastSuccess: null,
        lastFailure: null,
        misses: 0,
      });
    }

    placement.shards.sort((left, right) => left.index - right.index);
    this.remember(payloadDigest, placement, witnesses);

    return placement;
  }

  /**
   * Download any k shards of a streamed placement to files, then reconstruct the
   * payload file. Shard downloads stream to disk and the decode reads 8 MiB
   * chunks, so peak memory follows the chunk size rather than the payload size.
   */
  async retrieveStreamed(
    placement: Placement,
    outputPath: string,
    holders: DurabilityHolder[],
    options: { workDir?: string; concurrency?: number } = {},
  ): Promise<{ bytes: number; sha256: string; downloaded: number }> {
    const meta = placement.streamed;
    if (!meta) throw new Error("this placement is not streamed");
    if (!meta.chunkDigests || meta.chunkDigests.length !== meta.chunks) {
      throw new Error("streamed metadata is incomplete");
    }

    const concurrency = options.concurrency ?? DEFAULT_RETRIEVAL_CONCURRENCY;

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("retrieval concurrency must be a positive integer");
    }

    const byId = new Map(holders.map((holder) => [holder.id, holder]));
    const working = options.workDir ?? mkdtempSync(join(tmpdir(), "rarext-streamed-"));
    const created = options.workDir === undefined;

    try {
      const { downloaded, failures } = await downloadShards(
        placement.shards,
        byId,
        working,
        placement.dataShards,
        concurrency,
      );

      if (downloaded.length < placement.dataShards) {
        const detail = failures.length > 0
          ? `; ${failures.slice(0, 4).join("; ")}${failures.length > 4 ? ` (+${failures.length - 4} more)` : ""}`
          : "";
        throw new Error(
          `need ${placement.dataShards} shard files, downloaded ${downloaded.length}${detail}`,
        );
      }

      const streamed: StreamedPlacement = {
        version: 1,
        payloadDigest: placement.blobHash,
        length: placement.length,
        paddedLength: meta.paddedLength,
        chunkBytes: meta.chunkBytes,
        chunks: meta.chunks,
        chunkDigests: meta.chunkDigests,
        dataShards: placement.dataShards,
        parityShards: placement.parityShards,
        shards: downloaded.map((entry) => {
          const shard = placement.shards.find((candidate) => candidate.index === entry.index)!;
          return {
            index: shard.index,
            path: entry.path,
            bytes: shard.size,
            leaves: shard.leaves,
            root: shard.root,
            sha256: shard.digest,
          };
        }),
      };

      const result = decodeShardsToFile({ placement: streamed, outputPath, available: downloaded });

      return { bytes: result.bytes, sha256: result.sha256, downloaded: downloaded.length };
    } finally {
      if (created) rmSync(working, { recursive: true, force: true });
    }
  }

  async challenge(
    blobHash: string,
    holders: DurabilityHolder[],
  ): Promise<ChallengeOutcome[]> {
    const placement = this.placements.get(blobHash);

    if (!placement) throw new Error(`unknown blob ${blobHash}`);

    const byId = new Map(holders.map((holder) => [holder.id, holder]));
    const witnesses = this.witnesses.get(blobHash)!;
    const now = this.now();
    const outcomes: ChallengeOutcome[] = [];

    for (const shard of placement.shards) {
      const witness = witnesses.get(shard.index)!;
      const holder = byId.get(shard.holder);

      if (!holder) {
        outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "holder-missing" });
        this.miss(witness, now);
        continue;
      }

      const leafIndex = this.random(shard.leaves);
      const nonce = randomBytesNode(16).toString("hex");
      const request = { storedAs: shard.storedAs, leafIndex, nonce };

      try {
        const response = await holder.respond(request);

        if (!response) {
          outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "shard-missing" });
          this.miss(witness, now);
          continue;
        }

        if (!verifyChallengeResponse(shard, response, request)) {
          outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "bad-proof" });
          this.miss(witness, now);
          continue;
        }
      } catch (error) {
        const reason =
          error instanceof HolderRejectedError ? "rejected" : "holder-missing";
        outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason });
        this.miss(witness, now);
        continue;
      }

      witness.lastSuccess = now;
      witness.lastFailure = null;
      witness.misses = 0;
      outcomes.push({ index: shard.index, holder: shard.holder, ok: true, reason: "ok" });
    }

    return outcomes;
  }

  private miss(witness: Witness, now: number): void {
    witness.lastFailure = now;
    witness.lastSuccess = null;
    witness.misses += 1;
  }

  audit(blobHash: string): DurabilityReport {
    const placement = this.placements.get(blobHash);

    if (!placement) throw new Error(`unknown blob ${blobHash}`);

    const witnesses = this.witnesses.get(blobHash)!;
    const now = this.now();

    const shards = placement.shards.map((shard) => {
      const witness = witnesses.get(shard.index)!;
      const fresh =
        witness.lastSuccess !== null && now - witness.lastSuccess <= this.windowMs;

      return {
        index: shard.index,
        holder: shard.holder,
        size: shard.size,
        ok: fresh,
        misses: witness.misses,
        lastSuccess:
          witness.lastSuccess === null
            ? null
            : new Date(witness.lastSuccess).toISOString(),
      };
    });

    const live = shards.filter((shard) => shard.ok).length;
    const challenged = shards.some(
      (shard) => shard.lastSuccess !== null || shard.misses > 0,
    );

    return {
      blobHash,
      tier: placement.tier,
      required: placement.required,
      live,
      challenged,
      status: live >= placement.required ? "ok" : "under-replicated",
      shards,
    };
  }

  /**
   * Rebuilds every shard that failed or is missing, from any k survivors, and
   * places it on a holder that does not already hold a shard of this blob. The
   * returned placement is the same object, updated.
   *
   * Only one repair runs at a time per blob: a concurrent caller joins the
   * in-flight repair instead of writing the same shard twice.
   */
  async repair(blobHash: string, holders: DurabilityHolder[]): Promise<RepairOutcome> {
    const inFlight = this.inFlightRepairs.get(blobHash);
    if (inFlight) return inFlight;

    const promise = this.repairNow(blobHash, holders).finally(() => {
      this.inFlightRepairs.delete(blobHash);
    });

    this.inFlightRepairs.set(blobHash, promise);
    return promise;
  }

  private async repairNow(blobHash: string, holders: DurabilityHolder[]): Promise<RepairOutcome> {
    const placement = this.placements.get(blobHash);

    if (!placement) throw new Error(`unknown blob ${blobHash}`);

    const witnesses = this.witnesses.get(blobHash)!;
    const byId = new Map(holders.map((holder) => [holder.id, holder]));
    const used = new Set(placement.shards.map((shard) => shard.holder));

    const degraded = new Set<number>();
    let missingHolder: { shard: ShardPlacement; holderId: string } | null = null;

    for (const shard of placement.shards) {
      const witness = witnesses.get(shard.index)!;
      const holder = byId.get(shard.holder);
      const failed =
        witness.lastFailure !== null &&
        (witness.lastSuccess === null || witness.lastFailure > witness.lastSuccess);

      let present = false;

      if (holder) {
        try {
          present = await holder.has(shard.storedAs);
        } catch {
          present = false;
        }
      }

      if (!holder || failed || !present) {
        degraded.add(shard.index);
        // A shard whose bytes are intact on a holder that is not in the caller's
        // list is a configuration problem, not just a loss. The operator has to
        // add the holder back, not wait for a spare to absorb the shard.
        if (!holder && !failed) {
          missingHolder ??= { shard, holderId: shard.holder };
        }
      }
    }

    if (degraded.size === 0) {
      // If no shards are degraded, the repair is complete (or unnecessary).
      // If no shards are degraded, the repair is complete (or unnecessary).
      // If no shards are degraded, the repair is complete (or unnecessary).
      return { filled: 0, readBytes: 0, writtenBytes: 0, placement };
    }

    if (missingHolder) {
      throw new Error(
        `cannot repair: holder ${missingHolder.holderId} for shard ${missingHolder.shard.index} is not configured`,
      );
    }

    const survivors = placement.shards.filter((shard) => !degraded.has(shard.index));

    if (survivors.length < placement.dataShards) {
      const survivingData = survivors.filter((shard) => shard.index < placement.dataShards).length;
      throw new Error(
        `cannot repair: only ${survivingData} of ${placement.dataShards} data shards survive`,
      );
    }

    const leaseExpiresAt = this.now() + this.repairLeaseMs;

    if (placement.streamed) {
      return await this.repairStreamed(
        placement,
        degraded,
        survivors,
        holders,
        byId,
        used,
        witnesses,
        leaseExpiresAt,
      );
    }

    // An MDS repair needs exactly k shards. If a survivor cannot be read
    // (a holder dropped out after the presence probe), try the next survivor
    // before failing. Corruption is different: those bytes were read, so they
    // still go to decode and fail loudly rather than being routed around.
    const survivorShards: ErasureShard[] = [];
    const unreadable: number[] = [];
    let readBytes = 0;

    for (const shard of survivors) {
      if (survivorShards.length >= placement.dataShards) break;

      this.assertRepairLease(blobHash, placement, leaseExpiresAt, "reading survivors");
      const holder = byId.get(shard.holder);

      if (!holder) {
        throw new Error(
          `cannot repair: holder ${shard.holder} for shard ${shard.index} is not configured`,
        );
      }

      let bytes: Uint8Array | null = null;

      try {
        bytes = await holder.get(shard.storedAs);
          } catch (error) {
            // If a holder fails during 'get', treat it as if the shard is not present.
            // Log the error for debugging. This might be a transient network issue
            // or a persistent problem with the holder.
            console.warn(`Holder ${holder.id} failed 'get' for shard ${shard.index}: ${error}`);
            bytes = null;
          }


      if (!bytes) {
        unreadable.push(shard.index);
        continue;
      }

      survivorShards.push({
        index: shard.index,
        dataShards: placement.dataShards,
        parityShards: placement.parityShards,
        length: placement.length,
        payloadDigest: placement.blobHash,
        bytes: Uint8Array.from(bytes),
        digest: shard.digest,
      });
      readBytes += bytes.length;
    }

    if (survivorShards.length < placement.dataShards) {
      const suffix =
        unreadable.length > 0
          ? `; unreadable survivor shards: ${unreadable.join(", ")}`
          : "";
      throw new Error(
        `cannot repair: read ${survivorShards.length} of ${placement.dataShards} survivor shards${suffix}`,
      );
    }

    const payload = decodeBytes(survivorShards);
    const reencoded = encodeBytes(payload, placement.dataShards, placement.parityShards);
    const probe = placement.shards[0]!.storedAs;
    const candidates = holders
      .filter((candidate) => !used.has(candidate.id))
      .sort((left, right) => left.id.localeCompare(right.id));

    // A configured holder may be offline. Probe before staging so an
    // unreachable spare is skipped instead of failing the whole repair.
    // `has` is read-only and content-addressed, so a holder that survived a
    // crash with the orphaned shard is still a valid candidate.
    const spare: DurabilityHolder[] = [];

    for (const candidate of candidates) {
      this.assertRepairLease(blobHash, placement, leaseExpiresAt, "probing spares");

      try {
        await candidate.has(probe);
        spare.push(candidate);
          } catch (error) {
            // Offline or refusing the read; leave it out of this repair.
            // Log the error for debugging purposes.
            console.warn(`Holder ${candidate.id} failed probe for repair: ${error}`);
          }

    }

    if (spare.length < degraded.size) {
      const reason =
        survivors.length < placement.dataShards
          ? `cannot repair: only ${survivors.length} of ${placement.dataShards} shards survive`
          : `no spare holder: ${degraded.size} shard(s) need repair and ${spare.length} holder(s) are free`;
      throw new Error(reason);
    }

    // Stage every write before touching the placement. A failed write, a full
    // spare, or a crash leaves the signed placement exactly as it was; a retry
    // is idempotent because the holder store is content-addressed. If a spare
    // rejects the write, try the next free holder instead of abandoning a
    // repair that has other viable targets.
    const staged: {
      index: number;
      holder: DurabilityHolder;
      storedAs: string;
      bytes: Uint8Array;
      leaves: string[];
    }[] = [];
    const assigned = new Set<string>();
    const unusable = new Set<string>();

    for (const index of [...degraded].sort((left, right) => left - right)) {
      this.assertRepairLease(blobHash, placement, leaseExpiresAt, "staging writes");
      const bytes = reencoded.find((shard) => shard.index === index)!.bytes;
      let lastError: unknown = null;
      let written = false;

      for (const holder of spare) {
        if (assigned.has(holder.id) || unusable.has(holder.id)) continue;

        try {
          const storedAs = await holder.put(bytes);
          const expected = sha256Bytes(bytes);
          if (storedAs !== expected) {
            throw new Error(`holder ${holder.id} returned a lying storedAs: expected ${expected}, got ${storedAs}`);
          }
          staged.push({
            index,
            holder,
            storedAs,
            bytes,
            leaves: chunkLeaves(bytes),
          });
          assigned.add(holder.id);
          lastError = null;
          written = true;
          break;
        } catch (error) {
          lastError = error;
          unusable.add(holder.id);
        }
      }

      if (!written) {
        throw new Error(
          `repair write failed for shard ${index}: no spare holder accepted it (${
            lastError instanceof Error ? lastError.message : String(lastError)
          })`,
        );
      }
    }

    this.assertRepairLease(blobHash, placement, leaseExpiresAt, "commit");
    let writtenBytes = 0;

    for (const entry of staged) {
      const target = placement.shards.find((shard) => shard.index === entry.index)!;

      target.holder = entry.holder.id;
      target.storedAs = entry.storedAs;
      target.size = entry.bytes.length;
      target.leaves = entry.leaves.length;
      target.root = merkleRoot(entry.leaves);

      witnesses.set(entry.index, {
        holder: entry.holder.id,
        lastSuccess: null,
        lastFailure: null,
        misses: 0,
      });

      used.add(entry.holder.id);
      writtenBytes += entry.bytes.length;
    }

    return { filled: staged.length, readBytes, writtenBytes, placement };
  }

  private async repairStreamed(
    placement: Placement,
    degraded: Set<number>,
    survivors: ShardPlacement[],
    holders: DurabilityHolder[],
    byId: Map<string, DurabilityHolder>,
    used: Set<string>,
    witnesses: Map<number, Witness>,
    leaseExpiresAt: number,
  ): Promise<RepairOutcome> {
    const meta = placement.streamed!;
    const working = mkdtempSync(join(tmpdir(), "rarext-repair-streamed-"));
    const blobHash = placement.blobHash;

    try {
      const available: { index: number; path: string }[] = [];
      let readBytes = 0;

      for (const shard of survivors) {
        if (available.length >= placement.dataShards) break;

        this.assertRepairLease(blobHash, placement, leaseExpiresAt, "downloading survivors");
        const holder = byId.get(shard.holder);

        if (!holder) {
          throw new Error(
            `cannot repair streamed placement: holder ${shard.holder} for shard ${shard.index} is not configured`,
          );
        }

        const path = join(working, `${shard.index}-${shard.storedAs}`);

        try {
          const ok = holder.getFile
            ? await holder.getFile(shard.storedAs, path)
            : await (async () => {
              const bytes = await holder.get(shard.storedAs);
              if (!bytes) return false;
              writeFileSync(path, bytes);
              return true;
            })();

          if (ok) {
            available.push({ index: shard.index, path });
            readBytes += statSync(path).size;
          }
        } catch {
          rmSync(path, { force: true });
        }
      }

      if (available.length < placement.dataShards) {
        throw new Error(
          `cannot repair streamed placement: downloaded ${available.length} of ${placement.dataShards} survivor shards`,
        );
      }

      const probe = placement.shards[0]!.storedAs;
      const candidates = holders
        .filter((candidate) => !used.has(candidate.id))
        .sort((left, right) => left.id.localeCompare(right.id));
      const spare: DurabilityHolder[] = [];

      for (const candidate of candidates) {
        this.assertRepairLease(blobHash, placement, leaseExpiresAt, "probing spares");

        try {
          await candidate.has(probe);
          spare.push(candidate);
          } catch (error) {
            // Offline or refusing the read; leave it out of this repair.
            // Log the error for debugging purposes.
            console.warn(`Holder ${candidate.id} failed probe for repair: ${error}`);
          }

      }

      if (spare.length < degraded.size) {
        const reason =
          available.length < placement.dataShards
            ? `cannot repair streamed placement: only ${available.length} of ${placement.dataShards} shards survive`
            : `no spare holder: ${degraded.size} shard(s) need repair and ${spare.length} holder(s) are free`;
        throw new Error(reason);
      }

      const rebuilt: {
        index: number;
        holder: DurabilityHolder;
        storedAs: string;
        size: number;
        leaves: number;
        root: string;
        digest: string;
      }[] = [];

      const assigned = new Set<string>();
      const unusable = new Set<string>();

      for (const index of [...degraded].sort((left, right) => left - right)) {
        this.assertRepairLease(blobHash, placement, leaseExpiresAt, "rebuilding shards");
        const target = placement.shards.find((shard) => shard.index === index)!;
        const path = join(working, `rebuilt-${index}`);
        const rebuiltShard = reencodeStreamedShard({
          placement: {
            version: 1,
            payloadDigest: placement.blobHash,
            length: placement.length,
            paddedLength: meta.paddedLength,
            chunkBytes: meta.chunkBytes,
            chunks: meta.chunks,
            chunkDigests: meta.chunkDigests,
            dataShards: placement.dataShards,
            parityShards: placement.parityShards,
            shards: placement.shards.map((shard) => ({
              index: shard.index,
              path: "",
              bytes: shard.size,
              leaves: shard.leaves,
              root: shard.root,
              sha256: shard.digest,
            })),
          },
          targetIndex: index,
          available,
          outputPath: path,
        });

        if (rebuiltShard.bytes !== target.size) {
          throw new Error(`rebuilt shard ${index} has the wrong size`);
        }
        if (rebuiltShard.sha256 !== target.digest) {
          throw new Error(`rebuilt shard ${index} does not match the signed digest`);
        }

        let storedAs: string | null = null;
        let lastError: unknown = null;

        for (const holder of spare) {
          if (assigned.has(holder.id) || unusable.has(holder.id)) continue;
          this.assertRepairLease(blobHash, placement, leaseExpiresAt, "writing shards");

          try {
            const uploaded = holder.putFile
              ? await holder.putFile(path, rebuiltShard.sha256)
              : await holder.put(Uint8Array.from(readFileSync(path)));
            if (uploaded !== rebuiltShard.sha256) {
              throw new Error(`holder ${holder.id} returned a lying storedAs: expected ${rebuiltShard.sha256}, got ${uploaded}`);
            }
            storedAs = uploaded;
            assigned.add(holder.id);
            rebuilt.push({
              index,
              holder,
              storedAs: uploaded,
              size: rebuiltShard.bytes,
              leaves: rebuiltShard.leaves,
              root: rebuiltShard.root,
              digest: rebuiltShard.sha256,
            });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            storedAs = null;
            unusable.add(holder.id);
          }
        }

        if (storedAs === null || lastError !== null) {
          throw new Error(
            `repair write failed for shard ${index}: no spare holder accepted it (${
              lastError instanceof Error ? lastError.message : String(lastError)
            })`,
          );
        }
      }

      this.assertRepairLease(blobHash, placement, leaseExpiresAt, "commit");
      let writtenBytes = 0;

      for (const entry of rebuilt) {
        const target = placement.shards.find((shard) => shard.index === entry.index)!;
        target.holder = entry.holder.id;
        target.storedAs = entry.storedAs;
        target.size = entry.size;
        target.leaves = entry.leaves;
        target.root = entry.root;
        target.digest = entry.digest;

        witnesses.set(entry.index, {
          holder: entry.holder.id,
          lastSuccess: null,
          lastFailure: null,
          misses: 0,
        });

        used.add(entry.holder.id);
        writtenBytes += entry.size;
      }

      return { filled: rebuilt.length, readBytes, writtenBytes, placement };
    } finally {
      rmSync(working, { recursive: true, force: true });
    }
  }

  /**
   * Collects all shard hashes referenced by placements in this ledger.
   * Returns a map from holder id to array of storedAs hashes.
   */
  referencedShardsByHolder(): Map<string, string[]> {
    const map = new Map<string, string[]>();

    for (const placement of this.placements.values()) {
      for (const shard of placement.shards) {
        const arr = map.get(shard.holder) ?? [];
        arr.push(shard.storedAs);
        map.set(shard.holder, arr);
      }
    }

    return map;
  }

  /**
   * Runs garbage collection on all configured holders.
   *
   * @param holderUrls - Map from holder id to base URL (e.g., "http://host:port")
   * @param options - GC options
   */
  async gcWithUrls(
    holderUrls: Map<string, string>,
    options: { gracePeriodMs?: number; dryRun?: boolean; fetch?: typeof fetch; token?: string } = {},
  ): Promise<GcResult[]> {
    const referenced = this.referencedShardsByHolder();
    const results: GcResult[] = [];
    const callFetch = options.fetch ?? fetch;
    const token = options.token;
    const gracePeriodMs = options.gracePeriodMs ?? 24 * 60 * 60 * 1000;
    const dryRun = options.dryRun ?? true;

    for (const [holderId, baseUrl] of holderUrls) {
      const hashes = referenced.get(holderId) ?? [];

      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;

        const resp = await callFetch(`${baseUrl.replace(/\/+$/, "")}/v1/holder/gc/scan`, {
          method: "POST",
          headers,
          body: JSON.stringify({ referenced: hashes, gracePeriodMs, dryRun }),
          signal: AbortSignal.timeout(30_000),
        });

        const data = await resp.json() as GcScanResponse & { error?: string };

        if (!resp.ok) {
          results.push({
            holder: holderId,
            error: data.error ?? `holder GC failed with status ${resp.status}`,
          } as GcResult);
          continue;
        }

        results.push(data);
      } catch (error) {
        results.push({
          holder: holderId,
          error: error instanceof Error ? error.message : "GC failed",
        } as GcResult);
      }
    }

    return results;
  }
}

export interface GcScanResponse {
  holder: string;
  scanned: number;
  referenced: number;
  candidates: number;
  deleted: number;
  /** Shards skipped this pass because a reader still had them open. */
  deferred?: number;
  deferredShards?: string[];
  /** Stale `*.tmp` files left by an interrupted write that this pass removed. */
  purgedTemp?: number;
  wouldDelete: string[];
  dryRun: boolean;
  gracePeriodMs: number;
  error?: string;
}

export interface GcResult extends GcScanResponse {}
