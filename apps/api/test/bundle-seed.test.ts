import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { bundleFromSeed, verifyBundle, type Bundle } from "../src/bundle.ts";
import { cidV1Raw } from "../src/adapters/content.ts";
import { MAX_BUNDLE_RESPONSE_BYTES } from "../../../packages/core/src/index.ts";

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

    // THE CONTENT ADDRESS: when the seed pins a CID, the client hashes the
    // bytes it received. The server serves compact JSON, so the pin is computed
    // over exactly those bytes — the positive control.
    const servedBytes = Buffer.from(JSON.stringify(committed), "utf8");
    const cid = cidV1Raw(servedBytes);
    const withCid = await bundleFromSeed({
      bundle: `${base}/mirror/bundle.json`,
      bundleRoot: pinnedRoot,
      bundleCid: cid,
    });
    assert.equal(withCid.source, `${base}/mirror/bundle.json`);

    // And a mirror serving a bundle that verifies perfectly and rebuilds the
    // pinned root, but whose BYTES hash elsewhere, is refused: the pointer is
    // a hash, and a hash cannot be re-serialized into being. The re-serialized
    // copy below is semantically the same bundle with different whitespace —
    // the published shape (pretty-printed with a trailing newline), which this
    // test's server does not serve.
    const reserialized = Buffer.from(JSON.stringify(committed, null, 2) + "\n", "utf8");
    const otherCid = cidV1Raw(reserialized);
    assert.notEqual(otherCid, cid, "the fixture must serve different bytes");
    await assert.rejects(
      () =>
        bundleFromSeed({
          bundle: `${base}/mirror/bundle.json`,
          bundleRoot: pinnedRoot,
          bundleCid: otherCid,
        }),
      (error: Error) => {
        assert.match(error.message, /serves .* the seed pins /);
        assert.match(error.message, new RegExp(cid.slice(0, 12)));
        return true;
      },
      "a re-serialized copy of the same bundle must be refused by the CID pin",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a candidate that answers oversized is refused at the cap, and the next candidate still wins", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  // Three hostile shapes a mirror can take, each answered before the body is
  // fully materialized: a LYING Content-Length (declares a huge body, serves
  // an honest one), an HONEST-but-huge Content-Length (declares 2 GiB), and a
  // body that simply STREAMS past the cap with no Content-Length at all.
  const streamedPast: number[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (url === "/lying/bundle.json") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(4 * 1024 * 1024 * 1024),
      });
      response.end(JSON.stringify(committed));
      return;
    }
    if (url === "/huge/bundle.json") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024 * 1024),
      });
      response.end();
      return;
    }
    if (url === "/streaming/bundle.json") {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      let written = 0;
      const writeMore = () => {
        while (written < 32 * 1024 * 1024) {
          if (response.destroyed || request.destroyed) return;
          written += chunk.length;
          streamedPast.push(written);
          if (!response.write(chunk)) {
            response.once("drain", writeMore);
            return;
          }
        }
        response.end();
      };
      writeMore();
      return;
    }
    if (url === "/mirror/bundle.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(committed));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    for (const hostile of ["lying", "huge", "streaming"]) {
      const found = await bundleFromSeed({
        bundle: `${base}/${hostile}/bundle.json`,
        bundleRoot: pinnedRoot,
        mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
      });
      assert.equal(
        found.source,
        `${base}/mirror/bundle.json`,
        `the honest candidate is still accepted after a ${hostile} mirror`,
      );
    }

    // The streaming refusal happens WHILE READING — the client stops well
    // before the server stops sending — and every refusal names the cap.
    assert.ok(
      streamedPast.at(-1)! <= 2 * MAX_BUNDLE_RESPONSE_BYTES,
      `the server was cut off early (served ${streamedPast.at(-1)} bytes), not read to its end`,
    );
    await assert.rejects(
      () =>
        bundleFromSeed({
          bundle: `${base}/lying/bundle.json`,
          bundleRoot: pinnedRoot,
        }),
      (error: Error) => {
        assert.match(error.message, /lying\/bundle\.json/);
        assert.match(error.message, /declares 4294967296 bytes/);
        assert.match(error.message, new RegExp(`above the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
        return true;
      },
    );
    await assert.rejects(
      () =>
        bundleFromSeed({
          bundle: `${base}/streaming/bundle.json`,
          bundleRoot: pinnedRoot,
        }),
      (error: Error) => {
        assert.match(error.message, /streaming\/bundle\.json/);
        assert.match(error.message, new RegExp(`streamed past the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
        assert.match(error.message, /at least \d+ bytes/);
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
