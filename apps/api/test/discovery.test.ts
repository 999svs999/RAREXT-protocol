import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import type { Bundle } from "../../../packages/core/src/index.ts";
import { start, stop } from "./helpers.ts";
import { RarextStore } from "../src/store.ts";
import { verifyBundle } from "../src/bundle.ts";
import { cidV1Raw } from "../src/adapters/content.ts";
import { DEFAULT_DISCOVERY_SEED, discoverySeeds } from "../src/discovery.ts";
import {
  DAY,
  announcementSigner,
  iso,
  otherSigner,
  signedAnnouncement,
} from "../../../packages/agent-sdk/test/announcement-fixtures.ts";

/**
 * `GET /v1/discovery` — the announcement layer as an operating surface.
 *
 * The route folds the operator's seeds through THIS server's identities and
 * reports which location answered and whose keys said so. Two properties are
 * the point of it, and both are tested rather than asserted in prose: the route
 * takes no location from the caller (no SSRF surface to hand a stranger), and it
 * never answers 200 for a bundle that did not verify.
 */

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as Bundle;
const computedRoot = verifyBundle(committed).computedRoot;
assert.ok(computedRoot, "the committed bundle recomputes a root");
const pinnedRoot = computedRoot as string;
const pinnedCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));

const ANNOUNCER = "operator-alice";

/** A fixture origin standing in for the network, logging every request it gets. */
async function origin() {
  const requests: string[] = [];
  const routes = new Map<string, string>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(req.url ?? "");
    const payload = routes.get(req.url ?? "");
    if (payload === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  routes.set("/registry/bundle.json", JSON.stringify(committed));
  routes.set("/mirror/bundle.json", JSON.stringify(committed));

  return {
    requests,
    base,
    urls: {
      seed: `${base}/seed.json`,
      registry: `${base}/registry/bundle.json`,
      mirror: `${base}/mirror/bundle.json`,
      announcements: `${base}/announcements.json`,
    },
    publishSeed: (urls: { registry: string; mirror: string; announcements?: string | string[] }) => {
      const announcements =
        urls.announcements === undefined
          ? undefined
          : Array.isArray(urls.announcements)
            ? urls.announcements
            : [urls.announcements];
      routes.set(
        "/seed.json",
        JSON.stringify({
          url: `${base}/seed.json`,
          bundle: urls.registry,
          bundleRoot: pinnedRoot,
          bundleCid: pinnedCid,
          ...(announcements ? { announcements } : {}),
        }),
      );
    },
    publishAnnouncements: (records: unknown[]) =>
      routes.set("/announcements.json", JSON.stringify(records)),
    down: (path: string) => routes.delete(path),
    close: () => server.close(),
  };
}

function storeKnowing(signer: ReturnType<typeof announcementSigner>): RarextStore {
  const store = new RarextStore();
  store.addIdentity({
    handle: ANNOUNCER,
    keyId: signer.keyId,
    algorithm: signer.suite,
    publicKey: signer.publicKey as never,
    createdAt: iso(-400 * DAY),
  });
  return store;
}

test("discovery reports which location answered and whose keys verified it", async () => {
  const signer = announcementSigner();
  const net = await origin();
  const app = await start(storeKnowing(signer), { discoverySeeds: [net.urls.seed] , discoveryFetch: fetch });
  try {
    const record = signedAnnouncement(signer, {
      bundle: net.urls.registry,
      mirror: net.urls.mirror,
      bundleRoot: pinnedRoot,
    });
    net.publishSeed(net.urls);
    net.publishAnnouncements([record]);
    // The seed's own copy goes away: only the announcement can produce a
    // candidate, so a report that names the mirror proves resolution ran.
    net.down("/registry/bundle.json");

    const response = await fetch(`${app.base}/v1/discovery`);
    assert.equal(response.status, 200);
    const report = (await response.json()) as {
      source: string;
      root: string;
      candidates: number;
      announcements: { status: string }[];
    };

    assert.equal(report.root, pinnedRoot, "the report's root is the recomputed one");
    assert.equal(report.source, net.urls.mirror, "the report names the location that answered");
    assert.equal(report.candidates, 2, "the union held both candidates");
    assert.ok(
      report.announcements.some((event) => event.status === "accepted"),
      `the announcement that nominated the mirror is reported as accepted: ${JSON.stringify(report.announcements)}`,
    );
  } finally {
    await stop(app.server);
    net.close();
  }
});

test("the route takes no location from the caller", async () => {
  const signer = announcementSigner();
  const net = await origin();
  const app = await start(storeKnowing(signer), { discoverySeeds: [net.urls.seed], discoveryFetch: fetch });
  try {
    net.publishSeed(net.urls);

    // A caller names a location. The route must not go there — this is the SSRF
    // line: a server that fetches a client's URL is a proxy into whatever it can
    // reach, and it would also let a stranger choose what the report says.
    const attacker = "http://169.254.169.254/latest/meta-data/";
    const response = await fetch(`${app.base}/v1/discovery?seed=${encodeURIComponent(attacker)}`);
    assert.equal(response.status, 200, "the operator's seed still answers");

    assert.ok(
      !net.requests.some((url) => url.includes("169.254.169.254")),
      "the fixture never saw the caller's location",
    );
    assert.ok(
      net.requests.includes("/seed.json"),
      `the configured seed WAS read: ${JSON.stringify(net.requests)}`,
    );
  } finally {
    await stop(app.server);
    net.close();
  }
});

test("a bundle nothing verified is a 502 carrying the refusals", async () => {
  const signer = announcementSigner();
  const net = await origin();
  // An EMPTY store: the server owns the seed, but vouches for no handle — so
  // the announcement that nominates the mirror cannot be believed.
  const app = await start(new RarextStore(), { discoverySeeds: [net.urls.seed], discoveryFetch: fetch });
  try {
    const record = signedAnnouncement(otherSigner(), {
      bundle: net.urls.registry,
      mirror: net.urls.mirror,
      bundleRoot: pinnedRoot,
    });
    net.publishSeed(net.urls);
    net.publishAnnouncements([record]);
    net.down("/registry/bundle.json");

    const response = await fetch(`${app.base}/v1/discovery`);
    assert.equal(response.status, 502, "an unverified bundle is never a 200");
    const body = (await response.json()) as { error: string; refusals: string[] };
    assert.ok(body.refusals.length > 0, "the refusals come with it, not a bare code");
    assert.match(
      body.refusals.join("\n"),
      /operator-alice|no key history|vouch/,
      `the refusal names the reason: ${JSON.stringify(body.refusals)}`,
    );
  } finally {
    await stop(app.server);
    net.close();
  }
});

test("the configured seeds are the operator's, and the default is the published one", () => {
  assert.deepEqual(discoverySeeds({}), [DEFAULT_DISCOVERY_SEED]);
  assert.deepEqual(discoverySeeds({ RAREXT_DISCOVERY_SEEDS: "" }), [DEFAULT_DISCOVERY_SEED]);
  assert.deepEqual(discoverySeeds({ RAREXT_DISCOVERY_SEEDS: " https://a/seed.json , https://b/seed.json " }), [
    "https://a/seed.json",
    "https://b/seed.json",
  ]);
});
