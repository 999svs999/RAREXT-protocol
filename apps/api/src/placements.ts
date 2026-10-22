import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalize,
  type JsonWebKey,
  type SignatureSuite,
} from "../../../packages/core/src/index.ts";
import {
  type DurabilityTier,
  type Placement,
  requiredHolders,
} from "./durability.ts";
import { suiteFor, verifyPayload } from "./identity.ts";

export const PLACEMENT_KIND = "rarext.placement";

export interface PlacementSigner {
  publicKey: unknown;
  keyId: string;
  suite: SignatureSuite;
  sign(payload: unknown): string;
}

export interface PlacementRecord {
  kind: typeof PLACEMENT_KIND;
  version: 1;
  sequence: number;
  previous: string | null;
  steward: {
    keyId: string;
    publicKey: JsonWebKey;
    algorithm: SignatureSuite;
  };
  placement: Placement;
  createdAt: string;
}

export interface SignedPlacement {
  record: PlacementRecord;
  signature: string;
}

export interface PlacementSummary {
  blobHash: string;
  sequence: number;
  tier: DurabilityTier;
  holders: number;
  required: number;
  createdAt: string;
}

const HASH = /^[0-9a-f]{64}$/;
const TIERS: DurabilityTier[] = ["ephemeral", "pinned", "durable"];

function publicKeyId(publicKey: JsonWebKey): string {
  return createHash("sha256").update(canonicalize(publicKey)).digest("hex");
}

export function recordDigest(record: PlacementRecord): string {
  return createHash("sha256").update(canonicalize(record)).digest("hex");
}

function placementProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") return "placement must be an object";

  const placement = value as Placement;

  if (!HASH.test(placement.blobHash)) return "blobHash must be a sha256 hex digest";
  if (!Number.isInteger(placement.dataShards) || placement.dataShards < 1) return "dataShards must be at least 1";
  if (!Number.isInteger(placement.parityShards) || placement.parityShards < 0) return "parityShards must be at least 0";
  if (!TIERS.includes(placement.tier)) return "tier is not recognised";
  if (!Array.isArray(placement.shards) || placement.shards.length !== placement.dataShards + placement.parityShards) {
    return "shards must contain exactly k + m entries";
  }

  const indices = new Set<number>();

  for (const shard of placement.shards) {
    if (!Number.isInteger(shard.index) || shard.index < 0 || shard.index >= placement.dataShards + placement.parityShards) {
      return "shard index is out of range";
    }

    if (indices.has(shard.index)) return "shard indices must be unique";

    indices.add(shard.index);

    if (typeof shard.holder !== "string" || shard.holder.length === 0) {
      return "every shard needs a holder id";
    }

    if (!HASH.test(shard.digest) || !HASH.test(shard.storedAs) || !HASH.test(shard.root)) {
      return "shard digests must be sha256 hex values";
    }

    if (!Number.isInteger(shard.size) || shard.size < 0) return "shard size is invalid";
    if (!Number.isInteger(shard.leaves) || shard.leaves < 1) return "shard leaves must be at least 1";
  }

  if (placement.required !== requiredHolders(placement.tier, placement)) {
    return "required does not match the tier";
  }

  return null;
}

export function signPlacement(
  placement: Placement,
  signer: PlacementSigner,
  previous: SignedPlacement | null = null,
): SignedPlacement {
  const problem = placementProblem(placement);
  if (problem) throw new Error(problem);

  const record: PlacementRecord = {
    kind: PLACEMENT_KIND,
    version: 1,
    sequence: previous ? previous.record.sequence + 1 : 0,
    previous: previous ? recordDigest(previous.record) : null,
    steward: {
      keyId: signer.keyId,
      publicKey: signer.publicKey as JsonWebKey,
      algorithm: signer.suite,
    },
    placement,
    createdAt: new Date().toISOString(),
  };

  return { record, signature: signer.sign(record) };
}

export function verifyPlacement(signed: SignedPlacement): {
  ok: boolean;
  reason: string | null;
  digest: string | null;
} {
  const invalid = (reason: string) => ({ ok: false, reason, digest: null });
  const record = signed?.record;

  if (!record || typeof record !== "object") return invalid("record must be an object");
  if (record.kind !== PLACEMENT_KIND) return invalid("kind is not a placement");
  if (record.version !== 1) return invalid("version is not supported");
  if (typeof signed.signature !== "string") return invalid("signature must be a string");

  if (!Number.isInteger(record.sequence) || record.sequence < 0) {
    return invalid("sequence must be a non-negative integer");
  }

  if (record.sequence === 0) {
    if (record.previous !== null) return invalid("the first record cannot link backwards");
  } else if (!HASH.test(record.previous ?? "")) {
    return invalid("previous must be a sha256 hex digest");
  }

  const steward = record.steward;

  if (!steward || typeof steward !== "object") return invalid("steward is missing");
  if (typeof steward.keyId !== "string" || !HASH.test(steward.keyId)) {
    return invalid("steward keyId must be a sha256 hex digest");
  }

  if (!steward.publicKey || typeof steward.publicKey !== "object") {
    return invalid("steward publicKey is missing");
  }

  if (publicKeyId(steward.publicKey) !== steward.keyId) {
    return invalid("steward keyId does not match its public key");
  }

  const suite = suiteFor(steward.publicKey);
  if (!suite || suite !== steward.algorithm) return invalid("steward algorithm is not supported");

  const problem = placementProblem(record.placement);
  if (problem) return invalid(problem);

  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    return invalid("createdAt must be an ISO timestamp");
  }

  if (!verifyPayload(steward.publicKey, record, signed.signature, suite)) {
    return invalid("signature does not verify");
  }

  return { ok: true, reason: null, digest: recordDigest(record) };
}

export function asSignedPlacement(value: unknown): SignedPlacement | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<SignedPlacement>;

  if (!candidate.record || typeof candidate.record !== "object") return null;
  if (typeof candidate.signature !== "string") return null;

  return candidate as SignedPlacement;
}

function chainProblem(history: SignedPlacement[]): string | null {
  for (let index = 0; index < history.length; index += 1) {
    const current = history[index]!;
    const previous = index === 0 ? null : history[index - 1]!;

    if (current.record.sequence !== index) return "history skips a sequence";
    if (index === 0) {
      if (current.record.previous !== null) return "the first record cannot link backwards";
      continue;
    }

    if (current.record.previous !== recordDigest(previous!.record)) {
      return "history does not link backwards";
    }
  }

  return null;
}

/**
 * Append-only, file-backed placement records. A holder can re-serve any
 * historical record on its own; this registry is a convenience, not a
 * trust anchor.
 */
export class PlacementRegistry {
  private readonly directory: string | null;
  private readonly entries = new Map<string, SignedPlacement[]>();

  constructor(directory: string | null = null) {
    this.directory = directory;

    if (directory) {
      mkdirSync(directory, { recursive: true });
      this.load();
    }
  }

  private index(): string {
    return join(this.directory!, "placements.json");
  }

  private load(): void {
    if (!existsSync(this.index())) return;

    const parsed = JSON.parse(readFileSync(this.index(), "utf8")) as {
      version?: number;
      blobs?: { blobHash?: string; history?: SignedPlacement[] }[];
    };

    if (parsed.version !== 1 || !Array.isArray(parsed.blobs)) return;

    for (const entry of parsed.blobs) {
      const blobHash = entry.blobHash;
      const history = entry.history;

      if (!blobHash || !HASH.test(blobHash) || !Array.isArray(history)) continue;
      if (history.length === 0 || chainProblem(history)) continue;
      if (!history.every((signed) => verifyPlacement(signed).ok)) continue;
      if (history.some((signed) => signed.record.placement.blobHash !== blobHash)) continue;

      this.entries.set(blobHash, history);
    }
  }

  private save(): void {
    if (!this.directory) return;

    const blobs = [...this.entries].map(([blobHash, history]) => ({
      blobHash,
      history,
    }));
    const temporary = `${this.index()}.tmp`;

    writeFileSync(temporary, JSON.stringify({ version: 1, blobs }, null, 2));
    renameSync(temporary, this.index());
  }

  put(signed: SignedPlacement): { status: number; error?: string } {
    const verified = verifyPlacement(signed);

    if (!verified.ok) return { status: 401, error: verified.reason ?? "invalid placement" };

    const blobHash = signed.record.placement.blobHash;
    const history = this.entries.get(blobHash) ?? [];
    const current = history.at(-1) ?? null;

    if (current) {
      if (recordDigest(current.record) === verified.digest) return { status: 200 };
      if (signed.record.sequence !== current.record.sequence + 1) {
        return { status: 409, error: "placement does not extend the current record" };
      }
      if (signed.record.previous !== recordDigest(current.record)) {
        return { status: 409, error: "placement does not link to the current record" };
      }
    } else if (signed.record.sequence !== 0) {
      return { status: 409, error: "the first placement must start at sequence 0" };
    }

    history.push(signed);
    this.entries.set(blobHash, history);
    this.save();

    return { status: 201 };
  }

  get(blobHash: string): SignedPlacement | null {
    return this.entries.get(blobHash)?.at(-1) ?? null;
  }

  historyFor(blobHash: string): SignedPlacement[] {
    return [...(this.entries.get(blobHash) ?? [])];
  }

  list(): PlacementSummary[] {
    return [...this.entries].map(([blobHash, history]) => {
      const record = history.at(-1)!.record;

      return {
        blobHash,
        sequence: record.sequence,
        tier: record.placement.tier,
        holders: record.placement.shards.length,
        required: record.placement.required,
        createdAt: record.createdAt,
      };
    });
  }
}
