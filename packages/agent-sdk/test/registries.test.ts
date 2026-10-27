import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Bundle } from "../../../packages/core/src/index.ts";
import { MAX_BUNDLE_RESPONSE_BYTES, parseRegistrySeedList, registrySeedUrl } from "@rarext/core";
import {
  findVerifiedBundlesFromRegistryList,
  registriesFromPublishedList,
} from "../src/registries.ts";
import { verifyBundle } from "../src/index.ts";

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
