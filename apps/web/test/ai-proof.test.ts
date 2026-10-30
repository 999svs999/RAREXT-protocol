import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalize } from "@rarext/core";
import {
  STARTER_MODEL,
  STARTER_SEED,
  STARTER_STEPS,
  checkBoundedClaim,
  checkClaim,
  runBoundedProof,
  runCommittedModel,
  sha256Hex,
  fixtureFromBundle,
  renderBoundedPicture,
  renderProofPicture,
  semanticsCommitmentHolds,
  verifyPublishedRendition,
} from "../src/ai.ts";

/**
 * The proof, made in the browser's runtime. These run under node, which has the
 * same WebCrypto — so this file is also the cross-runtime test: if WebCrypto and
 * node's createHash disagreed about any part of the evidence, "anyone can
 * recompute this" would be a slogan rather than a property.
 */

interface CommittedBundle {
  publications: Array<{
    app?: string;
    artifact: { body: { model?: unknown; seed?: number; output?: string; values?: number[] } };
    attestation?: { metricValue?: number };
    challengeId?: string;
  }>;
  challenges: Array<{ id: string; spec: { metric?: string; bound?: number; reference?: number[] } }>;
}

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as CommittedBundle;
const published = committed.publications.find((entry) => entry.app === "ai-generative")!;

test("the browser's digest is node's digest, byte for byte", async () => {
  const sample = canonicalize({ b: 1, a: [1, 2, 3] });
  const node = createHash("sha256").update(sample).digest("hex");
  assert.equal(await sha256Hex(sample), node, "the hash the browser injects into core is the hash the server injects");
});

test("the committed model, run here, reproduces the PUBLISHED output", async () => {
  const run = await runCommittedModel(STARTER_MODEL, STARTER_SEED, STARTER_STEPS);

  assert.equal(run.output, published.artifact.body.output!, "the published output, byte for byte");
  assert.equal(run.proof.correct, true, "and the replay agrees, computed here rather than taken on trust");

  // The evidence matches what node computes for the same inputs — the model
  // digest, and the trace hash built exactly as attestRun builds it.
  const modelDigest = createHash("sha256").update(canonicalize(STARTER_MODEL)).digest("hex");
  assert.equal(run.proof.modelDigest, modelDigest);
  const trace = { modelDigest, seed: STARTER_SEED, steps: STARTER_STEPS, expected: run.output };
  assert.equal(run.proof.traceHash, createHash("sha256").update(canonicalize(trace)).digest("hex"));

  // The committed publication's own seed and model are the ones this page runs.
  assert.equal(published.artifact.body.seed, STARTER_SEED);
  assert.deepEqual(published.artifact.body.model, STARTER_MODEL, "the page runs the committed model, not a copy of its shape");
});

test("a claimed output that is not the model's is refused here too", () => {
  const forged = `${published.artifact.body.output!.slice(0, -4)}zzzz`;
  const verdict = checkClaim(STARTER_MODEL, STARTER_SEED, forged, STARTER_STEPS);
  assert.equal(verdict.correct, false);
  assert.notEqual(verdict.expected, forged, "and the verdict carries what the model actually produces");
  assert.equal(verdict.expected, published.artifact.body.output!);
});

test("the page refuses what it cannot mean, by name rather than by clamping", async () => {
  await assert.rejects(() => runCommittedModel(STARTER_MODEL, STARTER_SEED, -1), /non-negative integer/);
  await assert.rejects(() => runCommittedModel(STARTER_MODEL, STARTER_SEED, 2.5), /non-negative integer/);
  await assert.rejects(() => runCommittedModel(STARTER_MODEL, Number.NaN, 8), /finite number/);
  await assert.rejects(
    () => runCommittedModel(STARTER_MODEL, STARTER_SEED, 1_000_000_000),
    /must not exceed/,
    "a page that generated a billion tokens would be a browser tab as a denial of service",
  );
});

const boundedPublished = committed.publications.find((entry) => entry.app === "ai-bounded")!;
const boundedChallenge = committed.challenges.find((entry) => entry.id === boundedPublished.challengeId)!;
const boundedSpec = boundedChallenge.spec as { metric: "maxAbsError" | "meanAbsError"; bound: number; reference: number[] };

test("the lossy proof, computed here, matches the COMMITTED metric and node's hashes", async () => {
  const proof = await runBoundedProof(
    boundedSpec.reference,
    boundedPublished.artifact.body.values!,
    boundedSpec.metric,
    boundedSpec.bound,
  );

  // The published attestation says what the registry measured; this says what a
  // browser measures for the same bytes. They must be the same number.
  assert.equal(proof.metricValue, boundedPublished.attestation?.metricValue, "the committed metric, recomputed here");
  assert.equal(proof.correct, true, "and it is within the bound the challenge declares");
  assert.equal(proof.metric, boundedSpec.metric);
  assert.equal(proof.bound, boundedSpec.bound);

  // The evidence hashes are node's, from the same fields the registry uses.
  const referenceDigest = createHash("sha256").update(canonicalize(boundedSpec.reference)).digest("hex");
  const reconstructionDigest = createHash("sha256").update(canonicalize(boundedPublished.artifact.body.values!)).digest("hex");
  assert.equal(proof.referenceDigest, referenceDigest);
  assert.equal(proof.reconstructionDigest, reconstructionDigest);
  const trace = {
    metric: boundedSpec.metric,
    metricValue: proof.metricValue,
    bound: boundedSpec.bound,
    referenceDigest,
    reconstructionDigest,
  };
  assert.equal(proof.traceHash, createHash("sha256").update(canonicalize(trace)).digest("hex"));
});

test("a reconstruction outside the bound is refused here too", () => {
  const beyond = boundedPublished.artifact.body.values!.map((value) => value + boundedSpec.bound + 4);
  const claim = checkBoundedClaim(boundedSpec.reference, beyond, boundedSpec.metric, boundedSpec.bound);
  assert.equal(claim.correct, false);
  assert.ok((claim.metricValue ?? 0) > boundedSpec.bound, `the distance is reported: ${claim.metricValue} > ${boundedSpec.bound}`);
});

test("the lossy path refuses what it cannot mean, by name", async () => {
  const values = boundedPublished.artifact.body.values!;
  await assert.rejects(
    () => runBoundedProof(boundedSpec.reference, values.slice(0, 3), boundedSpec.metric, boundedSpec.bound),
    /does not match reference length/,
    "a reconstruction of the wrong length is not a reconstruction of this reference",
  );
  await assert.rejects(
    () => runBoundedProof(boundedSpec.reference, [...values.slice(0, -1), Number.NaN], boundedSpec.metric, boundedSpec.bound),
    /finite numbers/,
  );
  await assert.rejects(() => runBoundedProof(boundedSpec.reference, values, boundedSpec.metric, Number.NaN), /bound must be a finite number/);
});

test("the picture the page draws is the published one, both representations", () => {
  // The same file the page fetches beside itself: `./bundle.json` is the mirror's
  // bundle, and the lossy reference lives in the CHALLENGE spec — exactly where
  // `loadBoundedFixture` reads it. Rendering here in the browser runtime and
  // matching the published raster digests is what makes the page's picture the
  // artifact's picture rather than a picture that happens to look right.
  const bundle = JSON.parse(
    readFileSync(new URL("../../../site/registry/mirror/bundle.json", import.meta.url), "utf8"),
  ) as {
    publications: Array<{ app?: string; challengeId?: string; artifact: { body: any } }>;
    challenges: Array<{ id?: string; spec?: { reference?: number[] } }>;
  };

  const generative = bundle.publications.find((entry) => entry.app === "ai-generative")!;
  const genBody = generative.artifact.body;
  const genBytes = renderProofPicture(genBody, genBody.media.size);
  assert.equal(createHash("sha256").update(genBytes).digest("hex"), genBody.media.raster);
  assert.equal(genBytes.length, genBody.media.size * genBody.media.size * 3);

  const bounded = bundle.publications.find((entry) => entry.app === "ai-bounded")!;
  const boundedBody = bounded.artifact.body;
  const challenge = bundle.challenges.find((entry) => entry.id === bounded.challengeId)!;
  const media = boundedBody.media;
  const strip = renderBoundedPicture(challenge.spec!.reference!, boundedBody.values, {
    width: media.width,
    height: media.height,
    rule: media.rule,
  });
  assert.equal(createHash("sha256").update(strip).digest("hex"), media.raster);

  // And a rule this page does not implement is refused, not drawn.
  assert.throws(() => renderProofPicture({ ...genBody, media: { rule: "someone-elses-v9" } }, 64));
  assert.throws(() => renderBoundedPicture(challenge.spec!.reference!, boundedBody.values, { rule: "someone-elses-v9" }));
});

const mirrorBundle = () =>
  JSON.parse(
    readFileSync(new URL("../../../site/registry/mirror/bundle.json", import.meta.url), "utf8"),
  ) as { publications: Array<any>; challenges: Array<any>; semantics: Array<any> };

test("the fixture's picture comes from the generative edition, not the lossy one", () => {
  const bundle = mirrorBundle();
  const fixture = fixtureFromBundle(bundle)!;
  const generative = bundle.publications.find((entry) => entry.app === "ai-generative");
  const bounded = bundle.publications.find((entry) => entry.app === "ai-bounded");

  assert.equal(fixture.picture.raster, generative.artifact.body.media.raster);
  assert.equal(fixture.picture.size, generative.artifact.body.media.size);
  // The two editions record DIFFERENT rasters, so reading the wrong publication
  // cannot pass by coincidence — which is how the defect survived a green suite.
  assert.notEqual(fixture.picture.raster, bounded.artifact.body.media.raster);

  assert.ok(fixture.lossy, "the bundle carries a committed reference");
  assert.equal(fixture.lossy!.reference.length, 8);
  assert.equal(fixture.lossy!.rendition.width, bounded.artifact.body.media.width);
  assert.equal(fixture.lossy!.rendition.height, bounded.artifact.body.media.height);
  assert.equal(fixture.lossy!.rendition.rule, bounded.artifact.body.media.rule);
});

test("the two halves are independent: with no lossy publication the picture survives", () => {
  const bundle = mirrorBundle();
  const generative = bundle.publications.find((entry) => entry.app === "ai-generative");
  const withoutBounded = { ...bundle, publications: bundle.publications.filter((entry) => entry.app !== "ai-bounded") };

  const fixture = fixtureFromBundle(withoutBounded)!;
  assert.equal(fixture.lossy, null, "no bounded publication, no lossy half");
  // This is the defect, asserted directly: the picture note must still be able to
  // say the drawn picture is the published one when the lossy half is missing.
  assert.equal(fixture.picture.raster, generative.artifact.body.media.raster);
});

test("a bundle without a committed reference yields no lossy half; junk yields nothing", () => {
  assert.equal(fixtureFromBundle({ publications: [], challenges: [] })!.lossy, null);
  assert.equal(fixtureFromBundle(null), null);
  assert.equal(fixtureFromBundle("nope"), null);
  assert.equal(fixtureFromBundle(42), null);
});

test("a published rendition re-derives from its own commitment, both representations", async () => {
  const bundle = mirrorBundle();
  const generative = bundle.publications.find((entry) => entry.app === "ai-generative");
  const bounded = bundle.publications.find((entry) => entry.app === "ai-bounded");
  const challenge = bundle.challenges.find((entry) => entry.id === bounded.challengeId);

  const gen = await verifyPublishedRendition({ app: "ai-generative", body: generative.artifact.body });
  assert.equal(gen.matches, true, "the generative picture is the artifact's own");
  assert.equal(gen.derived, generative.artifact.body.media.raster);

  const lossy = await verifyPublishedRendition({
    app: "ai-bounded",
    body: bounded.artifact.body,
    challenge,
  });
  assert.equal(lossy.matches, true, "the lossy strip is the artifact's own");
  assert.equal(lossy.derived, bounded.artifact.body.media.raster);
});

test("a rendition that is not the claim's picture does NOT re-derive", async () => {
  const bundle = mirrorBundle();
  const generative = bundle.publications.find((entry) => entry.app === "ai-generative");
  const body = generative.artifact.body;

  // Change the SEED and the derived picture moves: the recorded raster is now a
  // picture this commitment cannot produce. This is the whole point of re-deriving.
  const forged = await verifyPublishedRendition({ app: "ai-generative", body: { ...body, seed: body.seed + 1 } });
  assert.equal(forged.matches, false);
  assert.notEqual(forged.derived, forged.recorded);

  // A rule this page does not implement is refused by NAME, never compared loosely.
  const unknown = await verifyPublishedRendition({ app: "x", body: { media: { rule: "someone-elses-v9", raster: "a".repeat(64) } } });
  assert.equal(unknown.derived, null);
  assert.equal(unknown.matches, false);
  assert.match(String(unknown.reason), /does not implement the rule/);

  // An artifact with no raster records nothing to re-derive against.
  const none = await verifyPublishedRendition({ app: "x", body: {} });
  assert.equal(none.recorded, "");
  assert.equal(none.matches, false);
});

test("the published registry's semantics commitment is visible to a browser", async () => {
  // The hasher is ASYNC here on purpose: a browser's only hasher is crypto.subtle, and a
  // synchronous implementation compared each digest against a Promise — reporting all five
  // records as missing while a node-createHash test passed. This test uses the page's shape.
  const asyncSha = async (v: string) => createHash("sha256").update(v).digest("hex");
  const syncSha = (v: string) => createHash("sha256").update(v).digest("hex");
  const bundle = mirrorBundle();

  const status = await semanticsCommitmentHolds(bundle, asyncSha);
  assert.ok(status, "the published registry records a semantics commitment");
  assert.equal(status!.committed, bundle.semantics.length, "every record the bundle carries is committed");
  assert.equal(status!.matched, status!.committed, "and every committed digest matches its record");
  assert.deepEqual(status!.missing, [], "an async hasher must not report records as missing");

  const withSync = await semanticsCommitmentHolds(bundle, syncSha);
  assert.deepEqual(withSync!.missing, [], "a synchronous hasher agrees, so the two shapes cannot drift");

  const edited = {
    ...bundle,
    semantics: bundle.semantics.map((record: any, index: number) =>
      index === 0 ? { ...record, summary: `${record.summary} (edited)` } : record,
    ),
  };
  const drifted = (await semanticsCommitmentHolds(edited, asyncSha))!;
  assert.equal(drifted.missing.length, 1, "an edited record is reported as missing from the commitment");

  // And a bundle with no commitment at all answers null — not false. The bundle never
  // made the claim; that is a different statement from its claim failing.
  assert.equal(await semanticsCommitmentHolds({ publications: [], semantics: [] }, asyncSha), null);
});
