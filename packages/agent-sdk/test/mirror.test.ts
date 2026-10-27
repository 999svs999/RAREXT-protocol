import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  cidV1,
  cidV1Raw,
  findVerifiedBundle,
  verifyBundle,
  type Bundle,
} from "../src/index.ts";

/**
 * The SDK's mirror client, exercised against hostile copies: it tries the
 * seed's own URL and then each mirror, reads BYTES, and accepts only a copy
 * that hashes to the CID the seed pins and rebuilds the pinned root. A
 * tampered copy, a 404, and a re-serialized copy of the same bundle must all
 * be refused with a named reason.
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

test("the SDK finds the mirror whose bytes rebuild the seed's pinned root", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const tampered: Bundle = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );
  assert.equal(verifyBundle(tampered).valid, false, "the tampered copy must not verify");

  const honestBytes = Buffer.from(JSON.stringify(committed), "utf8");
  const honestCid = cidV1Raw(honestBytes);
  // The SDK exports the same core composition an operator uses; the only
  // difference is the digest the caller supplies.
  const nodeSha256 = (bytes: Uint8Array) =>
    new Uint8Array(createHash("sha256").update(bytes).digest());
  assert.equal(cidV1(nodeSha256, honestBytes), honestCid);

  // The same bundle with different whitespace is different bytes, hence a
  // different content address even though it verifies perfectly.
  const reserialized = JSON.stringify(committed, null, 2) + "\n";
  const reserializedCid = cidV1Raw(Buffer.from(reserialized, "utf8"));
  assert.notEqual(reserializedCid, honestCid, "the fixture must serve different bytes");

  const server = serve({
    "/registry/bundle.json": { body: JSON.stringify(tampered) },
    "/mirror/bundle.json": { body: JSON.stringify(committed) },
    "/reserialized/bundle.json": { body: reserialized },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // The seed's own copy is tampered (and therefore hashes elsewhere); the
    // mirror is honest, so the client falls through and accepts it.
    const found = await findVerifiedBundle({
      bundle: `${base}/registry/bundle.json`,
      bundleRoot: pinnedRoot,
      bundleCid: honestCid,
      mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
    });

    assert.equal(found.source, `${base}/mirror/bundle.json`, "the mirror is the copy that verifies");
    assert.equal(found.root, pinnedRoot);
    assert.equal(found.bundle.manifest.root, pinnedRoot);

    // A tampered copy is refused by the shape check, and the refusal names it.
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/registry/bundle.json`,
          bundleRoot: pinnedRoot,
        }),
      (error: Error) => {
        assert.match(error.message, /registry\/bundle\.json/);
        assert.match(error.message, /do not rebuild the anchored root/);
        return true;
      },
      "a copy whose publications rebuild another root must be refused",
    );

    // The CID pin: the reserialized copy verifies internally and rebuilds the
    // pinned root, but its bytes hash elsewhere, so it is refused.
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/reserialized/bundle.json`,
          bundleRoot: pinnedRoot,
          bundleCid: honestCid,
        }),
      (error: Error) => {
        assert.match(error.message, /serves .* the seed pins /);
        assert.match(error.message, new RegExp(honestCid.slice(0, 12)));
        return true;
      },
      "a re-serialized copy of the same bundle must be refused by the CID pin",
    );

    // Every candidate failing names every candidate's reason.
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/absent.json`,
          bundleRoot: pinnedRoot,
          mirrors: [{ bundle: `${base}/registry/bundle.json`, root: pinnedRoot }],
        }),
      (error: Error) => {
        assert.match(error.message, /absent\.json/);
        assert.match(error.message, /HTTP 404/);
        assert.match(error.message, /registry\/bundle\.json/);
        assert.match(error.message, /do not rebuild the anchored root/);
        return true;
      },
      "the refusal lists the 404 and the tampered copy with their reasons",
    );

    // A seed naming nothing at all is refused before any request.
    await assert.rejects(
      () => findVerifiedBundle({ bundle: "", bundleRoot: pinnedRoot }),
      /names no bundle or mirror/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
