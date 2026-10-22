import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import type {
  Artifact,
  Attestation,
  Challenge,
  OperatorAttestation,
  Publication,
} from "../../../packages/core/src/index.ts";
import { canonicalize } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  RarextClient,
  createAgentKeyfile,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import { VerifierOperatorRegistry, signOperator } from "../src/verifier-operators.ts";
import { post, start, stop } from "./helpers.ts";

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
  target: Artifact = artifact,
  overrides: Partial<Attestation> = {},
): Attestation {
  return {
    id: randomUUID(),
    verifier: "echo-lab-independent",
    app: target.app,
    challengeId: challenge.id,
    taskId: challenge.id,
    circuitHash: createHash("sha256").update(canonicalize(target)).digest("hex"),
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
    ...overrides,
  };
}

function signedBy(owner: AgentSigner, attestation: Attestation): OperatorAttestation {
  return { keyId: owner.keyId, attestation, signature: owner.sign(attestation) };
}

function challenges() {
  return {
    list: () => [challenge],
    get: (id: string) => (id === challenge.id ? challenge : null),
  };
}

test("a publication from an independent operator needs no local verifier", async () => {
  const owner = signer();
  const operators = new VerifierOperatorRegistry();
  const { server, base } = await start(undefined, {
    challenges: challenges(),
    operators,
  });

  try {
    const registration = await post(
      base,
      "/v1/verifier-operators",
      signOperator(
        { name: "Echo Lab Verifier", apps: ["echo-lab"], url: "https://verify.example" },
        owner,
      ),
    );

    assert.equal(registration.status, 201);
    assert.deepEqual(await registration.json(), {
      status: "registered",
      keyId: owner.keyId,
      name: "Echo Lab Verifier",
      apps: ["echo-lab"],
    });

    const list = (await (await fetch(`${base}/v1/verifier-operators`)).json()) as {
      keyId: string;
    }[];

    assert.equal(list.length, 1);
    assert.equal(list[0]!.keyId, owner.keyId);

    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Echo build",
      challengeId: challenge.id,
      artifact,
      operatorAttestation: signedBy(owner, attestationFor(owner)),
    });

    assert.equal(response.status, 201);

    const publication = (await response.json()) as Publication;

    assert.equal(publication.verification, "operator");
    assert.equal(publication.attestationKeyId, owner.keyId);
    assert.equal(typeof publication.attestationSignature, "string");
    assert.equal(publication.attestation.score, 88);
    assert.equal(publication.attestation.verifier, "echo-lab-independent");
    assert.equal(publication.verified, false);

    const fetched = (await (
      await fetch(`${base}/v1/publications/${publication.id}`)
    ).json()) as Publication;

    assert.equal(fetched.attestationKeyId, owner.keyId);
    assert.equal(typeof fetched.attestationSignature, "string");

    const verified = (await (await post(base, "/v1/verify", {
      publicationId: publication.id,
    })).json()) as {
      valid: boolean;
      reason: string | null;
      recomputed: null;
      operator: { name: string } | null;
    };

    assert.equal(verified.valid, true);
    assert.equal(verified.recomputed, null);
    assert.equal(verified.operator!.name, "Echo Lab Verifier");
  } finally {
    await stop(server);
  }
});

test("a signed publication carries the operator attestation through the payload", async () => {
  const owner = signer();
  const operators = new VerifierOperatorRegistry();

  operators.register(signOperator({ name: "Echo Lab Verifier", apps: ["echo-lab"] }, owner));

  const { server, base } = await start(undefined, {
    challenges: challenges(),
    operators,
  });

  try {
    const client = new RarextClient({ baseUrl: base });
    const keyfile = createAgentKeyfile("agent-echo");
    const author = new AgentSigner(keyfile.privateKey);

    await client.registerAgent(author, keyfile.handle);

    const operatorAttestation = signedBy(owner, attestationFor(owner));
    const publication = await client.publishArtifactAs(author, {
      author: keyfile.handle,
      title: "Signed echo build",
      challengeId: challenge.id,
      artifact,
      operatorAttestation,
    });

    assert.equal(publication.verification, "operator");
    assert.equal(publication.attestationKeyId, owner.keyId);
    assert.equal(publication.verified, true);
    assert.equal(publication.attestationSignature, operatorAttestation.signature);
    assert.equal(
      ((await (await post(base, "/v1/verify", { publicationId: publication.id })).json()) as {
        valid: boolean;
      }).valid,
      true,
    );
  } finally {
    await stop(server);
  }
});

test("operator attestations are refused when any binding is wrong", async () => {
  const owner = signer();
  const outsider = signer();
  const operators = new VerifierOperatorRegistry();

  operators.register(signOperator({ name: "Echo Lab Verifier", apps: ["echo-lab"] }, owner));
  operators.register(signOperator({ name: "Other Lab", apps: ["other-lab"] }, outsider));

  const { server, base } = await start(undefined, {
    challenges: challenges(),
    operators,
  });

  const submit = async (operatorAttestation: OperatorAttestation, target = artifact) => {
    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Echo build",
      challengeId: challenge.id,
      artifact: target,
      operatorAttestation,
    });

    return { status: response.status, body: (await response.json()) as { error?: string } };
  };

  try {
    const control = await submit(signedBy(owner, attestationFor(owner)));

    assert.equal(control.status, 201, "the control case succeeds");

    const unauthorised = await submit(signedBy(outsider, attestationFor(outsider)));

    assert.equal(unauthorised.status, 422);
    assert.match(unauthorised.body.error ?? "", /not authorised/);

    const attestation = attestationFor(owner);
    const tampered = signedBy(owner, attestation);
    tampered.attestation = { ...attestation, score: 99 };

    const forged = await submit(tampered);

    assert.equal(forged.status, 422);
    assert.match(forged.body.error ?? "", /signature/);

    const wrongArtifact = await submit(
      signedBy(owner, attestationFor(owner)),
      { ...artifact, body: { value: 41 } },
    );

    assert.equal(wrongArtifact.status, 422);
    assert.match(wrongArtifact.body.error ?? "", /another artifact/);

    const sealedResponse = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Sealed echo",
      challengeId: challenge.id,
      artifact,
      visibility: "sealed",
      operatorAttestation: signedBy(owner, attestationFor(owner)),
    });

    assert.equal(sealedResponse.status, 422);
    assert.match(
      ((await sealedResponse.json()) as { error: string }).error,
      /sealed/,
    );

    const noVerifier = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Echo build",
      challengeId: challenge.id,
      artifact,
      operatorAttestation: signedBy(signer(), attestationFor(signer())),
    });

    assert.equal(noVerifier.status, 422);
    assert.match(((await noVerifier.json()) as { error: string }).error, /unknown verifier operator/);
  } finally {
    await stop(server);
  }
});

test("a publication without an operator or a local verifier is still refused", async () => {
  const { server, base } = await start(undefined, { challenges: challenges() });

  try {
    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Echo build",
      challengeId: challenge.id,
      artifact,
    });

    assert.equal(response.status, 404);
  } finally {
    await stop(server);
  }
});
