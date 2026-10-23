// Trac `trac1…` addresses are bech32m ("trac" prefix, 32-byte Ed25519 key). The
// wire format RESET signs is the 64-hex key, so links normalize either spelling
// to hex before verification. Ported from Trac-Systems/reset's trac-address.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M = 0x2bc830a3;
const HRP = "trac";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HEX32 = /^[0-9a-f]{64}$/;

function polymod(values: number[]): number {
  let checksum = 1;

  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;

    for (let index = 0; index < 5; index += 1) {
      if ((top >>> index) & 1) checksum ^= GEN[index];
    }
  }

  return checksum >>> 0;
}

function hrpExpand(): number[] {
  const codes = [...HRP].map((char) => char.charCodeAt(0));

  return [...codes.map((code) => code >> 5), 0, ...codes.map((code) => code & 31)];
}

export function tracToHex(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 90) return null;

  const text = value === value.toUpperCase() ? value.toLowerCase() : value;

  if (
    text !== text.toLowerCase() ||
    text.lastIndexOf("1") !== HRP.length ||
    !text.startsWith(HRP)
  ) {
    return null;
  }

  const data: number[] = [];

  for (const char of text.slice(HRP.length + 1)) {
    const index = CHARSET.indexOf(char);
    if (index < 0) return null;
    data.push(index);
  }

  if (data.length < 7 || polymod([...hrpExpand(), ...data]) !== BECH32M) return null;

  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const item of data.slice(0, -6)) {
    accumulator = ((accumulator << 5) | item) & 0xfff;
    bits += 5;

    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }

  if (bits >= 5 || (accumulator & ((1 << bits) - 1)) !== 0 || bytes.length !== 32) {
    return null;
  }

  return Buffer.from(bytes).toString("hex");
}

export function hexToTrac(hex: unknown): string | null {
  if (typeof hex !== "string" || !HEX32.test(hex)) return null;

  const data: number[] = [];
  let accumulator = 0;
  let bits = 0;

  for (const byte of Buffer.from(hex, "hex")) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      data.push((accumulator >> bits) & 31);
    }
  }

  if (bits) data.push((accumulator << (5 - bits)) & 31);

  const mod = polymod([...hrpExpand(), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  const checksum = [0, 1, 2, 3, 4, 5].map((index) => (mod >>> (5 * (5 - index))) & 31);

  return `${HRP}1${[...data, ...checksum].map((item) => CHARSET[item]).join("")}`;
}

export function canonicalTracAddress(value: string): string | null {
  if (HEX32.test(value)) return value;

  return tracToHex(value);
}
