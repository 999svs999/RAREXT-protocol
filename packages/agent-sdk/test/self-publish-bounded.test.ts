import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
