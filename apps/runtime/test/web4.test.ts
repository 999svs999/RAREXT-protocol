import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
import { createVerifierServer, runSpecFromChallenge, verifierConfig } from "../src/verifier.ts";
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
    // and the transcript carries all three, including the dissent.
    const dissenting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).startsWith(endpoints[2]!)) return response;
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
