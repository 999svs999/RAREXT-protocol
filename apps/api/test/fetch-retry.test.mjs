// The ship watchdog's drift check failed three times in one evening (2026-11-04)
// on transient "fetch failed" errors — three bare fetches with no timeout and no
// retry. This pins the retry helper: network blips and retryable 5xx/429 are
// absorbed; a wrong request is not.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../../../scripts/lib/fetch-retry.mjs";

function callsThen(codes) {
  const seq = [...codes];
  let n = 0;
  return {
    calls: () => n,
    impl: async () => {
      n += 1;
      const status = seq.shift();
      return { status, body: `body-${status}` };   // helper reads res.status — return a Response shape, not a number
    },
  };
}

test("recovers from a transient network error", async () => {
  const seen = [];
  const res = await fetchWithRetry("https://x.test/", {}, {
    attempts: 3, baseDelayMs: 1, sleep: async () => {},
    fetchImpl: async (url, opts) => { seen.push(opts.signal); if (seen.length < 2) throw new Error("fetch failed"); return { status: 200, body: "ok" }; },
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2);
  for (const s of seen) assert.ok(s instanceof AbortSignal, "every attempt must carry a timeout signal");
});

test("retries 503/429 but not 404", async () => {
  const a = callsThen([503, 200]);
  const r1 = await fetchWithRetry("https://x.test/", {}, { attempts: 3, baseDelayMs: 1, sleep: async () => {}, fetchImpl: a.impl });
  assert.equal(r1.status, 200); assert.equal(a.calls(), 2, "503 is retryable");
  const b = callsThen([404]);
  const r2 = await fetchWithRetry("https://x.test/", {}, { attempts: 3, baseDelayMs: 1, sleep: async () => {}, fetchImpl: b.impl });
  assert.equal(r2.status, 404); assert.equal(b.calls(), 1, "a 404 must not be retried");
});

test("throws the last error after exhausting attempts", async () => {
  const seen = [];
  await assert.rejects(
    fetchWithRetry("https://x.test/", {}, {
      attempts: 3, baseDelayMs: 1, sleep: async () => {},
      fetchImpl: async () => { seen.push(1); throw new Error("still down"); },
    }),
  );
  assert.equal(seen.length, 3, "attempts are exhausted, then the error propagates");
});
