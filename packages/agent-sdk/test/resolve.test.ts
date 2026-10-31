import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { resolveRarextUri } from "../src/index.ts";
import { creditRoot, publicationRoot } from "../../core/src/index.ts";
import type { Publication } from "../../core/src/index.ts";
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

async function serve(bytes: string | Uint8Array, contentType = "application/json") {
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
    assert.equal(resolved.kind, "bundle", "a registry's bundle is the reading that answered");
    assert.equal(resolved.root, ROOT);
    assert.equal(resolved.source, origin.url);
    assert.equal(resolved.bytes, undefined, "a bundle reading carries no blob bytes");
    assert.ok(Array.isArray(resolved.bundle?.publications));
    assert.ok((resolved.bundle?.publications.length ?? 0) > 0);
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
    // SIX attempts: two candidates, read THREE ways each — a bundle, a record, then bytes. A
    // reference does not say what it names, so a failure reports every reading: "not a bundle" is
    // not the same answer as "not there".
    assert.equal(impossible.attempts.length, 6);
    assert.match(impossible.reason, /c{16}/, "the failure names the root it looked for");
    assert.match(impossible.reason, /reading the same candidates as records and as bytes found none/);
    const evidence = impossible.attempts.map((entry) => entry.reason).join(" | ");
    assert.match(evidence, /its bytes hash to/, "the byte reading says what it hashed to");
    assert.match(evidence, /as a publication it is/, "the record reading says what the document was, or that it is not one");

    // The kinds are STRUCTURAL, so an operator can tell a dead mirror from a lying one without
    // grepping prose: the lying copy is a mismatch, not an outage.
    const lying = impossible.attempts.filter((entry) => entry.url === wrong.url);
    assert.deepEqual(
      lying.map((entry) => entry.kind),
      ["mismatch", "mismatch", "mismatch"],
      "a copy that answers but does not rebuild the root is a mismatch, three readings over",
    );
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

test("a reference names CONTENT, not a format: bytes resolve by their sha256, and ONE URL can be two objects", async () => {
  // Whatever a reader might want to publish and name: an image, a model file, a tarball of a site.
  // The resolver is not told what it is and does not need to be — the root says what was meant.
  const bytes = Buffer.from("a tarball of a website, an image, a model file: the resolver does not care which", "utf8");
  const blobRoot = createHash("sha256").update(bytes).digest("hex");
  const blob = await serve(bytes, "application/octet-stream");
  try {
    const resolved = await resolveRarextUri(`rarext:${blob.host}/thing.bin@${blobRoot}`, opts());
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
    if (!resolved.ok) return;
    assert.equal(resolved.kind, "blob");
    assert.equal(resolved.root, blobRoot);
    assert.equal(resolved.mediaType, "application/octet-stream");
    assert.equal(Buffer.compare(Buffer.from(resolved.bytes!), bytes), 0, "the bytes are the object");
    assert.equal(resolved.bundle, undefined, "a blob reading carries no bundle");
  } finally {
    await blob.close();
  }

  // And the property that makes two objects of one location: a bundle's root is a hash of its
  // CONTENT, so it is not the sha256 of the bytes that carry it. The same URL, named by two
  // different roots, resolves to two different objects — neither reading can quietly accept the
  // other's copy.
  const origin = await serve(committed);
  try {
    const asBundle = await resolveRarextUri(`rarext:${origin.host}/bundle.json@${ROOT}`, opts());
    assert.equal(asBundle.ok, true, asBundle.ok ? "" : asBundle.reason);
    if (asBundle.ok) assert.equal(asBundle.kind, "bundle");

    const bytesRoot = createHash("sha256").update(Buffer.from(committed, "utf8")).digest("hex");
    assert.notEqual(bytesRoot, ROOT, "the bundle's root is not the sha256 of its bytes");

    const asBlob = await resolveRarextUri(`rarext:${origin.host}/bundle.json@${bytesRoot}`, opts());
    assert.equal(asBlob.ok, true, asBlob.ok ? "" : asBlob.reason);
    if (!asBlob.ok) return;
    assert.equal(asBlob.kind, "blob", "the same URL, the other root: the other object");
    assert.equal(asBlob.root, bytesRoot);
    assert.equal(Buffer.from(asBlob.bytes!).toString("utf8"), committed);
  } finally {
    await origin.close();
  }
});

test("the readings AFTER a bundle obey the SAME policy as the walk: a private candidate under a public reference is refused, not fetched", async () => {
  const bytes = Buffer.from("private", "utf8");
  const root = createHash("sha256").update(bytes).digest("hex");
  const origin = await serve(bytes, "application/octet-stream");
  try {
    const outward = await resolveRarextUri(`rarext:example.com/thing.bin@${root}`, { candidates: [origin.url] });
    assert.equal(outward.ok, false);
    if (outward.ok) return;
    assert.match(
      outward.attempts.map((entry) => entry.reason).join(" | "),
      /not read: .*private or link-local/,
      "the later readings refuse by policy too — a record is not readable just because we stopped expecting a bundle",
    );
    // And the policy refusal is not a MISMATCH for this reference: nothing was served from the
    // refused location, so nothing lied about content. (A public host that answered 404 IS
    // classified as unavailable — it answered — while the policy-blocked private candidate is
    // unreachable, and the kinds say which is which.)
    assert.ok(outward.attempts.every((entry) => entry.kind !== "mismatch"));
    assert.ok(outward.attempts.some((entry) => entry.kind === "unreachable"));
  } finally {
    await origin.close();
  }
});

test("a record the economy is written in is named by its own root, as served — with the root attached", async () => {
  // A REAL publication from the project's committed bundle, not a fixture: the storage economy's
  // records are what this reading exists for.
  const bundle = JSON.parse(committed) as { publications: Publication[] };
  const record = bundle.publications[0]!;
  const root = publicationRoot(record, (value) =>
    createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex"),
  );

  // Served the way the API serves it: the record, plus the `root` it was told and a durability
  // observation. Those are attached to the record, not part of it, and the client must be able to
  // recompute the digest from exactly what arrived.
  const served = JSON.stringify({ ...record, root, durability: null });
  const origin = await serve(served);
  try {
    const resolved = await resolveRarextUri(`rarext:${origin.host}/bundle.json@${root}`, opts());
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
    if (!resolved.ok) return;
    assert.equal(resolved.kind, "publication");
    assert.equal((resolved.record as Publication).id, record.id);
    assert.equal(resolved.bytes, undefined, "a record reading carries no bytes");
    assert.equal(resolved.bundle, undefined, "and no bundle");

    // The same URL named by the sha256 of the bytes it served is a DIFFERENT object, and the root
    // decides which one the client asked for — the same property as a bundle, one reading on.
    const bytesRoot = createHash("sha256").update(Buffer.from(served, "utf8")).digest("hex");
    const asBlob = await resolveRarextUri(`rarext:${origin.host}/bundle.json@${bytesRoot}`, opts());
    assert.equal(asBlob.ok, true, asBlob.ok ? "" : asBlob.reason);
    if (asBlob.ok) assert.equal(asBlob.kind, "blob");
  } finally {
    await origin.close();
  }
});

test("a worker's RECEIPT is nameable: a credit record resolves by the root it rebuilds to", async () => {
  const record = {
    keyId: "worker-key",
    action: "verify",
    bounty: 12,
    challengeId: "gen-starter",
    artifactHash: "c".repeat(64),
    at: "2026-11-01T00:00:00.000Z",
  };
  const hash = (value: string | Uint8Array) =>
    createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
  const root = creditRoot(record, hash);

  // Served as the API serves it: the receipt, plus the root the node attached.
  const origin = await serve(JSON.stringify({ ...record, root }), "application/json");
  try {
    const resolved = await resolveRarextUri(`rarext:${origin.host}/receipt.json@${root}`, opts());
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
    if (!resolved.ok) return;
    assert.equal(resolved.kind, "credit");
    assert.equal((resolved.record as { keyId: string }).keyId, "worker-key");
    assert.equal((resolved.record as { bounty: number }).bounty, 12);
  } finally {
    await origin.close();
  }
});
