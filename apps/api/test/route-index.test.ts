import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildRouteIndex, serializeRouteIndex } from "../../../scripts/build-route-index.mjs";

const ARTIFACT = new URL("../../../site/schema/routes.json", import.meta.url);
const DOC = new URL("../../../docs/ARCHITECTURE.md", import.meta.url);

test("the published route index is a faithful, current extract of the documentation", () => {
  const onDisk = readFileSync(ARTIFACT, "utf8");
  const index = JSON.parse(onDisk);

  // It IS the route index, and it says so — a consumer should not have to guess the shape.
  assert.equal(index.kind, "rarext.routes.v1");
  assert.equal(typeof index.note, "string");
  assert.ok(index.note.length > 40, "the index explains what it is");

  // Counted honestly: the declared count is the number of routes actually listed.
  assert.ok(Array.isArray(index.routes));
  assert.equal(index.count, index.routes.length);
  assert.ok(index.routes.length >= 30, "the surface is large; a three-route index would be a lie of omission");

  // Every row is complete: a route with no response shape tells a consumer nothing.
  for (const route of index.routes) {
    assert.match(route.method, /^(GET|POST|PUT|DELETE|PATCH)$/, `${route.path} has a real method`);
    assert.match(route.path, /^\//, `${route.method} has an absolute path`);
    assert.ok(typeof route.response === "string" && route.response.length > 0, `${route.method} ${route.path} declares a response`);
    assert.ok(typeof route.body === "string" && route.body.length > 0, `${route.method} ${route.path} declares a body (or "none")`);
  }

  // Its own parse of the doc must agree — the test does not simply trust the generator.
  const fromDoc = readDocTable(readFileSync(DOC, "utf8"));
  assert.deepEqual(
    index.routes.map((route: { method: string; path: string }) => `${route.method} ${route.path}`),
    fromDoc,
    "the artifact lists exactly the routes the documentation publishes, in order",
  );

  // And the committed bytes came from the committed generator: regeneration is a no-op, so the
  // file on disk is current rather than whatever a past session happened to leave behind.
  assert.equal(serializeRouteIndex(), onDisk, "site/schema/routes.json is current — re-run scripts/build-route-index.mjs");
  assert.equal(buildRouteIndex().count, index.count);
});

/** The doc's table, re-parsed here independently of the generator. */
function readDocTable(doc: string): string[] {
  const routes: string[] = [];
  for (const line of doc.split("\n")) {
    const match = line.match(/^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`([^`]+)`\s*\|/);
    if (match) routes.push(`${match[1]} ${match[2].trim()}`);
  }
  return routes;
}
