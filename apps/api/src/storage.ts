import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export const STORAGE_TIERS: StorageTier[] = ["public", "sealed"];

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

export class BlobStore {
  readonly directory: string;
  private readonly records = new Map<string, BlobRecord>();

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(this.directory, { recursive: true });
    this.load();
  }

  private path(hash: string): string {
    return join(this.directory, hash);
  }

  private indexPath(): string {
    return join(this.directory, "_index.json");
  }

  private load(): void {
    if (!existsSync(this.directory)) return;

    for (const name of readdirSync(this.directory)) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;

      const bytes = readFileSync(this.path(name));
      if (sha256Bytes(bytes) !== name) continue;

      this.records.set(name, {
        hash: name,
        size: bytes.length,
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
      const saved = JSON.parse(readFileSync(indexPath, "utf8")) as BlobRecord[];

      for (const record of saved) {
        if (!this.records.has(record.hash)) continue;
        this.records.set(record.hash, record);
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

    try {
      this.saveIndex();
    } catch (error) {
      if (created) rmSync(this.path(hash), { force: true });
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
    const hash = blobHash(bytes);
    const target = this.path(hash);
    const created = !existsSync(target);

    if (created) {
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

    if (Date.now() < Date.parse(record.retentionUntil)) return null;

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

    const matured = Boolean(
      record.retentionUntil && Date.now() >= Date.parse(record.retentionUntil),
    );

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
    return this.get(hash) !== null;
  }

  list(): BlobRecord[] {
    return [...this.records.values()].sort((a, b) => a.hash.localeCompare(b.hash));
  }

  remove(hash: string): boolean {
    const record = this.records.get(hash);
    if (!record) return false;

    rmSync(this.path(hash), { force: true });
    this.records.delete(hash);
    this.saveIndex();
    return true;
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
      };

      entry.blobs += 1;
      entry.bytes += record.size;
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
