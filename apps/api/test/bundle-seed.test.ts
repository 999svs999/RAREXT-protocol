import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  bundleFromSeed,
  bundleFromSeeds,
  verifyBundle,
  type AnnouncementEvent,
  type Bundle,
  type SeedDocument,
} from "../src/bundle.ts";
import { findVerifiedBundleFromSeeds } from "../../../packages/agent-sdk/src/index.ts";
import {
  DAY,
  announcementSigner,
  announcerIdentity,
  iso,
  signedAnnouncement,
} from "../../../packages/agent-sdk/test/announcement-fixtures.ts";
import { publicationLeaf } from "../../../packages/core/src/index.ts";
import { cidV1Raw } from "../src/adapters/content.ts";
import { createHash } from "node:crypto";
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

/**
 * The same local server, recording the path of every request it is asked for,
 * so a test can assert not only what was fetched but what never was — the
 * announcement half of RFC 0019 is entirely about a URL staying untouched.
 * The table is read per request (and may gain routes once the port is known),
 * which is also what lets a fixture name this server's own URLs.
 */
async function serveRecording(routes: Record<string, { status?: number; body: string }>) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    const route = routes[path];
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(route.status ?? 200, { "content-type": "application/json" });
    response.end(route.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    routes,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

/** Two operators' seed documents for the same registry, each carrying its provenance. */
function opSeed(url: string, seed: Omit<SeedDocument, "url">): SeedDocument {
  return { ...seed, url };
}

test("a client pooling two operators' seeds gets the union, and stops loudly on disagreement", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const tampered: Bundle = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );

  const seedA = opSeed("https://operator-a.example/seed.json", {
    bundle: "REPLACED",
    bundleRoot: pinnedRoot,
    mirrors: [{ bundle: "REPLACED", root: pinnedRoot }],
  });
  const seedB = opSeed("https://operator-b.example/seed.json", {
    bundle: "REPLACED",
    bundleRoot: pinnedRoot,
  });

  // Operator A's copy is tampered and A's only mirror is down; operator B's
  // copy is honest. The union tries every candidate and accepts B's.
  const server = serve({
    "/registry/bundle.json": { body: JSON.stringify(tampered) },
    "/mirror-a/bundle.json": { status: 404, body: JSON.stringify({ error: "not found" }) },
    "/mirror-b/bundle.json": { body: JSON.stringify(committed) },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    seedA.bundle = `${base}/registry/bundle.json`;
    seedA.mirrors![0].bundle = `${base}/mirror-a/bundle.json`;
    seedB.bundle = `${base}/mirror-b/bundle.json`;

    const found = await bundleFromSeeds([seedA, seedB]);
    assert.equal(
      found.source,
      `${base}/mirror-b/bundle.json`,
      "the copy only seed B nominated is accepted after all of seed A's candidates fail",
    );
    assert.equal(found.root, pinnedRoot);
    assert.equal(found.candidates, 3, "the union held every candidate, deduplicated");
    assert.deepEqual(found.seeds, [seedB.url], "the result says which seeds nominated the winner");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // The disagreement rule is checked BEFORE any candidate is fetched: the
  // fetch stub records every call, and zero calls must happen.
  const calls: string[] = [];
  const recording = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify(committed), { status: 200 });
  }) as typeof fetch;
  const registry = "https://registry.example/bundle.json";

  await assert.rejects(
    () =>
      bundleFromSeeds(
        [
          opSeed("https://operator-a.example/seed.json", {
            bundle: registry,
            bundleRoot: pinnedRoot,
          }),
          opSeed("https://operator-b.example/seed.json", {
            bundle: registry,
            bundleRoot: "0".repeat(64),
          }),
        ],
        { fetch: recording },
      ),
    (error: Error) => {
      assert.match(error.message, /the seeds disagree about the registry/);
      assert.match(error.message, /bundleRoot/);
      assert.match(error.message, new RegExp(pinnedRoot.slice(0, 12)));
      assert.match(error.message, /0{12}/);
      assert.match(error.message, /https:\/\/operator-a\.example\/seed\.json/);
      assert.match(error.message, /https:\/\/operator-b\.example\/seed\.json/);
      assert.deepEqual(calls, [], "a disagreement must be seen before any fetch");
      return true;
    },
    "two operators pinning different roots for the same registry must stop the resident",
  );

  // Every candidate across the union failing names refusals from BOTH seeds,
  // with the seed that nominated each failing copy.
  const failedA = opSeed("https://operator-a.example/seed.json", {
    bundle: "REPLACED",
    bundleRoot: pinnedRoot,
  });
  const failedB = opSeed("https://operator-b.example/seed.json", {
    bundle: "REPLACED",
    bundleRoot: pinnedRoot,
  });
  const honestServer = serve({
    "/absent-a.json": { status: 404, body: JSON.stringify({ error: "not found" }) },
    "/absent-b.json": { status: 404, body: JSON.stringify({ error: "not found" }) },
  });
  try {
    honestServer.listen(0, "127.0.0.1");
    await once(honestServer, "listening");
    const { port } = honestServer.address() as AddressInfo;
    failedA.bundle = `http://127.0.0.1:${port}/absent-a.json`;
    failedB.bundle = `http://127.0.0.1:${port}/absent-b.json`;
    await assert.rejects(
      () => bundleFromSeeds([failedA, failedB]),
      (error: Error) => {
        assert.match(error.message, /absent-a\.json/);
        assert.match(error.message, /absent-b\.json/);
        assert.equal((error.message.match(/HTTP 404/g) ?? []).length, 2);
        assert.match(error.message, /https:\/\/operator-a\.example\/seed\.json/);
        assert.match(error.message, /https:\/\/operator-b\.example\/seed\.json/);
        return true;
      },
      "the union's failure names every refusal, with the seed that nominated each copy",
    );
  } finally {
    honestServer.closeAllConnections();
    await new Promise<void>((resolve) => honestServer.close(() => resolve()));
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
test("one sequence, not two: the API twin and the SDK twin behave byte-identically", async () => {
  // Three candidates: the first tampered (shape refusal), the second
  // internally valid and CID-valid under its nominator's pin but a DIFFERENT
  // registry (root refusal), the third the honest copy (accepted). All three
  // failing must name every candidate in order; the honest list must accept
  // the third — identically in BOTH callers, because after `verifyCandidates`
  // moved to core there is only one sequence left to diverge.
  const nodeSha256 = (bytes: Uint8Array) =>
    new Uint8Array(createHash("sha256").update(bytes).digest());
  const committedBytes = new TextEncoder().encode(JSON.stringify(committed));
  const committedCid = cidV1Raw(committedBytes);

  const tampered: Bundle = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );
  const tamperedBytes = new TextEncoder().encode(JSON.stringify(tampered));

  const otherBundle: Bundle = structuredClone(committed);
  otherBundle.publications = otherBundle.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "another registry's record" } : publication,
  );
  otherBundle.manifest.publications = otherBundle.publications.map((publication) => ({
    id: publication.id,
    leaf: publicationLeaf(publication, nodeSha256, otherBundle.manifest.leafVersion),
  }));
  const otherRoot = verifyBundle(otherBundle).computedRoot!;
  otherBundle.manifest.root = otherRoot;
  assert.equal(verifyBundle(otherBundle).valid, true, "the fixture verifies internally");
  const otherBytes = new TextEncoder().encode(JSON.stringify(otherBundle));
  const otherCid = cidV1Raw(otherBytes);

  const server = serve({
    "/tampered/bundle.json": { body: Buffer.from(tamperedBytes).toString("utf8") },
    "/another/bundle.json": { body: Buffer.from(otherBytes).toString("utf8") },
    "/honest/bundle.json": { body: Buffer.from(committedBytes).toString("utf8") },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const pinnedRoot = committed.manifest.root;

    // All three failing: the aggregate names tampered (shape), another (root,
    // its pin passing because the nominator pins ITS bytes), and an absent
    // third URL — in candidate order — with the nominating seed named.
    const failing: SeedDocument[] = [
      { bundle: `${base}/tampered/bundle.json`, bundleRoot: pinnedRoot },
      { bundle: `${base}/another/bundle.json`, bundleRoot: pinnedRoot, bundleCid: otherCid },
      { bundle: `${base}/absent/bundle.json`, bundleRoot: pinnedRoot, bundleCid: committedCid },
    ];

    let apiError!: Error;
    try {
      await bundleFromSeeds(
        failing.map((seed) => ({ ...seed, url: "https://operator.example/seed.json" })),
      );
      assert.fail("every candidate failing must reject");
    } catch (error) {
      if (!(error instanceof Error) || /must reject/.test(error.message)) throw error;
      apiError = error;
    }
    assert.match(apiError.message, /no candidate rebuilt the pinned root/);
    assert.ok(
      apiError.message.indexOf("tampered/bundle.json") <
        apiError.message.indexOf("another/bundle.json") &&
        apiError.message.indexOf("another/bundle.json") <
          apiError.message.indexOf("absent/bundle.json"),
      `the refusals are recorded in candidate order: ${apiError.message}`,
    );
    assert.match(
      apiError.message,
      /tampered\/bundle\.json: the publications in this bundle do not rebuild the anchored root/,
    );
    assert.match(apiError.message, /another\/bundle\.json: verifies internally but rebuilds/);
    assert.match(apiError.message, /absent\/bundle\.json: HTTP 404/);
    assert.match(
      apiError.message,
      /nominated by https:\/\/operator\.example\/seed\.json/,
    );

    let sdkError!: Error;
    try {
      await findVerifiedBundleFromSeeds(
        failing.map((seed) => ({ ...seed, url: "https://operator.example/seed.json" })),
      );
      assert.fail("every candidate failing must reject");
    } catch (error) {
      if (!(error instanceof Error) || /must reject/.test(error.message)) throw error;
      sdkError = error;
    }
    assert.equal(
      sdkError.message,
      apiError.message,
      "the two callers run the one sequence: their aggregate refusals agree byte for byte",
    );

    // The tampered, pin-valid-but-root-wrong, honest list from the task: the
    // accepted source must be the third in both callers.
    const honest: SeedDocument[] = [
      { bundle: `${base}/tampered/bundle.json`, bundleRoot: pinnedRoot },
      { bundle: `${base}/another/bundle.json`, bundleRoot: pinnedRoot, bundleCid: otherCid },
      { bundle: `${base}/honest/bundle.json`, bundleRoot: pinnedRoot, bundleCid: committedCid },
    ];
    const apiFound = await bundleFromSeeds(honest.map((seed) => ({ ...seed })));
    assert.equal(apiFound.source, `${base}/honest/bundle.json`, "the third candidate verifies");
    assert.equal(apiFound.root, pinnedRoot);
    assert.equal(apiFound.candidates, 3);

    const sdkFound = await findVerifiedBundleFromSeeds(honest.map((seed) => ({ ...seed })));
    assert.equal(sdkFound.source, `${base}/honest/bundle.json`);
    assert.equal(sdkFound.root, pinnedRoot);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * RFC 0019 step 1 on the API path: `bundleFromSeed`/`bundleFromSeeds` fold the
 * seed's `announcements` through THE core fold — the same `foldAnnouncements`
 * the SDK's `findVerifiedBundleFromSeeds` calls — so the six behaviours the SDK
 * suite forces are forced here too, over loopback HTTP and with this server's
 * own identity primitives (`keyId`, `suiteFor`, `verifyPayload` from
 * `apps/api/src/identity.ts`) injected into the fold. The fixtures are signed
 * by `packages/agent-sdk/test/announcement-fixtures.ts`, the module the SDK
 * suite imports as well: one definition of what a record looks like, two
 * callers of one fold.
 */
test("a verified announcement nominates an extra mirror, and that mirror wins when the seed's own candidates fail", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;
  const honestCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));

  const tampered: Bundle = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );

  const routes: Record<string, { status?: number; body: string }> = {
    "/registry/bundle.json": { body: JSON.stringify(tampered) },
    "/mirror/bundle.json": { status: 404, body: JSON.stringify({ error: "not found" }) },
    "/announced/bundle.json": { body: JSON.stringify(committed) },
  };
  const { base, requests, close } = await serveRecording(routes);
  try {
    const registry = `${base}/registry/bundle.json`;
    const announcementUrl = `${base}/announcements.json`;
    const announcedMirror = `${base}/announced/bundle.json`;
    // The record names URLs only knowable once the server has a port, so the
    // document's route is added after listening — the table is read per
    // request, exactly as a server answers a path published later.
    routes["/announcements.json"] = {
      body: JSON.stringify([
        signedAnnouncement(announcementSigner(), {
          bundle: registry,
          mirror: announcedMirror,
          bundleRoot: pinnedRoot,
        }),
      ]),
    };

    const events: AnnouncementEvent[] = [];
    const found = await bundleFromSeeds(
      [
        {
          url: "https://registry.example/seed.json",
          bundle: registry,
          bundleRoot: pinnedRoot,
          bundleCid: honestCid,
          mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
          announcements: [announcementUrl],
        },
      ],
      { identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event) },
    );

    assert.equal(
      requests[0],
      "/announcements.json",
      "the announcement document is fetched before any candidate is",
    );
    assert.equal(
      found.source,
      announcedMirror,
      "the announced mirror is the copy that verifies after the seed's own candidates fail",
    );
    assert.equal(found.root, pinnedRoot);
    assert.equal(found.bundle.manifest.root, pinnedRoot);
    assert.equal(found.candidates, 3, "the seed's two candidates and the announced one, deduplicated");
    assert.deepEqual(
      found.seeds,
      [announcementUrl],
      "the winning copy is attributed to the announcement document that nominated it",
    );
    assert.deepEqual(events, [
      { url: announcementUrl, status: "accepted", mirror: announcedMirror },
    ]);
  } finally {
    await close();
  }
});

test("a forged announcement is reported with its reason, and the seed's own candidates still work", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const routes: Record<string, { status?: number; body: string }> = {
    "/registry/bundle.json": { body: JSON.stringify(committed) },
    // The forgery's mirror serves an honest copy on purpose: if the record
    // were pooled, this test would find it instead of the seed's own copy.
    "/evil/bundle.json": { body: JSON.stringify(committed) },
  };
  const { base, requests, close } = await serveRecording(routes);
  try {
    const registry = `${base}/registry/bundle.json`;
    const announcementUrl = `${base}/announcements.json`;
    const evilMirror = `${base}/evil/bundle.json`;

    // The forgery: the payload is edited AFTER signing, so the signature no
    // longer covers what the record claims.
    const record = signedAnnouncement(announcementSigner(), {
      bundle: registry,
      mirror: `${base}/announced/bundle.json`,
      bundleRoot: pinnedRoot,
    });
    record.announcement = { ...record.announcement, mirror: evilMirror };
    routes["/announcements.json"] = { body: JSON.stringify([record]) };

    const seed: SeedDocument = {
      url: "https://registry.example/seed.json",
      bundle: registry,
      bundleRoot: pinnedRoot,
      announcements: [announcementUrl],
    };

    const events: AnnouncementEvent[] = [];
    const found = await bundleFromSeed(seed, { identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event) });
    assert.equal(found.source, registry, "the seed's own candidate still verifies");
    assert.equal(found.root, pinnedRoot);
    assert.deepEqual(events, [
      {
        url: announcementUrl,
        status: "skipped",
        reason: "record 0: the announcement's signature does not verify",
      },
    ]);
    assert.ok(
      !requests.includes("/evil/bundle.json"),
      "a forged record must not nominate anything: its mirror is never fetched",
    );

    // And it adds no candidate either: with the seed's own copy withdrawn, the
    // search must fail on the seed's 404 rather than fall through to the
    // honest copy the forged record pointed at.
    const fetched = [...requests];
    requests.length = 0;
    routes["/registry/bundle.json"] = { status: 404, body: JSON.stringify({ error: "not found" }) };
    await assert.rejects(
      () => bundleFromSeed(seed, { identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event) }),
      (error: Error) => {
        assert.match(error.message, /no candidate rebuilt the pinned root/);
        assert.match(error.message, /HTTP 404/);
        assert.ok(!error.message.includes("/evil/"), "the refusal names no forged location");
        return true;
      },
      "the forged record nominated no candidate, so nothing verifies",
    );
    assert.deepEqual(requests.slice(0, fetched.length), fetched, "the same two fetches, in the same order");
    assert.ok(!requests.includes("/evil/bundle.json"), "the rejected path never reaches the forged mirror either");
  } finally {
    await close();
  }
});

test("an expired announcement is discarded before the union, so its mirror is never fetched", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const routes: Record<string, { status?: number; body: string }> = {
    "/registry/bundle.json": { body: JSON.stringify(committed) },
    // Serves an honest copy, so a record that leaked past the window check
    // would win this test rather than merely escape its notice.
    "/announced/bundle.json": { body: JSON.stringify(committed) },
  };
  const { base, requests, close } = await serveRecording(routes);
  try {
    const registry = `${base}/registry/bundle.json`;
    const announcementUrl = `${base}/announcements.json`;
    const announcedMirror = `${base}/announced/bundle.json`;
    routes["/announcements.json"] = {
      body: JSON.stringify([
        signedAnnouncement(announcementSigner(), {
          bundle: registry,
          mirror: announcedMirror,
          bundleRoot: pinnedRoot,
          issuedAt: iso(-2 * DAY),
          expiresAt: iso(-DAY),
        }),
      ]),
    };

    const seed: SeedDocument = {
      url: "https://registry.example/seed.json",
      bundle: registry,
      bundleRoot: pinnedRoot,
      announcements: [announcementUrl],
    };

    // The path still works: an expired record is a skipped record, not a
    // broken search.
    const events: AnnouncementEvent[] = [];
    const found = await bundleFromSeed(seed, { identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event) });
    assert.equal(found.source, registry, "the seed's own candidate verifies despite the expired record");
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "skipped");
    assert.match(events[0].status === "skipped" ? events[0].reason : "", /expired at /);
    assert.ok(
      !requests.includes("/announced/bundle.json"),
      "an expired record is discarded before the union: its mirror URL is never fetched",
    );

    // And it entered no union: with the seed's own copy withdrawn the search
    // must fail, because the expired record's mirror would have won it.
    requests.length = 0;
    routes["/registry/bundle.json"] = { status: 404, body: JSON.stringify({ error: "not found" }) };
    await assert.rejects(
      () => bundleFromSeed(seed, { identity: announcerIdentity(),
    onAnnouncement: () => {} }),
      /no candidate rebuilt the pinned root/,
      "the expired record nominated no candidate, so the union holds only the seed's dead copy",
    );
    assert.deepEqual(requests, ["/announcements.json", "/registry/bundle.json"]);
    assert.ok(!requests.includes("/announced/bundle.json"), "the mirror of an expired record is never fetched");
  } finally {
    await close();
  }
});

test("a valid announcement contradicting the pins trips the union's loud stop, naming both", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;
  const otherRoot = "f".repeat(64);

  const routes: Record<string, { status?: number; body: string }> = {};
  const { base, requests, close } = await serveRecording(routes);
  try {
    const registry = `${base}/registry/bundle.json`;
    const announcementUrl = `${base}/announcements.json`;
    const announcedMirror = `${base}/announced/bundle.json`;
    routes["/announcements.json"] = {
      body: JSON.stringify([
        signedAnnouncement(announcementSigner(), {
          bundle: registry,
          mirror: announcedMirror,
          bundleRoot: otherRoot,
        }),
      ]),
    };

    const seed: SeedDocument = {
      url: "https://registry.example/seed.json",
      bundle: registry,
      bundleRoot: pinnedRoot,
      announcements: [announcementUrl],
    };

    let apiError!: Error;
    try {
      // A VALID announcement (resolvable, correctly signed) that contradicts
      // the pins: it must enter the union and trip the existing rule.
      await bundleFromSeed(seed, { identity: announcerIdentity() });
      assert.fail("a disagreement must reject");
    } catch (error) {
      if (!(error instanceof Error) || /must reject/.test(error.message)) throw error;
      apiError = error;
    }
    assert.match(apiError.message, /the seeds disagree about the registry/);
    assert.match(apiError.message, /bundleRoot/);
    assert.ok(
      apiError.message.includes(pinnedRoot) && apiError.message.includes(otherRoot),
      `both roots are named in full: ${apiError.message}`,
    );
    assert.ok(
      apiError.message.includes("https://registry.example/seed.json"),
      "the seed that pinned the root is named",
    );
    assert.ok(
      apiError.message.includes(announcementUrl),
      "the announcement document that contradicted it is named",
    );
    assert.deepEqual(
      requests,
      ["/announcements.json"],
      "only the announcement document is fetched: the disagreement stops before any candidate is fetched",
    );

    // The SDK path stops on the same bytes, with the same words — one
    // disagreement rule, called by both, not two that happen to agree today.
    requests.length = 0;
    let sdkError!: Error;
    try {
      await findVerifiedBundleFromSeeds([seed], { identity: announcerIdentity() });
      assert.fail("a disagreement must reject");
    } catch (error) {
      if (!(error instanceof Error) || /must reject/.test(error.message)) throw error;
      sdkError = error;
    }
    assert.equal(
      sdkError.message,
      apiError.message,
      "the two callers throw the one disagreement error, byte for byte",
    );
    assert.deepEqual(requests, ["/announcements.json"], "the SDK path fetches only the announcement document too");
  } finally {
    await close();
  }
});

test("a seed without announcements fetches only its own candidates, byte for byte as before", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const { base, requests, close } = await serveRecording({
    "/registry/bundle.json": { status: 404, body: JSON.stringify({ error: "not found" }) },
    "/mirror/bundle.json": { body: JSON.stringify(committed) },
  });
  try {
    const registry = `${base}/registry/bundle.json`;
    // Poisoned for announcement URLs: if the API path so much as looked at
    // one, the poison is recorded, the fetch throws, and this test fails.
    const touched: string[] = [];
    const poisoned = (async (url: unknown, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("announcement")) {
        touched.push(value);
        throw new Error("POISON: an announcement URL must not be fetched");
      }
      return fetch(value, init);
    }) as typeof fetch;

    const seed: SeedDocument = {
      url: "https://registry.example/seed.json",
      bundle: registry,
      bundleRoot: pinnedRoot,
      mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
    };

    const found = await bundleFromSeed(seed, { fetch: poisoned });
    assert.equal(found.source, `${base}/mirror/bundle.json`);
    assert.deepEqual(touched, [], "no announcement URL is touched when the seed carries none");
    assert.deepEqual(
      requests,
      ["/registry/bundle.json", "/mirror/bundle.json"],
      "only the seed's own candidates are fetched",
    );

    // And the refusal wording is the one the no-announcement path has always
    // produced: a single seed, one refusal, no attribution, byte for byte.
    requests.length = 0;
    await assert.rejects(
      () => bundleFromSeed({ ...seed, bundle: `${base}/absent.json`, mirrors: [] }, { fetch: poisoned }),
      (error: Error) => {
        assert.equal(
          error.message,
          `no candidate rebuilt the pinned root:\n  ${base}/absent.json: HTTP 404`,
        );
        return true;
      },
    );
    assert.deepEqual(touched, [], "the failing path fetches no announcement URL either");
    assert.deepEqual(requests, ["/absent.json"]);
  } finally {
    await close();
  }
});

test("an announcement URL that 404s is reported and skipped, and everything else works", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const routes: Record<string, { status?: number; body: string }> = {
    "/registry/bundle.json": { body: JSON.stringify(committed) },
    "/announcements.json": { status: 404, body: JSON.stringify({ error: "not found" }) },
  };
  const { base, requests, close } = await serveRecording(routes);
  try {
    const registry = `${base}/registry/bundle.json`;
    const announcementUrl = `${base}/announcements.json`;

    const events: AnnouncementEvent[] = [];
    const found = await bundleFromSeed(
      {
        url: "https://registry.example/seed.json",
        bundle: registry,
        bundleRoot: pinnedRoot,
        announcements: [announcementUrl],
      },
      { identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event) },
    );

    assert.equal(found.source, registry, "the unreachable announcement does not stop the search");
    assert.equal(found.root, pinnedRoot);
    assert.deepEqual(events, [
      { url: announcementUrl, status: "skipped", reason: "HTTP 404" },
    ]);
    assert.deepEqual(requests, ["/announcements.json", "/registry/bundle.json"]);
  } finally {
    await close();
  }
});

test("one fold, two callers: the API path and the SDK path report the same announcement events", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const routes: Record<string, { status?: number; body: string }> = {
    "/registry/bundle.json": { body: JSON.stringify(committed) },
    "/announced/bundle.json": { body: JSON.stringify(committed) },
    "/evil/bundle.json": { body: JSON.stringify(committed) },
    "/expired/bundle.json": { body: JSON.stringify(committed) },
    "/announcements-b.json": { status: 404, body: JSON.stringify({ error: "not found" }) },
  };
  const { base, requests, close } = await serveRecording(routes);
  try {
    const registry = `${base}/registry/bundle.json`;
    const documentUrl = `${base}/announcements.json`;
    const unreachable = `${base}/announcements-b.json`;
    const signer = announcementSigner();

    const valid = signedAnnouncement(signer, {
      bundle: registry,
      mirror: `${base}/announced/bundle.json`,
      bundleRoot: pinnedRoot,
    });
    const forged = signedAnnouncement(signer, {
      bundle: registry,
      mirror: `${base}/evil/bundle.json`,
      bundleRoot: pinnedRoot,
    });
    // The forgery: the nonce is edited AFTER signing, so the signature no
    // longer covers what the record claims.
    forged.announcement = { ...forged.announcement, nonce: "forged-after-signing" };
    const expired = signedAnnouncement(signer, {
      bundle: registry,
      mirror: `${base}/expired/bundle.json`,
      bundleRoot: pinnedRoot,
      issuedAt: iso(-2 * DAY),
      expiresAt: iso(-DAY),
    });
    routes["/announcements.json"] = { body: JSON.stringify([valid, forged, expired]) };

    const seed: SeedDocument = {
      url: "https://registry.example/seed.json",
      bundle: registry,
      bundleRoot: pinnedRoot,
      announcements: [documentUrl, unreachable],
    };

    const apiEvents: AnnouncementEvent[] = [];
    const apiFound = await bundleFromSeeds([seed], {
      identity: announcerIdentity(),
    onAnnouncement: (event) => apiEvents.push(event),
    });
    const apiRequests = [...requests];
    requests.length = 0;

    const sdkEvents: AnnouncementEvent[] = [];
    const sdkFound = await findVerifiedBundleFromSeeds([seed], {
      identity: announcerIdentity(),
    onAnnouncement: (event) => sdkEvents.push(event),
    });
    const sdkRequests = [...requests];
    requests.length = 0;

    assert.equal(apiEvents.length, 4, "the accepted, the forged, the expired, and the unreachable are each reported");
    assert.deepEqual(
      sdkEvents,
      apiEvents,
      "the SDK path reports the identical events for the identical documents",
    );
    assert.deepEqual(sdkRequests, apiRequests, "the two callers fetch the same URLs in the same order");
    assert.equal(apiFound.source, registry);
    assert.equal(sdkFound.source, apiFound.source);
    assert.equal(sdkFound.root, apiFound.root);
    assert.equal(sdkFound.candidates, apiFound.candidates);
    assert.deepEqual(sdkFound.seeds, apiFound.seeds);
    assert.equal(
      apiFound.candidates,
      2,
      "only the verified record added a candidate: the forged and expired mirrors joined neither union",
    );
  } finally {
    await close();
  }
});
