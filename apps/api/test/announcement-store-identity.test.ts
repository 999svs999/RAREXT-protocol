import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import type { Bundle } from "../../../packages/core/src/index.ts";
import { RarextStore } from "../src/store.ts";
import { bundleFromSeedForStore, verifyBundle } from "../src/bundle.ts";
import { cidV1Raw } from "../src/adapters/content.ts";
import { announcementIdentityForStore } from "../src/announcement-identity.ts";
import {
  DAY,
  announcementSigner,
  iso,
  otherSigner,
  signedAnnouncement,
} from "../../../packages/agent-sdk/test/announcement-fixtures.ts";

/**
 * The API resolving announcements from ITS OWN store.
 *
 * Before this, the server owned the identities, the rotations and the
 * revocations, and its discovery path passed core's `unresolvedIdentity` — so a
 * record carrying no public key was refused as unresolvable no matter what the
 * store knew. The first test is the case that was impossible then.
 */

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as Bundle;
const computedRoot = verifyBundle(committed).computedRoot;
assert.ok(computedRoot, "the committed bundle recomputes a root");
const pinnedRoot = computedRoot as string;
const pinnedCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));

const ANNOUNCER = "operator-alice";

type Announcement = ReturnType<typeof signedAnnouncement>;

/** One origin serving the committed bundle at two distinct paths. */
interface Fixture {
  urls: { registry: string; mirror: string; announcements: string };
  publish(records: Announcement[]): void;
  /** Take a route down, so what answers can only be the nominated mirror. */
  down(path: string): void;
  close(): void;
}

async function fixture(): Promise<Fixture> {
  const routes = new Map<string, string>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  routes.set("/announcements.json", "[]");

  return {
    urls: {
      registry: `${base}/registry/bundle.json`,
      mirror: `${base}/mirror/bundle.json`,
      announcements: `${base}/announcements.json`,
    },
    publish: (records) => routes.set("/announcements.json", JSON.stringify(records)),
    down: (path) => routes.delete(path),
    close: () => server.close(),
  };
}

/** The record with NO public key in the envelope: resolution is the only source. */
function keyless(record: Announcement): Announcement {
  const copy: { [key: string]: unknown } = { ...record };
  delete copy.publicKey;
  return copy as unknown as Announcement;
}

function seedPointingAt(urls: Fixture["urls"]) {
  return {
    url: "https://registry.example/seed.json",
    bundle: urls.registry,
    bundleRoot: pinnedRoot,
    bundleCid: pinnedCid,
    announcements: [urls.announcements],
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

type Event = { status: string; reason?: string };

function refusals(events: Event[]): string {
  const skipped = events.find((event) => event.status !== "accepted" && event.status !== "verified");
  assert.ok(skipped, `the refusal must be REPORTED, not silent: ${JSON.stringify(events)}`);
  return String(skipped.reason);
}

test("a keyless record is believed through the API's own store", async () => {
  const signer = announcementSigner();
  const server = await fixture();
  try {
    const record = keyless(
      signedAnnouncement(signer, {
        bundle: server.urls.registry,
        mirror: server.urls.mirror,
        bundleRoot: pinnedRoot,
      }),
    );
    server.publish([record]);
    // The seed's OWN copy goes away, so only resolution can produce a candidate:
    // if the store were not consulted, there is nothing left to serve this.
    server.down("/registry/bundle.json");

    const events: Event[] = [];
    const found = await bundleFromSeedForStore(seedPointingAt(server.urls), storeKnowing(signer), {
      onAnnouncement: (event) => events.push(event as Event),
    });

    assert.equal(found.root, pinnedRoot, "the announced mirror rebuilt the pinned root");
    assert.equal(found.source, server.urls.mirror, "the NOMINATED mirror is what served it");
  } finally {
    server.close();
  }
});

test("the same keyless record is refused when the store vouches for a different key", async () => {
  const signer = announcementSigner();
  const server = await fixture();
  try {
    const record = keyless(
      signedAnnouncement(signer, {
        bundle: server.urls.registry,
        mirror: server.urls.mirror,
        bundleRoot: pinnedRoot,
      }),
    );
    server.publish([record]);
    server.down("/registry/bundle.json"); // no other source may answer

    const events: Event[] = [];
    await assert.rejects(
      () =>
        bundleFromSeedForStore(seedPointingAt(server.urls), storeKnowing(otherSigner()), {
          onAnnouncement: (event) => events.push(event as Event),
        }),
      /no candidate rebuilt the pinned root/,
    );

    assert.match(refusals(events), new RegExp(ANNOUNCER), "the refusal names the handle");
  } finally {
    server.close();
  }
});

test("a revoked key is refused even though its window is valid", async () => {
  const signer = announcementSigner();
  const server = await fixture();
  try {
    const record = signedAnnouncement(signer, {
      bundle: server.urls.registry,
      mirror: server.urls.mirror,
      bundleRoot: pinnedRoot,
    });
    server.publish([record]);
    server.down("/registry/bundle.json"); // no other source may answer

    const store = storeKnowing(signer);
    store.addRevocation({
      id: "rev-1",
      kind: "capability",
      target: signer.keyId,
      reason: "key compromised",
      issuer: ANNOUNCER,
      issuedAt: iso(0),
    });

    const events: Event[] = [];
    await assert.rejects(
      () =>
        bundleFromSeedForStore(seedPointingAt(server.urls), store, {
          onAnnouncement: (event) => events.push(event as Event),
        }),
      /no candidate rebuilt the pinned root/,
    );

    assert.match(refusals(events), /revok/i, "the refusal names the revocation");
  } finally {
    server.close();
  }
});

test("an unknown handle is refused, and the store is what decides", async () => {
  const signer = announcementSigner();
  const server = await fixture();
  try {
    const record = keyless(
      signedAnnouncement(signer, {
        bundle: server.urls.registry,
        mirror: server.urls.mirror,
        bundleRoot: pinnedRoot,
      }),
    );
    server.publish([record]);
    server.down("/registry/bundle.json"); // no other source may answer

    // An EMPTY store: nothing is known, so nothing is believed.
    const events: Event[] = [];
    await assert.rejects(
      () =>
        bundleFromSeedForStore(seedPointingAt(server.urls), new RarextStore(), {
          onAnnouncement: (event) => events.push(event as Event),
        }),
      /no candidate rebuilt the pinned root/,
    );
    assert.match(refusals(events), /no key history/, "the reason is the missing history");

    // The contrast is the proof that the STORE decided: byte-identical record,
    // believed by a store that knows the handle.
    const found = await bundleFromSeedForStore(seedPointingAt(server.urls), storeKnowing(signer));
    assert.equal(found.source, server.urls.mirror, "believed once the store knows the handle");
  } finally {
    server.close();
  }
});

test("the adapter answers the port and decides nothing", async () => {
  const signer = announcementSigner();
  const store = storeKnowing(signer);
  const port = announcementIdentityForStore(store);

  const history = await port.resolveKeys(ANNOUNCER);
  assert.ok(history, "a known handle resolves");
  assert.equal(history.identity.keyId, signer.keyId);
  assert.deepEqual(history.rotations, []);

  assert.equal(await port.resolveKeys("nobody"), null, "an unknown handle answers null, NOT an empty history");
  assert.equal(await port.revokedKey(signer.keyId), null, "an unrevoked key answers null");

  store.addRevocation({
    id: "rev-2",
    kind: "capability",
    target: signer.keyId,
    reason: "compromised",
    issuer: ANNOUNCER,
    issuedAt: iso(0),
  });
  const revocation = await port.revokedKey(signer.keyId);
  assert.ok(revocation, "a revoked key answers the revocation");
  assert.equal(revocation.target, signer.keyId);
  assert.equal(revocation.reason, "compromised");
});
