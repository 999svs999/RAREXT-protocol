import type { Sha256 } from "./digest.ts";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * A CIDv1 over a raw sha2-256 multihash, which is what a content-addressed file
 * looks like to an IPFS or Arweave node. The digest is injected so the caller
 * decides where sha256 comes from; the composition is shared.
 *
 *   CIDv1 = <0x01 version> <0x55 raw codec> <0x12 sha2-256> <0x20 length> <digest>
 */
export function cidV1(sha256: Sha256, bytes: Uint8Array): string {
  const digest = sha256(bytes);
  const cid = new Uint8Array(4 + digest.length);

  cid[0] = 0x01;
  cid[1] = 0x55;
  cid[2] = 0x12;
  cid[3] = digest.length;
  cid.set(digest, 4);

  return `b${base32Encode(cid)}`;
}
