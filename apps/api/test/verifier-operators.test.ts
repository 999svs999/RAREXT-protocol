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
