import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../../api/src/app.ts";
import { PlacementRegistry } from "../../api/src/placements.ts";
import { BlobStore } from "../../api/src/storage.ts";
import { RarextStore } from "../../api/src/store.ts";
import { RunLedger } from "../src/ledger.ts";
import { challengeFor } from "../src/publisher.ts";
import { startGateway } from "../src/gateway.ts";
import {
  bundleManifestHash,
  buildModelBundle,
  crossCheckProviderCard,
  fetchBundleChunks,
  fetchBundleManifest,
  fetchProviderCard,
  providerCardDigest,
  uploadBundle,
  verifyModelBundle,
  verifyProviderCard,
  verifyBundleChunks,
} from "../src/model-bundle.ts";
import type { ExecutionRef, ModelBundle } from "../src/model-bundle.ts";
import {
  buildDeployment,
  commitDeployment,
  hardwareFromNetwork,
  validateDeployment,
} from "../src/manifest.ts";
import { startProvider } from "../src/provider.ts";
import { verifyDeploymentBody, verifyRunBody } from "../src/transcript.ts";
import { runSpecFromChallenge } from "../src/verifier.ts";
import type { EngineProbe, ModelRef } from "../src/types.ts";

const NATIVE_MODEL = {
  kind: "xorshift32" as const,
  params: { a: 13, b: 17, c: 5 },
  vocab: ["red", "green", "blue", "amber", "violet", "teal", "rose", "slate"],
};

const NATIVE_BYTES = Buffer.from(JSON.stringify(NATIVE_MODEL));

const NATIVE_REF: ModelRef = {
  id: "native-proof",
  family: "rarext-native",
  parameters: "8 tokens",
  quantization: "exact",
  format: "json",
  sizeBytes: null,
  weightsDigest: null,
  contextLength: 64,
};

const NATIVE_EXECUTION: ExecutionRef = {
  kind: "native",
  modelClass: "xorshift32",
  defaultSteps: 12,
};

async function registry() {
  const root = mkdtempSync(join(tmpdir(), "rarext-web4-test-"));
  const blobs = new BlobStore(join(root, "blobs"));
  const server = createApp({
    store: new RarextStore(),
    blobs,
    placements: new PlacementRegistry(join(root, "placements")),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    root,
    blobs,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function publishNative(input: {
  base: string;
  chunkBytes?: number;
}): Promise<{ bundle: ModelBundle; manifestHash: string }> {
  const { bundle, chunks } = buildModelBundle({
    bytes: NATIVE_BYTES,
    model: NATIVE_REF,
    execution: NATIVE_EXECUTION,
    chunkBytes: input.chunkBytes ?? 97,
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  const uploaded = await uploadBundle({ registry: input.base, bundle, chunks });
  return { bundle, manifestHash: uploaded.manifestHash };
}

test("a model is sharded into content-addressed blobs and rebuilt byte-for-byte", async () => {
  const reg = await registry();
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    assert.ok(bundle.shards.length > 1, "the fixture is split across multiple shards");
    assert.equal(bundle.model.sizeBytes, NATIVE_BYTES.length);
    assert.equal(bundle.model.weightsDigest, `sha256:${createHash("sha256").update(NATIVE_BYTES).digest("hex")}`);

    const fetchedManifest = await fetchBundleManifest({
      registry: reg.base,
      manifestHash,
    });
    assert.deepEqual(fetchedManifest, bundle);
    assert.equal(bundleManifestHash(fetchedManifest), manifestHash);

    const { bytes } = await fetchBundleChunks({ registry: reg.base, bundle });
    assert.deepEqual(bytes, NATIVE_BYTES);
    assert.equal(verifyBundleChunks(bundle, bundle.shards.map((_, i) =>
      Buffer.from(`not shard ${i}`))).ok, false);

    // The manifest is itself a blob, so a reader can fetch the shard list from
    // storage instead of trusting a provider's copy of it.
    const listed = (await (await fetch(`${reg.base}/v1/blobs`)).json()) as Array<{ hash: string }>;
    assert.ok(listed.some((record) => record.hash === manifestHash));
    for (const shard of bundle.shards) {
      assert.ok(listed.some((record) => record.hash === shard.hash));
    }
  } finally {
    await reg.close();
  }
});

test("the binary blob route checks the content address it is given", async () => {
  const reg = await registry();
  try {
    const wrong = "0".repeat(64);
    const refused = await fetch(`${reg.base}/v1/blobs/raw`, {
      method: "POST",
      headers: { "x-rarext-hash": wrong },
      body: new Uint8Array(Buffer.from("weights")),
    });
    assert.equal(refused.status, 409);

    const accepted = await fetch(`${reg.base}/v1/blobs/raw`, {
      method: "POST",
      headers: { "x-rarext-media-type": "application/octet-stream" },
      body: new Uint8Array(Buffer.from("weights")),
    });
    assert.equal(accepted.status, 201);
  } finally {
    await reg.close();
  }
});

test("a provider fetches the model from RAREXT, verifies it, and serves it", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const running = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    provider = running;

    assert.deepEqual(running.modelBytes, NATIVE_BYTES);
    assert.equal(running.card.bundle.manifestHash, manifestHash);

    const cardResponse = await fetch(`${running.url}/v1/provider-card`);
    const card = await cardResponse.json();
    assert.deepEqual(verifyProviderCard(card), []);

    const request = (prompt: string) =>
      fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 8,
        }),
      });

    const firstResponse = await request("the same prompt");
    const first = (await firstResponse.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const second = (await (await request("the same prompt")).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const other = (await (await request("a different prompt")).json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    assert.equal(first.choices[0]!.message.content, second.choices[0]!.message.content);
    assert.notEqual(first.choices[0]!.message.content, other.choices[0]!.message.content);
    assert.equal(firstResponse.headers.get("x-rarext-bundle"), bundle.digest);
    assert.equal(first.choices[0]!.message.content.length > 0, true);

    // The legacy completions surface is part of the OpenAI shape too.
    const legacy = await fetch(`${running.url}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, prompt: "the same prompt", max_tokens: 8 }),
    });
    assert.equal(legacy.status, 200);
    const legacyBody = (await legacy.json()) as { choices: Array<{ text: string }> };
    assert.equal(legacyBody.choices[0]!.text, first.choices[0]!.message.content);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider refuses to serve bytes that no longer match their shard", async () => {
  const reg = await registry();
  try {
    const { bundle } = await publishNative({ base: reg.base });
    writeFileSync(join(reg.root, "blobs", bundle.shards[0]!.hash), Buffer.from("tampered"));

    await assert.rejects(
      startProvider({
        bundle,
        registry: reg.base,
        stateDir: join(reg.root, "provider"),
        port: 0,
      }),
      /missing|does not match|failed verification|hashes to/i,
    );
  } finally {
    await reg.close();
  }
});

test("a web4 deployment commits the bundle and every run carries it", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });

    const card = await fetchProviderCard({ endpoint: provider.url });
    const fetchedBundle = await fetchBundleManifest({
      registry: reg.base,
      manifestHash: card.bundle.manifestHash,
    });
    assert.deepEqual(crossCheckProviderCard(card, fetchedBundle), { ok: true, errors: [] });

    const probe: EngineProbe = {
      engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
      model: card.model,
      apis: ["openai"],
      models: [card.model],
    };
    const deployment = commitDeployment(
      buildDeployment({
        probe,
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: fetchedBundle.digest,
          shardsRoot: fetchedBundle.shardsRoot,
          manifestHash: card.bundle.manifestHash,
          provider: card.id,
          providerCard: card.digest,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.bundleDigest, fetchedBundle.digest);
    assert.equal(spec.shardsRoot, fetchedBundle.shardsRoot);
    assert.equal(verifyDeploymentBody(deployment, spec).correct, true);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "prove the bundle" }],
        max_tokens: 10,
      }),
    });
    assert.equal(response.status, 200);
    const completion = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.ok(completion.choices[0]!.message.content.length > 0);

    const records = new RunLedger(join(reg.root, "gateway")).records();
    assert.equal(records.length, 1);
    const body = records[0]!.body;
    assert.ok(body.bundle, "the run names the bundle it was produced from");
    assert.equal(body.bundle!.digest, fetchedBundle.digest);
    assert.equal(body.bundle!.shardsRoot, fetchedBundle.shardsRoot);
    assert.equal(body.bundle!.manifestHash, card.bundle.manifestHash);
    assert.equal(body.bundle!.weightsDigest, fetchedBundle.model.weightsDigest);

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("bundle.digest"));

    // Swapping the bundle in a run is visible even though every other digest
    // in the transcript is untouched.
    const swapped = { ...body, bundle: { ...body.bundle!, digest: "f".repeat(64) } };
    const refused = verifyRunBody(swapped, spec);
    assert.equal(refused.correct, false);
    assert.match(refused.error ?? "", /bundle.digest/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a web4 card whose bundle was swapped is refused", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });

    const lie = `sha256:${"1".repeat(64)}`;
    const relabelled = {
      ...card,
      model: { ...card.model, weightsDigest: lie },
      bundle: { ...card.bundle, weightsDigest: lie },
    };
    assert.ok(verifyProviderCard(relabelled).some((error) => error.includes("digest")));

    // A card can be re-signed over the lie; the independent bundle manifest is
    // what catches it.
    const { digest: _digest, ...unsigned } = relabelled;
    const resigned = { ...unsigned, digest: providerCardDigest(unsigned) };
    assert.deepEqual(verifyProviderCard(resigned), []);
    const cross = crossCheckProviderCard(resigned, bundle);
    assert.equal(cross.ok, false);
    assert.ok(cross.errors.some((error) => error.includes("weightsDigest")));
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("web4 manifests must name network hardware and their committed bundle", async () => {
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };

  const local = buildDeployment({
    probe,
    hardware: { backend: "cpu", device: "host", memoryBytes: 8, os: "x", arch: "y" },
    placement: "web4",
    labels: { execution: "web4", bundle: "b".repeat(64), shardsRoot: "c".repeat(64), manifestHash: "d".repeat(64) },
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  const errors = validateDeployment(local);
  assert.ok(errors.some((error) => error.includes('hardware.backend must be "network"')));
  assert.ok(errors.some((error) => error.includes("memoryBytes must be null")));

  const labelled = buildDeployment({
    probe,
    hardware: hardwareFromNetwork("https://provider.example"),
    placement: "web4",
    labels: { execution: "web4", bundle: "b".repeat(64), shardsRoot: "c".repeat(64), manifestHash: "d".repeat(64) },
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  assert.deepEqual(validateDeployment(labelled), []);

  const deployment = commitDeployment(labelled);
  const withoutBundle = runSpecFromChallenge(challengeFor({ ...deployment, labels: undefined }));
  const verdict = verifyDeploymentBody(deployment, withoutBundle);
  assert.equal(verdict.correct, false);
  assert.ok((verdict.proof as { failures?: string[] }).failures?.includes("challenge.bundle"));
});

test("a bundle with an edited shard list is refused before anything is fetched", async () => {
  const reg = await registry();
  try {
    const { bundle } = await publishNative({ base: reg.base });
    const edited = {
      ...bundle,
      shards: bundle.shards.map((shard, index) =>
        index === 0 ? { ...shard, size: shard.size + 1 } : shard,
      ),
    };
    assert.ok(verifyModelBundle(edited).some((error) => error.includes("totalBytes")));
    assert.ok(verifyModelBundle(edited).some((error) => error.includes("shardsRoot")));
    assert.ok(verifyModelBundle(edited).some((error) => error.includes("digest")));
  } finally {
    await reg.close();
  }
});
