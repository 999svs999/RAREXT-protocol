import {
  merkleProof as coreMerkleProof,
  merkleRoot as coreMerkleRoot,
  verifyProof as coreVerifyProof,
} from "../../../packages/core/src/index.ts";

import { nodeSha256 } from "./digest.ts";

export function merkleRoot(leaves: string[]): string {
  return coreMerkleRoot(leaves, nodeSha256);
}

export function merkleProof(leaves: string[], index: number): string[] {
  return coreMerkleProof(leaves, index, nodeSha256);
}

export function verifyProof(
  leaf: string,
  proof: string[],
  root: string,
  index: number,
): boolean {
  return coreVerifyProof(leaf, proof, root, index, nodeSha256);
}
