import assert from "node:assert/strict";
import test from "node:test";

import type { Publication } from "../../../packages/core/src/index.ts";
import { buildLaunchTrajectory, type LaunchCheckInput } from "../src/trajectory.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop } from "./helpers.ts";

function check(overrides: Partial<LaunchCheckInput> = {}): LaunchCheckInput {
  return {
    publicationId: "pub-1",
    block: 100,
    correct: true,
    score: 100,
    challengeId: "fair-launch-v1",
    semanticsId: "launchpad/fair-launch-v1",
    semanticsVersion: 1,
    semanticsHash: "a".repeat(64),
    verifierHash: "b".repeat(64),
    attestedAt: "2026-10-23T00:00:00.000Z",
    anchored: true,
    ...overrides,
  };
}

test("a policy change is visible as segments, not silently merged", () => {
  const result = buildLaunchTrajectory("0xsafe", "base", [
    check({ publicationId: "p1", block: 10 }),
    check({ publicationId: "p2", block: 20 }),
    check({
      publicationId: "p3",
      block: 30,
      challengeId: "fair-launch-v2",
      semanticsHash: "c".repeat(64),
      verifierHash: "d".repeat(64),
      anchored: false,
    }),
  ]);

  assert.equal(result.verdict, "safe");
  assert.equal(result.count, 3);
  assert.equal(result.policyChanges, 1);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(
    result.segments.map((segment) => [segment.fromBlock, segment.toBlock, segment.count]),
    [[10, 20, 2], [30, 30, 1]],
  );
  assert.equal(result.anchored, 2);
  assert.equal(result.fullyAnchored, false);
  assert.match(result.summary, /2\/3 anchored/);
  assert.match(result.summary, /says nothing after it/);
});

test("one failed check makes the whole trajectory not safe", () => {
  const result = buildLaunchTrajectory("0xsafe", "base", [
    check({ publicationId: "p1", block: 10 }),
    check({ publicationId: "p2", block: 20, correct: false, score: 70 }),
    check({ publicationId: "p3", block: 30 }),
  ]);

  assert.equal(result.verdict, "not-safe");
  assert.equal(result.safe, 2);
  assert.equal(result.unsafe, 1);
  assert.equal(result.checks[1]!.level, "UNSAFE");
  assert.match(result.summary, /1 did not pass/);
});

test("duplicate blocks make a linear trajectory ambiguous", () => {
  const result = buildLaunchTrajectory("0xsafe", "base", [
    check({ publicationId: "p1", block: 10 }),
    check({ publicationId: "p2", block: 10, attestedAt: "2026-10-23T00:01:00.000Z" }),
    check({ publicationId: "p3", block: 20 }),
  ]);

  assert.equal(result.verdict, "ambiguous");
  assert.deepEqual(result.duplicateBlocks, [10]);
  assert.equal(result.policyChanges, 0);
});

test("duplicate publications are counted once and an empty series is honest", () => {
  const duplicated = buildLaunchTrajectory("0xsafe", "base", [
    check({ publicationId: "p1", block: 10 }),
    check({ publicationId: "p1", block: 10 }),
  ]);
  assert.equal(duplicated.count, 1);

  const empty = buildLaunchTrajectory("0xmissing", "base", []);
  assert.equal(empty.verdict, "empty");
  assert.equal(empty.count, 0);
  assert.equal(empty.latest, null);
  assert.match(empty.summary, /no public launch checks/);
});

test("the API maps launch.plan publications to a trajectory", async () => {
  const store = new RarextStore();
  const { server, base } = await start(store);

  try {
    for (const [index, block] of [100, 200, 300].entries()) {
      store.addPublication(publication(`pub-${index}`, block));
    }
    store.addPublication(publication("other", 999, "0xother"));

    const response = await fetch(`${base}/v1/launches/0xSAFE/trajectory?chain=BASE`);
    const body = (await response.json()) as {
      count: number;
      lastBlock: number;
      latest: { publicationId: string };
      verdict: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.count, 3);
    assert.equal(body.lastBlock, 300);
    assert.equal(body.latest.publicationId, "pub-2");
    assert.equal(body.verdict, "safe");

    const missing = await fetch(`${base}/v1/launches/0xmissing/trajectory?chain=base`);
    assert.equal(((await missing.json()) as { count: number }).count, 0);

    const noChain = await fetch(`${base}/v1/launches/0xSAFE/trajectory`);
    assert.equal(noChain.status, 400);
  } finally {
    await stop(server);
  }
});

function publication(id: string, block: number, mint = "0xsafe"): Publication {
  return {
    id,
    author: "apesdaily",
    authorKey: null,
    signatureAlgorithm: "ecdsa-p256",
    title: `Launch ${id}`,
    body: "",
    app: "launchpad",
    challengeId: "fair-launch-v1",
    artifact: {
      app: "launchpad",
      kind: "launch.plan",
      version: 1,
      mediaType: "application/json",
      body: { mint, chain: "base", block },
    },
    taskId: "fair-launch-v1",
    visibility: "public",
    artifactCommitment: null,
    parentId: null,
    source: null,
    createdAt: "2026-10-23T00:00:00.000Z",
    attestedAt: "2026-10-23T00:00:00.000Z",
    verified: true,
    signature: null,
    nonce: null,
    attestation: {
      id: `att-${id}`,
      verifier: "launchpad",
      taskId: "fair-launch-v1",
      circuitHash: "0".repeat(64),
      traceHash: "0".repeat(64),
      correct: true,
      score: 100,
      gateCount: 0,
      semanticsId: "launchpad/fair-launch-v1",
      semanticsVersion: 1,
      semanticsHash: "a".repeat(64),
      claimKind: "attests",
      scope: null,
      verifierHash: "b".repeat(64),
      proofKind: "recomputable",
      signatureAlgorithm: "ecdsa-p256",
      cryptoProfile: "classical",
      createdAt: "2026-10-23T00:00:00.000Z",
    },
  } as Publication;
}
