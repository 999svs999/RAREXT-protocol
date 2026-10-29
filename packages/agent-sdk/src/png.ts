import { deflateSync } from "node:zlib";

/**
 * Encodes a raw RGB raster as a valid 8-bit truecolour PNG — no dependencies,
 * node zlib only. The raster is the commitment (its digest is what artifacts
 * record); the PNG is one faithful encoding of it, because two encoders are free
 * to produce different deflate streams for the same pixels. Keeping the rule
 * "digest the raster, not the file" is what lets a browser verify the image
 * without agreeing with node on compression details.
 *
 * It lives here so a resident can ship the SAME artifact shape a registry
 * publishes — a rendition beside the values, not just the values — and so there
 * is one encoder rather than one per caller.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePngRaster(raster: Uint8Array, width: number, height: number = width): Buffer {
  if (!(raster instanceof Uint8Array)) throw new Error("encodePngRaster: raster must be a Uint8Array");
  if (!Number.isInteger(width) || width < 1) throw new Error("encodePngRaster: bad width");
  if (!Number.isInteger(height) || height < 1) throw new Error("encodePngRaster: bad height");
  if (raster.length !== width * height * 3) {
    throw new Error(`encodePngRaster: expected ${width * height * 3} bytes, got ${raster.length}`);
  }

  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    Buffer.from(raster.buffer, raster.byteOffset + y * stride, stride).copy(raw, y * (1 + stride) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
