import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Bundle } from "../../../packages/core/src/index.ts";
import { MAX_BUNDLE_RESPONSE_BYTES, parseRegistrySeedList, registrySeedUrl } from "@rarext/core";
import {
  findVerifiedBundlesFromRegistryList,
  joinRegistryNetwork,
  registriesFromPublishedList,
  registryListDigestOf,
} from "../src/registries.ts";
import { verifyBundle } from "../src/index.ts";
import {
  DAY,
  announcementSigner,
  iso,
  signedAnnouncement,
} from "./announcement-fixtures.ts";

/**
 * The federation query. The seed list existed and was served, but nothing
 * consumed it: a resident still had to be handed one registry at a time, which
 * is not a network. These tests are about the two properties that make it
 * usable — the list means one thing to everybody, and a dead registry is
 * reported rather than fatal.
 */

const committedBytes = readFileSync("site/registry/bundle.json");
const committed = JSON.parse(committedBytes.toString("utf8")) as Bundle;
const computedRoot = verifyBundle(committed).computedRoot;
assert.ok(computedRoot, "the committed bundle recomputes a root");
const root = computedRoot as string;

function stubNetwork(routes: Record<string, string>) {
  const calls: string[] = [];
  const doFetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

test("the list's shape means one thing: core parses it for the server and the client", () => {
  const entry = parseRegistrySeedList([
    { id: "a", url: "https://a.example/" },
    { id: "b", url: "https://b.example", operator: "bee", chains: ["base", 7], note: "n", seed: "https://b.example/s.json" },
    { id: "no-url" },
    "not an object",
  ]);

  assert.equal(entry.length, 2, "entries that do not say where to look are dropped");
  assert.deepEqual(entry[0], {
    id: "a",
    url: "https://a.example/",
    operator: "",
    chains: [],
    note: null,
    seed: null,
  });
  assert.equal(entry[1].operator, "bee");
  assert.deepEqual(entry[1].chains, ["base"], "non-string chains are dropped, not coerced");
  assert.equal(entry[1].seed, "https://b.example/s.json");

  // The wrapped shape the API serves parses identically.
  assert.equal(parseRegistrySeedList({ self: {}, registries: [{ id: "a", url: "https://a.example" }] }).length, 1);

  // The convention, in ONE place: a trailing slash cannot produce a doubled one.
  assert.equal(registrySeedUrl(entry[0]), "https://a.example/registry/seed.json");
  assert.equal(registrySeedUrl(entry[1]), "https://b.example/s.json");
});

test("every registry on the list is asked, and the one that is dead is reported", async () => {
  const net = stubNetwork({
    "https://list.example/registries": JSON.stringify({
      registries: [
        { id: "good", url: "https://good.example" },
        { id: "dead", url: "https://dead.example" },
      ],
    }),
    "https://good.example/registry/seed.json": JSON.stringify({
      url: "https://good.example/registry/seed.json",
      bundle: "https://good.example/registry/bundle.json",
      bundleRoot: root,
    }),
    "https://good.example/registry/bundle.json": committedBytes.toString("utf8"),
  });

  const events: string[] = [];
  const result = await findVerifiedBundlesFromRegistryList("https://list.example/registries", {
    fetch: net.doFetch,
    onRegistry: (event) => events.push(`${event.id}:${event.status}`),
  });

  assert.equal(result.verified.length, 1, "the registry that answered is verified");
  assert.equal(result.verified[0].id, "good");
  assert.equal(result.verified[0].bundle.root, root);
  assert.equal(result.verified[0].bundle.source, "https://good.example/registry/bundle.json");

  assert.equal(result.failures.length, 1, "the dead one is REPORTED, not fatal");
  assert.equal(result.failures[0].id, "dead");
  assert.match(result.failures[0].reason, /404|HTTP/);
  assert.deepEqual(events, ["good:verified", "dead:refused"], "both are reported, in list order");
});

test("a registry whose copy does not rebuild the pinned root is refused by name", async () => {
  const tampered = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );

  const net = stubNetwork({
    "https://list.example/registries": JSON.stringify([
      { id: "liar", url: "https://liar.example" },
    ]),
    "https://liar.example/registry/seed.json": JSON.stringify({
      url: "https://liar.example/registry/seed.json",
      bundle: "https://liar.example/registry/bundle.json",
      bundleRoot: root,
    }),
    "https://liar.example/registry/bundle.json": JSON.stringify(tampered),
  });

  const result = await findVerifiedBundlesFromRegistryList("https://list.example/registries", {
    fetch: net.doFetch,
  });

  assert.equal(result.verified.length, 0, "a copy that does not rebuild the root is never a bundle");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /no candidate rebuilt the pinned root/);
});

test("the list and its seeds are read under the response cap", async () => {
  const huge = `{"registries":[{"id":"a","url":"https://a.example"}],"pad":"${"x".repeat(
    MAX_BUNDLE_RESPONSE_BYTES + 1,
  )}"}`;
  const net = stubNetwork({ "https://list.example/registries": huge });

  await assert.rejects(
    async () => {
      await registriesFromPublishedList("https://list.example/registries", { fetch: net.doFetch });
    },
    "an unbounded list is never parsed",
  );
});

test("joining the network verifies each registry and attributes its announcements", async () => {
  const signer = announcementSigner();
  const handle = "operator-alice";
  const root64 = root;

  const record = signedAnnouncement(signer, {
    handle,
    bundle: "https://a.example/registry/bundle.json",
    mirror: "https://a.example/announced/bundle.json",
    bundleRoot: root64,
  });
  const keyless = { ...record } as Record<string, unknown>;
  delete keyless.publicKey;

  const net = stubNetwork({
    "https://list.example/registries": JSON.stringify([
      { id: "a", url: "https://a.example" },
      { id: "b", url: "https://b.example" },
    ]),
    // Registry A: a seed naming an announcement, its own identity documents,
    // and an announced mirror. Its own copy is absent, so the announcement is
    // the only thing that can produce a candidate.
    "https://a.example/registry/seed.json": JSON.stringify({
      url: "https://a.example/registry/seed.json",
      bundle: "https://a.example/registry/bundle.json",
      bundleRoot: root64,
      announcers: [handle],
      announcements: ["https://a.example/announcements.json"],
    }),
    "https://a.example/announcements.json": JSON.stringify([keyless]),
    "https://a.example/announced/bundle.json": committedBytes.toString("utf8"),
    [`https://a.example/v1/identities/${handle}`]: JSON.stringify({
      handle,
      keyId: signer.keyId,
      algorithm: signer.suite,
      publicKey: signer.publicKey,
      createdAt: iso(-400 * DAY),
    }),
    [`https://a.example/v1/identities/${handle}/rotations`]: "[]",
    "https://a.example/v1/revocations": "[]",
    // Registry B does not answer at all.
  });

  const result = await joinRegistryNetwork("https://list.example/registries", { fetch: net.doFetch });

  assert.deepEqual(
    result.registries.map((entry) => `${entry.id}:${entry.status}`),
    ["a:verified", "b:unreachable"],
    `every registry is reported, and a dead one is not fatal: ${JSON.stringify(result.registries)}`,
  );
  assert.equal(result.verified.length, 1);
  assert.equal(result.verified[0].bundle.source, "https://a.example/announced/bundle.json");
  assert.equal(result.verified[0].bundle.root, root64);

  const accepted = result.announcements.find((event) => event.status === "accepted");
  assert.ok(accepted, `the announcement is reported: ${JSON.stringify(result.announcements)}`);
  assert.equal(accepted.registry, "a", "and attributed to the registry whose seed listed it");
  assert.equal(accepted.mirror, "https://a.example/announced/bundle.json");
});

test("a network join refuses an announcement whose key that registry revoked", async () => {
  const signer = announcementSigner();
  const handle = "operator-alice";

  const record = signedAnnouncement(signer, {
    handle,
    bundle: "https://c.example/registry/bundle.json",
    mirror: "https://c.example/announced/bundle.json",
    bundleRoot: root,
  });
  const keyless = { ...record } as Record<string, unknown>;
  delete keyless.publicKey;

  const net = stubNetwork({
    "https://list.example/registries": JSON.stringify([{ id: "c", url: "https://c.example" }]),
    "https://c.example/registry/seed.json": JSON.stringify({
      url: "https://c.example/registry/seed.json",
      bundle: "https://c.example/registry/bundle.json",
      bundleRoot: root,
      announcers: [handle],
      announcements: ["https://c.example/announcements.json"],
    }),
    "https://c.example/announcements.json": JSON.stringify([keyless]),
    "https://c.example/announced/bundle.json": committedBytes.toString("utf8"),
    [`https://c.example/v1/identities/${handle}`]: JSON.stringify({
      handle,
      keyId: signer.keyId,
      algorithm: signer.suite,
      publicKey: signer.publicKey,
      createdAt: iso(-400 * DAY),
    }),
    [`https://c.example/v1/identities/${handle}/rotations`]: "[]",
    "https://c.example/v1/revocations": JSON.stringify([
      { id: "rev-1", kind: "capability", target: signer.keyId, reason: "key compromised" },
    ]),
  });

  const result = await joinRegistryNetwork("https://list.example/registries", { fetch: net.doFetch });

  assert.equal(result.verified.length, 0, "a revoked key yields no verified bundle");
  assert.equal(result.registries[0].status, "refused");
  const refusal = result.announcements.find((event) => event.status !== "accepted");
  assert.ok(refusal, `the refusal is reported: ${JSON.stringify(result.announcements)}`);
  assert.equal(refusal.registry, "c");
  assert.match(String(refusal.reason), /revok/i, "and names the revocation");
});

test("a seed list can be CHECKED rather than trusted, and the wrapper is not what is checked", async () => {
  const entries = [
    { id: "a", url: "https://a.example", operator: "aye", chains: ["base"], note: "n", seed: null },
    { id: "b", url: "https://b.example", operator: "", chains: [], note: null, seed: "https://b.example/s.json" },
  ];
  const digest = registryListDigestOf(entries as never);

  const list = (registries: unknown[], self: unknown = { url: "https://list.example", chain: ["base"] }) =>
    JSON.stringify({ self, registries });

  // The correct digest passes.
  const good = stubNetwork({ "https://list.example/registries": list(entries) });
  const read = await registriesFromPublishedList("https://list.example/registries", {
    fetch: good.doFetch,
    expectDigest: digest,
  });
  assert.equal(read.length, 2);

  // The SAME list with one entry's chains changed is refused, naming both.
  const tampered = entries.map((entry, index) => (index === 0 ? { ...entry, chains: ["solana"] } : entry));
  const bad = stubNetwork({ "https://list.example/registries": list(tampered) });
  await assert.rejects(
    async () => {
      await registriesFromPublishedList("https://list.example/registries", {
        fetch: bad.doFetch,
        expectDigest: digest,
      });
    },
    (error: Error) => {
      assert.match(error.message, new RegExp(digest));
      assert.match(error.message, /computed [0-9a-f]{64}/);
      return true;
    },
  );

  // A different SELF description does not change what is checked: the server
  // reaching itself at another hostname is not a change in which registries exist.
  const otherSelf = stubNetwork({
    "https://list.example/registries": list(entries, { url: "http://127.0.0.1:9999", chain: ["base", "cosmos"] }),
  });
  const stillRead = await registriesFromPublishedList("https://list.example/registries", {
    fetch: otherSelf.doFetch,
    expectDigest: digest,
  });
  assert.equal(stillRead.length, 2, "a server describing itself differently is not a different list");

  // And field order inside an entry is not a change either.
  const reordered = stubNetwork({
    "https://list.example/registries": JSON.stringify({
      registries: [
        { seed: null, note: "n", chains: ["base"], operator: "aye", url: "https://a.example", id: "a" },
        { id: "b", url: "https://b.example", seed: "https://b.example/s.json", note: null, operator: "", chains: [] },
      ],
    }),
  });
  const reorderedRead = await registriesFromPublishedList("https://list.example/registries", {
    fetch: reordered.doFetch,
    expectDigest: digest,
  });
  assert.equal(reorderedRead.length, 2, "canonical form: order in the document is not order in the meaning");
});

test("without an expectation, the reader behaves exactly as before", async () => {
  const net = stubNetwork({
    "https://list.example/registries": JSON.stringify([{ id: "a", url: "https://a.example" }]),
  });
  const entries = await registriesFromPublishedList("https://list.example/registries", { fetch: net.doFetch });
  assert.equal(entries.length, 1, "no expectation means no new failure mode");
});
