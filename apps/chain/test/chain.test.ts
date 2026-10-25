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

test("a block must name the key that signed it", () => {
  const draft = {
    height: 1,
    prevHash: GENESIS_HASH,
    timestamp: "2026-10-22T00:00:00.000Z",
    roots: ["a".repeat(64)],
    root: merkleRoot(["a".repeat(64)]),
    signer: "f".repeat(64),
  };
  const { hash, signature } = signBlock(draft, key.privateKey);

  assert.equal(verifyBlock({ ...draft, hash, signature }, key.publicKey), false);
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

test("publication ids are committed by the block hash", () => {
  const log = chain();
  const root = "a".repeat(64);
  const block = log.append([root], ["pub-1", "pub-2"]);

  assert.deepEqual(block.publicationIds, ["pub-1", "pub-2"]);
  assert.equal(verifyBlock(block, key.publicKey), true);

  const tampered = { ...block, publicationIds: ["pub-3"] };
  assert.equal(verifyBlock(tampered, key.publicKey), false);
});

test("restoring a saved log keeps every hash, signature, and publication id", () => {
  const original = chain();
  original.append(["a".repeat(64)], ["pub-1"]);
  original.append(["b".repeat(64)], ["pub-2", "pub-3"]);

  const saved = JSON.parse(JSON.stringify(original.list())) as unknown[];
  const restored = AnchorChain.restore("rarex-test-1", key, saved);

  assert.deepEqual(restored.list(), original.list());
  assert.deepEqual(restored.audit(), { valid: true, height: 2, brokenAt: null });
  assert.equal(restored.state().head, original.state().head);
});

test("restore rejects a tampered block instead of re-signing it", () => {
  const original = chain();
  original.append(["a".repeat(64)], ["pub-1"]);

  const changedTimestamp = JSON.parse(JSON.stringify(original.list()));
  changedTimestamp[0].timestamp = "2026-10-22T00:00:00.000Z";
  assert.throws(
    () => AnchorChain.restore("rarex-test-1", key, changedTimestamp),
    /bad hash or signature/,
  );

  const changedIds = JSON.parse(JSON.stringify(original.list()));
  changedIds[0].publicationIds = ["pub-2"];
  assert.throws(
    () => AnchorChain.restore("rarex-test-1", key, changedIds),
    /bad hash or signature/,
  );

  const changedParent = JSON.parse(JSON.stringify(original.list()));
  changedParent[0].prevHash = "0".repeat(64);
  changedParent[0].height = 2;
  assert.throws(
    () => AnchorChain.restore("rarex-test-1", key, changedParent),
    /height 2, expected 1/,
  );

  const wrongKey = generateChainKey();
  assert.throws(
    () => AnchorChain.restore("rarex-test-1", wrongKey, original.list()),
    /bad hash or signature/,
  );
});

test("restore accepts a legacy block that predates publication ids", () => {
  const draft = {
    height: 1,
    prevHash: GENESIS_HASH,
    timestamp: "2026-10-22T00:00:00.000Z",
    roots: ["a".repeat(64)],
    root: merkleRoot(["a".repeat(64)]),
    signer: key.keyId,
  };
  const { hash, signature } = signBlock(draft, key.privateKey);

  const restored = AnchorChain.restore("rarex-test-1", key, [
    { ...draft, hash, signature },
  ]);

  assert.equal(restored.height, 1);
  assert.equal(restored.head()!.publicationIds, undefined);
  assert.deepEqual(restored.audit(), { valid: true, height: 1, brokenAt: null });
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

test("the chain's Merkle fold agrees with the registry's for every tree shape", async () => {
  const registry = await import("../../api/src/merkle.ts");

  for (const leaves of [
    ["a1"],
    ["a1", "b2"],
    ["a1", "b2", "c3"],
    ["a1", "b2", "c3", "d4"],
    ["a1", "b2", "c3", "d4", "e5"],
    ["a1", "b2", "c3", "d4", "e5", "f6", "g7"],
  ]) {
    assert.equal(
      merkleRoot(leaves),
      registry.merkleRoot(leaves),
      `the roots differ for ${leaves.length} leaves`,
    );

    for (let index = 0; index < leaves.length; index += 1) {
      const path = merklePath(leaves, index);
      assert.equal(
        verifyPath(leaves[index]!, path, registry.merkleRoot(leaves)),
        true,
        `the chain path does not verify against the registry root at ${index}`,
      );
      assert.equal(
        registry.verifyProof(
          leaves[index]!,
          registry.merkleProof(leaves, index),
          merkleRoot(leaves),
          index,
        ),
        true,
        `the registry proof does not verify against the chain root at ${index}`,
      );
    }
  }
});
