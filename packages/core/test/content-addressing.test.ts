import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { base32Encode, cidV1, toHex } from "../src/index.ts";

const nodeSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

/**
 * An INDEPENDENT base32 decoder, written here rather than borrowed from the module under test.
 * Reusing the encoder to check the encoder proves only that it agrees with itself; a second
 * implementation is what makes this a cross-check.
 */
function base32Decode(text: string): Uint8Array {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = "";
  for (const character of text) {
    const value = alphabet.indexOf(character);
    assert.notEqual(value, -1, `${character} is not in the base32 alphabet`);
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  return new Uint8Array(bytes);
}

test("a CID carries the sha256 of the bytes in another notation, not a different digest", () => {
  // Load-bearing for naming: the seed publishes `bundleCid` (base32) while a reference carries the
  // 64-hex form, so if these were different digests a blob named by one could not be checked with
  // the other. The CID is a WRAPPER around the digest — version, codec, multihash code and length —
  // and its last 32 bytes are exactly the sha256 the hex form spells.
  const bytes = new TextEncoder().encode("a tarball of a website, an image, a model file");
  const cid = cidV1(nodeSha256, bytes);

  assert.match(cid, /^b[a-z2-7]+$/, "CIDv1 + sha256 is lowercase base32 and starts with b");
  const raw = base32Decode(cid.slice(1));
  assert.deepEqual(
    [...raw.slice(0, 4)],
    [0x01, 0x55, 0x12, 0x20],
    "version 1, raw codec, sha256 multihash, 32 bytes long",
  );
  assert.equal(raw.length, 36, "4 bytes of wrapper and 32 of digest");
  assert.deepEqual([...raw.slice(4)], [...nodeSha256(bytes)], "the payload IS the digest");
  assert.equal(toHex(new Uint8Array(raw.slice(4))), toHex(nodeSha256(bytes)));

  // And it is a digest OF those bytes: different bytes, different CID.
  assert.notEqual(cidV1(nodeSha256, bytes), cidV1(nodeSha256, new TextEncoder().encode("other")));
  assert.equal(base32Encode(nodeSha256(bytes)).length, 52, "32 bytes of base32, unpadded");
});
