import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Bundle } from "../../../packages/core/src/index.ts";
import { MAX_BUNDLE_RESPONSE_BYTES } from "../../core/src/index.ts";
import { identityFromPublishedDocuments } from "../src/published-identity.ts";
import { findVerifiedBundleFromSeeds, verifyBundle } from "../src/index.ts";
import {
  DAY,
  announcementSigner,
  iso,
  signedAnnouncement,
} from "./announcement-fixtures.ts";

/**
 * These fixtures are LOCAL servers behind nominal operator URLs — the shape the
 * address policy refuses by default, because a public document naming a private
 * bundle is how an agent gets pointed at its own network. The wrapper says this
 * file means the local case; the unwrapped function still refuses it.
 */
const localFindVerifiedBundleFromSeeds = (
  ...args: Parameters<typeof findVerifiedBundleFromSeeds>
): ReturnType<typeof findVerifiedBundleFromSeeds> =>
  findVerifiedBundleFromSeeds(args[0], { allowPrivateHosts: true, ...(args[1] ?? {}) });


/**
 * A resident with no server: the keys of the world it lives in, read from
 * published documents. This is the half of "AI lives on RAREXT" that was
 * missing — the demo's resident could READ a registry, but believing an
 * announcement needed a port only an operator's server could supply.
 */

const ANNOUNCER = "operator-alice";

/** A stub network: URL → body, with a request log and per-URL failures. */
function stubNetwork(routes: Record<string, { body: string; status?: number }>) {
  const calls: string[] = [];
  const doFetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("{}", { status: 404 });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    doFetch,
    calls,
    /** Take a route down, so what answers can only be something else. */
    down: (url: string) => {
      delete routes[url];
    },
  };
}

const identityDoc = (signer: ReturnType<typeof announcementSigner>) =>
  JSON.stringify({
    handle: ANNOUNCER,
    keyId: signer.keyId,
    algorithm: signer.suite,
    publicKey: signer.publicKey,
    createdAt: iso(-400 * DAY),
  });

test("a known handle resolves through its published documents", async () => {
  const signer = announcementSigner();
  const net = stubNetwork({
    "https://registry.example/i/operator-alice": { body: identityDoc(signer) },
    "https://registry.example/i/operator-alice/rotations": { body: "[]" },
  });

  const port = identityFromPublishedDocuments({
    identityUrl: (handle) => `https://registry.example/i/${handle}`,
    rotationsUrl: (handle) => `https://registry.example/i/${handle}/rotations`,
    fetch: net.doFetch,
  });

  const history = await port.resolveKeys(ANNOUNCER);
  assert.ok(history, "a published handle resolves");
  assert.equal(history.identity.keyId, signer.keyId);
  assert.deepEqual(history.rotations, []);
});

test("an unknown handle answers null, and nothing else is fetched for it", async () => {
  const net = stubNetwork({});
  const port = identityFromPublishedDocuments({
    identityUrl: (handle) => `https://registry.example/i/${handle}`,
    rotationsUrl: (handle) => `https://registry.example/i/${handle}/rotations`,
    fetch: net.doFetch,
  });

  assert.equal(await port.resolveKeys("nobody"), null, "unknown is null, never an empty history");
  assert.equal(net.calls.length, 1, `a 404 ends it: ${JSON.stringify(net.calls)}`);
});

test("a corrupted identity document throws instead of reading as absent", async () => {
  const net = stubNetwork({
    "https://registry.example/i/operator-alice": { body: JSON.stringify({ handle: ANNOUNCER }) },
  });
  const port = identityFromPublishedDocuments({
    identityUrl: (handle) => `https://registry.example/i/${handle}`,
    fetch: net.doFetch,
  });

  await assert.rejects(async () => {
    await port.resolveKeys(ANNOUNCER);
  }, /not an identity document/);
});

test("a revoked key is answered, the list is read once, and no list means no revocations", async () => {
  const signer = announcementSigner();
  const net = stubNetwork({
    "https://registry.example/revocations": {
      body: JSON.stringify([
        { id: "rev-1", kind: "capability", target: signer.keyId, reason: "compromised" },
      ]),
    },
  });
  const port = identityFromPublishedDocuments({
    identityUrl: (handle) => `https://registry.example/i/${handle}`,
    revocationsUrl: "https://registry.example/revocations",
    fetch: net.doFetch,
  });

  const revocation = await port.revokedKey(signer.keyId);
  assert.ok(revocation, "a revoked key is answered");
  assert.equal(revocation.reason, "compromised");
  assert.equal(await port.revokedKey("some-other-key"), null, "an unrevoked key answers null");
  assert.equal(net.calls.length, 1, "one list for every key asked about, not one per ask");

  const without = identityFromPublishedDocuments({
    identityUrl: (handle) => `https://registry.example/i/${handle}`,
    fetch: net.doFetch,
  });
  assert.equal(await without.revokedKey(signer.keyId), null, "no list published means no revocations");
});

test("a document larger than the bundle cap is refused", async () => {
  const huge = `{"handle":"${ANNOUNCER}","pad":"${"x".repeat(MAX_BUNDLE_RESPONSE_BYTES + 1)}"}`;
  const net = stubNetwork({ "https://registry.example/i/operator-alice": { body: huge } });
  const port = identityFromPublishedDocuments({
    identityUrl: (handle) => `https://registry.example/i/${handle}`,
    fetch: net.doFetch,
  });

  await assert.rejects(async () => {
    await port.resolveKeys(ANNOUNCER);
  }, "an unbounded document is never parsed");
});

test("a resident believes a KEYLESS announcement whose key its documents vouch for", async () => {
  const signer = announcementSigner();
  const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as Bundle;
  const computedRoot = verifyBundle(committed).computedRoot;
  assert.ok(computedRoot, "the committed bundle recomputes a root");
  const pinnedRoot = computedRoot as string;

  const base = "https://registry.example";
  const record = signedAnnouncement(signer, {
    bundle: `${base}/registry/bundle.json`,
    mirror: `${base}/announced/bundle.json`,
    bundleRoot: pinnedRoot,
  });
  // THE case: no key in the envelope at all. Only the published documents can
  // say who signed it.
  const keyless = { ...record } as Record<string, unknown>;
  delete keyless.publicKey;

  const net = stubNetwork({
    [`${base}/seed.json`]: {
      body: JSON.stringify({
        url: `${base}/seed.json`,
        bundle: `${base}/registry/bundle.json`,
        bundleRoot: pinnedRoot,
        announcers: [ANNOUNCER],
        announcements: [`${base}/announcements.json`],
      }),
      status: 200,
    },
    [`${base}/announcements.json`]: { body: JSON.stringify([keyless]) },
    [`${base}/registry/bundle.json`]: { body: JSON.stringify(committed) },
    [`${base}/announced/bundle.json`]: { body: JSON.stringify(committed) },
    [`${base}/i/${ANNOUNCER}`]: { body: identityDoc(signer) },
    [`${base}/i/${ANNOUNCER}/rotations`]: { body: "[]" },
    [`${base}/revocations`]: { body: "[]" },
  });

  const port = identityFromPublishedDocuments({
    identityUrl: (handle) => `${base}/i/${handle}`,
    rotationsUrl: (handle) => `${base}/i/${handle}/rotations`,
    revocationsUrl: `${base}/revocations`,
    fetch: net.doFetch,
  });

  // The seed's own copy goes away, so only the announcement can produce a
  // candidate — and only if the published documents are what resolve the key.
  net.down(`${base}/registry/bundle.json`);

  const found = await localFindVerifiedBundleFromSeeds(
    [
      {
        url: `${base}/seed.json`,
        bundle: `${base}/registry/bundle.json`,
        bundleRoot: pinnedRoot,
        announcers: [ANNOUNCER],
        announcements: [`${base}/announcements.json`],
      },
    ],
    { fetch: net.doFetch, identity: port },
  );

  assert.equal(found.root, pinnedRoot);
  assert.equal(found.source, `${base}/announced/bundle.json`, "the announced mirror served it");
});
