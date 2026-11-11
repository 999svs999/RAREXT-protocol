import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  GENERATIONS,
  GENERATIONS_KIND,
  MODEL_SHARD_BYTES,
  axisLadder,
  canonicalize,
  generationsDigest,
  generationsProblems,
  networkMeets,
  nextGeneration,
  parseGenerations,
  planModelShards,
  shippedGeneration,
} from "../src/index.ts";

const nodeSha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

test("the ladder is a stable content commitment", () => {
  const digest = generationsDigest(nodeSha256);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(generationsDigest(nodeSha256), digest, "the digest of the same ladder is stable");
  // Recompute it the way a stranger would: canonical JSON, then sha256.
  const expected = createHash("sha256").update(canonicalize(GENERATIONS)).digest("hex");
  assert.equal(digest, expected, "the published digest is the canonical json's own");
  assert.equal(GENERATIONS.kind, GENERATIONS_KIND);
  assert.equal(GENERATIONS.status, "declared");
});

test("the ladder parses only when it is well-formed", () => {
  assert.deepEqual(generationsProblems(GENERATIONS), []);
  assert.ok(parseGenerations(GENERATIONS), "the shipped ladder parses");

  const clone = () => JSON.parse(JSON.stringify(GENERATIONS));

  const wrongKind = clone();
  wrongKind.kind = "rarext.something-else";
  assert.ok(generationsProblems(wrongKind).some((e) => e.includes("kind")));

  const empty = clone();
  empty.network = [];
  assert.ok(generationsProblems(empty).some((e) => e.includes("non-empty array")));

  const duplicate = clone();
  duplicate.web.push({ ...duplicate.web[0] });
  assert.ok(generationsProblems(duplicate).some((e) => e.includes("duplicate id")));

  const reordered = clone();
  reordered.protocol.reverse();
  assert.ok(generationsProblems(reordered).some((e) => e.includes("strictly increasing")));

  const badProfile = clone();
  badProfile.network[0].profile.latencyMsP50 = Number.NaN;
  assert.ok(generationsProblems(badProfile).some((e) => e.includes("latencyMsP50")));

  const badSize = clone();
  badSize.model[0].sizeBytes = 1;
  assert.ok(generationsProblems(badSize).some((e) => e.includes("sizeBytes")));

  assert.equal(parseGenerations({ kind: GENERATIONS_KIND }), null, "a truncated ladder does not parse");
});

test("shipped generations are named, and the model ladder ships the sub-1G class", () => {
  assert.equal(shippedGeneration("web"), "web4");
  assert.equal(shippedGeneration("network"), "5G");
  assert.equal(shippedGeneration("protocol"), "gen-4");
  assert.equal(shippedGeneration("model"), "1G", "the reference serves under 1 GiB; 6/7/8G stay targets");
  assert.equal(GENERATIONS.model.find((entry) => entry.id === "1G")?.shipped, true);
  assert.equal(GENERATIONS.model.find((entry) => entry.id === "8G")?.shipped, false);
});

test("the ladder continues past its last entry on every axis", () => {
  assert.equal(nextGeneration("web", "web4"), "web5");
  assert.equal(nextGeneration("web", "web8"), null);
  assert.equal(nextGeneration("network", "6G"), "7G");
  assert.equal(nextGeneration("protocol", "gen-4"), "gen-6");
  assert.equal(nextGeneration("protocol", "gen-8"), null);
  assert.equal(nextGeneration("model", "1G"), "6G");
  assert.equal(nextGeneration("model", "6G"), "7G");
  assert.equal(nextGeneration("model", "8G"), null);
  assert.deepEqual(axisLadder("model"), ["1G", "6G", "7G", "8G"]);
});

test("a network generation meets only the transports it declares", () => {
  assert.equal(networkMeets("8G", { downlinkMbps: 10000, maxLatencyMsP50: 1 }), true);
  assert.equal(networkMeets("6G", { downlinkMbps: 10000, maxLatencyMsP50: 1 }), true);
  assert.equal(
    networkMeets("5G", { maxLatencyMsP50: 1 }),
    false,
    "5G does not promise a 1 ms budget",
  );
  assert.equal(networkMeets("5G", { edge: true }), true);
  assert.equal(networkMeets("9G", {}), false, "a transport the ladder does not name is not declared");
});

test("a model class shards every byte, and the size is the commitment", () => {
  const plan = planModelShards("8G");
  assert.equal(plan.shardBytes, MODEL_SHARD_BYTES);
  assert.equal(plan.sizeBytes, 8 * 1024 ** 3);
  assert.equal(plan.shards, 1024, "8 GiB over 8 MiB shards");

  const finer = planModelShards("6G", { shardBytes: 1024 * 1024 });
  assert.equal(finer.shards, 6144, "6 GiB over 1 MiB shards");

  assert.throws(() => planModelShards("5G"), /unknown model generation/);
  assert.throws(() => planModelShards("6G", { shardBytes: 0 }), /positive integer/);
});
