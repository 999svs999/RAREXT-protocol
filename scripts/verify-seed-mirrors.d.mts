/**
 * Declarations for scripts/verify-seed-mirrors.mjs, so the pin check the live
 * runner performs can be exercised in the tests against a local fake service
 * rather than a stand-in that only looks like the script's own code.
 */

/** One `seed.pins` entry as the checker reads it. */
export interface SeedPinEntry {
  cid: string;
  service?: string;
  reference?: string;
  error?: string;
}

export declare function getBytes(url: string): Promise<Uint8Array>;

export declare function pinUrl(pin: SeedPinEntry): string | null;

export declare function checkPin(
  pin: SeedPinEntry,
  seed: { bundleCid?: string } | undefined,
  fetchBytes?: (url: string) => Promise<Uint8Array>,
): Promise<{ ok: boolean; url?: string; reason: string }>;
