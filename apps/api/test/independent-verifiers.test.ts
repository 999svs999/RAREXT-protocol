import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
import { createChallengeRegistry } from "../src/challenges.ts";
import { VerifierModuleRegistry } from "../src/verifierModules.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";
import { VerifierOperatorRegistry, signOperator } from "../src/verifier-operators.ts";
import { post, start, stop } from "./helpers.ts";

const SCRATCH = fileURLToPath(new URL("../../../.data/", import.meta.url));

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

test("two operators may disagree, but a publication binds to exactly one verdict", async () => {
  const owner = signer();
  const other = signer();
  const operators = new VerifierOperatorRegistry();

  operators.register(signOperator({ name: "Passing Echo", apps: ["echo-lab"] }, owner));
  operators.register(signOperator({ name: "Failing Echo", apps: ["echo-lab"] }, other));

  const passing = signedBy(owner, attestationFor(owner));
  const failing = signedBy(
    other,
    attestationFor(other, artifact, { correct: false, score: 0 }),
  );

  const { server, base } = await start(undefined, {
    challenges: challenges(),
    operators,
  });

  try {
    const refused = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Echo build",
      challengeId: challenge.id,
      artifact,
      operatorAttestation: failing,
    });

    assert.equal(refused.status, 422);
    assert.match(
      ((await refused.json()) as { error: string }).error,
      /did not attest/,
    );

    const accepted = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Echo build",
      challengeId: challenge.id,
      artifact,
      operatorAttestation: passing,
    });

    assert.equal(accepted.status, 201);
    const publication = (await accepted.json()) as Publication;

    assert.equal(publication.attestationKeyId, owner.keyId);
    assert.equal(publication.attestation.correct, true);

    const verified = (await (await post(base, "/v1/verify", {
      publicationId: publication.id,
    })).json()) as {
      valid: boolean;
      operator: { keyId: string } | null;
    };

    assert.equal(verified.valid, true);
    assert.equal(verified.operator!.keyId, owner.keyId);
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

test("an operator AI verdict is replayed again before /v1/verify accepts it", async () => {
  const browse = createChallengeRegistry();
  const generative = browse.get("gen-starter");
  if (!generative?.sampleArtifact) throw new Error("gen-starter sample missing");
  const sample = generative.sampleArtifact;

  const owner = signer();
  const operators = new VerifierOperatorRegistry();
  operators.register(
    signOperator({ name: "AI replay operator", apps: ["ai-generative"] }, owner),
  );

  const aiAttestation = (target: Artifact, overrides: Partial<Attestation> = {}) =>
    attestationFor(owner, target, {
      challengeId: generative.id,
      taskId: generative.id,
      semanticsId: generative.semanticsId,
      semanticsVersion: generative.semanticsVersion,
      representation: "generative",
      verifier: "operator-generative",
      ...overrides,
    });

  const { server, base } = await start(undefined, {
    challenges: browse,
    operators,
  });

  try {
    const accepted = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Operator replay",
      challengeId: generative.id,
      artifact: sample,
      operatorAttestation: signedBy(owner, aiAttestation(sample)),
    });
    assert.equal(accepted.status, 201);
    const publication = (await accepted.json()) as Publication;

    const verified = (await (await post(base, "/v1/verify", {
      publicationId: publication.id,
    })).json()) as {
      valid: boolean;
      reason: string | null;
      recomputed: Attestation | null;
    };

    assert.equal(verified.valid, true, verified.reason ?? "");
    assert.equal(verified.recomputed?.representation, "generative");
    assert.equal(verified.recomputed?.correct, true);

    const tamperedBody = JSON.parse(JSON.stringify(sample.body)) as { output: string };
    tamperedBody.output =
      tamperedBody.output.slice(0, -1) +
      (tamperedBody.output.endsWith("a") ? "b" : "a");
    const tampered: Artifact = { ...sample, body: tamperedBody };

    const bogus = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Operator replay that lies",
      challengeId: generative.id,
      artifact: tampered,
      operatorAttestation: signedBy(
        owner,
        aiAttestation(tampered, { correct: true, score: 100 }),
      ),
    });
    assert.equal(bogus.status, 201);
    const bogusPublication = (await bogus.json()) as Publication;

    const caught = (await (await post(base, "/v1/verify", {
      publicationId: bogusPublication.id,
    })).json()) as { valid: boolean; reason: string | null };

    assert.equal(caught.valid, false);
    assert.match(caught.reason ?? "", /local verdict/);
  } finally {
    await stop(server);
  }
});

test("the public module catalogue advertises only byte-exact verifier shards", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const root = mkdtempSync(join(SCRATCH, "modules-"));

  try {
    const directory = join(root, "echo");
    const dist = join(directory, "dist", "echo.mjs");
    mkdirSync(join(directory, "dist"), { recursive: true });

    const bytes = Buffer.from("export const verify = () => true;\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(dist, bytes);
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "echo",
        app: "echo-lab",
        kind: "echo.signal",
        format: "es-module",
        entry: "echo.mjs",
        abi: "rarext.verifier.v1",
        hash,
        bytes: bytes.length,
        description: "Echo module",
      }),
    );

    const bad = join(root, "bad");
    const badDist = join(bad, "dist", "bad.mjs");
    mkdirSync(join(bad, "dist"), { recursive: true });
    writeFileSync(badDist, "export const verify = () => false;\n");
    writeFileSync(
      join(bad, "manifest.json"),
      JSON.stringify({
        id: "bad",
        app: "bad",
        kind: "bad.artifact",
        format: "es-module",
        entry: "bad.mjs",
        abi: "rarext.verifier.v1",
        hash: "0".repeat(64),
        bytes: 37,
        description: "Hash does not match the shard",
      }),
    );

    const escape = join(root, "escape");
    mkdirSync(join(escape, "dist"), { recursive: true });
    writeFileSync(
      join(escape, "manifest.json"),
      JSON.stringify({
        id: "escape",
        app: "escape",
        kind: "escape.artifact",
        format: "es-module",
        entry: "../outside.mjs",
        abi: "rarext.verifier.v1",
        hash,
        bytes: bytes.length,
        description: "Entry must stay inside dist",
      }),
    );

    const registry = new VerifierModuleRegistry(root);

    assert.deepEqual(registry.list().map((module) => module.app), ["echo-lab"]);
    assert.equal(registry.get("bad"), null);
    assert.equal(registry.get("escape"), null);
    assert.equal(
      registry.bytesFor("echo-lab", hash)?.bytes.toString("utf8"),
      bytes.toString("utf8"),
    );
    assert.equal(registry.bytesFor("echo-lab", "0".repeat(64)), null);

    const { server, base } = await start(undefined, { verifierModules: registry });

    try {
      const catalogue = (await (await fetch(`${base}/v1/verifiers`)).json()) as {
        verifiers: { app: string; url: string }[];
      };
      assert.deepEqual(catalogue.verifiers.map((module) => module.app), ["echo-lab"]);

      const served = await fetch(`${base}${catalogue.verifiers[0]!.url}`);
      assert.equal(served.status, 200);
      assert.equal(await served.text(), bytes.toString("utf8"));

      writeFileSync(dist, "export const verify = () => null;\n");

      const after = (await (await fetch(`${base}/v1/verifiers`)).json()) as {
        verifiers: unknown[];
      };
      assert.equal(after.verifiers.length, 0);
      assert.equal(registry.list().length, 0);
      assert.equal(registry.get("echo-lab"), null);
      assert.equal(registry.bytesFor("echo-lab", hash), null);

      const stale = await fetch(`${base}${catalogue.verifiers[0]!.url}`);
      assert.equal(stale.status, 404);
    } finally {
      await stop(server);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an external verifier that never answers times out loudly", async () => {
  const server = createServer(() => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const registry = createVerifierRegistry(fetch, null, {
      timeoutMs: 25,
      configs: [
        {
          app: "slow-lab",
          url: `http://127.0.0.1:${port}/verify`,
        },
      ],
    });

    const slowChallenge = {
      ...challenge,
      id: "slow-1",
      app: "slow-lab",
    };
    const slowArtifact = {
      app: "slow-lab",
      kind: "slow-lab.artifact",
      version: 1,
      mediaType: "application/json",
      body: { value: 1 },
    } as const;

    await assert.rejects(
      () =>
        registry.verifyAttestation(
          slowArtifact,
          slowChallenge,
          attestationFor(signer(), slowArtifact),
        ),
      /verifier slow-lab timed out after 25ms/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
