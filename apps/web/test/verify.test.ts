import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalize, leafPayload } from "@rarext/core";
import type { Publication } from "@rarext/core";

import { verifyBundle, type Bundle } from "../src/verify.ts";

/**
 * The mirror verifier is what a stranger runs when the operator is gone, so it
 * has to agree with the registry for every tree shape, not just the one the
 * takedown test happens to publish.
 */

function publication(id: string, title = `build ${id}`): Publication {
  return {
    id,
    author: "alice",
    authorKey: "a".repeat(64),
    signatureAlgorithm: "ecdsa-p256",
    title,
    body: "A claim.",
    app: "logic",
    challengeId: "half-adder",
    artifact: {
      app: "logic",
      kind: "logic.netlist",
      version: 1,
      mediaType: "application/json",
      body: { components: [] },
    },
    taskId: "half-adder",
    circuit: { components: [] },
    visibility: "public",
    artifactCommitment: null,
    parentId: null,
    source: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    attestedAt: "2026-01-01T00:00:00.000Z",
    verified: true,
    signature: "c2lnbmF0dXJl",
    nonce: `nonce-${id}`,
    attestation: {
      id: `att-${id}`,
      verifier: "fabric-v0",
      app: "logic",
      challengeId: "half-adder",
      taskId: "half-adder",
      circuitHash: "circuit-hash",
      traceHash: "trace-hash",
      correct: true,
      score: 1000,
      gateCount: 5,
      semanticsId: "logic/half-adder",
      semanticsVersion: 1,
      semanticsHash: "semantics-hash",
      claimKind: "satisfies",
      scope: null,
      verifierHash: "verifier-hash",
      proofKind: "recomputable",
      signatureAlgorithm: "ecdsa-p256",
      cryptoProfile: "classical",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pair(left: string, right: string): string {
  return createHash("sha256").update(left).update(right).digest("hex");
}

function root(leaves: string[]): string {
  if (leaves.length === 0) return hex("");
  if (leaves.length === 1) return leaves[0]!;

  let level = [...leaves];

  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(pair(level[index]!, level[index + 1] ?? level[index]!));
    }
    level = next;
  }

  return level[0]!;
}

function bundle(publications: Publication[], leafVersion = 3): Bundle {
  const leaves = publications.map((entry) =>
    hex(canonicalize(leafPayload(entry, leafVersion))),
  );

  return {
    manifest: {
      root: root(leaves),
      leafVersion,
      publications: publications.map((entry, index) => ({
        id: entry.id,
        leaf: leaves[index]!,
      })),
    },
    publications,
  };
}

test("a one-publication mirror rebuilds the anchored root", async () => {
  const result = await verifyBundle(bundle([publication("p1")]));
  assert.equal(result.valid, true, result.reason ?? "");
});

test("a two-publication mirror rebuilds the anchored root", async () => {
  const result = await verifyBundle(
    bundle([publication("p1"), publication("p2")]),
  );
  assert.equal(result.valid, true, result.reason ?? "");
});

test("a many-publication mirror rebuilds the anchored root", async () => {
  const entries = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((id) =>
    publication(id),
  );

  const result = await verifyBundle(bundle(entries));
  assert.equal(result.valid, true, result.reason ?? "");
});

test("a mirror that changes a publication is not accepted", async () => {
  const original = bundle([publication("p1"), publication("p2")]);
  const tampered: Bundle = {
    manifest: original.manifest,
    publications: [original.publications[0]!, publication("p2", "something else")],
  };

  const result = await verifyBundle(tampered);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /do not rebuild|does not match/);
});

test("a mirror that claims a leaf it does not contain is not accepted", async () => {
  const original = bundle([publication("p1"), publication("p2")]);
  const tampered: Bundle = {
    manifest: {
      ...original.manifest,
      publications: [
        original.manifest.publications[0]!,
        { id: "p2", leaf: "0".repeat(64) },
      ],
    },
    publications: original.publications,
  };

  const result = await verifyBundle(tampered);
  assert.equal(result.valid, false);
});

test("the verifier honours the leaf version an old anchor was made with", async () => {
  const result = await verifyBundle(
    bundle([publication("p1"), publication("p2")], 2),
  );
  assert.equal(result.valid, true, result.reason ?? "");
});
