import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalize,
  type Artifact,
  type Attestation,
  type Challenge,
  type OperatorAttestation,
  type Publication,
} from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import {
  VerifierOperatorRegistry,
  signOperator,
  signOperatorRevocation,
  verifyOperatorAttestation,
} from "../src/verifier-operators.ts";
import { post, start, stop } from "./helpers.ts";

const SCRATCH = fileURLToPath(new URL("../../../.data/", import.meta.url));

const halfAdder: Challenge = {
  id: "half-adder",
  app: "logic",
  title: "Add two bits",
  description: "Turn the answer on when exactly one start is on.",
  version: 1,
  spec: {
    id: "half-adder",
    title: "Add two bits",
    description: "Turn the answer on when exactly one start is on.",
    inputs: ["a", "b"],
    outputs: ["sum", "carry"],
    referenceGateCount: 5,
    cases: [
      { inputs: { a: 0, b: 0 }, outputs: { sum: 0, carry: 0 } },
      { inputs: { a: 0, b: 1 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 0 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 1 }, outputs: { sum: 0, carry: 1 } },
    ],
  },
  semanticsId: "logic/half-adder",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const passingCircuit = {
  components: [
    { id: "a", type: "INPUT" as const },
    { id: "b", type: "INPUT" as const },
    { id: "n3", type: "NAND" as const, inputs: ["a", "b"] },
    { id: "n1", type: "NAND" as const, inputs: ["a", "n3"] },
    { id: "n2", type: "NAND" as const, inputs: ["b", "n3"] },
    { id: "n4", type: "NAND" as const, inputs: ["n1", "n2"] },
    { id: "n5", type: "NAND" as const, inputs: ["n3", "n3"] },
    { id: "sum", type: "OUTPUT" as const, inputs: ["n4"] },
    { id: "carry", type: "OUTPUT" as const, inputs: ["n5"] },
  ],
};

const artifact: Artifact = {
  app: "logic",
  kind: "logic.netlist",
  version: 1,
  mediaType: "application/json",
  body: passingCircuit,
};

function signer(): AgentSigner {
  return new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
}

function attestationFor(owner: AgentSigner): Attestation {
  return {
    id: randomUUID(),
    verifier: "half-adder-independent",
    app: halfAdder.app,
    challengeId: halfAdder.id,
    taskId: halfAdder.id,
    circuitHash: createHash("sha256").update(canonicalize(artifact)).digest("hex"),
    traceHash: "0".repeat(64),
    correct: true,
    score: 1000,
    gateCount: 7,
    semanticsId: halfAdder.semanticsId,
    semanticsVersion: halfAdder.semanticsVersion,
    semanticsHash: "0".repeat(64),
    claimKind: "satisfies",
    scope: null,
    verifierHash: "1".repeat(64),
    proofKind: "recomputable",
    signatureAlgorithm: owner.suite,
    cryptoProfile: owner.suite === "ecdsa-p256" ? "classical" : "post-quantum",
    createdAt: new Date().toISOString(),
  };
}

function signedBy(owner: AgentSigner, attestation: Attestation): OperatorAttestation {
  return { keyId: owner.keyId, attestation, signature: owner.sign(attestation) };
}

test("a published claim verifies against the recomputed meaning", async () => {
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [halfAdder],
      get: (id: string) => (id === halfAdder.id ? halfAdder : null),
    },
  });

  try {
    const published = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Adding machine",
      challengeId: halfAdder.id,
      artifact,
    });

    assert.equal(published.status, 201);

    const publication = (await published.json()) as Publication;
    const verified = await post(base, "/v1/verify", {
      publicationId: publication.id,
    });

    assert.equal(verified.status, 200);

    const result = (await verified.json()) as { valid: boolean };
    assert.equal(result.valid, true);
  } finally {
    await stop(server);
  }
});

test("operator claims bind to the registered key and revocation invalidates old claims", () => {
  mkdirSync(SCRATCH, { recursive: true });
  const root = mkdtempSync(join(SCRATCH, "operator-"));

  try {
    const owner = signer();
    const rotated = signer();
    const outsider = signer();
    const operators = new VerifierOperatorRegistry(root);

    assert.equal(
      operators.register(
        signOperator({ name: "Half Adder Verifier", apps: [halfAdder.app] }, owner),
      ).status,
      201,
    );

    const ownerAttestation = attestationFor(owner);
    const valid = verifyOperatorAttestation(
      signedBy(owner, ownerAttestation),
      operators,
      halfAdder,
      artifact,
    );
    assert.equal(valid.ok, true, valid.reason ?? undefined);

    const wrongSigner = verifyOperatorAttestation(
      {
        keyId: owner.keyId,
        attestation: ownerAttestation,
        signature: outsider.sign(ownerAttestation),
      },
      operators,
      halfAdder,
      artifact,
    );
    assert.equal(wrongSigner.ok, false);
    assert.match(wrongSigner.reason ?? "", /signature/);

    const selfAttested = verifyOperatorAttestation(
      signedBy(outsider, attestationFor(outsider)),
      operators,
      halfAdder,
      artifact,
    );
    assert.equal(selfAttested.ok, false);
    assert.match(selfAttested.reason ?? "", /unknown verifier operator/);

    assert.equal(
      operators.register(
        signOperator({ name: "Half Adder Verifier", apps: [halfAdder.app] }, rotated),
      ).status,
      201,
    );

    const rotatedClaim = verifyOperatorAttestation(
      signedBy(rotated, attestationFor(rotated)),
      operators,
      halfAdder,
      artifact,
    );
    assert.equal(rotatedClaim.ok, true, rotatedClaim.reason ?? undefined);

    assert.equal(
      verifyOperatorAttestation(
        signedBy(owner, ownerAttestation),
        operators,
        halfAdder,
        artifact,
      ).ok,
      true,
      "rotation keeps the old key valid until it is revoked",
    );

    assert.equal(operators.revoke(signOperatorRevocation(owner)).status, 200);

    const revoked = verifyOperatorAttestation(
      signedBy(owner, ownerAttestation),
      operators,
      halfAdder,
      artifact,
    );
    assert.equal(revoked.ok, false);
    assert.match(revoked.reason ?? "", /revoked/);

    assert.equal(
      verifyOperatorAttestation(
        signedBy(rotated, attestationFor(rotated)),
        operators,
        halfAdder,
        artifact,
      ).ok,
      true,
      "revoking the old key does not revoke a rotated key",
    );

    const reloaded = new VerifierOperatorRegistry(root);
    assert.equal(reloaded.isRevoked(owner.keyId), true);
    assert.equal(
      verifyOperatorAttestation(
        signedBy(owner, ownerAttestation),
        reloaded,
        halfAdder,
        artifact,
      ).ok,
      false,
    );
    assert.equal(
      reloaded.register(
        signOperator({ name: "Half Adder Verifier", apps: [halfAdder.app] }, owner),
      ).status,
      409,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier operator endpoint accepts only a matching signed revocation", async () => {
  const owner = signer();
  const operators = new VerifierOperatorRegistry();
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [halfAdder],
      get: (id: string) => (id === halfAdder.id ? halfAdder : null),
    },
    operators,
  });

  try {
    const registration = await post(
      base,
      "/v1/verifier-operators",
      signOperator({ name: "Half Adder Verifier", apps: [halfAdder.app] }, owner),
    );
    assert.equal(registration.status, 201);

    const mismatch = await post(
      base,
      `/v1/verifier-operators/${"0".repeat(64)}/revocation`,
      signOperatorRevocation(owner),
    );
    assert.equal(mismatch.status, 400);

    const revoked = await post(
      base,
      `/v1/verifier-operators/${owner.keyId}/revocation`,
      signOperatorRevocation(owner),
    );
    assert.equal(revoked.status, 200);
    assert.equal(operators.isRevoked(owner.keyId), true);

    const checked = verifyOperatorAttestation(
      signedBy(owner, attestationFor(owner)),
      operators,
      halfAdder,
      artifact,
    );
    assert.equal(checked.ok, false);
    assert.match(checked.reason ?? "", /revoked/);

    const reRegistered = await post(
      base,
      "/v1/verifier-operators",
      signOperator({ name: "Half Adder Verifier", apps: [halfAdder.app] }, owner),
    );
    assert.equal(reRegistered.status, 409);
  } finally {
    await stop(server);
  }
});
