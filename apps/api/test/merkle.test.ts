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
