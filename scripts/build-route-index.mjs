#!/usr/bin/env node
/**
 * Build the route index: the API's surface as a machine-readable artifact.
 *
 * docs/ARCHITECTURE.md publishes a table of every route — method, path, request body, response
 * shape — and the checker already holds that table against the guards in apps/api/src/app.ts. What
 * it did not do was PUBLISH the table in a form a program can read: a stranger (human or agent)
 * wanting to consume the protocol had to fetch and parse the docs.
 *
 * This writes the same table out as JSON, and the checker holds all three in agreement — the doc,
 * this artifact, and the code — so the published surface cannot drift from the implemented one in
 * either direction. The cells are kept as the documentation's OWN words rather than being
 * re-typed: inventing a schema here would be a second statement of the contract, and a second
 * statement is how a contract starts lying. Where a route has a real JSON Schema (the resolve
 * outcome), the index says where it is instead of paraphrasing it.
 *
 *   node scripts/build-route-index.mjs [--check]
 *
 * --check writes nothing and exits non-zero if the on-disk artifact differs (used by CI to prove
 * the published file is current rather than trusting whoever last ran the generator).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(root, "docs", "ARCHITECTURE.md");
const OUT = join(root, "site", "schema", "routes.json");

/** The route table: `| METHOD | `path` | body | response |`, in the doc's own order. */
export function routeIndexFromDoc(doc) {
  const routes = [];
  for (const line of doc.split("\n")) {
    const match = line.match(/^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|/);
    if (!match) continue;
    routes.push({
      method: match[1],
      path: match[2].trim(),
      body: match[3].trim().replace(/^—$/, "none"),
      response: match[4].trim(),
    });
  }
  return routes;
}

export function buildRouteIndex() {
  const doc = readFileSync(DOC, "utf8");
  const routes = routeIndexFromDoc(doc);
  return {
    kind: "rarext.routes.v1",
    note: "The API surface, generated from docs/ARCHITECTURE.md's route table. Held in agreement with the documentation and with the route guards in apps/api/src/app.ts by scripts/claim-check.mjs, so it cannot drift from what the node serves. Cells are the documentation's own words.",
    schemas: { "resolve outcome": "/schema/resolve-outcome.schema.json" },
    count: routes.length,
    routes,
  };
}

export function serializeRouteIndex() {
  return JSON.stringify(buildRouteIndex(), null, 2) + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const serialized = serializeRouteIndex();
  if (process.argv.includes("--check")) {
    let current = null;
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      console.error(`missing artifact: site/schema/routes.json — run: node scripts/build-route-index.mjs`);
      process.exit(1);
    }
    if (current !== serialized) {
      console.error("site/schema/routes.json is STALE — the published surface differs from the docs. Re-run: node scripts/build-route-index.mjs");
      process.exit(1);
    }
    console.log(`route index is current (${buildRouteIndex().routes.length} routes)`);
    process.exit(0);
  }
  writeFileSync(OUT, serialized);
  console.log(`wrote site/schema/routes.json (${buildRouteIndex().routes.length} routes)`);
}
