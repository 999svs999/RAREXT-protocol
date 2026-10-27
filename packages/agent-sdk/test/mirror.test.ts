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
  replayBundleAi,
  verifyBundle,
  type Bundle,
} from "../src/index.ts";
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
