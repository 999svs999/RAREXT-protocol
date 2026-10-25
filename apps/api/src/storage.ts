import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  BlobRecord,
  StorageInclusionProof,
  StorageManifest,
  StorageManifestEntry,
  StorageTier,
  StorageUsage,
} from "../../../packages/core/src/index.ts";

import { merkleProof, merkleRoot, verifyProof } from "./merkle.ts";
import { STORAGE_RENT_MONTH_MS } from "./storage-rent.ts";

export const STORAGE_TIERS: StorageTier[] = ["public", "sealed"];

/**
 * The hard cap on a single blob. Larger payloads must be split across
 * multiple blobs. The MCP put path uses its own smaller default
 * (`RAREXT_STORAGE_MAX_BYTES`, 8 MiB) for the base64 JSON encoding, but
 * this cap bounds the underlying store in every code path.
 */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const LOAD_HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Hash a file for startup adoption without reading it into memory. Holder
 * shards can be up to 8 GiB, so `readFileSync` here would exhaust the heap;
 * a fixed 1 MiB buffer bounds the cost. Non-regular files (a directory left
 * under a 64-hex name) and entries that disappear mid-read are skipped.
 */
function digestFile(path: string): { hash: string; size: number } | null {
  let fd: number;

  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }

  try {
    if (!fstatSync(fd).isFile()) return null;

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(LOAD_HASH_CHUNK_BYTES);
    let size = 0;

    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);

      if (read === 0) break;

      hash.update(buffer.subarray(0, read));
      size += read;
    }

    return { hash: hash.digest("hex"), size };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a retention term has matured. A timestamp the node cannot parse is
 * treated as still live: a corrupt record must not release the opening early
 * or let cleanup delete bytes the node may have promised to keep.
 */
function retentionMatured(record: BlobRecord, now: number): boolean {
  // Legacy records may have no field at all; an empty or malformed string is a
  // present-but-unusable term and must fail closed.
  if (record.retentionUntil == null) return true;

  const until = Date.parse(record.retentionUntil);
  if (!Number.isFinite(until)) return false;

  return now >= until;
}

export function blobHash(bytes: Uint8Array): string {
  return sha256Bytes(bytes);
}

/**
 * The leaf for one manifest entry. It binds the bytes' hash together with the
 * terms the manifest claims for them, so a proof of inclusion proves the storage
 * terms as well as the content.
 */
export function manifestLeaf(entry: StorageManifestEntry): string {
  return createHash("sha256")
    .update(
      canonicalize({
        hash: entry.hash,
        size: entry.size,
        tier: entry.tier,
        sealed: entry.sealed,
        retentionUntil: entry.retentionUntil,
      }),
    )
    .digest("hex");
}

export function manifestLeaves(manifest: StorageManifest): string[] {
  return manifest.blobs.map(manifestLeaf);
}

export function manifestRoot(manifest: StorageManifest): string {
  return merkleRoot(manifestLeaves(manifest));
}

export function manifestInclusion(
  manifest: StorageManifest,
  hash: string,
): { index: number; leaf: string; proof: string[]; root: string } | null {
  const index = manifest.blobs.findIndex((entry) => entry.hash === hash);
  if (index === -1) return null;

  const leaves = manifestLeaves(manifest);

  return {
    index,
    leaf: leaves[index]!,
    proof: merkleProof(leaves, index),
    root: manifestRoot(manifest),
  };
}

export function verifyManifestInclusion(
  manifest: StorageManifest,
  hash: string,
  proof: string[],
  root: string,
): boolean {
  const index = manifest.blobs.findIndex((entry) => entry.hash === hash);
  if (index === -1) return false;

  return verifyProof(manifestLeaves(manifest)[index]!, proof, root, index);
}

function isTier(value: unknown): value is StorageTier {
  return value === "public" || value === "sealed";
}

export function asManifest(value: unknown): StorageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("storage manifest must be an object");
  }

  const record = value as { policy?: unknown; blobs?: unknown };
  const list = Array.isArray(record.blobs) ? record.blobs : [];

  const blobs = list.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("manifest entries must be objects");
    }

    const entry = item as Record<string, unknown>;

    if (typeof entry.hash !== "string" || !/^[0-9a-f]{64}$/.test(entry.hash)) {
      throw new Error("manifest entry hash must be a sha256 hex digest");
    }

    if (!isTier(entry.tier)) {
      throw new Error("manifest entry tier must be public or sealed");
    }

    return {
      hash: entry.hash,
      size: typeof entry.size === "number" ? entry.size : 0,
      tier: entry.tier,
      sealed: entry.sealed === true,
      retentionUntil:
        typeof entry.retentionUntil === "string" ? entry.retentionUntil : null,
    };
  });

  return {
    policy: typeof record.policy === "string" ? record.policy : "storage-v1",
    blobs,
  };
}

/**
 * A content-addressed blob store.
 *
 * Bytes are written to a file named after their own hash, so a mirror can copy
 * the directory and every name is self-verifying. Writes are atomic: the file
 * lands under a temporary name and is renamed into place.
 */
/**
 * A retention commitment: the node binds itself to holding a blob until a
 * time, by committing to a secret it will only reveal once the term matures.
 *
 * The commitment is published in a manifest, and the manifest is anchored, so the
 * commitment is timestamped. The opening comes later, and the claim of retention
 * needs both: the earlier commitment and a possession attestation after the term
 * matured. Deleting the blob early breaks the second half, and the opening is
 * useless without the first.
 */
export function retentionCommitment(
  secret: string,
  hash: string,
  retentionUntil: string,
): string {
  return sha256Bytes(
    Buffer.from(
      `${secret}:${canonicalize({ hash, retentionUntil })}`,
      "utf8",
    ),
  );
}

export function manifestEntry(
  record: BlobRecord,
  opening: string | null = null,
): StorageManifestEntry {
  return {
    hash: record.hash,
    size: record.size,
    tier: record.tier,
    sealed: record.sealed,
    retentionUntil: record.retentionUntil,
    retentionCommitment: record.retentionCommitment,
    retentionOpening: opening,
  };
}

export class BlobQuotaError extends Error {
  readonly status = 507;
  readonly limit: number;

  constructor(limit: number) {
    super(`insufficient storage: node byte quota exceeded (${limit} bytes)`);
    this.name = "BlobQuotaError";
    this.limit = limit;
  }
}

export class BlobStore {
  readonly directory: string;
  /**
   * Hard cap on the size of one blob. The JSON `POST /v1/blobs` path cannot
   * carry a base64 body larger than `MAX_BODY_BYTES` anyway, but callers that
   * use `put()` directly can. The cap bounds per-blob memory and disk.
   */
  readonly maxBytes: number;
  /** Cap on all stored bytes, or null when the node is unmetered. */
  readonly maxTotalBytes: number | null;
  private readonly records = new Map<string, BlobRecord>();
  private bytes = 0;

  constructor(directory: string, options: { maxBytes?: number; maxTotalBytes?: number } = {}) {
    const maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? null;

    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive number");
    }
    if (maxTotalBytes !== null && (!Number.isFinite(maxTotalBytes) || maxTotalBytes < 0)) {
      throw new Error("maxTotalBytes must be a non-negative number");
    }

    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxTotalBytes = maxTotalBytes;
    mkdirSync(this.directory, { recursive: true });
    this.load();
    this.bytes = [...this.records.values()].reduce((sum, record) => sum + record.size, 0);
  }

  totalBytes(): number {
    return this.bytes;
  }

  private checkQuota(size: number): void {
    if (this.maxTotalBytes === null) return;
    if (this.totalBytes() + size <= this.maxTotalBytes) return;

    throw new BlobQuotaError(this.maxTotalBytes);
  }

  private path(hash: string): string {
    return join(this.directory, hash);
  }

  private indexPath(): string {
    return join(this.directory, "_index.json");
  }

  private load(): void {
    if (!existsSync(this.directory)) return;

    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      // Only regular files (or symlinks to them) are shards. A directory,
      // FIFO, or device under a digest-shaped name is ignored rather than
      // opened, which would block or crash startup.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const name = entry.name;
      if (!/^[0-9a-f]{64}$/.test(name)) continue;

      if (entry.isSymbolicLink()) {
        try {
          if (!statSync(this.path(name)).isFile()) continue;
        } catch {
          continue;
        }
      }

      const digest = digestFile(this.path(name));
      if (!digest || digest.hash !== name) continue;

      this.records.set(name, {
        hash: name,
        size: digest.size,
        mediaType: "application/octet-stream",
        tier: "public",
        sealed: false,
        createdAt: new Date().toISOString(),
        retentionUntil: null,
        retentionCommitment: null,
        retentionSecret: null,
      });
    }

    const indexPath = this.indexPath();
    if (!existsSync(indexPath)) return;

    try {
      const saved = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
      if (!Array.isArray(saved)) return;

      for (const value of saved) {
        if (typeof value !== "object" || value === null) continue;

        const record = value as BlobRecord;
        const current = this.records.get(record.hash);
        if (!current || typeof record.hash !== "string") continue;

        // The bytes on disk decide the size; the index may only enrich
        // metadata. A stale or edited index must not corrupt quota accounting.
        this.records.set(record.hash, { ...record, hash: record.hash, size: current.size });
      }
    } catch {
      return;
    }
  }

  private saveIndex(): void {
    const target = this.indexPath();
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;

    try {
      writeFileSync(temporary, JSON.stringify([...this.records.values()], null, 2));
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private store(
    hash: string,
    size: number,
    options: {
      mediaType?: string;
      tier?: StorageTier;
      sealed?: boolean;
      retentionUntil?: string | null;
    },
    created: boolean,
  ): BlobRecord {
    const existing = this.records.get(hash);
    const retentionUntil = options.retentionUntil ?? existing?.retentionUntil ?? null;

    let secret = existing?.retentionSecret ?? null;
    let commitment = existing?.retentionCommitment ?? null;

    if (retentionUntil && !commitment) {
      secret = randomBytes(32).toString("base64url");
      commitment = retentionCommitment(secret, hash, retentionUntil);
    }

    const record: BlobRecord = {
      hash,
      size,
      mediaType: options.mediaType ?? existing?.mediaType ?? "application/octet-stream",
      tier: options.tier ?? existing?.tier ?? "public",
      sealed: options.sealed ?? existing?.sealed ?? false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      retentionUntil,
      retentionCommitment: commitment,
      retentionSecret: secret,
    };

    this.records.set(hash, record);
    this.bytes += size - (existing?.size ?? 0);

    try {
      this.saveIndex();
    } catch (error) {
      if (created) rmSync(this.path(hash), { force: true });
      this.bytes -= size - (existing?.size ?? 0);

      if (existing) this.records.set(hash, existing);
      else this.records.delete(hash);

      throw error;
    }

    return record;
  }

  put(
    bytes: Uint8Array,
    options: {
      mediaType?: string;
      tier?: StorageTier;
      sealed?: boolean;
      retentionUntil?: string | null;
    } = {},
  ): BlobRecord {
    if (bytes.length > this.maxBytes) {
      throw new Error(`blob is ${bytes.length} bytes, above the ${this.maxBytes} byte cap`);
    }
    const hash = blobHash(bytes);
    const target = this.path(hash);
    const created = !existsSync(target);

    if (created) {
      this.checkQuota(bytes.length);
      const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;

      try {
        writeFileSync(temporary, bytes);
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    }

    return this.store(hash, bytes.length, options, created);
  }

  /**
   * Adopt a file whose bytes were streamed elsewhere and already hashed.
   * The caller must have verified that `hash` is the SHA-256 of `sourcePath`.
   */
  putFile(
    sourcePath: string,
    hash: string,
    size: number,
    options: {
      mediaType?: string;
      tier?: StorageTier;
      sealed?: boolean;
      retentionUntil?: string | null;
    } = {},
  ): BlobRecord {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("hash must be a sha256 hex digest");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("size must be a non-negative integer");

    const target = this.path(hash);
    const created = !existsSync(target);

    if (created) {
      this.checkQuota(size);
      renameSync(sourcePath, target);
    } else {
      rmSync(sourcePath, { force: true });
    }

    return this.store(hash, size, options, created);
  }

  /** The on-disk path for a shard, without reading its bytes. */
  filePath(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;

    const target = this.path(hash);
    return existsSync(target) ? target : null;
  }

  /**
   * The opening for a retention commitment. It is only released once the term
   * has matured, so a node cannot publish an opening early and pass it off as a
   * retention proof.
   */
  opening(hash: string): { opening: string; commitment: string; retentionUntil: string } | null {
    const record = this.records.get(hash);
    if (!record?.retentionSecret || !record.retentionCommitment || !record.retentionUntil) {
      return null;
    }

    if (!retentionMatured(record, Date.now())) return null;

    return {
      opening: record.retentionSecret,
      commitment: record.retentionCommitment,
      retentionUntil: record.retentionUntil,
    };
  }

  /**
   * The state of a retention term. The commitment is public from the start; the
   * opening only becomes available once the term has matured.
   */
  retention(hash: string): {
    hash: string;
    retentionUntil: string | null;
    commitment: string | null;
    matured: boolean;
    opening: string | null;
  } | null {
    const record = this.records.get(hash);
    if (!record) return null;

    const matured =
      record.retentionUntil != null && retentionMatured(record, Date.now());

    return {
      hash,
      retentionUntil: record.retentionUntil,
      commitment: record.retentionCommitment,
      matured,
      opening: matured ? record.retentionSecret : null,
    };
  }

  get(hash: string): { record: BlobRecord; bytes: Buffer } | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;

    const target = this.path(hash);
    if (!existsSync(target)) return null;

    const bytes = readFileSync(target);
    if (sha256Bytes(bytes) !== hash) return null;

    const record = this.records.get(hash) ?? {
      hash,
      size: bytes.length,
      mediaType: "application/octet-stream",
      tier: "public" as StorageTier,
      sealed: false,
      createdAt: new Date().toISOString(),
      retentionUntil: null,
      retentionCommitment: null,
      retentionSecret: null,
    };

    return { record, bytes };
  }

  has(hash: string): boolean {
    return this.filePath(hash) !== null;
  }

  list(): BlobRecord[] {
    return [...this.records.values()].sort((a, b) => a.hash.localeCompare(b.hash));
  }

  remove(hash: string): boolean {
    const record = this.records.get(hash);
    if (!record) return false;

    // A retention commitment binds the node to holding the blob until the term
    // matures. Refuse to collect it early, so orphan cleanup cannot break a
    // promise the node published and anchored. Once the term matures the
    // opening is released and the blob is ordinary garbage.
    if (!retentionMatured(record, Date.now())) return false;

    this.deleteFile(hash);
    this.saveIndex();
    return true;
  }

  private deleteFile(hash: string): void {
    const record = this.records.get(hash);

    rmSync(this.path(hash), { force: true });
    this.records.delete(hash);
    if (record) this.bytes = Math.max(0, this.bytes - record.size);
  }

  /**
   * Collect blobs the caller does not reference. A blob whose retention term
   * has not matured is held even when unreferenced: the node promised to keep
   * it. Collection is opt-in (`dryRun` defaults to true) and honours a grace
   * period so an operator can inspect candidates first.
   *
   * The scan, candidate save, and delete section is synchronous, so two calls
   * from the same process cannot interleave.
   */
  gc(options: {
    referenced: Iterable<string>;
    gracePeriodMs?: number;
    dryRun?: boolean;
    now?: number;
  }): {
    scanned: number;
    referenced: number;
    held: number;
    candidates: number;
    deleted: number;
    purgedTemp: number;
    wouldDelete: string[];
    dryRun: boolean;
    gracePeriodMs: number;
  } {
    const referenced = new Set(
      [...options.referenced].filter((hash) => /^[0-9a-f]{64}$/.test(hash)),
    );
    const gracePeriodMs = options.gracePeriodMs ?? 24 * 60 * 60 * 1000;
    const dryRun = options.dryRun !== false;
    const now = options.now ?? Date.now();
    const candidates = this.loadGcCandidates();
    const wouldDelete: string[] = [];
    const scanned = this.records.size;
    let held = 0;
    let referencedCount = 0;

    for (const record of this.records.values()) {
      if (referenced.has(record.hash)) {
        referencedCount += 1;
        candidates.delete(record.hash);
        continue;
      }

      if (record.retentionUntil != null && !retentionMatured(record, now)) {
        held += 1;
        candidates.delete(record.hash);
        continue;
      }

      const existing = candidates.get(record.hash);
      if (!existing) {
        candidates.set(record.hash, { hash: record.hash, firstSeen: now });
        if (gracePeriodMs === 0) wouldDelete.push(record.hash);
      } else if (now - existing.firstSeen >= gracePeriodMs) {
        wouldDelete.push(record.hash);
      }
    }

    // A candidate for bytes that were removed by hand or by an earlier pass
    // would otherwise stay in the file forever.
    for (const hash of [...candidates.keys()]) {
      if (!this.records.has(hash)) candidates.delete(hash);
    }

    let deleted = 0;
    if (!dryRun) {
      for (const hash of wouldDelete) {
        if (!this.records.has(hash)) continue;
        this.deleteFile(hash);
        candidates.delete(hash);
        deleted += 1;
      }
      if (deleted > 0) this.saveIndex();
    }

    this.saveGcCandidates(candidates);

    return {
      scanned,
      referenced: referencedCount,
      held,
      candidates: candidates.size,
      deleted,
      purgedTemp: this.purgeTempFiles(),
      wouldDelete,
      dryRun,
      gracePeriodMs,
    };
  }

  private gcCandidatesPath(): string {
    return join(this.directory, "_blob-gc-candidates.json");
  }

  private loadGcCandidates(): Map<string, { hash: string; firstSeen: number }> {
    const path = this.gcCandidatesPath();
    if (!existsSync(path)) return new Map();

    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        hash?: unknown;
        firstSeen?: unknown;
      }[];
      const candidates = new Map<string, { hash: string; firstSeen: number }>();

      for (const entry of parsed) {
        if (
          typeof entry.hash === "string" &&
          /^[0-9a-f]{64}$/.test(entry.hash) &&
          typeof entry.firstSeen === "number" &&
          Number.isFinite(entry.firstSeen)
        ) {
          candidates.set(entry.hash, { hash: entry.hash, firstSeen: entry.firstSeen });
        }
      }

      return candidates;
    } catch {
      return new Map();
    }
  }

  private saveGcCandidates(candidates: Map<string, { hash: string; firstSeen: number }>): void {
    const path = this.gcCandidatesPath();
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;

    try {
      writeFileSync(temporary, JSON.stringify([...candidates.values()], null, 2));
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /**
   * Remove `*.tmp` leftovers from an interrupted write or index save. A blob
   * file is named only by its 64-hex hash, so a temp file is never a blob.
   */
  private purgeTempFiles(): number {
    let removed = 0;

    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      const name = entry.name;

      // Sweep only regular temp files: a directory ending in `.tmp` is not an
      // interrupted write and is never removed recursively.
      if (!entry.isFile() || !name.endsWith(".tmp")) continue;

      try {
        rmSync(join(this.directory, name), { force: true });
        removed += 1;
      } catch {
        // Another handle still holds it; leave it for the next sweep.
      }
    }

    return removed;
  }

  /**
   * Metered usage per tier. This is the accounting a settlement layer would
   * price: bytes, blob count, and how long the bytes are committed for.
   */
  usage(): StorageUsage[] {
    const totals = new Map<StorageTier, StorageUsage>();

    for (const record of this.records.values()) {
      const entry = totals.get(record.tier) ?? {
        tier: record.tier,
        blobs: 0,
        bytes: 0,
        retainedUntil: null,
        committedByteMonths: 0,
      };

      entry.blobs += 1;
      entry.bytes += record.size;

      if (record.retentionUntil) {
        const createdAt = Date.parse(record.createdAt);
        const until = Date.parse(record.retentionUntil);

        if (Number.isFinite(createdAt) && Number.isFinite(until) && until > createdAt) {
          entry.committedByteMonths +=
            (record.size * (until - createdAt)) / STORAGE_RENT_MONTH_MS;

          if (
            entry.retainedUntil === null ||
            Date.parse(entry.retainedUntil) < until
          ) {
            entry.retainedUntil = record.retentionUntil;
          }
        }
      }

      totals.set(record.tier, entry);
    }

    return [...totals.values()].sort((a, b) => a.tier.localeCompare(b.tier));
  }
}

export function emptyInclusionProof(hash: string): StorageInclusionProof {
  return {
    hash,
    index: -1,
    leaf: "",
    proof: [],
    root: "",
    manifestId: null,
    anchorId: null,
    anchorRoot: null,
    valid: false,
  };
}
