import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  BOUNDED_RASTER_HEIGHT,
  BOUNDED_RASTER_RULE,
  BOUNDED_RASTER_SCALE,
  boundedRenditionHolds,
  renderBoundedRaster,
} from "@rarext/core";

import { AgentSigner, generateAgentKeypair, replayBundleAi, selfPublishBounded, verifyBundle } from "../src/index.ts";

/**
 * A LOSSY output, made and proved offline — the representation real model
 * classes take, where exact replay is impossible and the claim is a distance
 * instead: "the max absolute error against the committed reference is within the
 * bound".
 *
 * The fixture is the committed bounded publication's own reconstruction and
 * challenge, so the metric being asserted is the one the registry published.
 */

interface CommittedBundle {
  publications: Array<{ app?: string; artifact: { body: { values: number[] } }; challengeId: string }>;
  challenges: Array<{ id: string; spec: { metric?: string } }>;
  semantics: Array<{ id: string }>;
}

const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as CommittedBundle;
const published = committed.publications.find((entry) => entry.app === "ai-bounded")!;
const challenge = committed.challenges.find((entry) => entry.id === published.challengeId)!;
const semantics = committed.semantics.filter((entry) => entry.id.startsWith("ai-bounded/"));

const binding = { id: `ai-bounded/${challenge.id}`, version: 1, claimKind: "bounded" as const };

test("a lossy reconstruction is attested and the metric claim replays from the bundle", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const made = selfPublishBounded(signer, {
    author: "resident",
    title: "A quantized reconstruction, attested here",
    values: [...published.artifact.body.values],
    challenge: challenge as never,
    semantics: semantics as never,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  // The metric is computed, not asserted: the record carries the value and the
  // name of the distance it was measured by.
  assert.equal(made.attestation.representation, "bounded");
  assert.equal(made.attestation.verifier, "bounded-metric-replay", "the RULE's name, not the runner's");
  assert.equal(made.attestation.metricName, (challenge.spec as { metric?: string }).metric);
  assert.equal(typeof made.attestation.metricValue, "number");
  assert.ok(made.attestation.gateCount === published.artifact.body.values.length, "one gate per value");

  const verification = verifyBundle(made.bundle);
  assert.equal(verification.valid, true, verification.reason ?? undefined);

  // And a stranger holding only the bytes recomputes the same verdict.
  const replay = replayBundleAi(JSON.parse(JSON.stringify(made.bundle)));
  assert.equal(replay.claims.length, 1);
  assert.equal(replay.claims[0]!.representation, "bounded");
  assert.equal(
    replay.claims[0]!.correct,
    true,
    `the reconstruction is within the bound, so the claim is true by recomputation (${replay.claims[0]!.error ?? "replayed"})`,
  );
});

test("a reconstruction OUTSIDE the bound is refused, however well it is attested", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const bound = (challenge.spec as { bound?: number }).bound ?? 4;

  // Push every value past the promised distance: the claim is now false, and no
  // signature or attestation can make it true.
  const beyond = published.artifact.body.values.map((value) => value + bound + 4);

  const made = selfPublishBounded(signer, {
    author: "resident",
    title: "outside the bound",
    values: beyond,
    challenge: challenge as never,
    semantics: semantics as never,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  const replay = replayBundleAi(JSON.parse(JSON.stringify(made.bundle)));
  assert.equal(replay.claims.length, 1);
  assert.equal(
    replay.claims[0]!.correct,
    false,
    "the distance exceeds the committed bound, so the claim is false",
  );
  // No error string is the right shape here: this is a VERDICT (checked, and
  // found false), not a failure to check. What carries the reason is the record
  // itself — the distance it measured, against the bound it promised.
  assert.ok(
    (made.attestation.metricValue ?? 0) > bound,
    `the attestation carries the distance that made the claim false (${made.attestation.metricValue} > ${bound})`,
  );
});

test("the SDK refuses a reconstruction it cannot carry, before signing anything", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const call = (values: unknown) =>
    selfPublishBounded(signer, {
      author: "resident",
      title: "nonsense",
      values: values as number[],
      challenge: challenge as never,
      semantics: semantics as never,
      binding,
      createdAt: "2026-10-28T00:00:00.000Z",
    });

  assert.throws(() => call([1, 2, Number.NaN]), /array of finite numbers/, "NaN is a number that is not one");
  assert.throws(() => call([1, "2"]), /array of finite numbers/);
  assert.throws(() => call(3), /array of finite numbers/);
  // A REAL oversized array, not a fake one: an object with a `length` property
  // would trip the array check and prove nothing about the cap it claims to test.
  const oversized = new Array<number>(1_048_577).fill(0);
  assert.throws(() => call(oversized), /must not exceed/, "the cap is on length, and it is core's number");
});

test("a resident can ship the lossy strip, and the registry's own check accepts it", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  const reference = (challenge.spec as { reference: number[] }).reference;
  const values = published.artifact.body.values;

  const made = selfPublishBounded(signer, {
    author: "resident",
    title: "with a strip",
    values,
    challenge,
    semantics,
    binding,
    rendition: {},
    createdAt: "2026-10-28T00:00:00.000Z",
  } as never);

  const body = made.publication.artifact.body as { media?: Record<string, unknown> };
  const media = body.media as { width: number; height: number; rule: string; raster: string; blob: string; bytes: number };
  assert.ok(media, "the artifact carries a strip when one was asked for");

  // The registry's OWN check decides it.
  assert.equal(boundedRenditionHolds(body as never, challenge.spec as never, sha256), true);

  // The WIDTH is one lane per value at the rule's scale — NOT the value count. Taking
  // the count produces a wrong picture that still hashes consistently, so nothing
  // downstream would ever notice; this assertion is the only thing that would.
  assert.equal(media.width, reference.length * BOUNDED_RASTER_SCALE);
  assert.equal(media.height, BOUNDED_RASTER_HEIGHT);
  assert.equal(media.rule, BOUNDED_RASTER_RULE);
  assert.equal(media.raster, sha256(renderBoundedRaster(reference, values, media.width, media.height)));

  // And a strip that is not this artifact's makes the claim false.
  const forged = { ...body, media: { ...media, raster: "0".repeat(64) } };
  assert.equal(boundedRenditionHolds(forged as never, challenge.spec as never, sha256), false);
});

test("a rendition without a committed reference refuses by name", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  assert.throws(
    () =>
      selfPublishBounded(signer, {
        author: "resident",
        title: "no reference",
        values: published.artifact.body.values,
        challenge: { ...challenge, spec: { metric: "maxAbsError", bound: 4 } },
        semantics,
        binding,
        rendition: {},
        createdAt: "2026-10-28T00:00:00.000Z",
      } as never),
    /carries no committed reference/,
  );
});

test("no rendition asked for means none shipped", () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const made = selfPublishBounded(signer, {
    author: "resident",
    title: "values only",
    values: published.artifact.body.values,
    challenge,
    semantics,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  } as never);
  const body = made.publication.artifact.body as { media?: unknown };
  assert.equal(body.media, undefined);
  // And the registry's check says so in its own terms: null, not a false verdict —
  // "this artifact records no picture" is not the same claim as "its picture is wrong".
  assert.equal(boundedRenditionHolds(body as never, challenge.spec as never, (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")), null);
});
