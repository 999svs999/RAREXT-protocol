import { createHash } from "node:crypto";

function hashPair(left: string, right: string): string {
  return createHash("sha256").update(left).update(right).digest("hex");
}

function nextLevel(level: string[]): string[] {
  const next: string[] = [];

  for (let index = 0; index < level.length; index += 2) {
    next.push(hashPair(level[index], level[index + 1] ?? level[index]));
  }

  return next;
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return createHash("sha256").update("").digest("hex");
  }

  let level = [...leaves];

  while (level.length > 1) {
    level = nextLevel(level);
  }

  return level[0];
}

export function merkleProof(leaves: string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error("leaf index out of range");
  }

  const proof: string[] = [];
  let level = [...leaves];
  let cursor = index;

  while (level.length > 1) {
    const sibling = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    proof.push(level[sibling] ?? level[cursor]);
    level = nextLevel(level);
    cursor = Math.floor(cursor / 2);
  }

  return proof;
}

export function verifyProof(
  leaf: string,
  proof: string[],
  root: string,
  index: number,
): boolean {
  let hash = leaf;
  let cursor = index;

  for (const sibling of proof) {
    hash = cursor % 2 === 0 ? hashPair(hash, sibling) : hashPair(sibling, hash);
    cursor = Math.floor(cursor / 2);
  }

  return hash === root;
}
