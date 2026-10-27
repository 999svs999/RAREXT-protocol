/**
 * The one digest shape the protocol primitives accept. `@rarext/core` never
 * imports a hash implementation: the server passes node:crypto, the browser
 * passes WebCrypto, and the same math runs on both sides.
 */
export type Sha256 = (bytes: Uint8Array) => Uint8Array;

export function toHex(bytes: Uint8Array): string {
  let output = "";

  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }

  return output;
}

/** sha256 of a UTF-8 string, rendered as lowercase hex. */
export function sha256Hex(sha256: Sha256, value: string): string {
  return toHex(sha256(new TextEncoder().encode(value)));
}
