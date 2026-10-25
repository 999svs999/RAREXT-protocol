/**
 * Declarations for scripts/png-raster.mjs, so tests can exercise the real
 * encoder that the proof pipeline uses instead of a stand-in.
 */

export declare function crc32(bytes: Uint8Array): number;

export declare function encodePngRaster(
  raster: Uint8Array,
  width: number,
  height?: number,
): Uint8Array;
