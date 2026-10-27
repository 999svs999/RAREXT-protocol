import { sha256Hex, type Sha256 } from "./digest.ts";

function nextLevel(level: string[], sha256: Sha256): string[] {
  const next: string[] = [];

  for (let index = 0; index < level.length; index += 2) {
    next.push(sha256Hex(sha256, level[index] + (level[index + 1] ?? level[index])));
  }

  return next;
}

/**
 * The Merkle root of hex-string leaves. The hash is injected, so this is the
 * same implementation on a server (node:crypto) and in a client that supplies
 * its own digest.
 */
export function merkleRoot(leaves: string[], sha256: Sha256): string {
  if (leaves.length === 0) {
    return sha256Hex(sha256, "");
  }

  let level = [...leaves];

  while (level.length > 1) {
    level = nextLevel(level, sha256);
  }

  return level[0]!;
}

export function merkleProof(
  leaves: string[],
  index: number,
  sha256: Sha256,
): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error("leaf index out of range");
  }

  const proof: string[] = [];
  let level = [...leaves];
  let cursor = index;

  while (level.length > 1) {
    const sibling = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    proof.push(level[sibling] ?? level[cursor]!);
    level = nextLevel(level, sha256);
    cursor = Math.floor(cursor / 2);
  }

  return proof;
}

export function verifyProof(
  leaf: string,
  proof: string[],
  root: string,
  index: number,
  sha256: Sha256,
): boolean {
  let hash = leaf;
  let cursor = index;

  for (const sibling of proof) {
    hash =
      cursor % 2 === 0
        ? sha256Hex(sha256, hash + sibling)
        : sha256Hex(sha256, sibling + hash);
    cursor = Math.floor(cursor / 2);
  }

  return hash === root;
}
