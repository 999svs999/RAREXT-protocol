import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  VETTED_MODELS,
  verifyFuturisticRecord,
  vettedProviderFor,
} from "../src/futuristic.ts";

/**
 * The FUTURISTIC record verifier is what the registry ASSERTS about the brand's
 * media provenance, so its generator rule is a governance surface, not a
 * formality. It previously hard-required an `agnes-video-*` id, which made the
 * brand's content anchorable from exactly one vendor; the operator widened it to
 * a vetted list (2026-11-04) so the pipeline's second free generator counts too.
 *
 * Widening may only ADD acceptable records — an already-anchored attestation
 * must keep verifying — so the manifest and the attestation trace are
 * deliberately untouched by the change, and these tests pin that down.
 */

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "20261104T114549-efc34d",
    theme: "ai-robotics-companies",
    prompt: "Future companies with AI robotics",
    model: "agnes-video-2.5-flash",
    duration_s: 5.04,
    video: { r2_url: "https://cdn.example.invalid/site/a.mp4" },
    platforms: [{ platform: "youtube", id: "7TC_v7Nmjiw" }],
    ...over,
  };
}

test("a vetted multi-provider list is loaded, not a single hard-coded vendor", () => {
  const providers = VETTED_MODELS.map((m) => m.provider);
  assert.ok(providers.includes("agnes"), "agnes must stay vetted");
  assert.ok(providers.includes("ltx"), "ltx is the extension this test exists for");
  for (const { re } of VETTED_MODELS) {
    assert.ok(re instanceof RegExp && re.source.length > 0, "every entry is a usable pattern");
  }
});

test("agnes records still hold (the widening is backward compatible)", () => {
  const verdict = verifyFuturisticRecord(validBody());
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test("an LTX-backed record now holds — it could not anchor before", () => {
  const verdict = verifyFuturisticRecord(
    validBody({ model: "Lightricks/LTX-2.5" }),
  );
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test("an unvetted generator is still refused", () => {
  for (const model of ["some-other-video-model", "agnes-imposter", "", 42, null, undefined]) {
    const verdict = verifyFuturisticRecord(validBody({ model }));
    assert.equal(verdict.ok, false, `model ${JSON.stringify(model)} must not verify`);
  }
});

test("the vetted model is matched exactly, not by substring", () => {
  // A lookalike must not slip through on a prefix/substring match.
  assert.equal(vettedProviderFor("Lightricks/LTX-2.5-evil"), null);
  assert.equal(vettedProviderFor("xLightricks/LTX-2.5"), null);
  assert.equal(vettedProviderFor("Lightricks/LTX-2.5"), "ltx");
  assert.equal(vettedProviderFor("agnes-video-2.5-flash"), "agnes");
});

test("a non-string model is refused rather than coerced", () => {
  assert.equal(vettedProviderFor(null), null);
  assert.equal(vettedProviderFor({}), null);
  assert.equal(vettedProviderFor("agnes-video-"), "agnes");
});

test("the one-line prompt doctrine still binds", () => {
  const multiline = verifyFuturisticRecord(
    validBody({ prompt: "line one\nline two" }),
  );
  assert.equal(multiline.ok, false);
  assert.ok(
    !multiline.ok && multiline.errors.some((e) => /ONE line/.test(e)),
    JSON.stringify(multiline),
  );
});

test("a retracted run can never be anchored (takedown stays a ledger fact)", () => {
  // The vetted-generator widening made the 2026-11-04 takedown run anchorable;
  // without an explicit retraction the registry would have signed a permanent
  // record of a post that no longer exists anywhere.
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  for (const rel of ["scripts/publish-futuristic.mjs", "scripts/ship-registry.mjs"]) {
    const src = readFileSync(`${root}/${rel}`, "utf8");
    assert.ok(
      /stage === "retracted"/.test(src),
      `${rel} must skip runs the operator retracted`,
    );
  }
});

test("the watchdog reads the same vetted list instead of re-hard-coding one", () => {
  // The 2026-11-04 jam was one unanchorable record stalling every anchor pass
  // because the publisher's rule and the watchdog's assumption could disagree.
  // Both now read apps/api/src/vetted-models.json; this fails if either side
  // grows its own copy again.
  // this file is <repo>/apps/api/test/, so the repo root is three levels up
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const src = readFileSync(`${root}/scripts/ship-registry.mjs`, "utf8");
  assert.ok(
    src.includes("vetted-models.json"),
    "ship-registry.mjs must read the shared vetted list",
  );
  assert.ok(
    !/startsWith\("agnes-video-"\)/.test(src),
    "ship-registry.mjs must not hard-code the agnes rule again",
  );
});
