import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Artifact,
  Attestation,
  Challenge,
  OperatorAttestation,
} from "../../../packages/core/src/index.ts";
import { canonicalize } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import {
  VerifierOperatorRegistry,
  asOperatorAttestation,
  signOperator,
  signOperatorRevocation,
  verifyOperator,
  verifyOperatorAttestation,
} from "../src/verifier-operators.ts";

const challenge: Challenge = {
  id: "echo-1",
  app: "echo-lab",
  title: "Echo a signal",
  description: "Return a verified echo of the submitted signal.",
  version: 1,
  spec: { kind: "echo" },
  semanticsId: "echo-lab/echo-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const artifact: Artifact = {
  app: "echo-lab",
  kind: "echo.signal",
  version: 1,
  mediaType: "application/json",
  body: { value: 42 },
};

function signer(): AgentSigner {
  return new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
}

function attestationFor(
  owner: AgentSigner,
  options: Partial<Attestation> = {},
): Attestation {
  return {
    id: randomUUID(),
    verifier: "echo-lab-independent",
    app: artifact.app,
    challengeId: challenge.id,
    taskId: challenge.id,
    circuitHash: createHash("sha256").update(canonicalize(artifact)).digest("hex"),
    traceHash: "0".repeat(64),
    correct: true,
    score: 88,
    gateCount: 3,
    semanticsId: challenge.semanticsId,
    semanticsVersion: challenge.semanticsVersion,
    semanticsHash: "0".repeat(64),
    claimKind: "satisfies",
    scope: null,
    proofKind: "recomputable",
    signatureAlgorithm: owner.suite,
    cryptoProfile: owner.suite === "ecdsa-p256" ? "classical" : "post-quantum",
    verifierHash: "1".repeat(64),
    createdAt: new Date().toISOString(),
    ...options,
  };
}

test("an operator registration is self-signed and its keyId is its key", () => {
  const owner = signer();
  const signed = signOperator(
    { name: "Echo Lab Verifier", apps: ["echo-lab"], url: "https://verify.example" },
    owner,
  );

  assert.equal(verifyOperator(signed).ok, true);
  assert.equal(signed.operator.keyId, owner.keyId);
  assert.equal(signed.operator.algorithm, "ecdsa-p256");

  const tampered = structuredClone(signed);
  tampered.operator.name = "Someone Else";

  assert.equal(verifyOperator(tampered).ok, false);
  assert.match(verifyOperator(tampered).reason ?? "", /signature/);

  const swappedKey = structuredClone(signed);
  swappedKey.operator.publicKey = signer().publicKey as never;

  assert.equal(verifyOperator(swappedKey).ok, false);
});

test("the operator registry is permissionless but not forgeable", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-operators-"));
  const owner = signer();
  const signed = signOperator({ name: "Echo", apps: ["echo-lab"] }, owner);
  const registry = new VerifierOperatorRegistry(join(root, "operators"));

  try {
    assert.deepEqual(registry.register(signed), { status: 201 });
    assert.deepEqual(registry.register(signed), { status: 200 });
    assert.equal(registry.get(owner.keyId)!.name, "Echo");
    assert.equal(registry.list().length, 1);
    assert.ok(registry.authorize(owner.keyId, "echo-lab"));
    assert.equal(registry.authorize(owner.keyId, "other-lab"), null);

    const forgery = structuredClone(signed);
    forgery.operator.url = "https://other.example";
    forgery.signature = owner.sign(forgery.operator);

    assert.deepEqual(registry.register(forgery), {
      status: 409,
      error: "operator keyId is already registered",
    });

    const reloaded = new VerifierOperatorRegistry(join(root, "operators"));

    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.get(owner.keyId)!.name, "Echo");

    const nonOperator = { operator: { kind: "rarext.operator" }, signature: "AA" };

    assert.equal(verifyOperator(nonOperator as never).ok, false);
    assert.equal(registry.register({ ...signed, signature: "AAAA" }).status, 401);
    assert.equal(registry.get("0".repeat(64)), null);
    assert.equal(asOperatorAttestation({ keyId: "x" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wildcard operator covers every app", () => {
  const owner = signer();
  const registry = new VerifierOperatorRegistry();

  registry.register(signOperator({ name: "Anyone", apps: ["*"] }, owner));

  assert.ok(registry.authorize(owner.keyId, "echo-lab"));
  assert.ok(registry.authorize(owner.keyId, "anything-else"));
});

test("an operator attestation must bind the challenge, the artifact, and the operator", () => {
  const owner = signer();
  const registry = new VerifierOperatorRegistry();

  registry.register(
    signOperator(
      { name: "Echo", apps: ["echo-lab"], url: "https://verify.example" },
      owner,
    ),
  );

  const attestation = attestationFor(owner);
  const good: OperatorAttestation = {
    keyId: owner.keyId,
    attestation,
    signature: owner.sign(attestation),
  };

  const checked = verifyOperatorAttestation(good, registry, challenge, artifact);

  assert.equal(checked.ok, true);
  assert.equal(checked.operator!.name, "Echo");
  assert.deepEqual(asOperatorAttestation(good), good);

  const wrongArtifact = verifyOperatorAttestation(
    good,
    registry,
    challenge,
    { ...artifact, body: { value: 41 } },
  );

  assert.equal(wrongArtifact.ok, false);
  assert.match(wrongArtifact.reason ?? "", /another artifact/);

  const wrongChallenge = verifyOperatorAttestation(
    good,
    registry,
    { ...challenge, id: "echo-2" },
    artifact,
  );

  assert.equal(wrongChallenge.ok, false);

  const notCorrect = attestationFor(owner, { correct: false });
  const rejected = verifyOperatorAttestation(
    { keyId: owner.keyId, attestation: notCorrect, signature: owner.sign(notCorrect) },
    registry,
    challenge,
    artifact,
  );

  assert.equal(rejected.ok, false);
  assert.match(rejected.reason ?? "", /not attest/);

  const forged = verifyOperatorAttestation(
    { ...good, signature: signer().sign(attestation) },
    registry,
    challenge,
    artifact,
  );

  assert.equal(forged.ok, false);
  assert.match(forged.reason ?? "", /signature/);

  const unknown = verifyOperatorAttestation(
    { ...good, keyId: "f".repeat(64) },
    registry,
    challenge,
    artifact,
  );

  assert.equal(unknown.ok, false);
  assert.match(unknown.reason ?? "", /unknown verifier operator/);

  const otherRegistry = new VerifierOperatorRegistry();
  const outsider = signer();

  otherRegistry.register(
    signOperator({ name: "Other", apps: ["other-lab"] }, outsider),
  );

  const outsiderAttestation = attestationFor(outsider);
  const unauthorised = verifyOperatorAttestation(
    {
      keyId: outsider.keyId,
      attestation: outsiderAttestation,
      signature: outsider.sign(outsiderAttestation),
    },
    otherRegistry,
    challenge,
    artifact,
  );

  assert.equal(unauthorised.ok, false);
  assert.match(unauthorised.reason ?? "", /not authorised/);
});

// ---------------------------------------------------------------------------
// Hardening round: the operator gate. `register` stores whatever
// `verifyOperator` accepts, and this surface decides who is paid for verifier
// work — so every refusal branch is pinned by name.
// ---------------------------------------------------------------------------

test("mechanism: shape — a malformed operator record is refused, by name", () => {
  const owner = signer();
  const base = signOperator({ name: "Echo", apps: ["echo-lab"] }, owner);

  const mutate = (change: (record: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(base)) as { operator: Record<string, unknown> };
    change(copy.operator);
    return copy as never;
  };

  const expectations: Array<[string, () => unknown, RegExp]> = [
    ["record missing", () => ({ signature: "AA" }), /operator must be an object/],
    ["wrong kind", () => mutate((o) => { o.kind = "rarext.something"; }), /kind is not a verifier operator/],
    ["wrong version", () => mutate((o) => { o.version = 2; }), /version is not supported/],
    [
      "signature not a string",
      () => ({ operator: (base as { operator: unknown }).operator, signature: 42 }),
      /signature must be a string/,
    ],
    ["name missing", () => mutate((o) => { o.name = ""; }), /name is required/],
    ["name blank", () => mutate((o) => { o.name = "   "; }), /name is required/],
    ["name overlong", () => mutate((o) => { o.name = "n".repeat(81); }), /name is too long/],
    ["publicKey missing", () => mutate((o) => { o.publicKey = null; }), /publicKey is missing/],
    ["algorithm mismatch", () => mutate((o) => { o.algorithm = "ed25519"; }), /algorithm is not supported/],
    ["keyId not the key's digest", () => mutate((o) => { o.keyId = "0".repeat(64); }), /keyId does not match the public key/],
    ["apps not a list", () => mutate((o) => { o.apps = "echo-lab"; }), /apps must be a non-empty list/],
    ["apps empty", () => mutate((o) => { o.apps = []; }), /apps must be a non-empty list/],
    ["app not a string", () => mutate((o) => { o.apps = [5]; }), /every app must be a non-empty string/],
    ["app blank", () => mutate((o) => { o.apps = [""]; }), /every app must be a non-empty string/],
    ["apps duplicated", () => mutate((o) => { o.apps = ["echo-lab", "echo-lab"]; }), /apps must be unique/],
    ["url not http(s)", () => mutate((o) => { o.url = "ftp://example.test"; }), /url must be http\(s\) or null/],
    ["createdAt not ISO", () => mutate((o) => { o.createdAt = "yesterday"; }), /createdAt must be an ISO timestamp/],
  ];

  for (const [name, build, pattern] of expectations) {
    const result = verifyOperator(build() as never);
    assert.equal(result.ok, false, `${name} must be refused`);
    assert.match(result.reason ?? "", pattern, `${name}: got ${result.reason}`);
  }

  // A record whose shape is fine but whose signature does not cover it fails on
  // the signature itself: the verifier's canonical payload is the record.
  const edited = JSON.parse(JSON.stringify(base)) as { operator: Record<string, unknown> };
  edited.operator.name = "Renamed after signing";
  const tampered = verifyOperator(edited as never);
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason ?? "", /signature does not verify/);

  // And the honest record is accepted, so the gate is not simply refusing.
  assert.equal(verifyOperator(base).ok, true);
});

test("mechanism: registry — revoked, duplicate, and idempotent registrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-operators-"));
  const owner = signer();
  const other = signer();

  try {
    const registry = new VerifierOperatorRegistry(dir);
    const first = signOperator({ name: "Echo", apps: ["echo-lab"] }, owner);

    assert.equal(registry.register(first).status, 201, "a new operator is registered");
    assert.equal(registry.register(first).status, 200, "the same record again is idempotent");

    const renamed = signOperator({ name: "Echo renamed", apps: ["echo-lab"] }, owner);
    const conflict = registry.register(renamed);
    assert.equal(conflict.status, 409, "one keyId, one operator record");
    assert.match(conflict.error ?? "", /already registered/);
    assert.equal(registry.get(owner.keyId)?.name, "Echo", "the first record stands");

    // An invalid record never reaches the store.
    const rejected = registry.register({ operator: { kind: "rarext.operator" }, signature: "AA" } as never);
    assert.equal(rejected.status, 401);
    assert.equal(registry.list().length, 1);

    // A revoked key cannot come back, even with a fresh record.
    assert.equal(registry.register(signOperator({ name: "Other", apps: ["x"] }, other)).status, 201);
    assert.equal(registry.revoke(signOperatorRevocation(other)).status, 200);
    const afterRevocation = registry.register(signOperator({ name: "Other again", apps: ["x"] }, other));
    assert.equal(afterRevocation.status, 409);
    assert.match(afterRevocation.error ?? "", /revoked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
