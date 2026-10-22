import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalize,
  claimFromAttestation,
  findSemantics,
  LOGIC_SEMANTICS,
  semanticsBinding,
  taskForSemantics,
} from "../src/index.ts";
import type { Attestation, Challenge } from "../src/index.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const LOGIC_VERIFIER_MANIFEST = {
  algorithm: "nand-latch-simulator",
  app: "logic",
  artifactKind: "logic.netlist",
  version: 1,
};

test("pinned semantic spec hashes match the shipped task specs", () => {
  for (const semantics of LOGIC_SEMANTICS) {
    const task = taskForSemantics(semantics);
    assert.ok(task, `no task backs ${semantics.id}`);

    const hash = sha256(canonicalize(task));
    assert.equal(
      hash,
      semantics.specHash,
      `${semantics.id}@${semantics.version} spec hash is stale: bump the semantics version and repin the hash when a task spec changes`,
    );
  }
});

test("the built-in logic verifier hash is pinned to its manifest", () => {
  const hash = sha256(canonicalize(LOGIC_VERIFIER_MANIFEST));

  for (const semantics of LOGIC_SEMANTICS) {
    assert.equal(
      semantics.verifierHash,
      hash,
      `${semantics.id} verifier hash does not match the built-in manifest`,
    );
  }
});

test("semantics binding detects a changed spec", () => {
  const challenge: Challenge = {
    id: "half-adder",
    app: "logic",
    title: "Add two bits",
    description: "",
    version: 1,
    spec: { id: "half-adder", changed: true },
    semanticsId: "logic/half-adder",
    semanticsVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const specHash = sha256(canonicalize(challenge.spec));
  assert.equal(
    semanticsBinding(challenge, LOGIC_SEMANTICS, specHash),
    "spec-mismatch",
  );
});

test("semantics binding reports missing and version-mismatched meaning", () => {
  const task = taskForSemantics(LOGIC_SEMANTICS[0]!);
  assert.ok(task);

  const base: Challenge = {
    id: "half-adder",
    app: "logic",
    title: "Add two bits",
    description: "",
    version: 1,
    spec: task,
    semanticsId: "logic/half-adder",
    semanticsVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const hash = sha256(canonicalize(base.spec));
  assert.equal(semanticsBinding(base, LOGIC_SEMANTICS, hash), "ok");

  assert.equal(
    semanticsBinding({ ...base, semanticsId: "logic/unknown" }, LOGIC_SEMANTICS, hash),
    "missing",
  );
  assert.equal(
    semanticsBinding({ ...base, semanticsVersion: 9 }, LOGIC_SEMANTICS, hash),
    "version-mismatch",
  );
});

test("findSemantics returns the latest version by default", () => {
  const registry = [
    { ...LOGIC_SEMANTICS[0]!, version: 1 },
    { ...LOGIC_SEMANTICS[0]!, version: 2 },
  ];

  assert.equal(findSemantics(registry, "logic/half-adder")?.version, 2);
  assert.equal(findSemantics(registry, "logic/half-adder", 1)?.version, 1);
  assert.equal(findSemantics(registry, "logic/half-adder", 3), null);
});

test("a claim binds subject, meaning, and proof", () => {
  const semantics = LOGIC_SEMANTICS[0]!;
  const attestation: Attestation = {
    id: "att-1",
    verifier: "rarext-v0",
    app: "logic",
    challengeId: "half-adder",
    taskId: "half-adder",
    circuitHash: "circuit-hash",
    traceHash: "trace-hash",
    correct: true,
    score: 1000,
    gateCount: 5,
    semanticsId: semantics.id,
    semanticsVersion: semantics.version,
    semanticsHash: "semantics-hash",
    claimKind: "satisfies",
    scope: null,
    verifierHash: "verifier-hash",
    proofKind: "recomputable",
    signatureAlgorithm: "ecdsa-p256",
    cryptoProfile: "classical",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const claim = claimFromAttestation(attestation, semantics, "half-adder");

  assert.equal(claim.kind, "satisfies");
  assert.equal(claim.subject, "circuit-hash");
  assert.equal(claim.semanticsId, "logic/half-adder");
  assert.equal(claim.semanticsVersion, 1);
  assert.equal(claim.semanticsHash, "semantics-hash");
  assert.equal(claim.proofKind, "recomputable");
  assert.equal(claim.proofHash, "trace-hash");
  assert.equal(claim.predicate, "logic/half-adder@1 (half-adder)");
});
