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

/**
 * A bundle response read through the shared cap (`MAX_BUNDLE_RESPONSE_BYTES`):
 * a declared Content-Length above the cap is refused unread, and the cap holds
 * while reading even when the header is absent or lying. `fetchImpl` is
 * injectable so the cap is testable without a network; a test double may
 * return the plain response shape the shared reader needs.
 */
export declare function getBytes(
  url: string,
  fetchImpl?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<{
    ok: boolean;
    headers: { get(name: string): string | null };
    body: ReadableStream<Uint8Array> | null;
  }>,
): Promise<Uint8Array>;

export declare function pinUrl(pin: SeedPinEntry): string | null;

export declare function checkPin(
  pin: SeedPinEntry,
  seed: { bundleCid?: string } | undefined,
  fetchBytes?: (url: string) => Promise<Uint8Array>,
): Promise<{ ok: boolean; url?: string; reason: string }>;
