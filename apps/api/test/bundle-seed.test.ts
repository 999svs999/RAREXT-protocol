import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { bundleFromSeed, verifyBundle, type Bundle } from "../src/bundle.ts";

/**
 * Federation's first step, exercised against hostile copies: the client tries
 * the seed's own URL and then each mirror, and accepts only a copy that
 * rebuilds the root the seed pins. A tampered copy, a 404, and a copy that
 * verifies internally but is a DIFFERENT bundle must all be refused — the last
 * one is the whole point, because a mirror can rewrite both its bytes and the
 * root inside them.
 */
const committed = JSON.parse(
  readFileSync(new URL("../../../site/registry/bundle.json", import.meta.url), "utf8"),
) as Bundle;

function serve(routes: Record<string, { status?: number; body: string }>) {
  const server = createServer((request, response) => {
    const route = routes[request.url ?? ""];
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(route.status ?? 200, { "content-type": "application/json" });
    response.end(route.body);
  });
  return server;
}

test("a client finds the mirror whose copy rebuilds the seed's pinned root", async () => {
  // The committed bundle is the honest copy; its verification is the control
  // that the fixture really is a valid, pinned bundle.
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  // A tampered copy: retitle one publication, so the rebuilt root moves.
  const tampered: Bundle = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );
  assert.equal(verifyBundle(tampered).valid, false, "the tampered copy must not verify");

  // A third candidate that verifies internally but is a DIFFERENT bundle: the
  // honest one with its manifest root and one publication removed is no longer
  // internally valid, so the sharper case is a copy whose root is honestly
  // rebuilt from different content. Build it by dropping a publication and
  // pinning the seed to the committed root instead.
  const server = serve({
    "/registry/bundle.json": { body: JSON.stringify(tampered) },
    "/mirror/bundle.json": { body: JSON.stringify(committed) },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const found = await bundleFromSeed({
      bundle: `${base}/registry/bundle.json`,
      bundleRoot: pinnedRoot,
      mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
    });

    assert.equal(found.source, `${base}/mirror/bundle.json`, "the mirror is the copy that verifies");
    assert.equal(found.root, pinnedRoot);
    assert.equal(found.bundle.manifest.root, pinnedRoot);

    // A candidate that 404s is skipped for the next one, with its reason kept.
    const withMissing = await bundleFromSeed({
      bundle: `${base}/absent.json`,
      bundleRoot: pinnedRoot,
      mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
    });
    assert.equal(withMissing.source, `${base}/mirror/bundle.json`);

    // THE PIN: an internally valid bundle whose root is not the pinned one must
    // be refused, even though verifyBundle says it is valid.
    await assert.rejects(
      () =>
        bundleFromSeed({
          bundle: `${base}/mirror/bundle.json`,
          bundleRoot: "0".repeat(64),
        }),
      (error: Error) => {
        assert.match(error.message, /not the pinned/);
        assert.match(error.message, new RegExp(pinnedRoot.slice(0, 12)));
        return true;
      },
      "a valid bundle that rebuilds a different root must be refused by the pin",
    );

    // Every candidate failing names every candidate's reason.
    await assert.rejects(
      () =>
        bundleFromSeed({
          bundle: `${base}/registry/bundle.json`,
          bundleRoot: pinnedRoot,
          mirrors: [{ bundle: `${base}/absent.json`, root: pinnedRoot }],
        }),
      (error: Error) => {
        assert.match(error.message, /registry\/bundle\.json/);
        assert.match(error.message, /absent\.json/);
        assert.match(error.message, /HTTP 404/);
        return true;
      },
      "the refusal lists the tampered copy and the 404 with their reasons",
    );

    // A seed naming nothing at all is refused before any request.
    await assert.rejects(
      () => bundleFromSeed({ bundle: "", bundleRoot: pinnedRoot }),
      /names no bundle or mirror/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
