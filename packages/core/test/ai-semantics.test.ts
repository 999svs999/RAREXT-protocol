import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AI_SEMANTICS,
  claimFromAttestation,
  claimKindAllowed,
  semanticsBinding,
  SEMANTICS_CREATED_AT,
} from "../src/semantics.ts";
import type { Attestation } from "../src/types.ts";

test("the declared AI semantics licenses generative claims", () => {
  assert.equal(AI_SEMANTICS.length, 2);

  const record = AI_SEMANTICS[0]!;
  assert.equal(record.id, "ai-generative/gen-starter");
  assert.equal(record.app, "ai-generative");
  assert.equal(record.claimKind, "generative");
  assert.equal(record.origin, "declared");
  assert.equal(record.createdAt, SEMANTICS_CREATED_AT);
  assert.equal(claimKindAllowed(record, "generative"), true);
  assert.equal(claimKindAllowed(record, "satisfies"), false);
});

test("the declared bounded semantics licenses bounded claims", () => {
  const record = AI_SEMANTICS[1]!;
  assert.equal(record.id, "ai-bounded/bounded-starter");
  assert.equal(record.app, "ai-bounded");
  assert.equal(record.claimKind, "bounded");
  assert.equal(claimKindAllowed(record, "bounded"), true);
  assert.equal(claimKindAllowed(record, "satisfies"), false);
  assert.match(record.specHash, /^[0-9a-f]{64}$/);
  assert.equal(record.specHash, "f60f26388d166de74bb596ba449f96a135490c3a690584cb05031a8cf51c8b1f");
});

test("a bounded claim derives a recomputable proof kind", () => {
  const record = AI_SEMANTICS[1]!;
  const attestation = {
    claimKind: "bounded",
    representation: "bounded",
    metricName: "maxAbsError",
    metricValue: 2,
    circuitHash: "c".repeat(64),
    traceHash: "t".repeat(64),
    semanticsHash: record.specHash,
    scope: null,
    verifier: "bounded-metric-replay",
    verifierHash: record.verifierHash!,
    createdAt: SEMANTICS_CREATED_AT,
  } as Attestation;

  const claim = claimFromAttestation(attestation, record, "bounded-starter");
  assert.equal(claim.kind, "bounded");
  assert.equal(claim.proofKind, "recomputable");
  assert.equal(claim.representation, "bounded");
  assert.equal(claim.metricName, "maxAbsError");
  assert.equal(claim.metricValue, 2);
});

test("the pinned spec hash matches the gen-starter spec", () => {
  // The challenge registry seeds gen-starter with exactly this spec; if the
  // spec ever changes, the semantics version must be bumped with it.
  const record = AI_SEMANTICS[0]!;
  assert.match(record.specHash, /^[0-9a-f]{64}$/);
  assert.equal(record.specHash, "bf2f754113f0c32835ea5b1e6f88f7d694d3a00a9a0ca772c12a7c796de1b6a3");
});

test("a generative claim derives a recomputable proof kind", () => {
  const record = AI_SEMANTICS[0]!;
  const attestation = {
    claimKind: "generative",
    representation: "generative",
    circuitHash: "c".repeat(64),
    traceHash: "t".repeat(64),
    semanticsHash: record.specHash,
    scope: null,
    verifier: "xorshift32-replay",
    verifierHash: record.verifierHash!,
    createdAt: SEMANTICS_CREATED_AT,
  } as Attestation;

  const claim = claimFromAttestation(attestation, record, "gen-starter");
  assert.equal(claim.kind, "generative");
  assert.equal(claim.proofKind, "recomputable");
  assert.equal(claim.representation, "generative");
  assert.equal(claim.predicate, `${record.id}@${record.version} (gen-starter)`);
});

test("the binding check reports ok for the seeded spec", () => {
  const record = AI_SEMANTICS[0]!;
  const challenge = {
    id: "gen-starter",
    spec: { steps: 32 },
    semanticsId: record.id,
    semanticsVersion: record.version,
  };

  const canonicalize = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${(v as unknown[]).map(canonicalize).join(",")}]`;
    const record_ = v as Record<string, unknown>;
    const keys = Object.keys(record_).filter((k) => record_[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record_[k])}`).join(",")}}`;
  };
  const specHash = createHash("sha256").update(canonicalize(challenge.spec)).digest("hex");

  assert.equal(semanticsBinding(challenge, AI_SEMANTICS, specHash), "ok");
});
