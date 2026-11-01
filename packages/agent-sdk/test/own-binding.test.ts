import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseSiteBindingDocument,
  verifySiteBinding,
} from "../../core/src/index.ts";

/**
 * The reference deployment eats its own cooking: the origin's published binding
 * (site/.well-known/rarext.json) is parsed with the same rule any stranger's
 * site would be, and verified against the pin in the seed published beside the
 * bundle it names. Nothing here is hand-written in the test — both inputs are
 * the committed artifacts, and a republish that moves the root MUST regenerate
 * the binding or this test (and the checker) fails.
 */
test("the reference deployment's own binding verifies against its own registry", () => {
  const bindingText = readFileSync(
    new URL("../../../site/.well-known/rarext.json", import.meta.url),
    "utf8",
  );
  const seed = JSON.parse(
    readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8"),
  ) as { bundleRoot: string };

  const parsed = parseSiteBindingDocument(bindingText);
  assert.ok(parsed.ok, `the published binding does not parse: ${parsed.ok ? "" : parsed.reason}`);

  const verdict = verifySiteBinding(parsed.binding, {
    pinnedRoot: seed.bundleRoot,
    expectedRegistry: "rarext",
  });
  assert.equal(
    verdict.ok,
    true,
    `the origin's own binding does not verify against its own seed: ${verdict.ok ? "" : verdict.reason}`,
  );
  assert.equal(parsed.binding.registry, "rarext");
  assert.equal(parsed.binding.root, seed.bundleRoot);
});
