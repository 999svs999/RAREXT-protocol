import { randomBytes as randomBytesNode } from "node:crypto";

import { decodeBytes, encodeBytes, verifyShard, type ErasureShard } from "./erasure.ts";
import { merkleProof, merkleRoot, verifyProof } from "./merkle.ts";
import { BlobStore, sha256Bytes } from "./storage.ts";

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

export type DurabilityTier = "ephemeral" | "pinned" | "durable";

export interface HolderChallenge {
  storedAs: string;
  leafIndex: number;
  nonce: string;
}

export interface DurabilityHolder {
  readonly id: string;
  put(bytes: Uint8Array): Promise<string>;
  get(storedAs: string): Promise<Uint8Array | null>;
  remove(storedAs: string): Promise<boolean>;
  has(storedAs: string): Promise<boolean>;
  respond(challenge: HolderChallenge): Promise<ChallengeResponse | null>;
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
    put: async (bytes) => store.put(bytes).hash,
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
  options: { fetch?: typeof fetch } = {},
): DurabilityHolder {
  const base = baseUrl.replace(/\/+$/, "");
  const call = options.fetch ?? fetch;

  async function expect(response: Response, what: string): Promise<Response> {
    if (!response.ok) {
      throw new Error(`holder ${id} failed ${what}: ${response.status}`);
    }

    return response;
  }

  return {
    id,
    async put(bytes) {
      const response = await expect(
        await call(`${base}/v1/holder/shards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: Buffer.from(bytes).toString("base64") }),
        }),
        "put",
      );

      const body = (await response.json()) as { storedAs: string };
      return body.storedAs;
    },
    async get(storedAs) {
      const response = await call(`${base}/v1/holder/shards/${storedAs}`);

      if (response.status === 404) return null;

      await expect(response, "get");
      const body = (await response.json()) as { content: string };
      return Uint8Array.from(Buffer.from(body.content, "base64"));
    },
    async remove(storedAs) {
      const response = await call(`${base}/v1/holder/shards/${storedAs}`, {
        method: "DELETE",
      });

      return response.ok;
    },
    async has(storedAs) {
      const response = await call(`${base}/v1/holder/shards/${storedAs}`, {
        method: "HEAD",
      });

      return response.ok;
    },
    async respond(challenge) {
      const response = await call(`${base}/v1/holder/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(challenge),
      });

      if (response.status === 404) return null;

      await expect(response, "challenge");
      return (await response.json()) as ChallengeResponse;
    },
  };
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
  const leaves = chunkLeaves(bytes);

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

  /** Writes the map into the ledger so a published record can be rebuilt. */
  adopt(placement: Placement): Placement {
    this.placements.set(placement.blobHash, placement);
    this.witnesses.set(
      placement.blobHash,
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
      const storedAs = await holder.put(shard.bytes);
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

      try {
        const response = await holder.respond({
          storedAs: shard.storedAs,
          leafIndex,
          nonce,
        });

        if (!response) {
          outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "shard-missing" });
          this.miss(witness, now);
          continue;
        }

        if (!verifyChallengeResponse(shard, response)) {
          outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "bad-proof" });
          this.miss(witness, now);
          continue;
        }
      } catch {
        outcomes.push({ index: shard.index, holder: shard.holder, ok: false, reason: "holder-missing" });
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
  async repair(blobHash: string, holders: DurabilityHolder[]): Promise<RepairOutcome> {
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

      let present = false;

      if (holder) {
        try {
          present = await holder.has(shard.storedAs);
        } catch {
          present = false;
        }
      }

      if (!holder || failed || !present) degraded.add(shard.index);
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

    const survivorShards: ErasureShard[] = [];

    for (const shard of survivors) {
      const holder = byId.get(shard.holder)!;
      const bytes = await holder.get(shard.storedAs);

      if (!bytes) {
        throw new Error(`holder ${shard.holder} lost shard ${shard.index} during repair`);
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
    }

    const payload = decodeBytes(survivorShards);
    const reencoded = encodeBytes(payload, placement.dataShards, placement.parityShards);
    const probe = placement.shards.find((shard) => degraded.has(shard.index))!.storedAs;
    const spare: DurabilityHolder[] = [];

    for (const candidate of holders) {
      if (used.has(candidate.id)) continue;

      try {
        if (!(await candidate.has(probe))) spare.push(candidate);
      } catch {
        continue;
      }
    }

    spare.sort((left, right) => left.id.localeCompare(right.id));

    let readBytes = 0;
    for (const shard of survivorShards) readBytes += shard.bytes.length;

    if (spare.length < degraded.size) {
      throw new Error(
        `no spare holder: ${degraded.size} shard(s) need repair and ${spare.length} holder(s) are free`,
      );
    }

    let writtenBytes = 0;
    let filled = 0;

    for (const index of [...degraded].sort((left, right) => left - right)) {
      const next = spare.shift()!;
      const bytes = reencoded.find((shard) => shard.index === index)!.bytes;
      const storedAs = await next.put(bytes);
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
