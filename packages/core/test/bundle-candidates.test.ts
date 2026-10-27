import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  cidV1,
  planSeedUnion,
  publicationLeaf,
  verifyBundleShape,
  verifyCandidates,
  type Bundle,
  type BundleSeed,
  type CandidateOutcome,
} from "../src/index.ts";

/**
 * The one candidate-verification sequence core owns: fetch bytes, the seed's
 * CID pin over those bytes, the bundle's shape, the recomputed root against
 * the pinned root, a refusal record per candidate, and the first copy that
 * passes wins. This is THE sequence the API, the SDK and the live checker
 * delegate to, so its order and its refusals are pinned here — with the
 * callers' own http stubs injected so what runs is exactly what a client runs.
 */
const committed = JSON.parse(
  readFileSync(new URL("../../../site/registry/bundle.json", import.meta.url), "utf8"),
) as Bundle;

const nodeSha256 = (bytes: Uint8Array) =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

const honestBytes = () => Buffer.from(JSON.stringify(committed), "utf8");

function serveBytes(routes: Record<string, unknown>) {
  return async (url: string) => {
    const bytes = routes[url];
    if (bytes === undefined) throw new Error(`HTTP 404`);
    return bytes as Uint8Array;
  };
}

test("the shared sequence: tampered, pin-passing but root-wrong, then the honest copy", async () => {
  const honestBytes = Buffer.from(JSON.stringify(committed), "utf8");
  const honestCid = cidV1(nodeSha256, honestBytes);
  const reserialized = JSON.stringify(committed, null, 2) + "\n";

  // Candidate 1: an altered title, so the rebuilt root moves. Its nominator
  // carries no CID pin, so the refusal names the shape — the stage that comes
  // after the pin stage did not fire.
  const tampered = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );
  const tamperedBytes = Buffer.from(JSON.stringify(tampered), "utf8");

  // Candidate 2: an internally valid DIFFERENT bundle (its own publications
  // rebuild its own root) whose bytes hash to the CID its nominator pins, so
  // the pin stage PASSES — and the refusal lands on the root stage, proving
  // the shape and root stages run only after the pin.
  const otherBundle: Bundle = structuredClone(committed);
  otherBundle.publications = otherBundle.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "another registry's record" } : publication,
  );
  otherBundle.manifest.publications = otherBundle.publications.map((publication) => ({
    id: publication.id,
    leaf: publicationLeaf(publication, nodeSha256, otherBundle.manifest.leafVersion),
  }));
  otherBundle.manifest.root = verifyBundleShape(otherBundle, nodeSha256).computedRoot!;
  assert.notEqual(otherBundle.manifest.root, committed.manifest.root, "the fixture is a different registry");
  assert.equal(verifyBundleShape(otherBundle, nodeSha256).valid, true, "the fixture verifies internally");
  const otherBytes = new TextEncoder().encode(JSON.stringify(otherBundle));
  const otherCid = cidV1(nodeSha256, otherBytes);

  // Candidate 0 proves the pin stage runs FIRST: the same honest bundle with
  // different whitespace verifies perfectly and rebuilds the pinned root, but
  // its bytes hash elsewhere, so it is refused at the pin even though every
  // later stage would have passed.
  const seedFor = (url: string, extra: Partial<BundleSeed>): BundleSeed => ({
    bundle: url,
    bundleRoot: committed.manifest.root,
    ...extra,
  });

  const plan = planSeedUnion([
    seedFor("https://a.example/re-serialized.json", { bundleCid: honestCid }),
    seedFor("https://a.example/tampered.json", {}),
    seedFor("https://a.example/another.json", { bundleCid: otherCid }),
    seedFor("https://a.example/honest.json", { bundleCid: honestCid }),
  ] as BundleSeed[]);

  const events: CandidateOutcome[] = [];
  const result = await verifyCandidates({
    plan,
    fetchBytes: serveBytes({
      "https://a.example/re-serialized.json": Buffer.from(reserialized, "utf8"),
      "https://a.example/tampered.json": tamperedBytes,
      "https://a.example/another.json": otherBytes,
      "https://a.example/honest.json": honestBytes,
    }),
    sha256: nodeSha256,
    onCandidate: (event) => events.push(event),
  });

  assert.equal(result.status, "verified", "the honest copy is the first one that passes");
  assert.equal(result.source, "https://a.example/honest.json");
  assert.equal(result.root, committed.manifest.root);
  assert.equal(result.candidates, 4, "the plan held every candidate");

  // Every earlier candidate is refused, in order, with the stage it failed.
  assert.deepEqual(
    result.refusals.map((refusal) => ({ url: refusal.url, stage: refusal.stage })),
    [
      { url: "https://a.example/re-serialized.json", stage: "pin" },
      { url: "https://a.example/tampered.json", stage: "shape" },
      { url: "https://a.example/another.json", stage: "root" },
    ],
  );
  assert.match(result.refusals[0]!.reason, /serves .* the seed pins /);
  assert.match(result.refusals[1]!.reason, /do not rebuild the anchored root/);
  assert.match(result.refusals[2]!.reason, /verifies internally but rebuilds .*, not the pinned /);

  // And the observer saw the whole sequence as it ran: three refusals with
  // their reasons, then the verified root, in candidate order.
  const failed = events.filter((event) => event.status === "refused");
  assert.deepEqual(
    failed.map((event) => event.status === "refused" ? event.reason : ""),
    [
      (result.refusals[0] as { reason: string }).reason,
      (result.refusals[1] as { reason: string }).reason,
      (result.refusals[2] as { reason: string }).reason,
    ],
    "the observer hears the refusals before the accepted copy",
  );
  const last = events.at(-1)!;
  assert.equal(last.status, "verified");
  if (last.status === "verified") assert.equal(last.root, committed.manifest.root);
});

test("no candidate passes: the aggregate refusal names every candidate in order", async () => {
  const tamperedByteSets: Record<string, Uint8Array> = {
    // A body that is not JSON at all.
    "https://b.example/first.json": Buffer.from("not json at all", "utf8"),
    // An honest bundle whose root is not the one pinned.
    "https://b.example/second.json": honestBytes(),
  };

  const result = await verifyCandidates({
    plan: planSeedUnion([
      { bundle: "https://b.example/first.json", bundleRoot: "1".repeat(64) },
      { bundle: "https://b.example/second.json", bundleRoot: "1".repeat(64) },
      { bundle: "https://b.example/absent.json", bundleRoot: "1".repeat(64) },
    ] as BundleSeed[]),
    fetchBytes: serveBytes(tamperedByteSets),
    sha256: nodeSha256,
  });

  assert.equal(result.status, "refused");
  assert.match(result.message, /no candidate rebuilt the pinned root/);
  const lines = result.message.split("\n").slice(1);
  assert.match(lines[0]!, /first\.json: Unexpected token/);
  assert.match(lines[1]!, /second\.json: verifies internally but rebuilds/);
  assert.match(lines[2]!, /absent\.json: HTTP 404/);
  assert.ok(
    result.message.indexOf("first.json") < result.message.indexOf("second.json") &&
      result.message.indexOf("second.json") < result.message.indexOf("absent.json"),
    "the aggregate names the candidates in plan order",
  );

  // A pooled union attributes each refusal to the seed that nominated it.
  const pooled = await verifyCandidates({
    plan: planSeedUnion([
      { url: "https://operator-a.example/seed.json", bundle: "https://b.example/absent.json", bundleRoot: "1".repeat(64) },
      { url: "https://operator-b.example/seed.json", bundle: "https://b.example/absent.json", bundleRoot: "1".repeat(64) },
    ] as BundleSeed[]),
    fetchBytes: async () => {
      throw new Error("HTTP 404");
    },
    sha256: nodeSha256,
    attribute: true,
  });
  assert.equal(pooled.status, "refused");
  assert.match(
    pooled.message,
    /absent\.json: HTTP 404, nominated by https:\/\/operator-a\.example\/seed\.json, https:\/\/operator-b\.example\/seed\.json/,
  );
});
