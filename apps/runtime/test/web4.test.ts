import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  creditLeaf,
  creditLedgerRoot,
  inferenceCreditRecords,
  verifyProof,
} from "../../../packages/core/src/index.ts";
import type { CreditRecordFields } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  generateAgentKeypair,
  publicKeyId,
} from "../../../packages/agent-sdk/src/index.ts";
import { createApp } from "../../api/src/app.ts";
import { createVerifierRegistry } from "../../api/src/verifiers.ts";
import { PlacementRegistry } from "../../api/src/placements.ts";
import { BlobStore } from "../../api/src/storage.ts";
import { RarextStore } from "../../api/src/store.ts";
import { RunLedger } from "../src/ledger.ts";
import { challengeFor, challengesFile, RuntimePublisher } from "../src/publisher.ts";
import { startGateway } from "../src/gateway.ts";
import { discoverBundle, fetchAnchoredBundles, fetchVerifiedProvidersAcrossRegistries, verifiedProviders } from "../src/discovery.ts";
import {
  bundleManifestHash,
  buildModelBundle,
  buildProviderCard,
  crossCheckProviderCard,
  fetchBundleChunks,
  fetchBundleCiphertext,
  fetchBundleManifest,
  fetchProviderCard,
  generateSealKey,
  unwrapSealKey,
  issueProviderCertificate,
  providerBootStages,
  providerCardDigest,
  providerChainDepth,
  providerStageMeasurements,
  sealKeyCommitment,
  verifyProviderChain,
  verifyProviderQuote,
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
import { replayEngineRun } from "../src/replay.ts";
import {
  attestationBindsEnclaveKey,
  enclaveKeyDigest,
  openResponse,
  sealRequest,
} from "../src/confidential.ts";
import {
  HARDWARE_ROOT_KEY_ID,
  hardwareRootSigner,
  issueHardwareChain,
  issueMeasuredBootChain,
} from "../src/hardware-root.ts";
import {
  ROOT_CHAIN_KIND,
  issueRootRotation,
  verifyProviderRootChain,
  verifyRootChain,
} from "../src/root-chain.ts";
import { runtimeCodeMeasurement } from "../src/code-measurement.ts";
import { attestationForReceipt } from "../src/certificates.ts";
import { engineDescriptorFingerprint } from "../src/engine-pin.ts";
import {
  buildEngineBundle,
  fetchEngineArtifact,
  loadEngine,
  uploadEngineBundle,
  verifyEngineBundle,
} from "../src/engine-bundle.ts";
import { comparableCompletion } from "../src/completion.ts";
import { canonicalDigest } from "../src/digest.ts";
import { signImageManifest, verifyImageManifest } from "../src/image-manifest.ts";
import { verifyDeploymentBody, verifyRunBody } from "../src/transcript.ts";
import { createVerifierServer, runSpecFromChallenge, verifierConfig } from "../src/verifier.ts";
import type { EngineProbe, ModelRef, RunProviderAttestation } from "../src/types.ts";

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

test("a sealed bundle lives on RAREXT as ciphertext and opens only with the key", async () => {
  const reg = await registry();
  const sealKey = generateSealKey();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
    });
    assert.equal(bundle.sealing?.scheme, "aes-256-gcm");
    assert.equal(bundle.sealing?.keyCommitment, sealKeyCommitment(sealKey));
    assert.notEqual(bundle.totalBytes, bundle.model.sizeBytes, "ciphertext is larger than the plaintext");
    await uploadBundle({ registry: reg.base, bundle, chunks });

    // What the node holds is exactly the committed ciphertext: the plaintext
    // model is not in the store, and the raw blob hashes to the shard hash.
    const rawShard = Buffer.from(
      await (await fetch(`${reg.base}/v1/blobs/${bundle.shards[0]!.hash}/raw`)).arrayBuffer(),
    );
    assert.equal(createHash("sha256").update(rawShard).digest("hex"), bundle.shards[0]!.hash);
    assert.equal(rawShard.includes(Buffer.from("xorshift32")), false, "the store never holds the model");
    const listed = (await (await fetch(`${reg.base}/v1/blobs`)).json()) as Array<{ hash: string }>;
    const plaintextHash = createHash("sha256").update(NATIVE_BYTES).digest("hex");
    assert.equal(
      listed.some((record) => record.hash === plaintextHash),
      false,
      "the plaintext file is not addressable in the store",
    );

    // A reader without the key verifies the ciphertext but cannot produce the
    // plaintext; with the key the opened bytes match the model identity.
    const sealedChunks = await Promise.all(
      bundle.shards.map(async (shard) =>
        Buffer.from(await (await fetch(`${reg.base}/v1/blobs/${shard.hash}/raw`)).arrayBuffer()),
      ),
    );
    const withoutKey = verifyBundleChunks(bundle, sealedChunks);
    assert.equal(withoutKey.ok, true, withoutKey.errors.join("; "));
    assert.notDeepEqual(withoutKey.bytes, NATIVE_BYTES);
    const withKey = verifyBundleChunks(bundle, sealedChunks, sealKey);
    assert.equal(withKey.ok, true, withKey.errors.join("; "));
    assert.deepEqual(withKey.bytes, NATIVE_BYTES);

    // The provider refuses without the key, refuses a wrong key by commitment,
    // and serves only when the opened plaintext matches the committed model.
    await assert.rejects(
      startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "nokey"), port: 0 }),
      /sealed/,
    );
    await assert.rejects(
      startProvider({
        bundle,
        registry: reg.base,
        stateDir: join(reg.root, "wrongkey"),
        port: 0,
        sealKey: randomBytes(32),
      }),
      /key commitment/,
    );

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
      sealKey,
    });
    assert.deepEqual(provider.modelBytes, NATIVE_BYTES);
    assert.equal(provider.card.bundle.sealed, true);
    const completion = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "sealed?" }],
        max_tokens: 8,
      }),
    });
    const body = (await completion.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(completion.status, 200);
    assert.ok(body.choices[0]!.message.content.length > 0);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a sealed engine bundle is loaded through an ephemeral file the provider never keeps", async () => {
  const reg = await registry();
  const sealKey = generateSealKey();
  const gguf = Buffer.from("GGUF-fake-weights-for-the-engine-path");
  const stateDir = join(reg.root, "engine");
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let ephemeralFile: string | null = null;
  let existedDuringLoad = false;
  let bytesDuringLoad: Buffer | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: gguf,
      model: { ...NATIVE_REF, id: "sealed-engine", format: "gguf", weightsDigest: null },
      execution: { kind: "engine", engine: "ollama", engineModel: "sealed" },
      chunkBytes: 8,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir,
      port: 0,
      sealKey,
      engineEndpoint: "http://127.0.0.1:1",
      // The injected "engine" watches the file it is handed, the way Ollama's
      // loader would: the plaintext must exist for the load and nowhere else.
      engineCreate: async ({ file, modelfile }) => {
        ephemeralFile = file;
        existedDuringLoad = existsSync(file);
        bytesDuringLoad = readFileSync(file);
        assert.ok(
          !file.startsWith(stateDir),
          "the sealed file must not live in the provider's state dir",
        );
        assert.match(readFileSync(modelfile, "utf8"), /^FROM /);
      },
    });

    assert.equal(provider.card.bundle.sealed, true);
    assert.equal(existedDuringLoad, true, "the engine can read the plaintext while it loads");
    assert.deepEqual(bytesDuringLoad, gguf);
    // ... and it is gone the moment the engine is done, state dir included.
    assert.equal(existsSync(ephemeralFile!), false, "the ephemeral file is removed after the load");
    assert.equal(existsSync(join(stateDir, "models")), false, "no plaintext model is cached");
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

    // A card can be re-digested over the lie (dropping the operator signature
    // and key, which no longer cover the changed bytes); the independent bundle
    // manifest is what catches it.
    const { digest: _digest, signature: _signature, ...rest } = relabelled;
    const unsigned = {
      ...rest,
      provider: { handle: rest.provider.handle, keyId: rest.provider.keyId },
    };
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

/** A registry that learns challenges after the fact, plus the real verifier. */
async function verifierRegistry() {
  const root = mkdtempSync(join(tmpdir(), "rarext-web4-card-test-"));
  const verifier = createVerifierServer();
  verifier.listen(0, "127.0.0.1");
  await once(verifier, "listening");
  const verifierPort = (verifier.address() as AddressInfo).port;
  const verifierUrl = `http://127.0.0.1:${verifierPort}/verify`;

  const known = new Map<string, unknown>();
  const blobs = new BlobStore(join(root, "blobs"));
  const server = createApp({
    store: new RarextStore(),
    blobs,
    placements: new PlacementRegistry(join(root, "placements")),
    challenges: {
      list: () => [...known.values()],
      get: (id: string) => known.get(id) ?? null,
    } as never,
    verifiers: createVerifierRegistry(fetch, null, {
      configs: verifierConfig(verifierUrl).verifiers,
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  return {
    root,
    base: `http://127.0.0.1:${port}`,
    learn(challenge: unknown) {
      known.set((challenge as { id: string }).id, challenge);
    },
    async close() {
      server.closeAllConnections();
      verifier.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => verifier.close(() => resolve())),
      ]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a provider card is signed by the provider's own key and rejects tampering", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });

    // The card names a real key and carries a signature over its own bytes.
    assert.equal(typeof card.signature, "string");
    assert.equal(typeof card.provider.publicKey, "object");
    assert.deepEqual(verifyProviderCard(card), []);

    // Change a covered field while keeping the signature: the operator key no
    // longer matches the bytes, so the card is refused even though its
    // self-digest is recomputed to match.
    const tampered = {
      ...card,
      endpoint: "https://evil.example",
    };
    const { digest: _digest, ...payload } = tampered;
    const redigested = { ...payload, digest: providerCardDigest(payload) };
    assert.ok(
      verifyProviderCard(redigested).some((error) => error.includes("signature does not verify")),
    );

    // A card that claims a publicKey but carries no signature is refused.
    const { signature: _dropped, ...unsigned } = card;
    assert.ok(
      verifyProviderCard(unsigned).some((error) => error.includes("must carry a signature")),
    );
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider reuses its persisted identity and a fresh state gets a new one", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    const shared = join(reg.root, "shared-provider");
    first = await startProvider({ bundle, registry: reg.base, stateDir: shared, port: 0 });
    const firstCard = await fetchProviderCard({ endpoint: first.url });
    await first.close();
    first = null;

    // Same state directory, new process: the same operator identity.
    second = await startProvider({ bundle, registry: reg.base, stateDir: shared, port: 0 });
    const secondCard = await fetchProviderCard({ endpoint: second.url });
    assert.equal(secondCard.provider.keyId, firstCard.provider.keyId);

    // A different state directory is a different operator.
    other = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "other-provider"),
      port: 0,
    });
    const otherCard = await fetchProviderCard({ endpoint: other.url });
    assert.notEqual(otherCard.provider.keyId, firstCard.provider.keyId);
  } finally {
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a provider card is published under the challenge and discovered from the bundle", async () => {
  const reg = await verifierRegistry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          provider: card.id,
          providerCard: card.digest,
          providers: provider.url,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const challenge = challengeFor(deployment);
    reg.learn(challenge);

    const publisher = await RuntimePublisher.open({
      baseUrl: reg.base,
      handle: "web4-test-publisher",
      stateDir: join(reg.root, "publisher"),
      challengeId: challenge.id,
    });
    await publisher.publishDeployment(deployment);
    const publication = await publisher.publishProviderCard(card);
    assert.equal(publication.app, "ai-model-run");
    assert.equal(publication.artifact.kind, "ai.model-provider");
    assert.equal(publication.attestation?.correct, true);
    await publisher.client.anchor();

    const latest = await (await fetch(`${reg.base}/v1/bundles/latest`)).json();
    const report = discoverBundle(latest);
    const providerEntry = report.providers.find((entry) => entry.endpoint === provider!.url);
    assert.ok(providerEntry, "the bundle carries the published provider card");
    assert.equal(providerEntry.verified, true);
    assert.equal(providerEntry.attested, true);
    assert.equal(providerEntry.bundleDigest, bundle.digest);

    const discovered = verifiedProviders(latest, bundle.digest);
    assert.equal(discovered.providers.length, 1);
    assert.equal(discovered.providers[0]!.card.digest, card.digest);

    // Provider discovery is only as good as the bytes. An edited card in the
    // same bundle must not be adoptable, even though the registry attested it.
    const tampered = structuredClone(latest) as {
      publications: Array<{ artifact: { kind: string; body: { endpoint?: string } } }>;
    };
    for (const publicationEntry of tampered.publications) {
      if (publicationEntry.artifact.kind === "ai.model-provider") {
        publicationEntry.artifact.body.endpoint = "https://attacker.example";
      }
    }
    assert.equal(verifiedProviders(tampered, bundle.digest).providers.length, 0);

    // An anchor covers one batch. The provider's card was anchored, then a
    // later announcement became a second batch; discovery must read both.
    const reannounced = buildProviderCard({
      bundle,
      endpoint: provider.url,
      manifestHash,
      createdAt: "2026-11-07T00:00:01.000Z",
    });
    await publisher.publishProviderCard(reannounced);
    await publisher.client.anchor();
    const batches = await fetchAnchoredBundles({ registry: reg.base });
    assert.ok(batches.length >= 2, "each anchor is its own batch");
    const across = batches.flatMap(
      (batch) => verifiedProviders(batch, bundle.digest).providers,
    );
    assert.ok(across.length >= 2, "provider cards are found across anchored batches");
    assert.ok(across.every((entry) => entry.card.endpoint === provider!.url));
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("providers are discovered across independent registries; a dead mirror is not fatal", async () => {
  const one = await verifierRegistry();
  const two = await verifierRegistry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: one.base });
    provider = await startProvider({
      bundle,
      registry: one.base,
      stateDir: join(one.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const challenge = challengeFor(deployment);
    one.learn(challenge);
    two.learn(challenge);

    // The same signed card is announced to both registries. Neither copy is
    // privileged: discovery verifies the card's own bytes against the
    // challenge, then unions the registries by card digest.
    for (const [reg, name] of [
      [one, "one"],
      [two, "two"],
    ] as const) {
      const publisher = await RuntimePublisher.open({
        baseUrl: reg.base,
        handle: "multi-registry-publisher",
        stateDir: join(reg.root, `publisher-${name}`),
        challengeId: challenge.id,
      });
      await publisher.publishDeployment(deployment);
      await publisher.publishProviderCard(card);
      await publisher.client.anchor();
    }

    const across = await fetchVerifiedProvidersAcrossRegistries({
      registries: [one.base, two.base, "http://127.0.0.1:1"],
      bundleDigest: bundle.digest,
    });
    assert.equal(across.providers.length, 1, "the same card from two registries is one provider");
    assert.equal(across.providers[0]!.card.digest, card.digest);
    assert.ok(across.scanned >= 2, "both registries were read");
    assert.equal(across.errors.length, 1, "the unreachable mirror is reported, not fatal");
    assert.match(across.errors[0]!, /127\.0\.0\.1:1/);
  } finally {
    if (provider !== null) await provider.close();
    await one.close();
    await two.close();
  }
});

test("a committed bounty pays every distinct agreeing operator, verifiably", async () => {
  const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          bounty: "5",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.inferenceBounty, 5);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "who gets paid?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 200);

    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.ok(body.credits, "the run commits the payment it made");
    assert.equal(body.credits!.action, "infer");
    assert.equal(body.credits!.bounty, 5);
    assert.equal(body.credits!.paid, 2);
    assert.match(body.credits!.ledgerRoot, /^[0-9a-f]{64}$/);

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("credits"));

    // The payment is not taken on faith: editing the root, the bounty, or the
    // paid count moves the run away from what the quorum evidence implies.
    const tamperedRoot = { ...body, credits: { ...body.credits!, ledgerRoot: "0".repeat(64) } };
    assert.equal(verifyRunBody(tamperedRoot, spec).correct, false);
    const tamperedBounty = { ...body, credits: { ...body.credits!, bounty: 6 } };
    assert.equal(verifyRunBody(tamperedBounty, spec).correct, false);
    const tamperedPaid = { ...body, credits: { ...body.credits!, paid: 9 } };
    assert.equal(verifyRunBody(tamperedPaid, spec).correct, false);
    // Paying a dissenter is a different ledger too.
    const payingDissent = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({ ...entry, operator: "operator-a" })),
      },
      credits: body.credits!,
    };
    assert.equal(verifyRunBody(payingDissent, spec).correct, false);

    // An operator can read its own receipts with a Merkle inclusion proof.
    const ledgerView = (await (
      await fetch(`${gateway.url}/v1/rarext/credits`)
    ).json()) as { ledgerRoot: string; count: number; byOperator: Record<string, { credits: number }> };
    assert.equal(ledgerView.ledgerRoot, body.credits!.ledgerRoot);
    assert.equal(ledgerView.count, 2);
    assert.equal(ledgerView.byOperator["operator-a"]!.credits, 5);

    const mine = (await (
      await fetch(`${gateway.url}/v1/rarext/credits/operator-a`)
    ).json()) as {
      statement: { credits: { earned: number } };
      ledgerRoot: string;
      receipts: Array<CreditRecordFields & { ledger: { root: string; index: number; proof: string[] } }>;
    };
    assert.equal(mine.statement.credits.earned, 5);
    assert.equal(mine.receipts.length, 1);
    const receipt = mine.receipts[0]!;
    assert.equal(receipt.keyId, "operator-a");
    assert.equal(receipt.bounty, 5);
    assert.equal(receipt.action, "infer");
    assert.equal(
      verifyProof(
        creditLeaf(receipt, (value) =>
          createHash("sha256")
            .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
            .digest("hex"),
        ),
        receipt.ledger.proof,
        mine.ledgerRoot,
        receipt.ledger.index,
        bytesSha256,
      ),
      true,
      "the operator's receipt proves against the published root",
    );

    // The commitment the gateway published is exactly the one a reader derives
    // from the run alone.
    const derived = creditLedgerRoot(
      inferenceCreditRecords({
        providers: body.quorum!.providers.map((entry) => ({
          responseDigest: entry.responseDigest,
          operator: entry.operator ?? null,
        })),
        responseDigest: body.response.digest,
        deploymentDigest: body.deployment.digest,
        completedAt: body.completedAt,
        bounty: 5,
      }),
      (value) =>
        createHash("sha256")
          .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
          .digest("hex"),
    );
    assert.equal(derived, body.credits!.ledgerRoot);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a run under a bounty with no committed operators cannot be verified", () => {
  // The deployment refuses to commit a bounty without operators to pay, so the
  // challenge never names one and the run cannot invent a payment.
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromNetwork("https://provider.example"),
      placement: "web4",
      labels: {
        execution: "web4",
        bundle: "a".repeat(64),
        shardsRoot: "b".repeat(64),
        manifestHash: "c".repeat(64),
        providers: "https://provider.example",
        quorum: "1",
        bounty: "5",
      },
    }),
  );
  assert.ok(
    validateDeployment(deployment).some((error) => error.includes("labels.bounty requires")),
    "a bounty without operators is refused before it can pay nobody",
  );
});

test("two providers must agree, and the run records the quorum evidence", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });
    const providers = `${first.url},${second.url}`;

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          provider: card.id,
          providerCard: card.digest,
          providers,
          operators: "operator-a,operator-b",
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.quorum, 2);
    assert.deepEqual(spec.operators, ["operator-a", "operator-b"]);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "say the same thing" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-rarext-quorum"), "2/2");

    const records = new RunLedger(join(reg.root, "gateway")).records();
    assert.equal(records.length, 1);
    const body = records[0]!.body;
    assert.ok(body.quorum, "the run carries who answered and who agreed");
    assert.equal(body.quorum!.required, 2);
    assert.equal(body.quorum!.responded, 2);
    assert.equal(body.quorum!.agreed, 2);
    assert.equal(body.quorum!.providers.length, 2);
    assert.equal(new Set(body.quorum!.providers.map((entry) => entry.responseDigest)).size, 1);
    assert.deepEqual(
      body.quorum!.providers.map((entry) => entry.operator),
      ["operator-a", "operator-b"],
      "each provider records the operator it declared",
    );

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("quorum"));

    // Two endpoints run by one operator are one voice: the verifier rejects a
    // claimed agreement that collapses to a single operator.
    const collapsed = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({ ...entry, operator: "operator-a" })),
      },
    };
    assert.equal(verifyRunBody(collapsed, spec).correct, false);
    const unknownOperator = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) => ({
          ...entry,
          operator: index === 0 ? "operator-z" : entry.operator,
        })),
      },
    };
    assert.equal(verifyRunBody(unknownOperator, spec).correct, false);

    // A quorum deployment can still stream: it compares the complete answers
    // first and then replays the agreed one as SSE with the same evidence.
    const streamed = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "say the same thing" }],
        max_tokens: 8,
        temperature: 0,
        stream: true,
      }),
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(streamed.headers.get("x-rarext-quorum"), "2/2");
    assert.equal(streamed.headers.get("x-rarext-stream"), "quorum-agreed");
    const sse = await streamed.text();
    assert.match(sse, /"object":"chat\.completion\.chunk"/);
    assert.match(sse, /data: \[DONE\]/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 2);
    const streamedBody = new RunLedger(join(reg.root, "gateway")).records()[1]!.body;
    assert.equal(streamedBody.quorum?.agreed, 2);
    assert.equal(verifyRunBody(streamedBody, spec).correct, true);

    // Removing the evidence, lowering the count, or detaching the chosen
    // response from the agreeing digests are all visible.
    const { quorum: _quorum, ...withoutQuorum } = body;
    assert.equal(verifyRunBody(withoutQuorum, spec).correct, false);
    assert.equal(
      verifyRunBody({ ...body, quorum: { ...body.quorum!, required: 1 } }, spec).correct,
      false,
    );
    assert.equal(
      verifyRunBody({ ...body, response: { ...body.response, digest: "f".repeat(64) } }, spec).correct,
      false,
    );
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a dissent is recorded as evidence but never counted toward quorum", async () => {
  const reg = await registry();
  const providers: Array<Awaited<ReturnType<typeof startProvider>>> = [];
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    for (const name of ["a", "b", "c"]) {
      providers.push(
        await startProvider({
          bundle,
          registry: reg.base,
          stateDir: join(reg.root, `provider-${name}`),
          port: 0,
        }),
      );
    }
    const card = await fetchProviderCard({ endpoint: providers[0]!.url });
    const endpoints = providers.map((entry) => entry.url);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: endpoints[0]! },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(endpoints[0]!),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: endpoints.join(","),
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.quorum, 2);

    // The third provider answers differently. Two agree, so the run stands —
    // and the transcript carries all three, including the dissent. A real
    // dissenting provider SIGNS its own answer (over the exact request it got
    // and the bundle it served), so the dissent is evidence, not an unsigned
    // claim the gateway invented.
    const dissentSigner = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const dissenting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).startsWith(endpoints[2]!)) return response;
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      body.choices[0]!.message.content = "a different answer";
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const payload = {
        kind: "rarext.response-receipt.v1",
        request: canonicalDigest(requestBody),
        response: canonicalDigest(comparableCompletion(body as Record<string, unknown>)),
        bundle: bundle.digest,
      };
      const receipt = {
        ...payload,
        signature: dissentSigner.sign(payload),
        publicKey: dissentSigner.publicKey,
        suite: dissentSigner.suite,
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-rarext-receipt": Buffer.from(JSON.stringify(receipt), "utf8").toString("base64"),
        },
      });
    };

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: endpoints,
      quorum: 2,
      fetchImpl: dissenting,
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "who agrees?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-rarext-quorum"), "2/2");

    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(body.quorum!.required, 2);
    assert.equal(body.quorum!.responded, 3);
    assert.equal(body.quorum!.agreed, 2);
    assert.equal(body.quorum!.providers.length, 3, "all responders are recorded, dissent included");
    assert.equal(new Set(body.quorum!.providers.map((entry) => entry.responseDigest)).size, 2);

    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier does not take `agreed` on faith: claiming the dissenter
    // agreed is visible, and so is counting one endpoint twice.
    assert.equal(
      verifyRunBody({ ...body, quorum: { ...body.quorum!, agreed: 3 } }, spec).correct,
      false,
    );
    const duplicated = {
      ...body.quorum!,
      providers: [body.quorum!.providers[0]!, { ...body.quorum!.providers[1]!, endpoint: body.quorum!.providers[0]!.endpoint }],
    };
    assert.equal(verifyRunBody({ ...body, quorum: duplicated }, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    for (const entry of providers) await entry.close();
    await reg.close();
  }
});

test("the gateway refuses a quorum met by one operator across two endpoints", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          // The deployment says two operators, but the gateway is configured
          // with one identity for both endpoints. Bytes agree; independence
          // does not, and the run must not be written.
          operators: "operator-a,operator-b",
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-a" },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "who is one voice?" }],
        max_tokens: 8,
      }),
    });
    assert.equal(response.status, 503);
    const refused = (await response.json()) as { error: string };
    assert.match(refused.error, /distinct operator/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a machine-independent quorum refuses keys that attest the same machine", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    // Each provider signs its machine with its own leaf key, so the machine is a
    // signed claim, not a label. One provider attests machine-a, the other
    // machine-b.
    const signerA = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const signerB = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      machine: "machine-a",
      teeSigner: signerA,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      machine: "machine-b",
      teeSigner: signerB,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // Each card attests a machine, bound by its own signed quote.
    assert.equal(cardA.independence?.kind, "rarext.provider-machine.v1");
    assert.match(cardA.independence!.measurement, /^[0-9a-f]{64}$/);
    assert.equal(cardA.independence!.machine, "machine-a");
    assert.equal(cardB.independence!.machine, "machine-b");
    assert.equal(verifyProviderQuote(cardA.independence), signerA.keyId);
    assert.equal(verifyProviderQuote(cardB.independence), signerB.keyId);

    // The deployment commits distinct machines (from cards that attested
    // distinct hosts). A run must then be met by distinct machines.
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          machines: "machine-a,machine-b",
          independence: "machine",
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.independence, "machine");
    assert.deepEqual(spec.machines, ["machine-a", "machine-b"]);

    // The gateway is pointed at two endpoints that both attest machine-a: two
    // operator keys, one box. The second's signed quote is swapped for the
    // first's, so both MACHINES (from the quotes) are machine-a and the run must
    // not be written.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      machines: { [first.url]: "machine-a", [second.url]: "machine-a" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardA.independence! },
    });
    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "one box?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /distinct machine/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
    await gateway.close();
    gateway = null;

    // With distinct SIGNED machines the same quorum is met and the run verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-b"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      machines: { [first.url]: "machine-a", [second.url]: "machine-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-b")).records()[0]!.body;
    assert.deepEqual(
      body.quorum!.providers.map((entry) => entry.machine),
      ["machine-a", "machine-b"],
    );
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);

    // The verifier does not take the machines on faith: a run that claims the
    // quorum with one machine, or a machine the deployment never committed, is
    // refused.
    const collapsed = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({ ...entry, machine: "machine-a" })),
      },
    };
    assert.equal(verifyRunBody(collapsed, spec).correct, false);
    const invented = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) => ({
          ...entry,
          machine: index === 0 ? "machine-z" : entry.machine,
        })),
      },
    };
    assert.equal(verifyRunBody(invented, spec).correct, false);

    // A run whose RECORDED machine disagrees with the machine its own signed
    // quote binds is refused, even when both strings are ones the deployment
    // committed: the machine must be attested, not typed.
    const swappedQuote = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 1 ? { ...entry, attestation: cardA.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swappedQuote, spec).correct, false);
    assert.match(
      verifyRunBody(swappedQuote, spec).error ?? "",
      /quorum/,
    );

    // An agreeing provider with no signed machine quote cannot count.
    const noQuote = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 1 ? { ...entry, attestation: undefined } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(noQuote, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a machine-independent quorum refuses a machine whose quote does not verify", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    // A provider that NAMES a machine but whose quote does not verify: the leaf
    // key signs garbage, so the machine claim is not backed by a valid signature.
    const keypair = generateAgentKeypair("ecdsa-p256");
    const brokenSigner = {
      sign: () => "A".repeat(88),
      publicKey: keypair.publicKey,
      suite: "ecdsa-p256",
    };
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
      machine: "solo-machine",
      teeSigner: brokenSigner,
    });
    // fetchProviderCard refuses an invalid card, so read the raw card to show the
    // machine is NAMED but its quote does not verify.
    const card = (await (await fetch(`${provider.url}/v1/provider-card`)).json()) as {
      independence: RunProviderAttestation;
      provider: { keyId: string | null };
      model: ModelRef;
    };
    assert.equal(card.independence.machine, "solo-machine");
    assert.equal(verifyProviderQuote(card.independence), null, "the quote does not verify");

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: card.provider.keyId!,
          machines: "solo-machine",
          independence: "machine",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: card.provider.keyId! },
      machines: { [provider.url]: "solo-machine" },
      attestations: { [provider.url]: card.independence! },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "signed?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 503);
    assert.match(((await response.json()) as { error: string }).error, /distinct machine/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a measurement allowlist refuses a provider running unapproved software", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    second = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0 });
    const card = await fetchProviderCard({ endpoint: first.url });
    const approved = card.independence!.measurement;
    assert.match(approved, /^[0-9a-f]{64}$/);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          // The deployment approves exactly one software image.
          measurements: approved,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.deepEqual(spec.measurements, [approved]);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "approved?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // One provider presents a measurement the deployment never approved.
    const rogue = "0".repeat(64);
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-rogue"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      measurements: { [first.url]: approved, [second.url]: rogue },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unapproved measurement/);
    assert.equal(new RunLedger(join(reg.root, "gateway-rogue")).records().length, 0);
    await gateway.close();
    gateway = null;

    // Both present the approved measurement: the run is met and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      measurements: { [first.url]: approved, [second.url]: approved },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the allowlist rule: swapping in an unapproved
    // measurement is caught.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) => ({
          ...entry,
          measurement: index === 0 ? rogue : entry.measurement,
        })),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a measurement allowlist must be sha256 hex, and needs a quorum of operators", () => {
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromNetwork("https://provider.example"),
      placement: "web4",
      labels: {
        execution: "web4",
        bundle: "a".repeat(64),
        shardsRoot: "b".repeat(64),
        manifestHash: "c".repeat(64),
        providers: "https://provider.example",
        quorum: "1",
        measurements: "not-hex",
      },
    }),
  );
  const errors = validateDeployment(deployment);
  assert.ok(errors.some((error) => error.includes("measurements entries must be sha256 hex")));
  assert.ok(errors.some((error) => error.includes("measurements requires")));
});

test("a run pins the engine, and a replay refuses a provider whose engine differs", async () => {
  const reg = await registry();
  let pinned: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    pinned = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    // A second provider running a different engine build (a different version).
    other = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      engineVersion: "other-engine",
    });
    const health = (await (await fetch(`${pinned.url}/health`)).json()) as { engineFingerprint: string };
    const healthOther = (await (await fetch(`${other.url}/health`)).json()) as { engineFingerprint: string };
    assert.match(health.engineFingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(health.engineFingerprint, healthOther.engineFingerprint);

    const card = await fetchProviderCard({ endpoint: pinned.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: pinned.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(pinned.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: pinned.url,
          operators: "operator-a",
          quorum: "1",
          engineFingerprint: health.engineFingerprint,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.engineFingerprint, health.engineFingerprint);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [pinned.url],
      quorum: 1,
      operators: { [pinned.url]: "operator-a" },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "pinned engine?" }],
        max_tokens: 8,
        temperature: 0,
        seed: 7,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(body.engine.fingerprint, health.engineFingerprint);
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Replay against the pinned provider reproduces the committed output.
    const good = await replayEngineRun({ body, endpoint: pinned.url });
    assert.equal(good.engineFingerprint, health.engineFingerprint);
    assert.equal(good.reproduced, true, good.reason ?? "");
    assert.equal(good.ok, true);

    // A provider on a different engine is refused before a token is generated.
    const bad = await replayEngineRun({ body, endpoint: other.url });
    assert.equal(bad.ok, false);
    assert.equal(bad.reproduced, null);
    assert.match(bad.reason ?? "", /differs from the pinned engine/);

    // The verifier recomputes the pin: a run naming another engine is refused.
    const swapped = { ...body, engine: { ...body.engine, fingerprint: healthOther.engineFingerprint } };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (pinned !== null) await pinned.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a machine quote is checked against a pinned vendor key", async () => {
  const vendor = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      teeSigner: vendor,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      teeSigner: vendor,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // The card carries a vendor quote that verifies under the vendor key.
    assert.equal(cardA.independence?.scheme, "tee");
    assert.ok(cardA.independence?.quote);
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderQuote(cardA.independence), vendor.keyId);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: vendor.keyId,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeVendor, vendor.keyId);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "quoted?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A forged quote: the measurement changes but the vendor signature does not,
    // so it no longer verifies under the pinned key.
    const forged = { ...cardA.independence!, measurement: "0".repeat(64) };
    assert.equal(verifyProviderQuote(forged), null);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-forged"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: forged, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // Both quote under the pinned vendor: the run is met and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.ok(body.quorum!.providers.every((entry) => entry.attestation !== undefined));
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the quote rule: replacing one with a forgery fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: forged } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a machine quote's chain of trust must terminate at the pinned anchor", async () => {
  const anchor = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const attacker = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // The anchor vouches for the leaf key.
  const certificate = issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: anchor });

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      teeSigner: leaf,
      teeChain: [certificate],
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      teeSigner: leaf,
      teeChain: [certificate],
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // The leaf signs the quote; the certificate chains it to the anchor.
    assert.equal(cardA.independence?.quote?.chain?.length, 1);
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderQuote(cardA.independence), leaf.keyId, "the quote is the leaf's");
    assert.equal(verifyProviderChain(cardA.independence), anchor.keyId, "and its root is the anchor");

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          // The deployment pins the ANCHOR, not the leaf.
          teeVendor: anchor.keyId,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeVendor, anchor.keyId);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "chained?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A chain that does not reach the anchor: the leaf is certified by an
    // attacker's key, not the pinned anchor. The quote is genuine, the trust is
    // not — and it is refused.
    const wrongAnchorCert = issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: attacker });
    const wrongAnchor = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: [wrongAnchorCert] },
    };
    assert.equal(verifyProviderChain(wrongAnchor), attacker.keyId);
    assert.notEqual(verifyProviderChain(wrongAnchor), anchor.keyId);

    // A certificate whose signature does not match its issuer is broken.
    const brokenCert = { ...certificate, signature: attacker.sign({ subject: certificate.subject, issuer: certificate.issuer }) };
    const broken = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: [brokenCert] },
    };
    assert.equal(verifyProviderChain(broken), null);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-wrong"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: wrongAnchor, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // With the chain reaching the pinned anchor, the run is met and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the chain: swapping in the attacker-rooted chain
    // fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: wrongAnchor } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("an enclave serves a bundle sealed to it, and a forwarder never holds the key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const otherKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
  const sealKey = generateSealKey();
  const anchor = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const certificate = issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: anchor });

  const reg = await registry();
  let enclave: Awaited<ReturnType<typeof startProvider>> | null = null;
  let forwarder: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: publicKey,
    });
    assert.equal(bundle.sealing?.wrap?.scheme, "rsa-oaep-sha256");
    await uploadBundle({ registry: reg.base, bundle, chunks });

    // The enclave unwraps the data key with its private key; a different key cannot.
    assert.equal(unwrapSealKey(bundle, privateKey).equals(sealKey), true);
    assert.throws(() => unwrapSealKey(bundle, otherKey), /does not unwrap/);

    // A forwarding provider can verify the committed ciphertext but not open it.
    const ciphertext = await fetchBundleCiphertext({ registry: reg.base, bundle });
    assert.notDeepEqual(ciphertext.bytes, NATIVE_BYTES);
    assert.equal(ciphertext.bytes.length, bundle.totalBytes);

    enclave = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: privateKey,
      teeSigner: leaf,
      teeChain: [certificate],
    });

    forwarder = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "forwarder"),
      port: 0,
      enclaveEndpoint: enclave.url,
    });

    // The forwarder holds ciphertext and no key; its card names the bundle but
    // carries the ENCLAVE's attestation.
    const forwarderHealth = (await (await fetch(`${forwarder.url}/health`)).json()) as {
      holdsKey: boolean;
      bundle: string;
    };
    assert.equal(forwarderHealth.holdsKey, false);
    assert.equal(forwarderHealth.bundle, bundle.digest);
    assert.equal(forwarder.card.bundle.sealed, true);
    assert.equal(verifyProviderChain(forwarder.card.independence), anchor.keyId);
    assert.equal(verifyProviderQuote(forwarder.card.independence), leaf.keyId);

    // Inference through the forwarder is the enclave's inference.
    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "who sees the weights?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });
    const viaEnclave = (await (await ask(enclave.url)).json()) as { choices: Array<{ message: { content: string } }> };
    const viaForwarder = (await (await ask(forwarder.url)).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(viaForwarder.choices[0]!.message.content, viaEnclave.choices[0]!.message.content);
    assert.ok(viaForwarder.choices[0]!.message.content.length > 0);

    // An enclave started with the wrong key refuses the bundle.
    await assert.rejects(
      startProvider({
        bundle,
        registry: reg.base,
        stateDir: join(reg.root, "wrong-enclave"),
        port: 0,
        enclaveKey: otherKey,
      }),
      /does not unwrap/,
    );
  } finally {
    if (forwarder !== null) await forwarder.close();
    if (enclave !== null) await enclave.close();
    await reg.close();
  }
});

test("an enclave's attestation binds the encryption key a caller seals to", async () => {
  const enclave = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const impostor = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueMeasuredBootChain(leaf.publicKey, { app: runtimeCodeMeasurement() });

  const sealKey = generateSealKey();
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: enclave.publicKey,
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: enclave.privateKey,
      teeSigner: leaf,
      teeChain: chain,
    });

    const attestation = (await (await fetch(`${provider.url}/v1/attestation`)).json()) as {
      attestation: { enclaveKey?: string; quote?: unknown };
      enclavePublicKey: string;
    };
    assert.match(attestation.enclavePublicKey, /BEGIN PUBLIC KEY/);
    // The signed attestation carries the digest of the very key it published, and
    // the quote covers it, so a caller can check before encrypting anything.
    assert.equal(attestation.attestation.enclaveKey, enclaveKeyDigest(attestation.enclavePublicKey));
    assert.equal(verifyProviderQuote(attestation.attestation), leaf.keyId);
    assert.equal(attestationBindsEnclaveKey(attestation.attestation, attestation.enclavePublicKey), true);
    // A key the operator does not hold — a man in the middle — is refused.
    assert.equal(attestationBindsEnclaveKey(attestation.attestation, impostor.publicKey), false);
    assert.notEqual(enclaveKeyDigest(impostor.publicKey), attestation.attestation.enclaveKey);
    // The card carries the same binding.
    const card = await fetchProviderCard({ endpoint: provider.url });
    assert.deepEqual(verifyProviderCard(card), []);
    assert.equal(attestationBindsEnclaveKey(card.independence, attestation.enclavePublicKey), true);
    assert.equal(attestationBindsEnclaveKey(card.independence, impostor.publicKey), false);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a deployment can demand vendor-certified memory isolation, refusing a host-readable enclave", async () => {
  const reg = await registry();
  let isolated: Awaited<ReturnType<typeof startProvider>> | null = null;
  let plain: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const code = runtimeCodeMeasurement();

    // A vendor-signed image manifest that CERTIFIES host-root-excluded isolation,
    // and one that does not. Both chain to the shipped hardware root.
    const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const manifestChain = issueHardwareChain(manifestLeaf.publicKey).chain;
    const isolatedManifest = signImageManifest(
      { image: code, runtime: "rarext-runtime", isolation: "host-root-excluded" },
      manifestLeaf,
      manifestChain,
    );
    const hostReadableManifest = signImageManifest(
      { image: code, runtime: "rarext-runtime" },
      manifestLeaf,
      manifestChain,
    );
    assert.equal(verifyImageManifest(isolatedManifest)?.isolation, "host-root-excluded");
    assert.equal(verifyImageManifest(hostReadableManifest)?.isolation, null);

    const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const teeChain = issueHardwareChain(leaf.publicKey).chain;
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    isolated = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "isolated"),
      port: 0,
      machine: "iso-machine",
      isolation: "host-root-excluded",
      codeMeasurement: code,
      imageManifest: isolatedManifest,
      enclaveKey: rsa.privateKey,
      teeSigner: leaf,
      teeChain,
    });
    const card = await fetchProviderCard({ endpoint: isolated.url });
    assert.deepEqual(verifyProviderCard(card), []);
    assert.equal(card.independence?.isolation, "host-root-excluded");
    assert.equal(verifyProviderQuote(card.independence), leaf.keyId);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: isolated.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(isolated.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: isolated.url,
          operators: card.provider.keyId!,
          machines: "iso-machine",
          independence: "machine",
          quorum: "1",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          teeSignedImageDepth: "2",
          teeCodeMeasurement: code,
          teeIsolation: "host-root-excluded",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeIsolation, "host-root-excluded");

    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "isolated?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [isolated.url],
      quorum: 1,
      operators: { [isolated.url]: card.provider.keyId! },
      machines: { [isolated.url]: "iso-machine" },
      attestations: { [isolated.url]: card.independence! },
    });
    const ok = await ask(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.equal(body.quorum!.providers[0]!.attestation!.isolation, "host-root-excluded");
    assert.ok(verified.details.checks.includes("quorum"));

    // A recorded attestation that drops the isolation capability is refused: the
    // deployment demanded a vendor-certified host-root-excluded memory.
    const dropped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({
          ...entry,
          attestation: { ...entry.attestation!, isolation: undefined },
        })),
      },
    };
    assert.equal(verifyRunBody(dropped, spec).correct, false);

    await gateway.close();
    gateway = null;

    // A software-only provider — a vendor-signed image WITHOUT the isolation
    // capability — cannot satisfy the demand, even though its quote chains to the
    // pinned root.
    plain = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "plain"),
      port: 0,
      machine: "plain-machine",
      codeMeasurement: code,
      imageManifest: hostReadableManifest,
      teeSigner: leaf,
      teeChain,
    });
    const plainCard = await fetchProviderCard({ endpoint: plain.url });
    assert.equal(verifyProviderQuote(plainCard.independence), leaf.keyId);
    assert.equal(plainCard.independence?.isolation, undefined);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-plain"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [plain.url],
      quorum: 1,
      operators: { [plain.url]: plainCard.provider.keyId! },
      machines: { [plain.url]: "plain-machine" },
      attestations: { [plain.url]: plainCard.independence! },
    });
    const refused = await ask(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(
      ((await refused.json()) as { error: string }).error,
      /unverifiable machine quote/,
    );
    assert.equal(new RunLedger(join(reg.root, "gateway-plain")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (isolated !== null) await isolated.close();
    if (plain !== null) await plain.close();
    await reg.close();
  }
});

test("a run that commits an engine must have a provider receipt that signs it", async () => {
  const enclave = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sealKey = generateSealKey();
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueMeasuredBootChain(leaf.publicKey, { app: runtimeCodeMeasurement() });

  const reg = await registry();
  let enclaveNode: Awaited<ReturnType<typeof startProvider>> | null = null;
  let forwarder: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: enclave.publicKey,
    });
    const manifestHash = (await uploadBundle({ registry: reg.base, bundle, chunks })).manifestHash;

    enclaveNode = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: enclave.privateKey,
      teeSigner: leaf,
      teeChain: chain,
    });
    // The forwarder runs no engine of its own, so its receipts omit `engine`.
    forwarder = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "forwarder"),
      port: 0,
      enclaveEndpoint: enclaveNode.url,
    });
    const enclaveEngine = ((await (await fetch(`${enclaveNode.url}/health`)).json()) as {
      engineFingerprint: string;
    }).engineFingerprint;
    const forwarderKeyId = forwarder.card.provider.keyId!;

    const deploy = (engineFingerprint: string | null) =>
      commitDeployment(
        buildDeployment({
          probe: {
            engine: { name: "openai-compatible", version: "web4", endpoint: forwarder!.url },
            model: forwarder!.card.model,
            apis: ["openai"],
            models: [forwarder!.card.model],
          },
          hardware: hardwareFromNetwork(forwarder!.url),
          placement: "web4",
          labels: {
            execution: "web4",
            bundle: bundle.digest,
            shardsRoot: bundle.shardsRoot,
            manifestHash,
            providers: forwarder!.url,
            operators: forwarderKeyId,
            quorum: "1",
            ...(engineFingerprint === null ? {} : { engineFingerprint }),
            fixture: "loopback",
          },
          createdAt: "2026-11-07T00:00:00.000Z",
        }),
      );

    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: forwarder!.card.model.id,
          messages: [{ role: "user", content: "which engine?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 2,
        }),
      });

    // No engine committed: the run is fine even though the receipt omits it.
    const loose = deploy(null);
    assert.deepEqual(validateDeployment(loose), []);
    gateway = await startGateway({
      deployment: loose,
      ledgerDir: join(reg.root, "gateway-loose"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [forwarder.url],
      quorum: 1,
      operators: { [forwarder.url]: forwarderKeyId },
    });
    assert.equal((await ask(gateway.url)).status, 200);
    const looseBody = new RunLedger(join(reg.root, "gateway-loose")).records()[0]!.body;
    assert.equal(verifyRunBody(looseBody, runSpecFromChallenge(challengeFor(loose))).correct, true);
    await gateway.close();
    gateway = null;

    // The SAME run, but the deployment commits an engine the receipt does not
    // sign: the run claims an engine no agreeing provider attested, and is refused.
    const strict = deploy(enclaveEngine);
    assert.deepEqual(validateDeployment(strict), []);
    gateway = await startGateway({
      deployment: strict,
      ledgerDir: join(reg.root, "gateway-strict"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [forwarder.url],
      quorum: 1,
      operators: { [forwarder.url]: forwarderKeyId },
    });
    assert.equal((await ask(gateway.url)).status, 200);
    const strictBody = new RunLedger(join(reg.root, "gateway-strict")).records()[0]!.body;
    assert.equal(strictBody.engine.fingerprint, enclaveEngine);
    assert.equal(
      (strictBody.quorum!.providers[0]!.receipt as { engine?: string }).engine,
      undefined,
      "the forwarding provider's receipt omits the engine",
    );
    const verdict = verifyRunBody(strictBody, runSpecFromChallenge(challengeFor(strict)));
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (forwarder !== null) await forwarder.close();
    if (enclaveNode !== null) await enclaveNode.close();
    await reg.close();
  }
});

test("a sealed prompt is answered without the forwarder ever seeing plaintext", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sealKey = generateSealKey();
  const reg = await registry();
  let enclave: Awaited<ReturnType<typeof startProvider>> | null = null;
  let forwarder: Awaited<ReturnType<typeof startProvider>> | null = null;
  let plain: Awaited<ReturnType<typeof startProvider>> | null = null;
  const forwardedBodies: string[] = [];
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: publicKey,
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    enclave = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: privateKey,
    });

    // A fetch seam that records exactly what the forwarder relays to the enclave.
    const capturingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/chat/completions") && typeof init?.body === "string") {
        forwardedBodies.push(init.body);
      }
      return fetch(input, init);
    };
    forwarder = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "forwarder"),
      port: 0,
      enclaveEndpoint: enclave.url,
      fetchImpl: capturingFetch,
    });

    // The enclave publishes the key a caller seals to.
    const attestation = (await (await fetch(`${enclave.url}/v1/attestation`)).json()) as {
      enclavePublicKey: string;
    };
    assert.match(attestation.enclavePublicKey, /BEGIN PUBLIC KEY/);

    const secret = "TOP SECRET PROMPT";
    const request = {
      model: bundle.model.id,
      messages: [{ role: "user", content: secret }],
      max_tokens: 8,
      temperature: 0,
    };
    const { sealed, key } = sealRequest(attestation.enclavePublicKey, request);

    // The caller posts ciphertext to the FORWARDER, which holds no key.
    const response = await fetch(`${forwarder.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, confidential: sealed }),
    });
    assert.equal(response.status, 200);
    const sealedResponse = (await response.json()) as { confidential: { nonce: string; ciphertext: string } };
    assert.ok(sealedResponse.confidential, "the answer comes back sealed");
    const answer = openResponse(key, sealedResponse.confidential) as {
      choices: Array<{ message: { content: string } }>;
    };

    // The same prompt asked in the clear yields the same answer...
    const plainResponse = await fetch(`${enclave.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const plainJson = (await plainResponse.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(answer.choices[0]!.message.content, plainJson.choices[0]!.message.content);

    // ... and what the forwarder relayed never contained the secret.
    assert.equal(forwardedBodies.length, 1);
    assert.equal(forwardedBodies[0]!.includes(secret), false, "the forwarder never sees the prompt");
    assert.match(forwardedBodies[0]!, /"confidential"/);

    // A provider with no enclave key refuses a confidential request by name.
    const plainBundle = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    await uploadBundle({ registry: reg.base, bundle: plainBundle.bundle, chunks: plainBundle.chunks });
    plain = await startProvider({
      bundle: plainBundle.bundle,
      registry: reg.base,
      stateDir: join(reg.root, "plain"),
      port: 0,
    });
    const refused = await fetch(`${plain.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: plainBundle.bundle.model.id, confidential: sealed }),
    });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /no enclave key/);
  } finally {
    if (plain !== null) await plain.close();
    if (forwarder !== null) await forwarder.close();
    if (enclave !== null) await enclave.close();
    await reg.close();
  }
});

test("a machine quote must chain from a hardware (vendor) root of trust", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueHardwareChain(leaf.publicKey);
  assert.equal(chain.length, 2, "leaf -> platform -> vendor root");

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      teeSigner: leaf,
      teeChain: chain,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      teeSigner: leaf,
      teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // The leaf signs; the chain reaches the SHIPPED vendor root, depth two.
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderChain(cardA.independence), HARDWARE_ROOT_KEY_ID);
    assert.equal(providerChainDepth(cardA.independence), 2);

    // A leaf-only attestation is valid but NOT hardware-rooted: depth zero, and
    // its root is the leaf, not the vendor.
    const leafOnly = {
      ...cardA.independence!,
      quote: {
        signature: cardA.independence!.quote!.signature,
        publicKey: cardA.independence!.quote!.publicKey,
        suite: cardA.independence!.quote!.suite,
      },
    };
    assert.equal(providerChainDepth(leafOnly), 0);
    assert.notEqual(verifyProviderChain(leafOnly), HARDWARE_ROOT_KEY_ID);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          // Pinned to the vendor hardware root, requiring a depth-2 chain.
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeVendor, HARDWARE_ROOT_KEY_ID);
    assert.equal(spec.teeChainDepth, 2);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "hardware rooted?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A leaf-only attestation cannot meet a hardware-rooted quorum.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-leaf"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: leafOnly, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // The vendor-rooted chain satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the depth rule: a leaf-only attestation fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: leafOnly } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a quote's root can rotate, and a stale or revoked root is refused", async () => {
  // The vendor rotates its root. The retirement step is signed by the OLD root,
  // so authority flows from the shipped anchor forward; an unrelated key cannot
  // claim the new root.
  const newRoot = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const rotation = issueRootRotation({
    fromSigner: hardwareRootSigner(),
    nextSigner: newRoot,
    epoch: 1,
    previous: null,
    issuedAt: "2026-11-07T00:00:00.000Z",
  });
  const rootChain = {
    kind: ROOT_CHAIN_KIND as typeof ROOT_CHAIN_KIND,
    anchor: HARDWARE_ROOT_KEY_ID,
    rotations: [rotation],
  };
  const verified = verifyRootChain(rootChain, HARDWARE_ROOT_KEY_ID);
  assert.ok(verified, "the rotation chain verifies from the pinned anchor");
  assert.equal(verified.current, newRoot.keyId);
  assert.equal(verified.epoch, 1);

  // A certificate chain that terminates at the NEW root.
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const platform = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const rotatedChain = [
    issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: platform }),
    issueProviderCertificate({ subject: platform.publicKey, issuerSigner: newRoot }),
  ];

  const reg = await registry();
  let rotated: Awaited<ReturnType<typeof startProvider>> | null = null;
  let stale: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    rotated = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "rotated"),
      port: 0,
      teeSigner: leaf,
      teeChain: rotatedChain,
      teeRootChain: rootChain,
    });
    stale = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "stale"),
      port: 0,
      teeSigner: leaf,
      teeChain: issueHardwareChain(leaf.publicKey).chain,
    });
    const rotatedCard = await fetchProviderCard({ endpoint: rotated.url });
    const staleCard = await fetchProviderCard({ endpoint: stale.url });

    // The rotated quote terminates at the CURRENT root and reaches epoch 1.
    assert.deepEqual(verifyProviderCard(rotatedCard), []);
    assert.equal(verifyProviderChain(rotatedCard.independence), newRoot.keyId);
    const rooted = verifyProviderRootChain(rotatedCard.independence, HARDWARE_ROOT_KEY_ID, 1);
    assert.ok(rooted);
    assert.equal(rooted.current, newRoot.keyId);
    assert.equal(rooted.epoch, 1);

    // A quote that still terminates at the retired anchor is STALE once the
    // deployment has learned the rotation; at epoch 0 it is still accepted.
    assert.equal(verifyProviderRootChain(staleCard.independence, HARDWARE_ROOT_KEY_ID, 0)?.current, HARDWARE_ROOT_KEY_ID);
    assert.equal(verifyProviderRootChain(staleCard.independence, HARDWARE_ROOT_KEY_ID, 1), null);

    // Revoking the new root refuses every quote that terminates at it, even
    // though the chain still reaches it.
    const revokedRotation = issueRootRotation({
      fromSigner: hardwareRootSigner(),
      nextSigner: newRoot,
      epoch: 1,
      previous: null,
      revoke: [newRoot.keyId],
    });
    const revokedCard = {
      ...rotatedCard.independence!,
      quote: {
        ...rotatedCard.independence!.quote!,
        rootChain: {
          kind: ROOT_CHAIN_KIND as typeof ROOT_CHAIN_KIND,
          anchor: HARDWARE_ROOT_KEY_ID,
          rotations: [revokedRotation],
        },
      },
    };
    assert.equal(verifyProviderRootChain(revokedCard, HARDWARE_ROOT_KEY_ID, 1), null);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: rotated.url },
          model: rotatedCard.model,
          apis: ["openai"],
          models: [rotatedCard.model],
        },
        hardware: hardwareFromNetwork(rotated.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: rotated.url,
          operators: rotatedCard.provider.keyId!,
          quorum: "1",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "2",
          teeRootEpoch: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeRootEpoch, 1);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "rotated root?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The rotated provider satisfies the pinned epoch.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-rotated"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [rotated.url],
      quorum: 1,
      operators: { [rotated.url]: rotatedCard.provider.keyId! },
      attestations: { [rotated.url]: rotatedCard.independence! },
    });
    const accepted = await request(gateway.url);
    assert.equal(accepted.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-rotated")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A quote still rooted at the retired anchor is refused as stale.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-stale"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [stale.url],
      quorum: 1,
      operators: { [stale.url]: staleCard.provider.keyId! },
      attestations: { [stale.url]: staleCard.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (rotated !== null) await rotated.close();
    if (stale !== null) await stale.close();
    await reg.close();
  }
});

test("a quote must extend a measured-boot chain through every required stage", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, stages } = issueMeasuredBootChain(leaf.publicKey);
  assert.equal(chain.length, 3, "app -> os -> firmware -> vendor root");
  assert.deepEqual(stages, ["app", "os", "firmware"]);

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    second = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderChain(cardA.independence), HARDWARE_ROOT_KEY_ID);
    assert.equal(providerChainDepth(cardA.independence), 3);
    assert.deepEqual(providerBootStages(cardA.independence).sort(), ["app", "firmware", "os"]);

    // A chain with no stages at all: it reaches the vendor root but never
    // measured the boot.
    const { chain: stagelessChain } = issueHardwareChain(leaf.publicKey);
    const stageless = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: stagelessChain },
    };
    assert.equal(providerBootStages(stageless).includes("firmware"), false);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.deepEqual(spec.teeBootStages, ["firmware", "os", "app"]);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "measured boot?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A chain that omits the boot stages cannot meet the quorum.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-stageless"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: stageless, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // The measured-boot chain satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the stage rule: a stageless chain fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: stageless } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a deployment pins per-stage measurements, refusing unapproved firmware/os/app", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey);
  for (const value of Object.values(measurements)) assert.match(value, /^[0-9a-f]{64}$/);

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    second = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    assert.deepEqual(providerStageMeasurements(cardA.independence), {
      app: measurements.app,
      os: measurements.os,
      firmware: measurements.firmware,
    });

    // A chain running different firmware: its firmware measurement is not approved.
    const { chain: otherFirmware } = issueMeasuredBootChain(leaf.publicKey, {
      firmware: "0".repeat(64),
    });
    const wrongMeasure = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: otherFirmware },
    };
    assert.equal(providerStageMeasurements(wrongMeasure).firmware, "0".repeat(64));
    assert.notEqual(providerStageMeasurements(wrongMeasure).firmware, measurements.firmware);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeStageMeasurements!.firmware, measurements.firmware);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "measured?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-wrong"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: wrongMeasure, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: wrongMeasure } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a deterministic run records its decode trace, and replay refuses a divergence", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "trace me" }],
        max_tokens: 8,
        temperature: 0,
        seed: 7,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const trace = (body.response.body as { rarext_trace?: { kind: string; tokens: number[]; digest: string } })
      .rarext_trace;
    assert.ok(trace, "a deterministic run records its decode trace");
    assert.equal(trace!.kind, "rarext.decode-trace.v1");
    assert.ok(trace!.tokens.length > 0);
    assert.match(trace!.digest, /^[0-9a-f]{64}$/);
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Editing the tokens moves the trace digest, which the verifier recomputes.
    const tampered = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, tokens: [...trace!.tokens, 1] },
        },
      },
    };
    assert.equal(verifyRunBody(tampered, spec).correct, false);

    // Replay reproduces the output AND matches the trace.
    const good = await replayEngineRun({ body, endpoint: provider.url });
    assert.equal(good.reproduced, true, good.reason ?? "");
    assert.equal(good.traceMatches, true);
    assert.equal(good.ok, true);

    // A recorded trace the re-execution does not reproduce is refused by name.
    const diverged = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, digest: "0".repeat(64) },
        },
      },
    };
    const bad = await replayEngineRun({ body: diverged, endpoint: provider.url });
    assert.equal(bad.traceMatches, false);
    assert.equal(bad.ok, false);
    assert.match(bad.reason ?? "", /decode trace diverged/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a freshness challenge refuses a replayed attestation", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey);
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    second = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });

    // The provider answers a nonce with a freshly-signed quote bound to it.
    const nonce = "ab".repeat(32);
    const challenged = (await (
      await fetch(`${first.url}/v1/attestation?nonce=${nonce}`)
    ).json()) as { attestation: { challenge?: string; quote?: unknown } };
    assert.equal(challenged.attestation.challenge, nonce);
    assert.ok(challenged.attestation.quote);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeFreshness: "challenge",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeFreshness, "challenge");

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "fresh?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The gateway challenges each provider and records the bound nonce.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    const nonces = body.quorum!.providers.map((entry) => entry.attestation?.challenge);
    assert.ok(nonces.every((value) => typeof value === "string" && value !== ""));
    assert.equal(new Set(nonces).size, 1, "one run, one nonce");
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // The verifier recomputes freshness: a provider bound to another nonce (or
    // none) fails.
    const diverged = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: { ...entry.attestation, challenge: "cd".repeat(32) } } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(diverged, spec).correct, false);
    const missing = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => {
          const { challenge: _challenge, ...rest } = entry.attestation!;
          return { ...entry, attestation: rest };
        }),
      },
    };
    assert.equal(verifyRunBody(missing, spec).correct, false);

    // A provider that answers the challenge with a STALE (unchallenged) quote is
    // refused before a run is written.
    const staleFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/attestation?nonce=")) {
        return new Response(JSON.stringify({ attestation: cardA.independence }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(input, init);
    };
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-stale"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      fetchImpl: staleFetch,
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-stale")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("an engine run records a token-logprob judgment, and replay checks it", async () => {
  // A stub engine that returns per-token logprobs, the way Ollama does.
  const stub = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "cmpl",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello world" },
              finish_reason: "stop",
              logprobs: {
                content: [
                  { token: "hello", logprob: -0.1 },
                  { token: " world", logprob: -0.2 },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = (stub.address() as AddressInfo).port;
  const stubUrl = `http://127.0.0.1:${stubPort}`;

  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: Buffer.from("GGUF-fake-for-the-judgment-test"),
      model: { ...NATIVE_REF, id: "engine-judge", format: "gguf", weightsDigest: null },
      execution: { kind: "engine", engine: "ollama", engineModel: "judge" },
      chunkBytes: 8,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "engine"),
      port: 0,
      engineEndpoint: stubUrl,
      engineCreate: async () => {},
      engineLogprobs: true,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash: bundleManifestHash(bundle),
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "judge me" }],
        max_tokens: 4,
        temperature: 0,
        seed: 7,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const trace = (body.response.body as { rarext_trace?: { kind: string; tokens: string[]; logprobs: number[]; digest: string } })
      .rarext_trace;
    assert.ok(trace, "an engine run records its judgment");
    assert.equal(trace!.kind, "rarext.judgment.v1");
    assert.deepEqual(trace!.tokens, ["hello", " world"]);
    assert.deepEqual(trace!.logprobs, [-0.1, -0.2]);
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Editing a logprob moves the digest, which the verifier recomputes.
    const tampered = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, logprobs: [-0.1, -0.9] },
        },
      },
    };
    assert.equal(verifyRunBody(tampered, spec).correct, false);

    // Replay reproduces the text AND the judgment.
    const good = await replayEngineRun({ body, endpoint: provider.url });
    assert.equal(good.reproduced, true, good.reason ?? "");
    assert.equal(good.traceMatches, true);
    assert.equal(good.ok, true);

    const diverged = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, digest: "0".repeat(64) },
        },
      },
    };
    const bad = await replayEngineRun({ body: diverged, endpoint: provider.url });
    assert.equal(bad.traceMatches, false);
    assert.match(bad.reason ?? "", /decode trace diverged/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("a deployment pins the enclave's code measurement, refusing other code", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey);
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a") });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b") });
    // A provider running different code (a different code measurement).
    other = await startProvider({
      ...common,
      stateDir: join(reg.root, "c"),
      codeMeasurement: "0".repeat(64),
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardC = await fetchProviderCard({ endpoint: other.url });
    assert.match(cardA.independence!.code!, /^[0-9a-f]{64}$/);
    assert.equal(cardA.independence!.code, cardB.independence!.code, "same code, same measurement");
    assert.equal(cardC.independence!.code, "0".repeat(64));

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: cardA.independence!.code!,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeCodeMeasurement, cardA.independence!.code);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "code?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The provider running other code is refused before a run is written.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-wrong"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardC.independence!, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-wrong")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The approved code satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.ok(body.quorum!.providers.every((entry) => entry.attestation?.code === cardA.independence!.code));
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes it: swapping in another code fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: { ...entry.attestation, code: "0".repeat(64) } } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("an enclave's image is bound to a vendor-signed manifest", async () => {
  const code = runtimeCodeMeasurement();
  const vendorSigner = hardwareRootSigner();
  const manifest = signImageManifest({ image: code, runtime: "rarext-runtime" }, vendorSigner);
  assert.equal(verifyImageManifest(manifest)?.vendorKeyId, HARDWARE_ROOT_KEY_ID);

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // The measured boot's app stage IS the signed image, so the two attestations agree.
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let foreignProvider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain, imageManifest: manifest };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a") });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b") });

    // A manifest signed by another vendor: valid, but not the pinned vendor.
    const attacker = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const foreign = signImageManifest({ image: code, runtime: "rarext-runtime" }, attacker);
    foreignProvider = await startProvider({ ...common, stateDir: join(reg.root, "c"), imageManifest: foreign });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardC = await fetchProviderCard({ endpoint: foreignProvider.url });
    assert.equal(cardA.independence?.code, code);
    assert.ok(cardA.independence?.image);
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyImageManifest(cardC.independence?.image)?.vendorKeyId, attacker.keyId);

    // A manifest whose image is not the running code refuses to start.
    const wrongImage = signImageManifest({ image: "0".repeat(64), runtime: "x" }, vendorSigner);
    await assert.rejects(
      startProvider({ ...common, stateDir: join(reg.root, "wrong"), imageManifest: wrongImage }),
      /not the signed image/,
    );

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeSignedImage, HARDWARE_ROOT_KEY_ID);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "signed image?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // An image signed by another vendor cannot meet the quorum.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-foreign"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardC.independence!, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // The vendor-signed image satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes it: a foreign-signed image fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: { ...entry.attestation, image: foreign } } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (foreignProvider !== null) await foreignProvider.close();
    await reg.close();
  }
});

test("an image manifest's chain must terminate at the pinned hardware root", async () => {
  const code = runtimeCodeMeasurement();
  // The manifest signer is a LEAF, certified up to the shipped hardware root.
  const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain: manifestChain } = issueHardwareChain(manifestLeaf.publicKey);
  const chained = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf, manifestChain);
  // The SAME leaf, signed with no chain: a real signature, but self-rooted.
  const bare = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf);

  const chainedInfo = verifyImageManifest(chained)!;
  assert.equal(chainedInfo.vendorKeyId, manifestLeaf.keyId, "the signer is the leaf");
  assert.equal(chainedInfo.rootKeyId, HARDWARE_ROOT_KEY_ID, "and its chain reaches the hardware root");
  const bareInfo = verifyImageManifest(bare)!;
  assert.equal(bareInfo.vendorKeyId, manifestLeaf.keyId, "same signer");
  assert.equal(bareInfo.rootKeyId, manifestLeaf.keyId, "but a bare leaf is its own root");
  assert.notEqual(bareInfo.rootKeyId, HARDWARE_ROOT_KEY_ID);

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // The app stage must equal the signed image for these attestations to cohere.
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let bareProvider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a"), imageManifest: chained });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b"), imageManifest: chained });
    // A provider whose manifest is real but self-rooted (no chain to the anchor).
    bareProvider = await startProvider({ ...common, stateDir: join(reg.root, "bare"), imageManifest: bare });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardBare = await fetchProviderCard({ endpoint: bareProvider.url });
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyImageManifest(cardA.independence?.image)?.rootKeyId, HARDWARE_ROOT_KEY_ID);
    assert.equal(verifyImageManifest(cardBare.independence?.image)?.rootKeyId, manifestLeaf.keyId);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeSignedImage, HARDWARE_ROOT_KEY_ID);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "rooted image?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A self-rooted (bare-leaf) manifest cannot meet a hardware-rooted pin.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-bare"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, bareProvider.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [bareProvider.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [bareProvider.url]: cardBare.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-bare")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The chain that reaches the pinned root satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-rooted"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-rooted")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the chain: swapping in the bare-leaf manifest fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: cardBare.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (bareProvider !== null) await bareProvider.close();
    await reg.close();
  }
});

test("a pinned image-chain depth refuses a manifest signed directly by the root", async () => {
  const code = runtimeCodeMeasurement();
  // Signed directly by the anchor: the root matches, but the chain is empty.
  const rootSigned = signImageManifest({ image: code, runtime: "rarext-runtime" }, hardwareRootSigner());
  // Signed by a leaf CERTIFIED by the anchor: a real chain.
  const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain: manifestChain } = issueHardwareChain(manifestLeaf.publicKey);
  const chained = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf, manifestChain);

  const rootInfo = verifyImageManifest(rootSigned)!;
  assert.equal(rootInfo.rootKeyId, HARDWARE_ROOT_KEY_ID, "the root-signed manifest reaches the anchor");
  assert.equal(rootInfo.chainDepth, 0, "but it presents no chain");
  assert.equal(verifyImageManifest(chained)!.chainDepth, 2, "the certified leaf presents a chain");

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let rootProvider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a"), imageManifest: chained });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b"), imageManifest: chained });
    rootProvider = await startProvider({ ...common, stateDir: join(reg.root, "root"), imageManifest: rootSigned });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardRoot = await fetchProviderCard({ endpoint: rootProvider.url });
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyImageManifest(cardRoot.independence?.image)?.chainDepth, 0);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          teeSignedImageDepth: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeSignedImage, HARDWARE_ROOT_KEY_ID);
    assert.equal(spec.teeSignedImageDepth, 1);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "depth?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A depth-0 manifest that reaches the pinned root cannot meet a depth-≥1 pin.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-shallow"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, rootProvider.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [rootProvider.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [rootProvider.url]: cardRoot.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-shallow")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The certified chain meets the depth.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-deep"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-deep")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the depth: swapping in the depth-0 manifest fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: cardRoot.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (rootProvider !== null) await rootProvider.close();
    await reg.close();
  }
});

test("the measured boot's app stage must equal the signed image", async () => {
  const code = runtimeCodeMeasurement();
  // A signed image for `code`, chained to the shipped hardware root.
  const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain: manifestChain } = issueHardwareChain(manifestLeaf.publicKey);
  const manifest = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf, manifestChain);

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // A coherent boot chain: its app stage IS the signed image.
  const { chain: coherentChain } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  // An incoherent one: the app stage is some OTHER measurement.
  const { chain: incoherentChain } = issueMeasuredBootChain(leaf.publicKey, { app: "0".repeat(64) });

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let incoherent: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: coherentChain, imageManifest: manifest });
    second = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: coherentChain, imageManifest: manifest });
    incoherent = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "c"), port: 0, teeSigner: leaf, teeChain: incoherentChain, imageManifest: manifest });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardC = await fetchProviderCard({ endpoint: incoherent.url });
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(providerStageMeasurements(cardA.independence).app, code);
    assert.equal(providerStageMeasurements(cardC.independence).app, "0".repeat(64));

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          teeSignedImageDepth: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "app == image?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The incoherent chain measures a different app than the signed image.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-incoherent"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, incoherent.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [incoherent.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [incoherent.url]: cardC.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-incoherent")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The coherent chain (app == image) satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-coherent"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-coherent")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the binding: swapping in the incoherent chain fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: cardC.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (incoherent !== null) await incoherent.close();
    await reg.close();
  }
});

test("a deployment that requires a decode trace refuses a run without one", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          trace: "required",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.requireTrace, true);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "trace required?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 5,
        }),
      });

    // The native provider emits a trace, so the run is written and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.ok((body.response.body as { rarext_trace?: unknown }).rarext_trace);
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true);
    // The committed requirement is what the verifier checked, and it passed.
    assert.ok(verified.details.checks.includes("response.decodeTraceRequired"));

    // A run whose response lacks the trace fails that very check.
    const stripped = {
      ...body,
      response: {
        ...body.response,
        body: Object.fromEntries(
          Object.entries(body.response.body as Record<string, unknown>).filter(
            ([key]) => key !== "rarext_trace",
          ),
        ),
      },
    };
    const strippedVerdict = verifyRunBody(stripped, spec);
    assert.equal(strippedVerdict.correct, false);
    assert.ok(
      (strippedVerdict.proof as { failures: string[] }).failures.includes("response.decodeTraceRequired"),
    );
    // With no requirement, that check never runs, so its absence is not a failure.
    assert.equal(
      (verifyRunBody(stripped, { ...spec, requireTrace: undefined }).proof as { failures: string[] }).failures.includes(
        "response.decodeTraceRequired",
      ),
      false,
    );
    await gateway.close();
    gateway = null;

    // A gateway that receives a provider response with the trace stripped refuses
    // the run before writing it.
    const strippingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const json = (await response.json()) as Record<string, unknown>;
      delete (json as { rarext_trace?: unknown }).rarext_trace;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const receipt = response.headers.get("x-rarext-receipt");
      if (receipt !== null) headers["x-rarext-receipt"] = receipt;
      return new Response(JSON.stringify(json), { status: 200, headers });
    };
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-notrace"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
      fetchImpl: strippingFetch,
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /requires a decode trace/);
    assert.equal(new RunLedger(join(reg.root, "gateway-notrace")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a deployment that requires a replayable run refuses a sampled request", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          replay: "required",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.requireReplay, true);

    const ask = (url: string, extra: Record<string, unknown>) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "reproducible?" }],
          max_tokens: 8,
          ...extra,
        }),
      });

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });

    // A sampled request (temperature > 0, or no seed) is refused before a run.
    const sampled = await ask(gateway.url, { temperature: 0.7, seed: 5 });
    assert.equal(sampled.status, 422);
    assert.match(((await sampled.json()) as { error: string }).error, /replayable run/);
    const unseeded = await ask(gateway.url, { temperature: 0 });
    assert.equal(unseeded.status, 422);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);

    // A deterministic request is recorded with a replay envelope and verifies.
    const ok = await ask(gateway.url, { temperature: 0, seed: 5 });
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.ok(body.replay, "the run carries a replay envelope");
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true);
    assert.ok(verified.details.checks.includes("replay.required"));
    assert.equal((verified.proof as { replayable: boolean }).replayable, true);
    await gateway.close();
    gateway = null;

    // A run without the envelope fails the required-replay check.
    const sampledBody = { ...body, replay: null };
    const strippedVerdict = verifyRunBody(sampledBody, spec);
    assert.equal(strippedVerdict.correct, false);
    assert.ok((strippedVerdict.proof as { failures: string[] }).failures.includes("replay.required"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider's signed receipt binds the answer, catching a lying gateway", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    // An honest gateway records the provider's own signature over the answer.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
    });
    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "receipt?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });
    assert.equal((await request(gateway.url)).status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const receipt = body.quorum!.providers[0]!.receipt as { response: string; publicKey: unknown };
    assert.ok(receipt, "the run carries the provider's receipt");
    assert.equal(receipt.response, body.quorum!.providers[0]!.responseDigest);
    assert.equal(publicKeyId(receipt.publicKey as never), operatorKeyId);
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A gateway that rewrites the answer but keeps the provider's receipt is
    // caught: the receipt no longer matches the recorded response.
    const lyingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const header = response.headers.get("x-rarext-receipt");
      const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      json.choices[0]!.message.content = "a different answer";
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(header === null ? {} : { "x-rarext-receipt": header }),
        },
      });
    };
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-lie"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
      fetchImpl: lyingFetch,
    });
    assert.equal((await request(gateway.url)).status, 200);
    const liedBody = new RunLedger(join(reg.root, "gateway-lie")).records()[0]!.body;
    assert.equal(verifyRunBody(liedBody, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a run that commits evidence is refused when an agreeing provider presents no receipt", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
    });
    assert.equal(
      (
        await fetch(`${gateway.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: deployment.model.id,
            messages: [{ role: "user", content: "who signed?" }],
            max_tokens: 8,
            temperature: 0,
          }),
        })
      ).status,
      200,
    );
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    // The run commits evidence: a model bundle no provider can be attributed to
    // without a signature.
    assert.equal(body.bundle?.digest, bundle.digest);
    assert.ok(body.quorum!.providers[0]!.receipt, "the honest run carries a receipt");
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Strip the agreeing provider's OWN receipt. Everything else still matches —
    // the exact request, the exact response, the operator, the run's committed
    // bundle — so this is precisely the unattributed run the strict rule exists
    // to refuse.
    const stripped = structuredClone(body);
    delete (stripped.quorum!.providers[0] as { receipt?: unknown }).receipt;
    assert.equal(stripped.quorum!.providers[0]!.receipt, undefined);
    const verdict = verifyRunBody(stripped, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a forged unsigned dissent cannot be admitted as quorum evidence", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
    });
    assert.equal(
      (
        await fetch(`${gateway.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: deployment.model.id,
            messages: [{ role: "user", content: "any dissent?" }],
            max_tokens: 8,
            temperature: 0,
          }),
        })
      ).status,
      200,
    );
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // A gateway invents a dissenting provider — no signature, a different digest,
    // an endpoint the run never called — and raises `responded` to include it.
    // The disagreement is not paid (dissenters are not payees), so only the
    // receipt rule can refuse the padded evidence set.
    const padded = structuredClone(body);
    padded.quorum!.providers.push({
      endpoint: "http://127.0.0.1:1",
      responseDigest: "0".repeat(64),
      operator: "0".repeat(64),
      machine: null,
      measurement: null,
    });
    padded.quorum!.responded = padded.quorum!.providers.length;
    assert.equal(padded.quorum!.providers.length, 2);
    assert.equal(padded.quorum!.agreed, 1);
    const verdict = verifyRunBody(padded, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a non-quorum web4 run records its provider, and refuses an unsigned one", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    // No `quorum` label and no `quorum` option: this is the single-provider
    // path, where the run has no quorum evidence at all.
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.quorum, undefined);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      operators: { [provider.url]: operatorKeyId },
      attestations: { [provider.url]: card.independence! },
    });
    assert.equal(
      (
        await fetch(`${gateway.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: deployment.model.id,
            messages: [{ role: "user", content: "who answered?" }],
            max_tokens: 8,
            temperature: 0,
          }),
        })
      ).status,
      200,
    );
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(body.quorum, undefined);
    assert.ok(body.provider, "a non-quorum run names the one provider that answered");
    assert.equal(body.provider!.endpoint, provider.url);
    assert.equal(body.provider!.operator, operatorKeyId);
    assert.ok(body.provider!.attestation, "the observed attestation is recorded");
    assert.ok(body.provider!.receipt, "the provider's own receipt is recorded");
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Strip the receipt: the run still commits a bundle, but no provider signed
    // it. Without the non-quorum rule this body would verify — the gap this
    // closes is exactly a single-provider run attributed to no one.
    const unsigned = structuredClone(body);
    delete (unsigned.provider as { receipt?: unknown }).receipt;
    const unsignedVerdict = verifyRunBody(unsigned, spec);
    assert.equal(unsignedVerdict.correct, false);
    assert.ok(
      (unsignedVerdict.proof as { failures: string[] }).failures.includes("provider.evidence"),
    );

    // And the provider block itself is required when evidence is committed.
    const naked = structuredClone(body);
    delete naked.provider;
    const nakedVerdict = verifyRunBody(naked, spec);
    assert.equal(nakedVerdict.correct, false);
    assert.ok((nakedVerdict.proof as { failures: string[] }).failures.includes("provider.evidence"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider's receipt binds its own attestation, not just the answer", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueMeasuredBootChain(leaf.publicKey, { app: runtimeCodeMeasurement() });
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
      teeSigner: leaf,
      teeChain: chain,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
      // The gateway records the provider's attestation, so the receipt binds it.
      attestations: { [provider.url]: card.independence! },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "which enclave?" }],
        max_tokens: 8,
        temperature: 0,
        seed: 3,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const entry = body.quorum!.providers[0]!;
    const receipt = entry.receipt as { attestation: string; response: string };
    assert.ok(entry.attestation, "the run records the provider's attestation");
    assert.equal(
      receipt.attestation,
      canonicalDigest(attestationForReceipt(entry.attestation)),
      "the receipt binds the attestation",
    );
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // Pairing the genuine answer with a DIFFERENT attestation is caught: the
    // receipt's attestation digest no longer matches what the run records.
    const forged = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((p, index) =>
          index === 0 ? { ...p, attestation: { ...p.attestation, measurement: "0".repeat(64) } } : p,
        ),
      },
    };
    const forgedVerdict = verifyRunBody(forged, spec);
    assert.equal(forgedVerdict.correct, false);
    assert.ok((forgedVerdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider's receipt binds the engine it served with, so a verifier catches a changed engine", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    // A second provider on a DIFFERENT engine build.
    other = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      engineVersion: "other-engine",
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: other.url });
    const operatorA = cardA.provider.keyId!;
    const operatorB = cardB.provider.keyId!;
    const engineA = ((await (await fetch(`${first.url}/health`)).json()) as { engineFingerprint: string })
      .engineFingerprint;
    const engineB = ((await (await fetch(`${other.url}/health`)).json()) as { engineFingerprint: string })
      .engineFingerprint;
    assert.match(engineA, /^[0-9a-f]{64}$/);
    assert.notEqual(engineA, engineB);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${other.url}`,
          // Both operators are committed so the two runs differ ONLY by engine.
          operators: `${operatorA},${operatorB}`,
          quorum: "1",
          engineFingerprint: engineA,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.engineFingerprint, engineA);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "which engine?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 9,
        }),
      });

    // The provider on the committed engine verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-a"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url],
      quorum: 1,
      operators: { [first.url]: operatorA },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const goodBody = new RunLedger(join(reg.root, "gateway-a")).records()[0]!.body;
    assert.equal(goodBody.engine.fingerprint, engineA);
    assert.equal((goodBody.quorum!.providers[0]!.receipt as { engine: string }).engine, engineA);
    assert.equal(verifyRunBody(goodBody, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A provider on a DIFFERENT engine is refused by the VERIFIER — no replay
    // needed — because its receipt signs the engine it actually served with.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-b"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [other.url],
      quorum: 1,
      operators: { [other.url]: operatorB },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const badBody = new RunLedger(join(reg.root, "gateway-b")).records()[0]!.body;
    assert.equal(badBody.engine.fingerprint, engineA, "the run records the committed engine");
    assert.equal((badBody.quorum!.providers[0]!.receipt as { engine: string }).engine, engineB);
    const verdict = verifyRunBody(badBody, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a provider's receipt binds the bundle it served, so a verifier catches other weights", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    // Two DIFFERENT bundles with the same model id.
    const bundleA = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    const bundleB = buildModelBundle({
      // A valid xorshift model with DIFFERENT parameters: same model id, other weights.
      bytes: Buffer.from(JSON.stringify({ ...NATIVE_MODEL, params: { a: 5, b: 13, c: 17 } })),
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    assert.notEqual(bundleA.bundle.digest, bundleB.bundle.digest);
    const manifestA = (await uploadBundle({ registry: reg.base, bundle: bundleA.bundle, chunks: bundleA.chunks })).manifestHash;
    await uploadBundle({ registry: reg.base, bundle: bundleB.bundle, chunks: bundleB.chunks });

    first = await startProvider({ bundle: bundleA.bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    other = await startProvider({ bundle: bundleB.bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0 });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: other.url });
    const operatorA = cardA.provider.keyId!;
    const operatorB = cardB.provider.keyId!;

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundleA.bundle.digest,
          shardsRoot: bundleA.bundle.shardsRoot,
          manifestHash: manifestA,
          providers: `${first.url},${other.url}`,
          operators: `${operatorA},${operatorB}`,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "which weights?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 4,
        }),
      });

    // The provider serving the committed bundle verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-a"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url],
      quorum: 1,
      operators: { [first.url]: operatorA },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const goodBody = new RunLedger(join(reg.root, "gateway-a")).records()[0]!.body;
    assert.equal(goodBody.bundle!.digest, bundleA.bundle.digest);
    assert.equal((goodBody.quorum!.providers[0]!.receipt as { bundle: string }).bundle, bundleA.bundle.digest);
    assert.equal(verifyRunBody(goodBody, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A provider serving OTHER weights is refused by the VERIFIER: the receipt
    // signs the bundle it actually served, which is not the committed one.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-b"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [other.url],
      quorum: 1,
      operators: { [other.url]: operatorB },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const badBody = new RunLedger(join(reg.root, "gateway-b")).records()[0]!.body;
    assert.equal(badBody.bundle!.digest, bundleA.bundle.digest, "the run records the committed bundle");
    assert.equal((badBody.quorum!.providers[0]!.receipt as { bundle: string }).bundle, bundleB.bundle.digest);
    const verdict = verifyRunBody(badBody, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a provider falls back to a mirror when the primary registry cannot serve", async () => {
  const primary = await registry();
  const mirror = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    // The same content-addressed bundle is mirrored to both registries.
    await uploadBundle({ registry: primary.base, bundle, chunks });
    await uploadBundle({ registry: mirror.base, bundle, chunks });

    // Break every shard on the primary: it now serves bytes that do not match.
    for (const shard of bundle.shards) {
      writeFileSync(join(primary.root, "blobs", shard.hash), Buffer.from("corrupt"));
    }

    // With only the primary, the provider refuses to start.
    await assert.rejects(
      startProvider({ bundle, registry: primary.base, stateDir: join(primary.root, "solo"), port: 0 }),
      /from every registry/,
    );

    // With the mirror, it fetches the committed bytes and serves the model.
    provider = await startProvider({
      bundle,
      registry: primary.base,
      mirrors: [mirror.base],
      stateDir: join(primary.root, "mirror"),
      port: 0,
    });
    assert.deepEqual(provider.modelBytes, NATIVE_BYTES);
    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "mirror?" }],
        max_tokens: 8,
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.ok(body.choices[0]!.message.content.length > 0);
  } finally {
    if (provider !== null) await provider.close();
    await mirror.close();
    await primary.close();
  }
});

test("a machine-independent deployment needs distinct machines, or it is invalid", () => {
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromNetwork("https://provider.example"),
      placement: "web4",
      labels: {
        execution: "web4",
        bundle: "a".repeat(64),
        shardsRoot: "b".repeat(64),
        manifestHash: "c".repeat(64),
        providers: "https://p1.example,https://p2.example",
        operators: "op-1,op-2",
        machines: "machine-a,machine-a",
        independence: "machine",
        quorum: "2",
      },
    }),
  );
  assert.ok(
    validateDeployment(deployment).some((error) => error.includes("quorum distinct machines")),
    "two operators on one machine cannot satisfy a machine-independent quorum",
  );
});

test("a disagreeing provider blocks the run instead of averaging it away", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    // A fetch seam that lets the second provider answer with a different body,
    // exactly as a lying operator would.
    const disagreeing: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).startsWith(second!.url)) return response;
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      body.choices[0]!.message.content = "a different answer";
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      fetchImpl: disagreeing,
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "same question" }],
        max_tokens: 8,
      }),
    });
    assert.equal(response.status, 503);
    const refused = (await response.json()) as { error: string; evidence: { answered: unknown[] } };
    assert.match(refused.error, /quorum not met/);
    assert.equal(refused.evidence.answered.length, 2);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a deterministic-replay deployment records an independent witness that matches token-for-token", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "first"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "second"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });
    const operatorA = card.provider.keyId!;

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash: card.bundle.manifestHash,
          providers: first.url,
          operators: operatorA,
          trace: "required",
          replay: "required",
          determinism: "deterministic-replay",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.determinism, "deterministic-replay");
    assert.equal(spec.requireTrace, true);
    assert.equal(spec.requireReplay, true);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      witnesses: [second.url],
      operators: { [first.url]: operatorA },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "reproduce the arithmetic" }],
        max_tokens: 8,
        temperature: 0,
        seed: 4242,
      }),
    });
    assert.equal(response.status, 200);

    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const claim = body.determinism;
    assert.ok(claim, "the run carries a determinism claim");
    assert.equal(claim!.class, "deterministic-replay");
    assert.equal(
      claim!.witness.provider.endpoint.replace(/\/+$/, ""),
      second.url.replace(/\/+$/, ""),
      "the witness is the independent provider, not the run's own",
    );

    // The run's trace and the witness's trace are the same tokens.
    const runTrace = (body.response.body as Record<string, unknown>).rarext_trace as {
      kind: string;
      tokens: unknown[];
    };
    const witnessTrace = (claim!.witness.response as Record<string, unknown>).rarext_trace as {
      kind: string;
      tokens: unknown[];
    };
    assert.equal(witnessTrace.kind, runTrace.kind);
    assert.deepEqual(witnessTrace.tokens, runTrace.tokens);

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("determinism.replayWitness"));

    // Removing the claim leaves the committed class unbacked.
    const missing = verifyRunBody({ ...body, determinism: undefined }, spec);
    assert.equal(missing.correct, false);
    assert.match(missing.error ?? "", /determinism\.replayWitness/);

    // A witness that is one of the run's own providers is not independent.
    const notIndependent = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: {
            ...claim!.witness,
            provider: { ...claim!.witness.provider, endpoint: first.url },
          },
        },
      },
      spec,
    );
    assert.equal(notIndependent.correct, false);
    assert.match(notIndependent.error ?? "", /determinism\.replayWitness/);

    // A witness for a different request corroborates nothing.
    const otherRequest = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: { ...claim!.witness, request: { model: "someone-else" } },
        },
      },
      spec,
    );
    assert.equal(otherRequest.correct, false);

    // A witness response whose trace diverges breaks both the trace match and
    // the provider receipt that binds it.
    const tamperedTrace = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: {
            ...claim!.witness,
            response: {
              ...(claim!.witness.response as Record<string, unknown>),
              rarext_trace: {
                ...(witnessTrace as unknown as Record<string, unknown>),
                tokens: [987654321],
              },
            },
          },
        },
      },
      spec,
    );
    assert.equal(tamperedTrace.correct, false);

    // A witness receipt with a bad signature is refused.
    const badSignature = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: {
            ...claim!.witness,
            receipt: {
              ...(claim!.witness.receipt as Record<string, unknown>),
              signature: "A".repeat(88),
            },
          },
        },
      },
      spec,
    );
    assert.equal(badSignature.correct, false);

    // A challenge that commits the class without a trace/replay requirement is
    // itself invalid: there is nothing to compare or reproduce. The challenge
    // parser refuses it rather than letting a run satisfy it vacuously.
    const malformed = challengeFor(deployment);
    const malformedSpec = malformed.spec as Record<string, unknown>;
    delete malformedSpec.requireTrace;
    delete malformedSpec.requireReplay;
    assert.throws(
      () => runSpecFromChallenge(malformed),
      /requireTrace and challenge\.spec\.requireReplay/,
    );

    // A run may not claim a class the challenge never committed.
    const looseSpec = { ...spec, determinism: undefined, requireTrace: undefined, requireReplay: undefined };
    const uncommitted = verifyRunBody(body, looseSpec);
    assert.equal(uncommitted.correct, false);
    assert.match(uncommitted.error ?? "", /determinism\.replayWitness/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("the gateway refuses a deterministic-replay run without an independent witness", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "first"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "second"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash: card.bundle.manifestHash,
          trace: "required",
          replay: "required",
          determinism: "deterministic-replay",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "reproduce?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 7,
        }),
      });

    // No witness provider configured at all: the gateway refuses rather than
    // record a claim it cannot back.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-none"),
      port: 0,
      upstreamApi: "openai",
    });
    const none = await ask(gateway.url);
    assert.equal(none.status, 503);
    assert.match(((await none.json()) as { error: string }).error, /no independent witness provider/);
    assert.equal(new RunLedger(join(reg.root, "gateway-none")).records().length, 0);
    await gateway.close();
    gateway = null;

    // A witness that is one of the run's own providers is not a witness.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-self"),
      port: 0,
      upstreamApi: "openai",
      witnesses: [first.url, second.url],
    });
    const self = await ask(gateway.url);
    assert.equal(self.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-self")).records()[0]!.body;
    assert.equal(
      body.determinism!.witness.provider.endpoint.replace(/\/+$/, ""),
      second.url.replace(/\/+$/, ""),
      "the gateway skips its own provider and uses the independent one",
    );
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("the engine itself is a RAREXT artifact a provider fetches, verifies, and runs", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });

    // A tiny engine module: deterministic, and its output is NOT the built-in
    // engine's, so the test can tell which engine actually ran.
    const source = Buffer.from(
      [
        "module.exports.run = function (model, input) {",
        "  var seed = (input.seed == null ? 7 : input.seed) >>> 0;",
        "  var steps = Math.max(1, Math.min(input.steps || 4, 4));",
        "  var tokens = [];",
        "  for (var i = 0; i < steps; i++) { seed = (seed * 1103515245 + 12345) >>> 0; tokens.push(seed % model.vocab.length); }",
        "  return { text: tokens.map(function (t) { return model.vocab[t]; }).join(''), seed: seed, steps: steps, tokens: tokens };",
        "};",
      ].join("\n"),
    );
    const { bundle: engineBundle, chunks } = buildEngineBundle({
      source,
      name: "rarext-test-engine",
      engineVersion: "1",
      chunkBytes: 24,
    });
    assert.deepEqual(verifyEngineBundle(engineBundle), []);
    assert.ok(engineBundle.shards.length > 1, "the engine artifact is sharded");
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks });

    // The provider fetches every engine shard from RAREXT, verifies the digest,
    // and runs the FETCHED engine.
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
      engineBundle,
    });
    const health = (await (await fetch(`${provider.url}/health`)).json()) as {
      engineFingerprint: string;
    };
    assert.equal(
      health.engineFingerprint,
      engineDescriptorFingerprint({
        name: "rarext-test-engine",
        version: "1",
        digest: engineBundle.artifactDigest,
      }),
      "the engine-bundle digest is folded into the engine fingerprint",
    );

    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "engine from RAREXT" }],
        max_tokens: 4,
        temperature: 0,
        seed: 5,
      }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { rarext_trace?: { tokens: number[] } };
    // Recompute the FETCHED engine's tokens for seed 5 independently; the
    // built-in engine would give a different sequence.
    const vocab = (JSON.parse(NATIVE_BYTES.toString("utf8")) as { vocab: string[] }).vocab;
    const expected: number[] = [];
    let seed = 5 >>> 0;
    for (let index = 0; index < 4; index += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      expected.push(seed % vocab.length);
    }
    assert.deepEqual(json.rarext_trace?.tokens, expected, "the served trace is the fetched engine's");

    // A tampered engine artifact — a committed digest that does not match the
    // reassembled bytes — is refused before the provider can serve it.
    const tampered = { ...engineBundle, artifactDigest: `sha256:${"0".repeat(64)}` };
    const { digest: _digest, ...covered } = tampered;
    const reDigested = { ...tampered, digest: canonicalDigest(covered) };
    await assert.rejects(
      () => fetchEngineArtifact({ registries: [reg.base], bundle: reDigested }),
      /engine artifact digest .* does not match the committed/,
    );
    // A module that is not an engine is refused by the loader.
    assert.throws(() => loadEngine(Buffer.from("module.exports = {};")), /exports no run/);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});
