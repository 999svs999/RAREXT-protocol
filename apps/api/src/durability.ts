import { randomBytes as randomBytesNode } from "node:crypto";

import { decodeBytes, encodeBytes, verifyShard, type ErasureShard } from "./erasure.ts";
import { merkleProof, merkleRoot, verifyProof } from "./merkle.ts";
import { BlobStore, sha256Bytes } from "./storage.ts";

/**
 * Durability is a claim about *holders*, not about a directory. This module
 * places erasure shards on independent holders, challenges them for possession,
 * counts the ones that answered, and rebuilds what was lost.
 *
 * A holder is anything that can put and get bytes: a directory here, a browser
 * or another machine behind a transport later. An agent is a holder.
 */

export const SHARD_CHUNK_BYTES = 4096;

export type DurabilityTier = "ephemeral" | "pinned" | "durable";

export interface DurabilityHolder {
  readonly id: string;
  put(bytes: Uint8Array): string;
  get(storedAs: string): Uint8Array | null;
  remove(storedAs: string): boolean;
  has(storedAs: string): boolean;
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
  /** Length of the original payload, in bytes. */
  length: number;
  tier: DurabilityTier;
  required: number;
  shards: ShardPlacement[];
  createdAt: string;
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
  reason: "ok" | "holder-missing" | "shard-missing" | "bad-proof";
}

export interface DurabilityReport {
  blobHash: string;
  tier: DurabilityTier;
  required: number;
  live: number;
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
    put: (bytes) => store.put(bytes).hash,
    get: (storedAs) => store.get(storedAs)?.bytes ?? null,
    remove: (storedAs) => store.remove(storedAs),
    has: (storedAs) => store.has(storedAs),
  };
}

function chunkLeaves(bytes: Uint8Array): string[] {
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
 * A holder answers a challenge for one leaf of one shard. The leaf and its path
 * prove possession against the committed root; the nonce binding proves the
 * answer was computed after the challenge and cannot be replayed.
 */
export function respondToChallenge(
  bytes: Uint8Array,
  shard: ShardPlacement,
  leafIndex: number,
  nonce: string,
): ChallengeResponse {
  const leaves = chunkLeaves(bytes);

  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(`leaf ${leafIndex} is outside the shard`);
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

export function verifyChallengeResponse(
  shard: ShardPlacement,
  response: ChallengeResponse,
): boolean {
  if (!Number.isInteger(response.index) || response.index < 0) return false;
  if (response.index >= shard.leaves) return false;
  if (typeof response.nonce !== "string" || response.nonce.length === 0) return false;
  if (typeof response.leaf !== "string" || response.leaf.length !== 64) return false;
  if (typeof response.digest !== "string") return false;
  if (response.digest !== nonceBinding(response.nonce, response.leaf)) return false;
  if (!Array.isArray(response.proof)) return false;

  return verifyProof(response.leaf, response.proof, shard.root, response.index);
}

export class DurabilityLedger {
  private readonly placements = new Map<string, Placement>();
  private readonly witnesses = new Map<string, Map<number, Witness>>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly random: (upper: number) => number;

  constructor(options: DurabilityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
    this.random =
      options.random ?? ((upper) => Math.floor(Math.random() * upper));
  }

  get(blobHash: string): Placement | null {
    return this.placements.get(blobHash) ?? null;
  }

  place(
    shards: ErasureShard[],
    holders: DurabilityHolder[],
    tier: DurabilityTier,
  ): Placement {
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
    };

    const witnesses = new Map<number, Witness>();

    for (const shard of shards) {
      const holder = chosen[shard.index]!;
      const storedAs = holder.put(shard.bytes);
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

    this.placements.set(payloadDigest, placement);
    this.witnesses.set(payloadDigest, witnesses);

    return placement;
  }

  challenge(blobHash: string, holders: DurabilityHolder[]): ChallengeOutcome[] {
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

      const bytes = holder.get(shard.storedAs);

      if (!bytes) {
        outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "shard-missing" });
        this.miss(witness, now);
        continue;
      }

      const leafIndex = this.random(shard.leaves);
      const nonce = randomBytesNode(16).toString("hex");
      const response = respondToChallenge(bytes, shard, leafIndex, nonce);

      if (!verifyChallengeResponse(shard, response)) {
        outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "bad-proof" });
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

    return {
      blobHash,
      tier: placement.tier,
      required: placement.required,
      live,
      status: live >= placement.required ? "ok" : "under-replicated",
      shards,
    };
  }

  /**
   * Rebuilds every shard that failed or is missing, from any k survivors, and
   * places it on a holder that does not already hold a shard of this blob. The
   * returned placement is the same object, updated.
   */
  repair(blobHash: string, holders: DurabilityHolder[]): RepairOutcome {
    const placement = this.placements.get(blobHash);

    if (!placement) throw new Error(`unknown blob ${blobHash}`);

    const witnesses = this.witnesses.get(blobHash)!;
    const byId = new Map(holders.map((holder) => [holder.id, holder]));
    const used = new Set(placement.shards.map((shard) => shard.holder));

    const degraded = new Set<number>();

    for (const shard of placement.shards) {
      const witness = witnesses.get(shard.index)!;
      const holder = byId.get(shard.holder);
      const failed =
        witness.lastFailure !== null &&
        (witness.lastSuccess === null || witness.lastFailure > witness.lastSuccess);

      if (!holder || failed || !holder.has(shard.storedAs)) degraded.add(shard.index);
    }

    if (degraded.size === 0) {
      return { filled: 0, readBytes: 0, writtenBytes: 0, placement };
    }

    const survivors = placement.shards.filter((shard) => !degraded.has(shard.index));

    if (survivors.length < placement.dataShards) {
      throw new Error(
        `cannot repair: only ${survivors.length} of ${placement.dataShards} shards survive`,
      );
    }

    const survivorShards: ErasureShard[] = survivors.map((shard) => {
      const holder = byId.get(shard.holder)!;
      const bytes = holder.get(shard.storedAs)!;
      return {
        index: shard.index,
        dataShards: placement.dataShards,
        parityShards: placement.parityShards,
        length: placement.length,
        payloadDigest: placement.blobHash,
        bytes: Uint8Array.from(bytes),
        digest: shard.digest,
      };
    });

    const payload = decodeBytes(survivorShards);
    const reference = survivorShards[0]!;
    const reencoded = encodeBytes(payload, reference.dataShards, reference.parityShards);
    const spare = holders
      .filter((holder) => !used.has(holder.id))
      .sort((left, right) => left.id.localeCompare(right.id));

    let readBytes = 0;
    for (const shard of survivorShards) readBytes += shard.bytes.length;

    let writtenBytes = 0;
    let filled = 0;

    for (const index of [...degraded].sort((left, right) => left - right)) {
      const next = spare.shift();

      if (!next) {
        throw new Error(
          `no spare holder for shard ${index}: every holder already holds a shard of this blob`,
        );
      }

      const bytes = reencoded.find((shard) => shard.index === index)!.bytes;
      const storedAs = next.put(bytes);
      const leaves = chunkLeaves(bytes);
      const target = placement.shards.find((shard) => shard.index === index)!;

      target.holder = next.id;
      target.storedAs = storedAs;
      target.size = bytes.length;
      target.leaves = leaves.length;
      target.root = merkleRoot(leaves);

      witnesses.set(index, {
        holder: next.id,
        lastSuccess: null,
        lastFailure: null,
        misses: 0,
      });

      used.add(next.id);
      writtenBytes += bytes.length;
      filled += 1;
    }

    return { filled, readBytes, writtenBytes, placement };
  }
}
