// fetch-retry.mjs — a fetch that survives a blip.
//
// The ship watchdog runs every 2h and its drift check was three bare
// `await fetch(...)` calls with no timeout and no retry. One transient network
// error therefore failed the entire ship — it happened three times in a single
// evening (2026-11-04), each time logging a cron incident and delaying the
// registry by a full cycle. A registry that is supposed to be trustworthy should
// not have its sync fail on a momentary DNS hiccup.
//
// Deliberately small: retry only on network/timeout errors plus 5xx and 429
// (which are retryable), never on a 4xx that means "your request is wrong" —
// retrying a 404 just wastes the window.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(url, opts = {}, {
  attempts = 3,
  baseDelayMs = 400,
  timeoutMs = 15_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = globalThis.fetch,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (RETRYABLE_STATUS.has(res.status) && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status} (retryable)`);
      } else {
        return res;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));   // 400ms, 800ms, …
    }
  }
  throw lastError ?? new Error(`fetch failed: ${url}`);
}
