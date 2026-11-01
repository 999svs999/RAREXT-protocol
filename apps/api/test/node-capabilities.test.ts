import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { NODE_CAPABILITIES, NODE_CAPABILITIES_KIND } from "../src/node-capabilities.ts";
import { start, stop } from "./helpers.ts";

const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const extract = (pattern: RegExp): Set<string> =>
  new Set([...appSource.matchAll(pattern)].map((match) => match[1] as string));
const exactRoutes = extract(/pathname === "([^"]+)"/g);
const familyRoutes = extract(/pathname\.startsWith\("([^"]+)"\)/g);

test("the capabilities document is served, and self-describes", async () => {
  const { server, base } = await start();
  try {
    const response = await fetch(`${base}/v1/capabilities`);
    assert.equal(response.status, 200);
    const document = (await response.json()) as { kind: string; rails: Array<{ path: string }>; families: string[] };
    assert.equal(document.kind, NODE_CAPABILITIES_KIND);
    assert.ok(document.rails.length > 40, "the document names the node's real surface");
    assert.ok(
      document.rails.some((rail) => rail.path === "/v1/capabilities"),
      "the document lists itself: an agent can find it again",
    );
    assert.ok(
      document.rails.some((rail) => rail.path === "/v1/work/participation"),
      "the participation rail is discoverable",
    );
  } finally {
    await stop(server);
  }
});

test("every route literal in app.ts is covered by the capabilities document", () => {
  const railPaths = new Set(NODE_CAPABILITIES.rails.map((rail) => rail.path));
  const missing: string[] = [];
  for (const route of exactRoutes) {
    const covered = railPaths.has(route) || NODE_CAPABILITIES.families.some((family) => route.startsWith(family));
    if (!covered) missing.push(route);
  }
  assert.deepEqual(missing, [], "routes missing from the capabilities document — add them, the doc cannot silently lag the node");
});

test("every entry in the capabilities document matches a real route", () => {
  for (const rail of NODE_CAPABILITIES.rails) {
    assert.ok(
      exactRoutes.has(rail.path) || familyRoutes.has(rail.path),
      `the capabilities document names ${rail.path}, but app.ts answers no such route`,
    );
  }
  for (const family of NODE_CAPABILITIES.families) {
    assert.ok(
      familyRoutes.has(family),
      `the capabilities document names family ${family}, but app.ts answers no such prefix`,
    );
  }
  // And the exact list must not DUPLICATE a family it already covers.
  for (const rail of NODE_CAPABILITIES.rails) {
    const coveredByFamily = NODE_CAPABILITIES.families.find((family) => rail.path.startsWith(family));
    assert.ok(
      coveredByFamily === undefined,
      `${rail.path} is already covered by family ${coveredByFamily} — list it once`,
    );
  }
});
