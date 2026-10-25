import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";

/**
 * The RAREXT chain: a hash-linked, signed log of anchor commitments.
 *
 * This is the notary layer the protocol needs, and it is deliberately shaped
 * like a chain rather than like a database: blocks are linked by hash, each
 * carries a Merkle root over the roots anchored in it, and a node signs every
 * block with its key. A reader can verify the whole history without trusting
 * the node, and can prove that a particular anchor is in a particular block.
 *
 * It is a single-writer notary today. What a real network adds is multiple
 * writers, consensus over which block wins, and finality rules. The interface
 * is the part that is fixed: the anchor adapter in the registry talks to this
 * shape, so a consensus chain can be dropped in behind the same API.
 */

export interface ChainBlock {
  height: number;
  hash: string;
  prevHash: string;
  timestamp: string;
  roots: string[];
  root: string;
  signer: string;
  signature: string;
  /**
   * The registry publications whose leaves produced this block's roots. The
   * roots already commit the leaves; these ids make the block readable as a
   * registry record too. Older logs omit this field, so it is optional and is
   * only covered by the hash when present.
   */
  publicationIds?: string[];
}

export interface ChainInclusionProof {
  root: string;
  height: number;
  blockHash: string;
  index: number;
  path: MerkleStep[];
}

export const GENESIS_HASH = "0".repeat(64);

function hashPair(left: string, right: string): string {
  return createHash("sha256").update(left + right).digest("hex");
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return hashPair("", "");
  if (leaves.length === 1) return leaves[0]!;

  let level = [...leaves];

  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(hashPair(level[index]!, level[index + 1] ?? level[index]!));
    }
    level = next;
  }

  return level[0]!;
}

/**
 * The inclusion path for a leaf. Each step records which side the sibling was
 * on, because a Merkle path is only walkable if the order is known.
 */
export interface MerkleStep {
  hash: string;
  side: "left" | "right";
}

export function merklePath(leaves: string[], target: number): MerkleStep[] {
  const path: MerkleStep[] = [];
  let level = [...leaves];
  let index = target;

  while (level.length > 1) {
    const even = index % 2 === 0;
    const sibling = even ? index + 1 : index - 1;
    path.push({ hash: level[sibling] ?? level[index]!, side: even ? "right" : "left" });

    const next: string[] = [];
    for (let position = 0; position < level.length; position += 2) {
      next.push(hashPair(level[position]!, level[position + 1] ?? level[position]!));
    }

    level = next;
    index = Math.floor(index / 2);
  }

  return path;
}

export function verifyPath(leaf: string, path: MerkleStep[], root: string): boolean {
  let hash = leaf;

  for (const step of path) {
    hash =
      step.side === "right"
        ? hashPair(hash, step.hash)
        : hashPair(step.hash, hash);
  }

  return hash === root;
}

export function blockHash(block: Omit<ChainBlock, "hash" | "signature">): string {
  return createHash("sha256")
    .update(
      canonicalize({
        height: block.height,
        prevHash: block.prevHash,
        timestamp: block.timestamp,
        roots: block.roots,
        root: block.root,
        signer: block.signer,
        ...(block.publicationIds === undefined
          ? {}
          : { publicationIds: block.publicationIds }),
      }),
    )
    .digest("hex");
}

export interface ChainKey {
  publicKey: string;
  privateKey: string;
  keyId: string;
}

export function chainKeyId(publicKeyJwk: string): string {
  const jwk = JSON.parse(publicKeyJwk) as Record<string, string>;

  return createHash("sha256")
    .update(canonicalize({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }))
    .digest("hex");
}

export function generateChainKey(): ChainKey {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.privateKey.export({ format: "jwk" }) as Record<string, string>;
  const publicKey = JSON.stringify({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  });

  return {
    publicKey,
    privateKey: JSON.stringify(jwk),
    keyId: chainKeyId(publicKey),
  };
}

export function signBlock(
  block: Omit<ChainBlock, "hash" | "signature">,
  privateKeyJwk: string,
): { hash: string; signature: string } {
  const hash = blockHash(block);
  const key = createPrivateKey({
    key: JSON.parse(privateKeyJwk),
    format: "jwk",
  });

  const signature = sign("sha256", Buffer.from(hash, "hex"), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");

  return { hash, signature };
}

export function verifyBlock(block: ChainBlock, publicKeyJwk: string): boolean {
  try {
    if (block.signer !== chainKeyId(publicKeyJwk)) return false;
    if (block.root !== merkleRoot(block.roots)) return false;

    const expected = blockHash(block);

    if (expected !== block.hash) return false;

    const key = createPublicKey({
      key: JSON.parse(publicKeyJwk),
      format: "jwk",
    });

    return verify(
      "sha256",
      Buffer.from(block.hash, "hex"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(block.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export interface ChainState {
  chainId: string;
  height: number;
  head: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isChainBlock(value: unknown): value is ChainBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const block = value as Partial<ChainBlock>;

  return (
    Number.isSafeInteger(block.height) &&
    (block.height ?? 0) > 0 &&
    typeof block.hash === "string" &&
    typeof block.prevHash === "string" &&
    typeof block.timestamp === "string" &&
    isStringArray(block.roots) &&
    typeof block.root === "string" &&
    typeof block.signer === "string" &&
    typeof block.signature === "string" &&
    (block.publicationIds === undefined || isStringArray(block.publicationIds))
  );
}

export class AnchorChain {
  readonly chainId: string;
  private readonly key: ChainKey;
  private readonly blocks: ChainBlock[] = [];

  constructor(chainId: string, key: ChainKey) {
    this.chainId = chainId;
    this.key = key;
  }

  get height(): number {
    return this.blocks.length;
  }

  head(): ChainBlock | null {
    return this.blocks[this.blocks.length - 1] ?? null;
  }

  state(): ChainState {
    return {
      chainId: this.chainId,
      height: this.blocks.length,
      head: this.head()?.hash ?? GENESIS_HASH,
    };
  }

  /**
   * Rebuild a chain from its saved blocks without re-signing anything. The
   * saved hash and signature must verify against the current key, and every
   * height and parent link must be exact. This is what makes a restart keep
   * the history a reader already has instead of silently minting a new one.
   */
  static restore(
    chainId: string,
    key: ChainKey,
    saved: readonly unknown[],
  ): AnchorChain {
    const chain = new AnchorChain(chainId, key);
    let previous = GENESIS_HASH;

    for (const [index, value] of saved.entries()) {
      if (!isChainBlock(value)) {
        throw new Error(`saved block ${index + 1} is not a chain block`);
      }

      if (value.height !== index + 1) {
        throw new Error(
          `saved block ${index + 1} has height ${value.height}, expected ${index + 1}`,
        );
      }

      if (value.prevHash !== previous) {
        throw new Error(`saved block ${value.height} does not link to its parent`);
      }

      if (!verifyBlock(value, key.publicKey)) {
        throw new Error(`saved block ${value.height} has a bad hash or signature`);
      }

      chain.blocks.push({
        height: value.height,
        hash: value.hash,
        prevHash: value.prevHash,
        timestamp: value.timestamp,
        roots: [...value.roots],
        root: value.root,
        signer: value.signer,
        signature: value.signature,
        ...(value.publicationIds === undefined
          ? {}
          : { publicationIds: [...value.publicationIds] }),
      });
      previous = value.hash;
    }

    return chain;
  }

  append(roots: string[], publicationIds: string[] = []): ChainBlock {
    const previous = this.head();
    const height = this.blocks.length + 1;

    const draft = {
      height,
      prevHash: previous?.hash ?? GENESIS_HASH,
      timestamp: new Date().toISOString(),
      roots,
      root: merkleRoot(roots),
      signer: this.key.keyId,
      publicationIds,
    };

    const { hash, signature } = signBlock(draft, this.key.privateKey);
    const block: ChainBlock = { ...draft, hash, signature };

    this.blocks.push(block);
    return block;
  }

  block(height: number): ChainBlock | null {
    return this.blocks[height - 1] ?? null;
  }

  list(): ChainBlock[] {
    return [...this.blocks];
  }

  proof(root: string): ChainInclusionProof | null {
    for (const block of this.blocks) {
      const index = block.roots.indexOf(root);
      if (index === -1) continue;

      return {
        root,
        height: block.height,
        blockHash: block.hash,
        index,
        path: merklePath(block.roots, index),
      };
    }

    return null;
  }

  /** Walk the whole history and check every link and every signature. */
  audit(publicKeyJwk = this.key.publicKey): {
    valid: boolean;
    height: number;
    brokenAt: number | null;
  } {
    let previous = GENESIS_HASH;

    for (const [index, block] of this.blocks.entries()) {
      if (block.height !== index + 1 || block.prevHash !== previous) {
        return { valid: false, height: this.blocks.length, brokenAt: block.height };
      }

      if (!verifyBlock(block, publicKeyJwk)) {
        return { valid: false, height: this.blocks.length, brokenAt: block.height };
      }

      previous = block.hash;
    }

    return { valid: true, height: this.blocks.length, brokenAt: null };
  }
}
