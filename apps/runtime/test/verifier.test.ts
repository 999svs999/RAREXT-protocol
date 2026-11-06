import assert from "node:assert/strict";
import test from "node:test";

import { createVerifierRegistry } from "../../api/src/verifiers.ts";
import { createRunBody, runArtifact } from "../src/transcript.ts";
import { buildDeployment, commitDeployment, hardwareFromHost } from "../src/manifest.ts";
import { challengeFor } from "../src/publisher.ts";
import { createVerifierServer } from "../src/verifier.ts";
import type { DeploymentCommitment, EngineProbe } from "../src/types.ts";

const probe: EngineProbe = {
  engine: { name: "ollama", version: "0.23.2", endpoint: "http://127.0.0.1:11434" },
  model: {
    id: "qwen2.5:0.5b",
    family: "qwen2",
    parameters: "494M",
    quantization: "Q4_K_M",
    format: "gguf",
    sizeBytes: 397821319,
    weightsDigest: "sha256:a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67",
    contextLength: null,
  },
  apis: ["openai", "anthropic"],
  models: [],
};

function fixture(): { deployment: DeploymentCommitment; body: ReturnType<typeof createRunBody> } {
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromHost("cpu", "test host"),
      createdAt: "2026-11-06T00:00:00.000Z",
    }),
  );
  const body = createRunBody({
    deployment,
    api: "openai",
    request: { model: deployment.model.id, messages: [{ role: "user", content: "hello" }], temperature: 0, seed: 1 },
    response: {
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    },
    usage: null,
    sampling: { temperature: 0, topP: null, seed: 1, maxTokens: null },
    startedAt: "2026-11-06T00:00:01.000Z",
    completedAt: "2026-11-06T00:00:02.000Z",
    previous: null,
  });
  return { deployment, body };
}

test("the registry's external-verifier path carries representation exact onto the attestation", async () => {
  const { deployment, body } = fixture();
  const challenge = challengeFor(deployment);
  const server = createVerifierServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const registry = createVerifierRegistry(fetch, null, {
      configs: [
        {
          app: "ai-model-run",
          name: "runtime transcript",
          version: "1",
          url: `http://127.0.0.1:${port}/verify`,
          artifactKinds: ["ai.model-run"],
          manifest: { app: "ai-model-run", algorithm: "canonical-transcript-sha256" },
        },
      ],
    });

    const attestation = await registry.verify(
      runArtifact(body) as unknown as Parameters<typeof registry.verify>[0],
      challenge as unknown as Parameters<typeof registry.verify>[1],
    );

    assert.equal(attestation.correct, true);
    assert.equal(attestation.representation, "exact");
    assert.equal(attestation.app, "ai-model-run");
    assert.equal(attestation.challengeId, challenge.id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the external verifier refuses a transcript whose response was swapped", async () => {
  const { deployment, body } = fixture();
  const challenge = challengeFor(deployment);
  const server = createVerifierServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const registry = createVerifierRegistry(fetch, null, {
      configs: [
        {
          app: "ai-model-run",
          url: `http://127.0.0.1:${port}/verify`,
          artifactKinds: ["ai.model-run"],
        },
      ],
    });

    const tampered = structuredClone(body);
    tampered.response.text = "something else";
    const attestation = await registry.verify(
      runArtifact(tampered) as unknown as Parameters<typeof registry.verify>[0],
      challenge as unknown as Parameters<typeof registry.verify>[1],
    );
    assert.equal(attestation.correct, false);
    assert.equal(attestation.score, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
