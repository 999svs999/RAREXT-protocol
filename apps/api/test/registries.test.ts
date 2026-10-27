import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registrySeedList } from "../src/registries.ts";

/**
 * The seed list had no tests at all: one default entry, read by one route.
 * These cover the shapes an operator actually reaches for — inline JSON, a file,
 * a broken file, an empty list — and the rule they share: anything that does not
 * say where to look falls back to the known list rather than inventing one.
 */

const ORIGINAL = process.env.RAREXT_REGISTRIES;

test.afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RAREXT_REGISTRIES;
  else process.env.RAREXT_REGISTRIES = ORIGINAL;
});

test("with nothing configured, the list is the known reference deployment", () => {
  delete process.env.RAREXT_REGISTRIES;
  const list = registrySeedList();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "apesdaily");
  assert.equal(list[0].seed, null, "no seed named: the convention applies");
});

test("an inline list overrides the default, and normalises through core", () => {
  process.env.RAREXT_REGISTRIES = JSON.stringify([
    { id: "one", url: "https://one.example" },
    { id: "two", url: "https://two.example", seed: "https://two.example/s.json", chains: ["base"] },
  ]);
  const list = registrySeedList();
  assert.deepEqual(
    list.map((entry) => entry.id),
    ["one", "two"],
  );
  assert.equal(list[0].operator, "", "an absent operator is empty, not undefined");
  assert.deepEqual(list[0].chains, []);
  assert.equal(list[1].seed, "https://two.example/s.json");
});

test("a file path is read, and a broken or useless one falls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-registries-"));
  try {
    const good = join(dir, "registries.json");
    writeFileSync(good, JSON.stringify({ registries: [{ id: "file", url: "https://file.example" }] }));
    process.env.RAREXT_REGISTRIES = good;
    assert.equal(registrySeedList()[0].id, "file");

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    process.env.RAREXT_REGISTRIES = broken;
    assert.equal(registrySeedList()[0].id, "apesdaily", "a broken file does not become an empty network");

    // A list whose entries do not say where to look is an empty list, and an
    // empty list falls back: silence is not permission to have no registries.
    process.env.RAREXT_REGISTRIES = JSON.stringify([{ id: "no-url" }]);
    assert.equal(registrySeedList()[0].id, "apesdaily");

    process.env.RAREXT_REGISTRIES = join(dir, "missing.json");
    assert.equal(registrySeedList()[0].id, "apesdaily", "a missing file is not an outage of the default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
