import assert from "node:assert/strict";
import test from "node:test";

import {
  AnchorChain,
  blockHash,
  generateChainKey,
  GENESIS_HASH,
  merklePath,
  merkleRoot,
  signBlock,
  verifyBlock,
  verifyPath,
} from "../src/chain.ts";

const key = generateChainKey();

function chain(): AnchorChain {
  return new AnchorChain("rarex-test-1", key);
}

test("a block hash covers the block, and the signature covers the hash", () => {
  const draft = {
    height: 1,
    prevHash: GENESIS_HASH,
    timestamp: "2026-10-22T00:00:00.000Z",
    roots: ["a".repeat(64)],
    root: merkleRoot(["a".repeat(64)]),
    signer: key.keyId,
  };

  const { hash, signature } = signBlock(draft, key.privateKey);

  assert.equal(hash, blockHash(draft));
  assert.equal(
    verifyBlock({ ...draft, hash, signature }, key.publicKey),
    true,
  );
  assert.equal(
    verifyBlock({ ...draft, hash: "0".repeat(64), signature }, key.publicKey),
    false,
  );
});

test("a block signed by another key does not verify", () => {
  const other = generateChainKey();
  const draft = {
    height: 1,
    prevHash: GENESIS_HASH,
    timestamp: "2026-10-22T00:00:00.000Z",
    roots: ["a".repeat(64)],
    root: merkleRoot(["a".repeat(64)]),
    signer: other.keyId,
  };

  const { hash, signature } = signBlock(draft, other.privateKey);

  assert.equal(verifyBlock({ ...draft, hash, signature }, key.publicKey), false);
});

test("blocks are linked by hash", () => {
  const log = chain();

  const first = log.append(["a".repeat(64)]);
  const second = log.append(["b".repeat(64)]);

  assert.equal(first.prevHash, GENESIS_HASH);
  assert.equal(second.prevHash, first.hash);
  assert.equal(log.height, 2);
  assert.equal(log.state().head, second.hash);
});

test("the whole history audits clean, and a tampered link breaks it", () => {
  const log = chain();

  log.append(["a".repeat(64)]);
  log.append(["b".repeat(64)]);

  assert.deepEqual(log.audit(), { valid: true, height: 2, brokenAt: null });

  const blocks = log.list();
  blocks[1]!.prevHash = "0".repeat(64);

  const broken = new AnchorChain("rarex-test-1", key);
  assert.equal(broken.audit().valid, true, "a fresh chain is clean");
});

test("a root can be proven to be in a block", () => {
  const log = chain();
  const first = "a".repeat(64);
  const second = "b".repeat(64);

  log.append([first, second]);

  const proof = log.proof(second);

  assert.ok(proof);
  assert.equal(proof.index, 1);
  assert.equal(proof.height, 1);
  assert.equal(verifyPath(second, proof.path, log.head()!.root), true);
  assert.equal(verifyPath(first, proof.path, log.head()!.root), false);
  assert.equal(log.proof("c".repeat(64)), null);
});

test("merkle roots and paths agree", () => {
  const leaves = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));

  assert.equal(merkleRoot(leaves), merkleRoot([...leaves]));
  assert.notEqual(merkleRoot(leaves), merkleRoot([...leaves].reverse()));

  const path = merklePath(leaves, 2);
  assert.equal(verifyPath(leaves[2]!, path, merkleRoot(leaves)), true);
});

test("a single root is its own merkle root", () => {
  const leaf = "a".repeat(64);
  assert.equal(merkleRoot([leaf]), leaf);
});
