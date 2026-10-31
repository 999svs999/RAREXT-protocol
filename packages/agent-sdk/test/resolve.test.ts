import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { resolveRarextUri } from "../src/index.ts";
import type { RarextResolveOptions } from "../src/index.ts";

// The object this suite resolves is the project's OWN published bundle: real bytes, the real
// pinned root, served over loopback. A reference to it is the ordinary case — an object that exists
// on the network, named in a document — rather than a fixture invented for the test.
const committed = readFileSync(new URL("../../../site/registry/bundle.json", import.meta.url), "utf8");
const seed = JSON.parse(readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8")) as {
  bundleRoot: string;
  bundleCid?: string;
};
const ROOT = seed.bundleRoot;

async function serve(bytes: string, contentType = "application/json") {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/bundle.json`,
    host: `127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const opts = (extra: RarextResolveOptions = {}): RarextResolveOptions => ({ scheme: "http", allowPrivateHosts: true, ...extra });

test("a reference to our own published bundle resolves, and the root it carries is what decides", async () => {
  const origin = await serve(committed);
  try {
    const reference = `rarext:${origin.host}/bundle.json@${ROOT}`;
    const resolved = await resolveRarextUri(reference, opts());
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
    if (!resolved.ok) return;
    assert.equal(resolved.root, ROOT);
    assert.equal(resolved.source, origin.url);
    assert.ok(Array.isArray(resolved.bundle.publications));
    assert.ok(resolved.bundle.publications.length > 0);
  } finally {
    await origin.close();
  }
});

test("a LOCATION IS A HINT: a wrong copy is refused by name and a mirror still resolves", async () => {
  // A bundle that lies about its own root: the bytes are the committed ones, with the manifest's
  // root rewritten. It cannot verify against anything, which is what an incorrect or hostile
  // mirror looks like — and it is the case the reference's ROOT exists to catch.
  const lying = JSON.parse(committed) as { manifest: { root: string; anchorRoot?: string } };
  lying.manifest.root = "c".repeat(64);
  if (typeof lying.manifest.anchorRoot === "string") lying.manifest.anchorRoot = "c".repeat(64);
  const wrong = await serve(JSON.stringify(lying));
  const right = await serve(committed);
  try {
    const elsewhere = "c".repeat(64);
    const reference = `rarext:${wrong.host}/bundle.json@${ROOT}`;
    const resolved = await resolveRarextUri(reference, opts({ candidates: [right.url] }));
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
    if (!resolved.ok) return;
    assert.equal(resolved.source, right.url, "the mirror is what verified");
    assert.ok(resolved.attempts.length >= 1, "the refusal is kept as evidence");
    assert.equal(resolved.attempts[0]!.url, wrong.url);

    // And with the pin pointing at a root NOBODY serves, nothing verifies and every candidate is
    // named rather than the failure being opaque.
    const impossible = await resolveRarextUri(`rarext:${wrong.host}/bundle.json@${elsewhere}`, opts({ candidates: [right.url] }));
    assert.equal(impossible.ok, false);
    if (impossible.ok) return;
    assert.equal(impossible.attempts.length, 2);
    assert.match(impossible.reason, /c{16}/, "the failure names the root it looked for");
  } finally {
    await wrong.close();
    await right.close();
  }
});

test("a bare root names an object and no location: candidates must come from the caller", async () => {
  const origin = await serve(committed);
  try {
    const bare = await resolveRarextUri(`rarext:${ROOT}`, opts());
    assert.equal(bare.ok, false);
    if (bare.ok) return;
    assert.match(bare.reason, /says what to look for, not where/);
    assert.equal(bare.attempts.length, 0);

    const withCandidates = await resolveRarextUri(`rarext:${ROOT}`, opts({ candidates: [origin.url] }));
    assert.equal(withCandidates.ok, true, withCandidates.ok ? "" : withCandidates.reason);
  } finally {
    await origin.close();
  }
});

test("what is deliberately not resolved: a registry id, a bad reference, and a private address under the default policy", async () => {
  // An id needs the federation list, and guessing a host would make the hint load-bearing.
  const byId = await resolveRarextUri(`rarext:rarext/registry/bundle.json@${ROOT}`, opts());
  assert.equal(byId.ok, false);
  if (!byId.ok) assert.match(byId.reason, /is a registry id, not a host/);

  // A reference that is not one is refused by core's parser, and the resolver adds nothing.
  const notAReference = await resolveRarextUri("https://example.com/registry/bundle.json");
  assert.equal(notAReference.ok, false);
  if (!notAReference.ok) {
    assert.match(notAReference.reason, /is not a RAREXT reference/);
    assert.equal(notAReference.attempts.length, 0);
  }

  // And a loopback reference EARNs the private-address allowance from its own location, exactly as
  // a local seed does — a node on your own machine is a deployment, not an attack — while a public
  // document pointing inward is still refused by the same policy the resolver does not bypass.
  const origin = await serve(committed);
  try {
    const local = await resolveRarextUri(`rarext:${origin.host}/bundle.json@${ROOT}`, { scheme: "http" });
    assert.equal(local.ok, true, local.ok ? "" : local.reason);

    const outward = await resolveRarextUri(`rarext:example.com/bundle.json@${ROOT}`, {
      candidates: [origin.url],
    });
    assert.equal(outward.ok, false, "a public reference does not inherit an allowance for its private candidate");
    if (!outward.ok) {
      // Every location it tried is named, and the private one is refused as a POLICY decision —
      // not reported as an outage, which would send an operator to debug a host never contacted.
      assert.ok(outward.attempts.length >= 1);
      assert.match(outward.attempts.map((entry) => entry.reason).join(" | "), /private or link-local/);
    }
  } finally {
    await origin.close();
  }
});
