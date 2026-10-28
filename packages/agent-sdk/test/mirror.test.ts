import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  cidV1,
  cidV1Raw,
  findVerifiedBundle,
  findVerifiedBundleFromSeeds,
  MemoryAnnouncementCache,
  replayBundleAi,
  verifyBundle,
  type AnnouncementEvent,
  type AnnouncementIdentity,
  type Bundle,
  type SeedDocument,
} from "../src/index.ts";
import {
  DAY,
  announcementSigner,
  iso,
  signedAnnouncement,
  announcerIdentity,
} from "./announcement-fixtures.ts";
import { canonicalize, MAX_BUNDLE_RESPONSE_BYTES } from "../../core/src/index.ts";

/**
 * The SDK's mirror client, exercised against hostile copies: it tries the
 * seed's own URL and then each mirror, reads BYTES, and accepts only a copy
 * that hashes to the CID the seed pins and rebuilds the pinned root. A
 * tampered copy, a 404, and a re-serialized copy of the same bundle must all
 * be refused with a named reason.
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

test("the SDK finds the mirror whose bytes rebuild the seed's pinned root", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  const tampered: Bundle = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );
  assert.equal(verifyBundle(tampered).valid, false, "the tampered copy must not verify");

  const honestBytes = Buffer.from(JSON.stringify(committed), "utf8");
  const honestCid = cidV1Raw(honestBytes);
  // The SDK exports the same core composition an operator uses; the only
  // difference is the digest the caller supplies.
  const nodeSha256 = (bytes: Uint8Array) =>
    new Uint8Array(createHash("sha256").update(bytes).digest());
  assert.equal(cidV1(nodeSha256, honestBytes), honestCid);

  // The same bundle with different whitespace is different bytes, hence a
  // different content address even though it verifies perfectly.
  const reserialized = JSON.stringify(committed, null, 2) + "\n";
  const reserializedCid = cidV1Raw(Buffer.from(reserialized, "utf8"));
  assert.notEqual(reserializedCid, honestCid, "the fixture must serve different bytes");

  const server = serve({
    "/registry/bundle.json": { body: JSON.stringify(tampered) },
    "/mirror/bundle.json": { body: JSON.stringify(committed) },
    "/reserialized/bundle.json": { body: reserialized },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // The seed's own copy is tampered (and therefore hashes elsewhere); the
    // mirror is honest, so the client falls through and accepts it.
    const found = await findVerifiedBundle({
      bundle: `${base}/registry/bundle.json`,
      bundleRoot: pinnedRoot,
      bundleCid: honestCid,
      mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
    });

    assert.equal(found.source, `${base}/mirror/bundle.json`, "the mirror is the copy that verifies");
    assert.equal(found.root, pinnedRoot);
    assert.equal(found.bundle.manifest.root, pinnedRoot);

    // A tampered copy is refused by the shape check, and the refusal names it.
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/registry/bundle.json`,
          bundleRoot: pinnedRoot,
        }),
      (error: Error) => {
        assert.match(error.message, /registry\/bundle\.json/);
        assert.match(error.message, /do not rebuild the anchored root/);
        return true;
      },
      "a copy whose publications rebuild another root must be refused",
    );

    // The CID pin: the reserialized copy verifies internally and rebuilds the
    // pinned root, but its bytes hash elsewhere, so it is refused.
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/reserialized/bundle.json`,
          bundleRoot: pinnedRoot,
          bundleCid: honestCid,
        }),
      (error: Error) => {
        assert.match(error.message, /serves .* the seed pins /);
        assert.match(error.message, new RegExp(honestCid.slice(0, 12)));
        return true;
      },
      "a re-serialized copy of the same bundle must be refused by the CID pin",
    );

    // Every candidate failing names every candidate's reason.
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/absent.json`,
          bundleRoot: pinnedRoot,
          mirrors: [{ bundle: `${base}/registry/bundle.json`, root: pinnedRoot }],
        }),
      (error: Error) => {
        assert.match(error.message, /absent\.json/);
        assert.match(error.message, /HTTP 404/);
        assert.match(error.message, /registry\/bundle\.json/);
        assert.match(error.message, /do not rebuild the anchored root/);
        return true;
      },
      "the refusal lists the 404 and the tampered copy with their reasons",
    );

    // A seed naming nothing at all is refused before any request.
    await assert.rejects(
      () => findVerifiedBundle({ bundle: "", bundleRoot: pinnedRoot }),
      /names no bundle or mirror/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an oversized candidate is refused at the cap, and the honest mirror is still accepted", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;

  // The same hostile shapes the API path meets: a lying Content-Length, an
  // honest-but-huge one, and a body streaming past the cap with no header.
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
      const found = await findVerifiedBundle({
        bundle: `${base}/${hostile}/bundle.json`,
        bundleRoot: pinnedRoot,
        mirrors: [{ bundle: `${base}/mirror/bundle.json`, root: pinnedRoot }],
      });
      assert.equal(
        found.source,
        `${base}/mirror/bundle.json`,
        `the honest mirror is still accepted after a ${hostile} candidate`,
      );
    }

    // Each refusal is a candidate refusal naming the cap, not a thrown crash.
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/huge/bundle.json`,
          bundleRoot: pinnedRoot,
        }),
      (error: Error) => {
        assert.match(error.message, /huge\/bundle\.json/);
        assert.match(error.message, /declares 2147483648 bytes/);
        assert.match(error.message, new RegExp(`above the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
        return true;
      },
    );
    await assert.rejects(
      () =>
        findVerifiedBundle({
          bundle: `${base}/streaming/bundle.json`,
          bundleRoot: pinnedRoot,
        }),
      (error: Error) => {
        assert.match(error.message, /streaming\/bundle\.json/);
        assert.match(error.message, new RegExp(`streamed past the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The two AI publications the committed bundle carries, by representation. */
function aiClaim(bundle: Bundle, representation: "generative" | "bounded") {
  const publication = bundle.publications.find(
    (candidate) => candidate.attestation.representation === representation,
  );
  assert.ok(publication, `the committed bundle carries a ${representation} publication`);
  return publication;
}

test("from a seed document alone: find the bundle, then replay both AI claims with no server", async () => {
  const honest = verifyBundle(committed);
  assert.equal(honest.valid, true, honest.reason ?? undefined);
  const pinnedRoot = honest.computedRoot!;
  const bytes = Buffer.from(JSON.stringify(committed), "utf8");

  const server = serve({ "/registry/bundle.json": { body: bytes.toString("utf8") } });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const found = await findVerifiedBundle({
      bundle: `${base}/registry/bundle.json`,
      bundleRoot: pinnedRoot,
      bundleCid: cidV1Raw(bytes),
    });

    // Prove the boundary instead of asserting it: the server that just served
    // the copy is stopped and every fetch from here on throws, so a replay
    // that reached for the network would fail this test rather than quietly
    // succeed against a still-running endpoint.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("replayBundleAi must not reach the network");
    }) as unknown as typeof fetch;

    let replay: ReturnType<typeof replayBundleAi>;
    try {
      replay = replayBundleAi(found.bundle);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(replay.root, pinnedRoot, "the verdicts carry the root of the copy they came from");
    assert.equal(replay.claims.length, 2, "both AI publications yield exactly one verdict each");

    const generativePublication = aiClaim(found.bundle, "generative");
    const generative = replay.claims.find((claim) => claim.representation === "generative");
    assert.ok(generative);
    assert.equal(generative.publicationId, generativePublication.id);
    assert.equal(generative.title, generativePublication.title);
    assert.equal(generative.correct, true, generative.error);
    assert.equal(generative.error, undefined);

    const generativeBody = generativePublication.artifact.body as { seed: number; output: string; model: unknown };
    const steps = found.bundle.challenges.find((challenge) => challenge.id === "gen-starter")?.spec as { steps: number };
    assert.equal(generative.evidence?.seed, generativeBody.seed);
    assert.equal(generative.evidence?.steps, steps.steps);
    assert.match(generative.evidence?.modelDigest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      generative.evidence?.modelDigest,
      createHash("sha256").update(canonicalize(generativeBody.model)).digest("hex"),
      "the digest is the same computation the live verifyAi path runs",
    );
    // A faithful claim replays to exactly what it carries.
    assert.equal(generative.evidence?.expected, generativeBody.output);
    assert.equal(generative.evidence?.actual, generativeBody.output);

    const boundedPublication = aiClaim(found.bundle, "bounded");
    const bounded = replay.claims.find((claim) => claim.representation === "bounded");
    assert.ok(bounded);
    assert.equal(bounded.publicationId, boundedPublication.id);
    assert.equal(bounded.correct, true, bounded.error);
    assert.equal(bounded.error, undefined);
    assert.equal(bounded.evidence?.metricName, "maxAbsError");
    assert.equal(bounded.evidence?.bound, 4);
    assert.equal(bounded.evidence?.metricValue, boundedPublication.attestation.metricValue);
    assert.equal(bounded.evidence?.attestedMetricValue, boundedPublication.attestation.metricValue);
    assert.equal(bounded.evidence?.metricValue, 2, "the committed bundle's metric is the recomputed one");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a forged AI claim does not survive the resident's own replay", () => {
  const tampered = structuredClone(committed);
  const publication = aiClaim(tampered, "generative");
  const body = publication.artifact.body as { output: string };
  const claimed = body.output;
  body.output = `${claimed} forged`;

  // The forgery is a Merkle failure too — the leaf covers the artifact — which
  // is why a resident verifies the copy first. Replay is the second, separate
  // question: even handed the forged bytes out of band, the resident's own
  // recomputation must not agree with them.
  assert.equal(verifyBundle(tampered).valid, false, "the tampered copy does not rebuild the root");

  const replay = replayBundleAi(tampered);
  assert.equal(replay.claims.length, 2);

  const generative = replay.claims.find((claim) => claim.representation === "generative");
  assert.ok(generative);
  assert.equal(generative.correct, false, "a replayed output that is not the claimed one must fail");
  assert.equal(generative.evidence?.actual, `${claimed} forged`);
  assert.equal(generative.evidence?.expected, claimed);
  assert.notEqual(generative.evidence?.expected, generative.evidence?.actual);

  // The untouched bounded claim beside it still replays: the failure is the
  // forged claim's, not a blanket rejection of the copy.
  const bounded = replay.claims.find((claim) => claim.representation === "bounded");
  assert.ok(bounded);
  assert.equal(bounded.correct, true, bounded.error);
});

test("a publication whose challenge the bundle does not carry is a verdict, not a skip", () => {
  const withoutChallenge = structuredClone(committed);
  withoutChallenge.challenges = withoutChallenge.challenges.filter(
    (challenge) => challenge.id !== "bounded-starter",
  );

  const replay = replayBundleAi(withoutChallenge);
  assert.equal(replay.claims.length, 2, "the unplayable claim is still reported");

  const bounded = replay.claims.find((claim) => claim.representation === "bounded");
  assert.ok(bounded);
  assert.equal(bounded.correct, false, "a claim nobody replayed must not read as passing");
  assert.equal(bounded.error, "challenge bounded-starter not in bundle");
  assert.equal(bounded.evidence, undefined, "no verdict without the spec that defines it");

  // The generative claim next to it has its challenge and replays unchanged.
  const generative = replay.claims.find((claim) => claim.representation === "generative");
  assert.ok(generative);
  assert.equal(generative.correct, true, generative.error);
});

test("a bundle with no AI publications returns an empty list, not an error", () => {
  const noClaims = structuredClone(committed);
  noClaims.publications = noClaims.publications.map((publication) => {
    const copy = structuredClone(publication);
    delete copy.attestation.representation;
    delete copy.attestation.metricName;
    delete copy.attestation.metricValue;
    return copy;
  });

  const replayed = replayBundleAi(noClaims);
  assert.deepEqual(replayed.claims, [], "nothing here claims to be AI");
  assert.equal(replayed.root, noClaims.manifest.root, "the empty list still names the copy it read");

  assert.deepEqual(replayBundleAi({ ...committed, publications: [] }).claims, []);
});

/** Two operators' seed documents for the same registry, each carrying its provenance. */
function opSeed(url: string, seed: Omit<SeedDocument, "url">): SeedDocument {
  return { ...seed, url };
}

test("two agreeing seeds pool their mirrors: a copy only one operator nominated wins", async () => {
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
  // copy is honest. The union must try every candidate and accept B's —
  // cross-operator redundancy is the whole point of pooling the seeds.
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

    const found = await findVerifiedBundleFromSeeds([seedA, seedB]);

    assert.equal(
      found.source,
      `${base}/mirror-b/bundle.json`,
      "the copy only seed B nominated is accepted after all of seed A's candidates fail",
    );
    assert.equal(found.root, pinnedRoot);
    assert.equal(found.bundle.manifest.root, pinnedRoot);
    assert.equal(found.candidates, 3, "the union held every candidate, deduplicated");
    assert.deepEqual(found.seeds, [seedB.url], "the result says which seeds nominated the winner");

    // Every candidate across the union failing names refusals from BOTH seeds
    // — including the seed that nominated each failing copy.
    const seedC = opSeed("https://operator-c.example/seed.json", {
      bundle: `${base}/absent-c.json`,
      bundleRoot: pinnedRoot,
    });
    seedA.bundle = `${base}/absent-a.json`;
    seedA.mirrors = [];
    await assert.rejects(
      () => findVerifiedBundleFromSeeds([seedA, seedC]),
      (error: Error) => {
        assert.match(error.message, /absent-a\.json/);
        assert.match(error.message, /absent-c\.json/);
        assert.equal((error.message.match(/HTTP 404/g) ?? []).length, 2);
        assert.match(error.message, /https:\/\/operator-a\.example\/seed\.json/);
        assert.match(error.message, /https:\/\/operator-c\.example\/seed\.json/);
        return true;
      },
      "the union's failure names every refusal, with the seed that nominated each copy",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("seeds disagreeing about the registry stop loudly, before anything is fetched", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;

  const reserialized = JSON.stringify(committed, null, 2) + "\n";
  const honestCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));
  const otherCid = cidV1Raw(Buffer.from(reserialized, "utf8"));
  assert.notEqual(otherCid, honestCid);

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
      findVerifiedBundleFromSeeds(
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

  await assert.rejects(
    () =>
      findVerifiedBundleFromSeeds(
        [
          opSeed("https://operator-a.example/seed.json", {
            bundle: registry,
            bundleRoot: pinnedRoot,
            bundleCid: honestCid,
          }),
          opSeed("https://operator-b.example/seed.json", {
            bundle: registry,
            bundleRoot: pinnedRoot,
            bundleCid: otherCid,
          }),
        ],
        { fetch: recording },
      ),
    (error: Error) => {
      assert.match(error.message, /the seeds disagree about the registry/);
      assert.match(error.message, /bundleCid/);
      assert.match(error.message, new RegExp(honestCid.slice(0, 12)));
      assert.match(error.message, new RegExp(otherCid.slice(0, 12)));
      assert.match(error.message, /https:\/\/operator-a\.example\/seed\.json/);
      assert.match(error.message, /https:\/\/operator-b\.example\/seed\.json/);
      assert.deepEqual(calls, [], "a CID disagreement must be seen before any fetch");
      return true;
    },
    "two operators pinning different content addresses for the same registry must stop the resident",
  );

  // Three seeds, two agreeing and one divergent: the divergence is named with
  // its value and the seed that pinned it.
  await assert.rejects(
    () =>
      findVerifiedBundleFromSeeds(
        [
          opSeed("https://operator-a.example/seed.json", {
            bundle: registry,
            bundleRoot: pinnedRoot,
          }),
          opSeed("https://operator-b.example/seed.json", {
            bundle: registry,
            bundleRoot: pinnedRoot,
          }),
          opSeed("https://operator-c.example/seed.json", {
            bundle: registry,
            bundleRoot: "1".repeat(64),
          }),
        ],
        { fetch: recording },
      ),
    (error: Error) => {
      assert.match(error.message, /the seeds disagree about the registry/);
      assert.match(error.message, new RegExp(pinnedRoot.slice(0, 12)));
      assert.match(error.message, /1{12}/);
      assert.match(error.message, /https:\/\/operator-c\.example\/seed\.json/);
      assert.deepEqual(calls, [], "the divergent seed is named before any fetch");
      return true;
    },
  );
});

test("a seed without a bundleCid beside one that has it is coexistence, not contradiction", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;
  const reserialized = JSON.stringify(committed, null, 2) + "\n";
  const honestCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));

  const seedA = opSeed("https://operator-a.example/seed.json", {
    bundle: "REPLACED",
    bundleRoot: pinnedRoot,
  });
  const seedB = opSeed("https://operator-b.example/seed.json", {
    bundle: "REPLACED",
    bundleRoot: pinnedRoot,
    bundleCid: honestCid,
  });

  // The stricter pin governs candidates both seeds nominated: the
  // re-serialized copy rebuilds the pinned root and would pass the un-pinned
  // seed's checks alone, but the seed that pins the CID refuses it — silently
  // resolving by dropping the stricter pin is exactly what must not happen.
  const server = serve({
    "/reserialized/bundle.json": { body: reserialized },
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    seedA.bundle = `http://127.0.0.1:${port}/reserialized/bundle.json`;
    seedB.bundle = seedA.bundle;

    await assert.rejects(
      () => findVerifiedBundleFromSeeds([seedA, seedB]),
      (error: Error) => {
        assert.doesNotMatch(error.message, /the seeds disagree about the registry/);
        assert.match(error.message, /serves .* the seed pins /);
        assert.match(error.message, new RegExp(honestCid.slice(0, 12)));
        return true;
      },
      "absence of a pin is not a contradiction, and the stricter pin governs",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // And the honest bytes are accepted under the same pins, attributed to both
  // seeds that nominated the copy.
  const honestServer = serve({
    "/reserialized/bundle.json": { body: JSON.stringify(committed) },
  });
  try {
    honestServer.listen(0, "127.0.0.1");
    await once(honestServer, "listening");
    const { port } = honestServer.address() as AddressInfo;
    seedA.bundle = `http://127.0.0.1:${port}/reserialized/bundle.json`;
    seedB.bundle = seedA.bundle;
    const found = await findVerifiedBundleFromSeeds([seedA, seedB]);
    assert.equal(found.source, seedA.bundle);
    assert.deepEqual(found.seeds, [seedA.url, seedB.url]);
    assert.equal(found.candidates, 1);
  } finally {
    honestServer.closeAllConnections();
    await new Promise<void>((resolve) => honestServer.close(() => resolve()));
  }
});

/**
 * RFC 0019 step 1: signed announcements. A seed may carry `announcements[]`;
 * each document is fetched, every record is verified (signature, key id, and
 * the issued/expires window), and each survivor enters the SAME union
 * `planSeedUnion` already runs — no parallel rule. The fixtures are signed
 * with the repo's own helpers (`createAgentKeyfile` + `AgentSigner.sign`) and
 * live in `./announcement-fixtures.ts`, which the API's announcement suite
 * imports too, so both suites exercise the real verification path against one
 * definition of what a record looks like.
 */

/** A fetch stub serving exact routes and recording every URL it is asked for. */
function stubFetch(routes: Record<string, { status?: number; body: string }>, calls: string[] = []) {
  return (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const route = routes[u];
    if (!route) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("a verified announcement nominates its mirror, and that mirror wins when the seed's own candidates fail", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;
  const honestCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));

  const tampered: Bundle = structuredClone(committed);
  tampered.publications = tampered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );

  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: pinnedRoot,
  });

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    bundleCid: honestCid,
    mirrors: [{ bundle: "https://dead.example/bundle.json", root: pinnedRoot }],
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  const events: AnnouncementEvent[] = [];
  const found = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch({
      [registry]: { body: JSON.stringify(tampered) },
      "https://dead.example/bundle.json": { status: 404, body: "{}" },
      [announcedMirror]: { body: JSON.stringify(committed) },
      [announcementUrl]: { body: JSON.stringify([record]) },
    }),
    identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event),
  });

  assert.equal(
    found.source,
    announcedMirror,
    "the announced mirror is the copy that verifies after the seed's own candidates fail",
  );
  assert.equal(found.root, pinnedRoot);
  assert.equal(found.bundle.manifest.root, pinnedRoot);
  assert.deepEqual(
    found.seeds,
    [announcementUrl],
    "the winning copy is attributed to the announcement document that nominated it",
  );
  assert.deepEqual(events, [
    { url: announcementUrl, status: "accepted", mirror: announcedMirror },
  ]);
});

test("a forged announcement is reported and skipped, and the seed's own candidates still work", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;

  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  // The forgery: the payload is edited AFTER signing, so the signature no
  // longer covers what the record claims — the classic forged announcement.
  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: pinnedRoot,
  });
  record.announcement = { ...record.announcement, mirror: "https://evil.example/bundle.json" };

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  const calls: string[] = [];
  const events: AnnouncementEvent[] = [];
  const found = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(
      {
        [registry]: { body: JSON.stringify(committed) },
        [announcementUrl]: { body: JSON.stringify([record]) },
      },
      calls,
    ),
    identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event),
  });

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
    !calls.includes("https://evil.example/bundle.json"),
    "a forged record must not nominate anything: its mirror is never fetched",
  );
});

test("an expired announcement is discarded before the union, so its mirror is never fetched", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;

  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: pinnedRoot,
    issuedAt: iso(-2 * DAY),
    expiresAt: iso(-DAY),
  });

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  const calls: string[] = [];
  const events: AnnouncementEvent[] = [];
  const found = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(
      {
        [registry]: { body: JSON.stringify(committed) },
        [announcementUrl]: { body: JSON.stringify([record]) },
      },
      calls,
    ),
    identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event),
  });

  assert.equal(found.source, registry);
  assert.ok(
    !calls.includes(announcedMirror),
    "an expired record is discarded before the union: its mirror URL is never fetched",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "skipped");
  assert.match(events[0].status === "skipped" ? events[0].reason : "", /expired at /);
});

test("a valid announcement claiming a different root for the same registry trips the union's loud stop", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;
  const otherRoot = "f".repeat(64);

  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: otherRoot,
  });

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  const calls: string[] = [];
  await assert.rejects(
    () =>
      findVerifiedBundleFromSeeds([seed], {
        fetch: stubFetch({ [announcementUrl]: { body: JSON.stringify([record]) } }, calls),
        // Valid and resolvable: the disagreement is the union's to raise, not
        // resolution's to pre-empt.
        identity: announcerIdentity(),
      }),
    (error: Error) => {
      assert.match(error.message, /the seeds disagree about the registry/);
      assert.match(error.message, /bundleRoot/);
      assert.match(error.message, new RegExp(pinnedRoot.slice(0, 12)));
      assert.match(error.message, new RegExp(otherRoot.slice(0, 12)));
      assert.match(error.message, /https:\/\/registry\.example\/seed\.json/);
      assert.match(error.message, /https:\/\/announcer\.example\/announcements\.json/);
      assert.deepEqual(
        calls,
        [announcementUrl],
        "only the announcement document is fetched: the disagreement stops before any candidate is fetched",
      );
      return true;
    },
    "a validly signed announcement contradicting the seed's pin must stop the resident loudly",
  );
});

test("a seed without announcements behaves exactly as before, and no announcement URL is fetched", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;

  const registry = "https://registry.example/bundle.json";
  const mirror = "https://mirror.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";

  // Poisoned for announcement URLs: if the no-announcement path so much as
  // looked at one, the poison fires and the test fails.
  const calls: string[] = [];
  const poisoned = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("announcement")) {
      throw new Error("POISON: an announcement URL must not be fetched");
    }
    return stubFetch({ [mirror]: { body: JSON.stringify(committed) } }, calls)(u);
  }) as typeof fetch;

  const found = await findVerifiedBundle({
    bundle: registry,
    bundleRoot: pinnedRoot,
    mirrors: [{ bundle: mirror, root: pinnedRoot }],
  }, { fetch: poisoned });
  assert.equal(found.source, mirror);
  assert.deepEqual(
    calls,
    [registry, mirror],
    "only the seed's own candidates are fetched; no announcement URL is touched",
  );

  // And the failure wording is the one the no-announcement path has always
  // produced, byte for byte: a single seed, one refusal, no attribution.
  await assert.rejects(
    () => findVerifiedBundle({ bundle: `${registry}.absent`, bundleRoot: pinnedRoot }, { fetch: poisoned }),
    (error: Error) => {
      assert.equal(
        error.message,
        `no candidate rebuilt the pinned root:\n  ${registry}.absent: HTTP 404`,
      );
      return true;
    },
  );
});

/**
 * RFC 0019's question 5, answered mechanically: announcement DOCUMENTS may be
 * cached, VERDICTS never are. A cache hit skips only the fetch-and-parse; the
 * cached bytes re-enter the same record loop a fresh fetch would enter —
 * signature, key resolution, window, lifetime cap, and the per-fold
 * revocation lookup — so the tests below drive a cached document through all
 * four of those and through the reporting that must distinguish a hit from a
 * miss. The fixtures are the same signed ones every other announcement test
 * uses, so a cache cannot pass against hand-rolled crypto or its own shape.
 */

test("two folds sharing one cache fetch the announcement document once, and both accept", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;
  const honestCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));
  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: pinnedRoot,
  });

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    bundleCid: honestCid,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  // The seed's own URL is dead, so the announced mirror is the copy that has
  // to win — the seed's honesty to fall back on, removed.
  const routes = {
    [registry]: { status: 404, body: "{}" },
    [announcedMirror]: { body: JSON.stringify(committed) },
    [announcementUrl]: { body: JSON.stringify([record]) },
  };
  const calls: string[] = [];
  const announcementFetches = () => calls.filter((u) => u === announcementUrl).length;
  const cache = new MemoryAnnouncementCache();

  const first = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(routes, calls),
    identity: announcerIdentity(),
    cache,
    cacheMaxAgeMs: 60_000,
    onAnnouncement: () => {},
  });
  assert.equal(first.source, announcedMirror, "the announced mirror verifies on the first fold");
  const firstCount = announcementFetches();
  assert.equal(
    firstCount,
    1,
    "the cold fold fetches the announcement document exactly once",
  );

  // The second fold must not re-download the bytes it just cached, and a
  // verified record must still be accepted — the cache holds no verdict, so
  // the fold re-derives the acceptance from the cached document itself.
  const events: AnnouncementEvent[] = [];
  const second = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(routes, calls),
    identity: announcerIdentity(),
    cache,
    cacheMaxAgeMs: 60_000,
    onAnnouncement: (event) => events.push(event),
  });
  assert.equal(second.source, announcedMirror, "the announced mirror verifies from the cached document");
  assert.equal(
    announcementFetches(),
    firstCount,
    "the warm fold fetches the announcement document ONCE total across both folds",
  );
  assert.ok(
    events.some((event) => event.url === announcementUrl && event.status === "document" && event.source === "cache"),
    "the warm fold reports that it read the document from the cache",
  );
});

test("a cached document still dies when its key is revoked, because the verdict was never cached", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;
  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: pinnedRoot,
  });

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  // The seed's own URL is dead: before revocation the ANNOUNCED mirror is the
  // only copy the resident can land on, so after revocation the refusal is
  // observable as a louder failure rather than a quiet fallback.
  const routes = {
    [registry]: { status: 404, body: "{}" },
    [announcedMirror]: { body: JSON.stringify(committed) },
    [announcementUrl]: { body: JSON.stringify([record]) },
  };

  // First fold: the record verifies and its DOCUMENT enters the cache.
  const cache = new MemoryAnnouncementCache();
  const calls: string[] = [];
  const accepted = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(routes, calls),
    identity: announcerIdentity(),
    cache,
  });
  assert.equal(accepted.source, announcedMirror, "the record is believed before the key is revoked");

  // Second fold, same cache, same document — but the identity layer now
  // publishes the `key` revocation naming this announcing key. The fold must
  // refuse the record from the CACHED document: the document may live in
  // memory for years, the decision may not outlive its revocation check.
  const revokedIdentity: AnnouncementIdentity = {
    ...announcerIdentity(),
    revokedKey: async () => ({
      id: "revocation-1",
      kind: "key",
      target: announcementSigner().keyId,
      reason: "compromised",
    }),
  };
  const events: AnnouncementEvent[] = [];
  const callsBeforeSecondFold = calls.filter((u) => u === announcementUrl).length;
  await assert.rejects(
    () =>
      findVerifiedBundleFromSeeds([seed], {
        fetch: stubFetch(routes, calls),
        identity: revokedIdentity,
        cache,
        cacheMaxAgeMs: 5 * 60_000,
        onAnnouncement: (event) => events.push(event),
      }),
    (error: Error) => {
      assert.match(error.message, /no candidate rebuilt the pinned root/);
      return true;
    },
    "with the key revoked, the cached record's mirror is no longer a candidate",
  );

  assert.equal(
    calls.filter((u) => u === announcementUrl).length,
    callsBeforeSecondFold,
    "the document was served from the cache, not refetched",
  );
  const documentEvent = events.find((event) => event.status === "document");
  assert.ok(
    documentEvent && documentEvent.status === "document" && documentEvent.source === "cache",
    "the refusal happened on CACHED bytes, which is the point",
  );
  assert.deepEqual(
    events.filter((event) => event.status === "skipped"),
    [
      {
        url: announcementUrl,
        status: "skipped",
        reason: `record 0: the announcing key ${announcementSigner().keyId} is revoked (revocation-1: compromised)`,
      },
    ],
    "the cached record is refused by the revocation exactly as a fresh fetch would be",
  );
});

test("an entry older than cacheMaxAgeMs is a miss: refetched, not silently used", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;
  const honestCid = cidV1Raw(Buffer.from(JSON.stringify(committed), "utf8"));
  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: pinnedRoot,
  });

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    bundleCid: honestCid,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  // The seed's own URL is dead, so the announced mirror is the copy that wins.
  const routes = {
    [registry]: { status: 404, body: "{}" },
    [announcedMirror]: { body: JSON.stringify(committed) },
    [announcementUrl]: { body: JSON.stringify([record]) },
  };

  const calls: string[] = [];
  const cache = new MemoryAnnouncementCache();

  // A FRESH entry is used without a fetch: the fold trusts the caller's TTL.
  await cache.set({
    url: announcementUrl,
    document: JSON.parse(JSON.stringify([record])),
    fetchedAt: Date.now(),
  });
  const events: AnnouncementEvent[] = [];
  const freshFold = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(routes, calls),
    identity: announcerIdentity(),
    cache,
    cacheMaxAgeMs: 60_000,
    onAnnouncement: (event) => events.push(event),
  });
  assert.equal(freshFold.source, announcedMirror, "the cached record verifies and its mirror wins");
  assert.equal(
    calls.filter((u) => u === announcementUrl).length,
    0,
    "a fresh entry is used without refetching the document",
  );
  assert.ok(
    events.some((event) => event.status === "document" && event.source === "cache"),
  );

  // The SAME entry aged beyond the TTL must be a miss: the fold reports the
  // miss by fetching, rather than silently believing old bytes.
  await cache.set({
    url: announcementUrl,
    document: JSON.parse(JSON.stringify([record])),
    fetchedAt: Date.now() - 10 * 60_000,
  });
  const staleEvents: AnnouncementEvent[] = [];
  const stillVerified = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(routes, calls),
    identity: announcerIdentity(),
    cache,
    cacheMaxAgeMs: 60_000,
    onAnnouncement: (event) => staleEvents.push(event),
  });
  assert.equal(
    calls.filter((u) => u === announcementUrl).length,
    1,
    "an entry older than the caller's TTL is refetched, never used",
  );
  assert.ok(
    staleEvents.some((event) => event.status === "document" && event.source === "fetched"),
    "the refetch is reported as the miss it is",
  );
  assert.equal(stillVerified.source, announcedMirror, "the freshly fetched record still verifies");
});

test("a cache miss and a cache hit are both reported, and they are distinguishable", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;
  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";
  const announcedMirror = "https://announcer.example/bundle.json";

  const record = signedAnnouncement(announcementSigner(), {
    bundle: registry,
    mirror: announcedMirror,
    bundleRoot: pinnedRoot,
  });

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  const routes = {
    [registry]: { body: JSON.stringify(committed) },
    [announcementUrl]: { body: JSON.stringify([record]) },
  };
  const cache = new MemoryAnnouncementCache();

  // Cold: the cache is configured, but empty — a MISS, reported as fetched.
  const missEvents: AnnouncementEvent[] = [];
  await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(routes),
    identity: announcerIdentity(),
    cache,
    onAnnouncement: (event) => missEvents.push(event),
  });
  assert.deepEqual(missEvents, [
    { url: announcementUrl, status: "document", source: "fetched" },
    { url: announcementUrl, status: "accepted", mirror: announcedMirror },
  ]);

  // Warm: the same URL now answers from the cache — a HIT, reported as cache.
  const hitEvents: AnnouncementEvent[] = [];
  await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch(routes),
    identity: announcerIdentity(),
    cache,
    onAnnouncement: (event) => hitEvents.push(event),
  });
  assert.deepEqual(hitEvents, [
    { url: announcementUrl, status: "document", source: "cache" },
    { url: announcementUrl, status: "accepted", mirror: announcedMirror },
  ]);
});

test("an announcement URL that 404s is reported and skipped, and everything else works", async () => {
  const honest = verifyBundle(committed);
  const pinnedRoot = honest.computedRoot!;

  const registry = "https://registry.example/bundle.json";
  const announcementUrl = "https://announcer.example/announcements.json";

  const seed: SeedDocument = {
    url: "https://registry.example/seed.json",
    bundle: registry,
    bundleRoot: pinnedRoot,
    announcers: ["operator-alice"],
    announcements: [announcementUrl],
  };

  const events: AnnouncementEvent[] = [];
  const found = await findVerifiedBundleFromSeeds([seed], {
    fetch: stubFetch({
      [registry]: { body: JSON.stringify(committed) },
      [announcementUrl]: { status: 404, body: JSON.stringify({ error: "not found" }) },
    }),
    identity: announcerIdentity(),
    onAnnouncement: (event) => events.push(event),
  });

  assert.equal(found.source, registry, "the unreachable announcement does not stop the search");
  assert.deepEqual(events, [
    { url: announcementUrl, status: "skipped", reason: "HTTP 404" },
  ]);
});
