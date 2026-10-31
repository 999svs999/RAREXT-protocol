import assert from "node:assert/strict";
import test from "node:test";

import { URL_POLICY_REFUSAL_CODE, fetchWithUrlPolicy } from "../src/index.ts";

test("a policy refusal is machine-distinguishable from a network failure", async () => {
  // The distinction a caller has to make: "this client declined to look" is a decision, and
  // "this host could not be reached" is a failure. Matching the message text gets it wrong the
  // first time the wording changes, so the refusal carries a code — and this holds it.
  let requested = 0;
  const fetchImpl: typeof fetch = async () => {
    requested += 1;
    throw new Error("should not have been reached: the policy refuses before the request");
  };

  await assert.rejects(
    () => fetchWithUrlPolicy("http://127.0.0.1:1/.well-known/rarext.json", {}, { fetch: fetchImpl }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, URL_POLICY_REFUSAL_CODE);
      assert.match(error.message, /private or link-local/);
      return true;
    },
  );
  assert.equal(requested, 0, "a refused URL is not contacted at all");

  // And a genuinely unreachable host is NOT tagged as a refusal.
  const unreachable: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    () => fetchWithUrlPolicy("https://example.com/x", {}, { fetch: unreachable }),
    (error: Error & { code?: string }) => {
      assert.notEqual(error.code, URL_POLICY_REFUSAL_CODE);
      return true;
    },
  );
});
