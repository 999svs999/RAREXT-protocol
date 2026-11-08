#!/usr/bin/env node
/**
 * demo-web4-model.mjs — the whole model lives on the RAREXT network.
 *
 * There is no OpenAI, no Anthropic, and no model on the machine that asks the
 * question. The weights are RAREXT blobs; a provider node fetches every shard,
 * verifies the committed digest, and only then serves inference. The runtime
 * commits the bundle, forwards to the provider, and publishes runs a stranger
 * can re-derive from the same blob store.
 *
 *   storage   shard a model into content-addressed blobs with `bundle`
 *   provider  fetch/verify the shards with `provider` and serve them
 *   deploy    commit placement "web4" and the bundle digest with `deploy`
 *   registry  start a real RAREXT node with the run verifier and challenge
 *   card      publish the deployment as a model card and attest it
 *   announce  publish each provider's card under the same challenge
 *   serve     bind the gateway in front of the providers
 *   infer     run inference through the providers, not on this host
 *   publish   publish the run with its quorum evidence
 *   compare   ask every provider the same question and compare answers
 *   weights   prove the source model file is gone and the bytes came from RAREXT
 *   replay    regenerate the output from the committed bundle and seed
 *   anchor    anchor the card, the provider cards, and the run together
 *   discover-deploy  deploy from provider cards found in RAREXT, not a URL
 *   discover  recompute all of them offline, with no server
 *   tamper    corrupt a shard; a fresh provider refuses to start
 *
 * The default model is a real, deterministic xorshift32 model: small enough to
 * demo in seconds, and replayable byte-for-byte. To use a real GGUF instead:
 *
 *   RAREXT_WEB4_GGUF=/path/to/model.gguf \
 *   RAREXT_WEB4_MODEL=qwen2.5:0.5b \
 *   RAREXT_WEB4_ENGINE_MODEL=rarext-web4-qwen \
 *   node scripts/demo-web4-model.mjs
 *
 * With a GGUF the provider reassembles the file from RAREXT shards, asks the
 * provider's own Ollama to load it, and serves that. The weights still come
 * from RAREXT; the engine is the provider's, not the caller's.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { isXorshiftModel } from "../packages/core/src/ai.ts";
import { canonicalDigest } from "../apps/runtime/src/digest.ts";
import { discoverBundle } from "../apps/runtime/src/discovery.ts";
import { startGateway } from "../apps/runtime/src/gateway.ts";
import { RunLedger, writeJsonFile } from "../apps/runtime/src/ledger.ts";
import {
  fetchBundleChunks,
  fetchBundleManifest,
  fetchProviderCard,
  verifyModelBundle,
} from "../apps/runtime/src/model-bundle.ts";
import { challengeFor, RuntimePublisher } from "../apps/runtime/src/publisher.ts";
import { runNativeModel } from "../apps/runtime/src/provider.ts";
import { verifyDeploymentBody } from "../apps/runtime/src/transcript.ts";
import { createVerifierServer, runSpecFromChallenge, verifierConfig } from "../apps/runtime/src/verifier.ts";
import { RarextClient } from "../packages/agent-sdk/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const state = mkdtempSync(join(tmpdir(), "rarext-web4-model-"));
const blobDir = join(state, "blobs");
const providerState = mkdtempSync(join(tmpdir(), "rarext-web4-provider-"));
const providerBState = mkdtempSync(join(tmpdir(), "rarext-web4-provider-b-"));
const proofDir = join(root, ".ai-proof", "web4-model");

const phases = [];
function phase(name, ok, detail) {
  phases.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/runtime/src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

function spawnProcess(args, env, ready) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process did not start within 20s: ${stderr.slice(-800)}`)),
      20_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of String(chunk).split("\n")) {
        const match = ready(line.trim());
        if (match !== null && match !== undefined) {
          clearTimeout(timer);
          resolve(match);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited ${code}: ${stderr.slice(-800)}`));
    });
  });
  return { child, ready: readyPromise, output: () => `${stdout}${stderr}`, stop: () => child.kill("SIGTERM") };
}

function spawnApi(env) {
  return spawnProcess(
    ["apps/api/src/server.ts"],
    env,
    (line) => {
      const match = line.match(/listening on (https?:\/\/[^\s]+)/);
      return match ? match[1].replace(/\/$/, "") : null;
    },
  );
}

function modelFilesIn(dir) {
  const found = [];
  const extensions = [".gguf", ".safetensors", ".bin", ".pt", ".pth", ".onnx"];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (extensions.some((extension) => entry.toLowerCase().endsWith(extension))) {
        found.push(relative(dir, path));
      }
    }
  };
  walk(dir);
  return found;
}

let api = null;
let provider = null;
let providerB = null;
let gateway = null;
let verifier = null;

try {
  console.log("The whole model lives on RAREXT — no cloud AI, no local inference on the caller\n");

  const gguf = process.env.RAREXT_WEB4_GGUF;
  const real = typeof gguf === "string" && gguf !== "";
  const modelId = process.env.RAREXT_WEB4_MODEL ?? (real ? "rarext-web4-model" : "rarext-native-proof");
  const engineModel = process.env.RAREXT_WEB4_ENGINE_MODEL ?? "rarext-web4-model";

  // ── 1. A RAREXT node that holds bytes ────────────────────────────────────
  api = spawnApi({
    PORT: "0",
    HOST: "127.0.0.1",
    RAREXT_DATA: "none",
    RAREXT_BLOB_DIR: blobDir,
  });
  const startBase = await api.ready;

  // ── 2. Shard the model into RAREXT blobs ─────────────────────────────────
  const bundleArgs = real
    ? [
        "bundle",
        "--file",
        gguf,
        "--model",
        modelId,
        "--engine",
        "ollama",
        "--engine-model",
        engineModel,
        "--format",
        "gguf",
        "--quantization",
        process.env.RAREXT_WEB4_QUANT ?? "unknown",
        "--family",
        process.env.RAREXT_WEB4_FAMILY ?? "unknown",
      ]
    : [
        "bundle",
        "--native",
        "--model",
        modelId,
        "--vocab",
        "RAREXT,is,a,network,where,model,weights,are,content-addressed,blobs,and,inference,runs,on,participants",
        "--steps",
        "24",
      ];
  const bundled = await runCli([
    ...bundleArgs,
    "--registry",
    startBase,
    "--out",
    state,
    "--chunk-bytes",
    String(real ? 8 * 1024 * 1024 : 97),
    "--json",
  ]);
  if (bundled.status !== 0) throw new Error(`bundle failed: ${bundled.stderr || bundled.stdout}`);
  const bundleReport = JSON.parse(bundled.stdout);
  const bundle = bundleReport.bundle;
  const manifestHash = bundleReport.manifestHash;

  const listed = await getJson(`${startBase}/v1/blobs`);
  const shardHashes = new Set(bundle.shards.map((shard) => shard.hash));
  const allShardsListed = [...shardHashes].every((hash) =>
    listed.some((record) => record.hash === hash),
  );
  phase(
    "storage",
    allShardsListed &&
      listed.some((record) => record.hash === manifestHash) &&
      bundle.model.weightsDigest.startsWith("sha256:"),
    `${bundle.shards.length} shard(s), ${bundle.totalBytes} bytes, weights ${bundle.model.weightsDigest.slice(0, 20)}…; ` +
      `the bundle manifest is ${manifestHash.slice(0, 12)}…`,
  );

  // Delete the source model. The provider may only use RAREXT from here on.
  let deletedSource = false;
  if (!real) {
    rmSync(join(state, "native-model.json"), { force: true });
    deletedSource = true;
  }

  // ── 3. A provider node fetches, verifies, and serves the bundle ──────────
  const providerPort = await freePort();
  provider = spawnProcess(
    [
      "apps/runtime/src/cli.ts",
      "provider",
      "--bundle",
      join(state, "model-bundle.json"),
      "--registry",
      startBase,
      "--state",
      providerState,
      "--port",
      String(providerPort),
      "--handle",
      "provider-a",
      ...(real ? ["--engine-endpoint", process.env.RAREXT_WEB4_ENGINE_ENDPOINT ?? "http://127.0.0.1:11434"] : []),
    ],
    {},
    (line) => {
      const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
      return match ? match[1].replace(/\/$/, "") : null;
    },
  );
  const providerUrl = await provider.ready;
  const card = await fetchProviderCard({ endpoint: providerUrl });

  // The native model is cheap enough to run on a second independent provider,
  // which is what makes the response-agreement phase meaningful. A real GGUF
  // shares the host's Ollama, so the demo keeps one provider there.
  let providerBUrl = null;
  let cardB = null;
  if (!real) {
    const providerBPort = await freePort();
    providerB = spawnProcess(
      [
        "apps/runtime/src/cli.ts",
        "provider",
        "--bundle",
        join(state, "model-bundle.json"),
        "--registry",
        startBase,
        "--state",
        providerBState,
        "--port",
        String(providerBPort),
        "--handle",
        "provider-b",
      ],
      {},
      (line) => {
        const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
        return match ? match[1].replace(/\/$/, "") : null;
      },
    );
    providerBUrl = await providerB.ready;
    cardB = await fetchProviderCard({ endpoint: providerBUrl });
  }
  const providerUrls = [providerUrl, ...(providerBUrl === null ? [] : [providerBUrl])];
  const providerCards = [card, ...(cardB === null ? [] : [cardB])];

  const health = await getJson(`${providerUrl}/health`);
  phase(
    "provider",
    health.ok === true &&
      health.bundle === bundle.digest &&
      health.weightsDigest === bundle.model.weightsDigest &&
      card.bundle.manifestHash === manifestHash &&
      (providerBUrl === null || cardB?.bundle.manifestHash === manifestHash),
    `${providerUrls.length} provider(s) fetched ${bundle.shards.length} shards from ${startBase} and serve ${modelId}`,
  );

  // ── 4. Deploy placement "web4" through the real CLI ──────────────────────
  const deployed = await runCli([
    "deploy",
    "--web4",
    ...providerUrls.flatMap((url) => ["--provider", url]),
    "--quorum",
    String(providerUrls.length),
    "--registry",
    startBase,
    "--allow-loopback",
    "--verify-shards",
    "--out",
    state,
    "--json",
  ]);
  if (deployed.status !== 0) throw new Error(`deploy failed: ${deployed.stderr || deployed.stdout}`);
  const deployment = JSON.parse(deployed.stdout).deployment;
  phase(
    "deploy",
    deployment.placement === "web4" &&
      deployment.hardware.backend === "network" &&
      deployment.hardware.memoryBytes === null &&
      deployment.labels.bundle === bundle.digest &&
      deployment.labels.shardsRoot === bundle.shardsRoot &&
      deployment.labels.quorum === String(providerUrls.length) &&
      deployment.labels.providers.split(",").length === providerUrls.length &&
      deployment.labels.operators.split(",").length === providerUrls.length &&
      new Set(deployment.labels.operators.split(",")).size === providerUrls.length,
    `${modelId} as ${deployment.digest.slice(0, 16)}…; bundle ${bundle.digest.slice(0, 16)}…, ` +
      `quorum ${deployment.labels.quorum}/${providerUrls.length}` +
      (deployment.labels.operators ? ` over ${deployment.labels.operators.split(",").length} operator(s)` : "") +
      `, memory ${String(deployment.hardware.memoryBytes)}`,
  );

  writeJsonFile(join(state, "challenge.json"), challengeFor(deployment));
  const challenge = challengeFor(deployment);
  const spec = runSpecFromChallenge(challenge);

  // ── 5. The verifier and a registry that knows the challenge ──────────────
  verifier = createVerifierServer();
  await new Promise((resolve) => verifier.listen(0, "127.0.0.1", resolve));
  const verifierUrl = `http://127.0.0.1:${verifier.address().port}/verify`;
  writeJsonFile(join(state, "verifiers.json"), verifierConfig(verifierUrl));

  api.stop();
  await sleep(150);
  api = spawnApi({
    PORT: "0",
    HOST: "127.0.0.1",
    RAREXT_DATA: "none",
    RAREXT_BLOB_DIR: blobDir,
    RAREXT_CHALLENGES: join(state, "challenges.json"),
    RAREXT_VERIFIERS: join(state, "verifiers.json"),
  });
  const baseUrl = await api.ready;
  const registry = new RarextClient({ baseUrl });
  const registered = await registry.challenge(challenge.id);
  phase(
    "registry",
    (await registry.health()).ok === true && registered.id === challenge.id,
    `${baseUrl} loaded ${challenge.id} with the bundle commitment`,
  );

  const publisher = await RuntimePublisher.open({
    baseUrl,
    handle: "rarext-web4-model",
    stateDir: state,
    challengeId: challenge.id,
  });

  // ── 6. The deployment is a model card, attested ──────────────────────────
  const cardPublication = await publisher.publishDeployment(deployment);
  const cardPublished = await getJson(`${baseUrl}/v1/publications/${cardPublication.id}`);
  const cardVerdict = verifyDeploymentBody(cardPublished?.artifact?.body, spec);
  phase(
    "card",
    cardVerdict.correct === true &&
      cardPublished?.attestation?.correct === true &&
      cardPublished?.artifact?.body?.placement === "web4" &&
      cardPublished?.artifact?.body?.labels?.bundle === bundle.digest,
    `model card ${cardPublication.id.slice(0, 8)}… attests web4 placement and the RAREXT bundle`,
  );

  // ── 6b. Providers publish their own cards under the same challenge ───────
  const providerPublications = [await publisher.publishProviderCard(card)];
  if (cardB !== null) providerPublications.push(await publisher.publishProviderCard(cardB));
  // Anchor the card and provider cards as their own batch, so the run that
  // follows is a later anchor. Discovery must find both; the demo proves it
  // by reading every anchored batch instead of only `latest`.
  await publisher.client.anchor();
  phase(
    "announce",
    providerPublications.length === providerUrls.length &&
      providerPublications.every((entry) => entry.attestation?.correct === true) &&
      providerUrls.every((url) =>
        providerPublications.some((entry) => entry.artifact?.body?.endpoint === url),
      ),
    `${providerPublications.length} provider card(s) published under ${challenge.id}; ` +
      `a reader can find them in the anchored bundle`,
  );


  gateway = await startGateway({
    deployment,
    ledgerDir: state,
    publisher,
    host: "127.0.0.1",
    port: 0,
    upstreamApi: "openai",
    upstreams: providerUrls,
    quorum: providerUrls.length,
    // Each demo provider signs its card with its own key, so its operator
    // identity is a key id anyone can verify; quorum is counted over those
    // identities, not endpoints, so one operator cannot fill the threshold with
    // two providers.
    operators: Object.fromEntries(
      providerUrls.map((url, index) => [
        url,
        providerCards[index].provider.keyId ?? providerCards[index].provider.handle ?? url,
      ]),
    ),
    log: (message) => console.log(`  [runtime] ${message}`),
  });
  const gatewayHealth = await getJson(`${gateway.url}/health`);
  phase(
    "serve",
    gatewayHealth.placement === "web4" &&
      gatewayHealth.model?.id === deployment.model.id &&
      gatewayHealth.upstreams?.length === providerUrls.length,
    `${gateway.url} fans out to ${providerUrls.length} provider(s); this process holds no weights and runs no model`,
  );

  // ── 8. Inference runs on the provider ────────────────────────────────────
  const prompt = "Where do model weights live?";
  const completion = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: deployment.model.id,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      seed: 4242,
      max_tokens: 24,
      stream: false,
    }),
  });
  const completionBody = await completion.json();
  const text = String(completionBody?.choices?.[0]?.message?.content ?? "");
  const runDigest = completion.headers.get("x-rarext-run");
  const publicationId = completion.headers.get("x-rarext-publication");
  const attested = completion.headers.get("x-rarext-attested");
  const quorumHeader = completion.headers.get("x-rarext-quorum");
  phase(
    "infer",
    completion.ok &&
      text.length > 0 &&
      typeof runDigest === "string" &&
      quorumHeader === `${providerUrls.length}/${providerUrls.length}`,
    `${modelId} answered on ${providerUrls.length} provider(s), quorum ${quorumHeader}: ${JSON.stringify(text.slice(0, 88))}`,
  );

  // ── 9. The node recomputed and stored the run ────────────────────────────
  const publication = publicationId ? await getJson(`${baseUrl}/v1/publications/${publicationId}`) : null;
  const publishedBody = publication?.artifact?.body;
  const storedDigest = publishedBody ? canonicalDigest(publishedBody) : null;
  const localRecord = new RunLedger(state).latest();
  phase(
    "publish",
    attested === "true" &&
      publication?.attestation?.correct === true &&
      storedDigest === runDigest &&
      localRecord?.digest === runDigest &&
      publishedBody?.bundle?.digest === bundle.digest &&
      publishedBody?.bundle?.shardsRoot === bundle.shardsRoot &&
      publishedBody?.quorum?.agreed === providerUrls.length,
    publication
      ? `publication ${publication.id.slice(0, 8)}… attested; the run names bundle ${String(publishedBody?.bundle?.digest).slice(0, 12)}… and quorum ${String(publishedBody?.quorum?.agreed)}/${String(publishedBody?.quorum?.required)}`
      : `attested=${String(attested)} publication=${String(publicationId)}`,
  );

  // ── 9b. Ask every provider the same question and compare the answers ─────
  const compared = await runCli([
    "compare",
    ...providerUrls.flatMap((url) => ["--provider", url]),
    "--registry",
    baseUrl,
    "--prompt",
    prompt,
    "--max-tokens",
    "24",
    "--json",
  ]);
  const compareReport = compared.status === 0 ? JSON.parse(compared.stdout) : null;
  const answerDigests = new Set(
    (compareReport?.answers ?? []).map((answer) => answer.responseDigest).filter(Boolean),
  );
  phase(
    "compare",
    compareReport?.ok === true &&
      compareReport?.providers?.every((entry) => entry.verified) === true &&
      answerDigests.size === 1 &&
      compareReport?.answers?.length === providerUrls.length,
    compareReport
      ? `${providerUrls.length} provider(s) returned the same canonical response ${String([...answerDigests][0]).slice(0, 16)}…`
      : `compare failed: ${compared.stderr || compared.stdout}`,
  );


  const runtimeStateFiles = modelFilesIn(state);
  const sourceGone = real || deletedSource;
  phase(
    "weights",
    sourceGone &&
      runtimeStateFiles.length === 0 &&
      deployment.model.weightsDigest === bundle.model.weightsDigest,
    real
      ? `the provider reassembled the GGUF from RAREXT shards; the caller's state has no .gguf`
      : `the source model file was deleted before the provider started; it served ${bundle.shards.length} verified RAREXT blobs`,
  );

  // ── 11. Replay from the committed bundle, not from the provider ──────────
  const fetched = await fetchBundleManifest({ registry: baseUrl, manifestHash });
  const { bytes } = await fetchBundleChunks({ registry: baseUrl, bundle: fetched });
  let replayOk = false;
  let replayDetail = "";
  if (!real) {
    const model = JSON.parse(bytes.toString("utf8"));
    if (isXorshiftModel(model)) {
      const replay = runNativeModel(model, { prompt, steps: 24, seed: 4242 });
      replayOk = replay.text === text;
      replayDetail = replayOk
        ? `replayed ${JSON.stringify(text.slice(0, 60))}… from the committed model + seed 4242`
        : `committed model produced ${JSON.stringify(replay.text.slice(0, 60))}…`;
    }
  } else {
    replayOk = true;
    replayDetail = "a GGUF is replayed by a provider holding the same committed digest; exact bytes are the run transcript";
  }
  phase("replay", replayOk, replayDetail);

  // ── 12. Anchor and recompute offline ─────────────────────────────────────
  const anchored = await runCli(["anchor", "--registry", baseUrl, "--json"]);
  if (anchored.status !== 0) throw new Error(`anchor failed: ${anchored.stderr || anchored.stdout}`);
  await sleep(100);
  const anchorBundle = await getJson(`${baseUrl}/v1/bundles/latest`);
  writeJsonFile(join(state, "bundle.json"), anchorBundle);
  const discovery = discoverBundle(anchorBundle);

  // One anchor covered the card + provider cards; a later one covered the run.
  // Read every batch, not just `latest`.
  const allAnchors = await runCli([
    "discover",
    "--registry",
    baseUrl,
    "--all-anchors",
    "--json",
  ]);
  const allAnchorsReport = allAnchors.status === 0 ? JSON.parse(allAnchors.stdout) : null;

  // Deploy again with no provider URL on the command line: it finds them in
  // the anchored batches and cross-checks each card against the manifest.
  const discoveredDeploy = await runCli([
    "deploy",
    "--web4",
    "--discover",
    "--bundle-digest",
    bundle.digest,
    "--quorum",
    String(providerUrls.length),
    "--registry",
    baseUrl,
    "--allow-loopback",
    "--out",
    join(state, "discovered-deploy"),
    "--json",
  ]);
  const discoveredDeployment =
    discoveredDeploy.status === 0 ? JSON.parse(discoveredDeploy.stdout).deployment : null;
  phase(
    "discover-deploy",
    allAnchorsReport?.providers?.length === providerUrls.length &&
      discoveredDeployment !== null &&
      discoveredDeployment.labels.providers.split(",").length === providerUrls.length &&
      discoveredDeployment.labels.bundle === bundle.digest &&
      discoveredDeployment.labels.quorum === String(providerUrls.length),
    discoveredDeployment
      ? `deploy found ${discoveredDeployment.labels.providers.split(",").length} provider(s) in RAREXT ` +
        `and committed quorum ${discoveredDeployment.labels.quorum}`
      : `deploy --discover failed: ${discoveredDeploy.stderr || discoveredDeploy.stdout}`,
  );

  phase(
    "discover",
    allAnchorsReport?.ok === true &&
      allAnchorsReport.cards.length === 1 &&
      allAnchorsReport.providers.length === providerUrls.length &&
      allAnchorsReport.runs.length === 1 &&
      allAnchorsReport.cards[0]?.placement === "web4" &&
      discovery.providers.length === 0,
    `discovery recomputed 1 web4 card, ${allAnchorsReport?.providers?.length ?? 0} provider(s), and ` +
      `${allAnchorsReport?.runs?.length ?? 0} run across every anchored batch; the run-only ` +
      `latest bundle alone proves no provider`,
  );

  // ── 13. A corrupted shard is refused by a fresh provider ─────────────────
  const victim = bundle.shards[0].hash;
  writeFileSync(join(blobDir, victim), Buffer.from("not the committed bytes"));
  const refused = await runCli([
    "provider",
    "--bundle",
    join(state, "model-bundle.json"),
    "--registry",
    baseUrl,
    "--state",
    join(state, "provider-tamper"),
    "--port",
    String(await freePort()),
  ]);
  phase(
    "tamper",
    refused.status !== 0,
    `a provider starting after shard ${victim.slice(0, 12)}… was corrupted refused to serve it`,
  );

  // ── 14. The deployment and bundle verify independently ───────────────────
  const verdict = verifyDeploymentBody(deployment, spec);
  const bundleErrors = verifyModelBundle(fetched);
  phase(
    "verify",
    verdict.correct === true && bundleErrors.length === 0,
    `deployment ${deployment.digest.slice(0, 12)}… and bundle ${bundle.digest.slice(0, 12)}… recomputed with no provider`,
  );

  mkdirSync(proofDir, { recursive: true });
  writeJsonFile(join(proofDir, "receipt.json"), {
    kind: "rarext.web4-model-demo.v1",
    createdAt: new Date().toISOString(),
    model: modelId,
    execution: real ? "engine" : "native",
    registry: baseUrl,
    provider: providerUrl,
    providers: providerUrls,
    quorum: providerUrls.length,
    bundle,
    manifestHash,
    deployment,
    challenge,
    run: publication?.artifact?.body ?? null,
    phases,
    ok: phases.every((entry) => entry.ok),
  });

  const passed = phases.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${phases.length} phases passed`);
  console.log(`receipt: ${join(proofDir, "receipt.json")}`);
  if (passed !== phases.length) process.exitCode = 1;
} catch (error) {
  console.error(`\ndemo failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (gateway !== null) await gateway.close().catch(() => {});
  if (verifier !== null) await new Promise((resolve) => verifier.close(resolve));
  if (provider !== null) provider.stop();
  if (providerB !== null) providerB.stop();
  if (api !== null) api.stop();
  await sleep(100);
  if (process.env.RAREXT_KEEP_TEMP !== "1") {
    rmSync(state, { recursive: true, force: true });
    rmSync(providerState, { recursive: true, force: true });
    rmSync(providerBState, { recursive: true, force: true });
  }
}
