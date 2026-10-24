import test from "node:test";
import assert from "node:assert/strict";

import { merkleProof, merkleRoot, verifyProof } from "../src/merkle.ts";

const leaves = ["a1", "b2", "c3", "d4", "e5"];

test("every leaf verifies against its Merkle root", () => {
  const root = merkleRoot(leaves);

  for (let index = 0; index < leaves.length; index += 1) {
    const proof = merkleProof(leaves, index);
    assert.equal(verifyProof(leaves[index], proof, root, index), true);
  }
});

test("a tampered leaf or proof does not verify", () => {
  const root = merkleRoot(leaves);
  const proof = merkleProof(leaves, 2);

  assert.equal(verifyProof("ffff", proof, root, 2), false);
  assert.equal(
    verifyProof(leaves[2], [proof[0].replace(/^./, "0"), ...proof.slice(1)], root, 2),
    false,
  );
});

test("odd levels duplicate the final leaf", () => {
  const root = merkleRoot(["a1", "b2", "c3"]);
  const proof = merkleProof(["a1", "b2", "c3"], 2);

  assert.equal(proof.length, 2);
  assert.equal(verifyProof("c3", proof, root, 2), true);
});

test("a proof is bound to its root, index, and full path", () => {
  const root = merkleRoot(leaves);
  const proof = merkleProof(leaves, 2);
  const otherRoot = merkleRoot([...leaves.slice(0, 4), "zz"]);

  assert.equal(verifyProof(leaves[2], proof, otherRoot, 2), false);
  assert.equal(verifyProof(leaves[2], proof, root, 1), false);
  assert.equal(verifyProof(leaves[2], proof.slice(0, -1), root, 2), false);
  assert.equal(verifyProof(leaves[2], [proof[1]!, proof[0]!, proof[2]!], root, 2), false);
});

test("merkleProof refuses an out-of-range leaf index", () => {
  assert.throws(() => merkleProof(leaves, leaves.length), /index out of range/);
  assert.throws(() => merkleProof(leaves, -1), /index out of range/);
  assert.throws(() => merkleProof([], 0), /index out of range/);
});
