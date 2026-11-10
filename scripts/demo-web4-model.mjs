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
 *   sealed    (RAREXT_WEB4_SEAL=1) store ciphertext the store never opens
 *   provider  fetch/verify the shards with `provider` and serve them
 *   deploy    commit placement "web4" and the bundle digest with `deploy`
 *   registry  start a real RAREXT node with the run verifier and challenge
 *   card      publish the deployment as a model card and attest it
 *   announce  publish each provider's card under the same challenge
 *   serve     bind the gateway in front of the providers
 *   infer     run inference through the providers, not on this host
 *   publish   publish the run with its quorum evidence
 *   receipt   each provider signs what it said; the gateway cannot fabricate it
 *   trace     a required decode trace: a run without one is refused
 *   deterministic  a required replayable run: a sampled request is refused
 *   determinism  a claimed engine arithmetic: an independent witness must match
 *   engine    the engine itself is a RAREXT artifact the provider fetches/verifies
 *   pay       pay each agreeing operator and prove it against the ledger root
 *   settle    the node records the payments, and a key moves credits to another
 *   redeem    a key cashes credits out of the ledger against an external reference
 *   measure   a deployment approves provider measurements, or is refused
 *   quote     a provider's machine claim is vendor-signed and checked against a pin
 *   isolation a deployment demands vendor-certified host-root-excluded memory
 *   engine-pin  the run pins the serving engine; a replay refuses a changed one
 *   mirror    a provider serves from a mirror when its primary registry is down
 *   enclave   the serving process holds ciphertext; an enclave unwraps and answers
 *             a sealed prompt (the forwarder never sees the plaintext)
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
 * To store the weights as ciphertext the RAREXT node never opens:
 *
 *   RAREXT_WEB4_SEAL=1 node scripts/demo-web4-model.mjs
 *
 * Sealing works for a native model and for a GGUF. The engine path opens the
 * sealed bytes into a mode-0600 file under the OS temp dir, lets the engine load
 * it, and removes it — never the provider's state dir, never a cached artifact.
 *
 * By default a GGUF is served by the provider's own Ollama (interop). To remove
 * that third-party engine from the whole path, run RAREXT's own engine:
 *
 *   RAREXT_WEB4_OWN_ENGINE=1 node scripts/demo-web4-model.mjs
 *
 * In that mode the engine itself is sharded into RAREXT; every provider fetches
 * and verifies it, serves with NO engine endpoint, and the demo carries no
 * Ollama, llama.cpp, native addon, or container at all.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { isXorshiftModel } from "../packages/core/src/ai.ts";
import { creditLeaf } from "../packages/core/src/credits.ts";
import { verifyProof } from "../packages/core/src/merkle.ts";
import { canonicalDigest, sha256Hex } from "../apps/runtime/src/digest.ts";
import { discoverBundle } from "../apps/runtime/src/discovery.ts";
import { startGateway } from "../apps/runtime/src/gateway.ts";
import { RunLedger, writeJsonFile } from "../apps/runtime/src/ledger.ts";
import {
  buildModelBundle,
  fetchBundleChunks,
  fetchBundleManifest,
  fetchProviderCard,
  issueProviderCertificate,
  providerBootStages,
  providerChainDepth,
  providerStageMeasurements,
  uploadBundle,
  verifyModelBundle,
  verifyProviderChain,
  verifyProviderQuote,
} from "../apps/runtime/src/model-bundle.ts";
import { buildDeployment, commitDeployment } from "../apps/runtime/src/manifest.ts";
import { challengeFor, RuntimePublisher } from "../apps/runtime/src/publisher.ts";
import { runNativeModel, startProvider } from "../apps/runtime/src/provider.ts";
import { engineDescriptorFingerprint } from "../apps/runtime/src/engine-pin.ts";
import {
  ENGINE_ARTIFACT_RUNTIME_GGUF,
  buildEngineBundle,
  fetchEngineArtifact,
  uploadEngineBundle,
  verifyEngineBundle,
} from "../apps/runtime/src/engine-bundle.ts";
import {
  attestationBindsEnclaveKey,
  openResponse,
  sealRequest,
} from "../apps/runtime/src/confidential.ts";
import { replayEngineRun } from "../apps/runtime/src/replay.ts";
import {
  HARDWARE_ROOT_KEY_ID,
  hardwareRootSigner,
  issueHardwareChain,
  issueMeasuredBootChain,
} from "../apps/runtime/src/hardware-root.ts";
import {
  ROOT_CHAIN_KIND,
  issueRootRotation,
  verifyProviderRootChain,
  verifyRootChain,
} from "../apps/runtime/src/root-chain.ts";
import { runtimeCodeMeasurement } from "../apps/runtime/src/code-measurement.ts";
import { signImageManifest, verifyImageManifest } from "../apps/runtime/src/image-manifest.ts";
import { attestationForReceipt } from "../apps/runtime/src/certificates.ts";
import {
  verifySettlementInclusion,
  verifySettlementReceipt,
} from "../apps/api/src/settlement.ts";
import { verifyDeploymentBody, verifyRunBody } from "../apps/runtime/src/transcript.ts";
import { createVerifierServer, runSpecFromChallenge, verifierConfig } from "../apps/runtime/src/verifier.ts";
import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
  publicKeyId,
} from "../packages/agent-sdk/src/index.ts";

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
  const seal = process.env.RAREXT_WEB4_SEAL === "1";
  const modelId = process.env.RAREXT_WEB4_MODEL ?? (real ? "rarext-web4-model" : "rarext-native-proof");
  const engineModel = process.env.RAREXT_WEB4_ENGINE_MODEL ?? "rarext-web4-model";
  // `RAREXT_WEB4_OWN_ENGINE=1` runs the WHOLE real-GGUF path on RAREXT's own
  // engine artifact: the provider is started with no engine endpoint and no
  // Ollama, so the demo itself carries no third-party engine. The default keeps
  // Ollama as interop for a machine that already has it.
  const ownEngineMode = real && process.env.RAREXT_WEB4_OWN_ENGINE === "1";
  // Credits each distinct agreeing operator earns for the run. Payment is a
  // commitment the deployment (and therefore the challenge) names, not a
  // gateway setting.
  const bounty = Number(process.env.RAREXT_WEB4_BOUNTY ?? "12");
  if (!Number.isSafeInteger(bounty) || bounty <= 0) {
    throw new Error(`RAREXT_WEB4_BOUNTY must be a positive integer, got ${process.env.RAREXT_WEB4_BOUNTY}`);
  }

  // A measured-boot chain: each provider's leaf (app) key is certified by the OS,
  // the OS by firmware, firmware by the SHIPPED vendor hardware root. Each link
  // names its stage, so the deployment can require the chain to extend through
  // the boot it trusts. The root is a fixed key shipped with the protocol — the
  // shape of a fused root, but still a file.
  const teeLeaves = [];
  for (let index = 0; index < 2; index += 1) {
    const leafKeypair = generateAgentKeypair("ecdsa-p256");
    const leaf = new AgentSigner(leafKeypair.privateKey);
    // The measured boot's final (app) stage IS the running code, so it equals the
    // signing-image measurement the manifest will carry: the two attestations
    // about "the code" must agree.
    const { chain, stages, measurements } = issueMeasuredBootChain(leafKeypair.publicKey, {
      app: runtimeCodeMeasurement(),
    });
    const leafPath = join(state, `tee-leaf-${index}.json`);
    const certPath = join(state, `tee-cert-${index}.json`);
    writeJsonFile(leafPath, { privateKey: leafKeypair.privateKey, publicKey: leafKeypair.publicKey });
    writeJsonFile(certPath, { chain });
    teeLeaves.push({ leaf, leafPath, certPath, keyId: leaf.keyId, stages, measurements });
  }

  // A vendor-signed image manifest whose certificate CHAIN reaches the shipped
  // hardware root. The provider refuses to run if the manifest does not vouch for
  // the code it is actually running, and the deployment pins the ROOT the chain
  // must terminate at — so a manifest signed by a bare (self-rooted) key is
  // refused even though its signature is valid.
  const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain: manifestChain } = issueHardwareChain(manifestLeaf.publicKey);
  const codeManifest = signImageManifest(
    { image: runtimeCodeMeasurement(), runtime: "rarext-runtime" },
    manifestLeaf,
    manifestChain,
  );
  const codeManifestPath = join(state, "image-manifest.json");
  writeJsonFile(codeManifestPath, codeManifest);
  // The off-ledger settlement adapter signs each movement with its own key; the
  // node pins that key, so an unsigned or mis-signed settlement is refused rather
  // than recorded on faith.
  const settlementKeypair = generateAgentKeypair("ecdsa-p256");
  const settlementSigner = new AgentSigner(settlementKeypair.privateKey);
  const settlementKeyPath = join(state, "settlement-key.json");
  writeJsonFile(settlementKeyPath, {
    privateKey: settlementKeypair.privateKey,
    publicKey: settlementKeypair.publicKey,
  });
  // The external ledger signs a checkpoint over its settlement state; the node
  // pins that key and requires a Merkle inclusion proof, so a movement the ledger
  // never recorded is refused rather than paid out against the adapter's word.
  const ledgerKeypair = generateAgentKeypair("ecdsa-p256");
  const ledgerSigner = new AgentSigner(ledgerKeypair.privateKey);
  const ledgerKeyPath = join(state, "settlement-ledger-key.json");
  writeJsonFile(ledgerKeyPath, {
    privateKey: ledgerKeypair.privateKey,
    publicKey: ledgerKeypair.publicKey,
  });
  const ledgerHeight = 7;
  // A bare-leaf manifest: a real signature, but no chain to the hardware root.
  const bareManifest = signImageManifest(
    { image: runtimeCodeMeasurement(), runtime: "rarext-runtime" },
    manifestLeaf,
  );

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
        ...(ownEngineMode
          ? [
              "--engine",
              "rarext",
              // Commit RAREXT's own engine into the model bundle itself: no
              // provider is told which engine to run out of band.
              "--engine-module",
              fileURLToPath(new URL("../apps/runtime/engines/rarext-gguf-engine.js", import.meta.url)),
              "--engine-runtime",
              "gguf",
              "--engine-name",
              "rarext-gguf-engine",
              "--engine-version",
              "1",
            ]
          : ["--engine", "ollama", "--engine-model", engineModel]),
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
    ...(seal ? ["--seal"] : []),
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
  const sealKeyPath = bundleReport.sealKeyPath ?? null;
  if (seal && sealKeyPath === null) throw new Error("sealed bundle produced no seal key file");
  // The replay phase is a legitimate key holder: it recomputes the model from
  // the committed bundle, so for a sealed bundle it opens the shards too.
  const sealKey =
    seal && sealKeyPath !== null
      ? Buffer.from(readFileSync(sealKeyPath, "utf8").trim(), "hex")
      : null;

  // In own-engine mode the ENGINE is a RAREXT artifact too, and the model bundle
  // COMMITS it: `bundle --engine-module` uploads the engine and names its digest
  // in `execution.artifact`. Every provider therefore resolves the engine from
  // the bundle with no out-of-band `--engine-bundle` flag.
  const ownEngineBundle = ownEngineMode ? bundleReport.engineBundle : null;
  const ownEngineBundlePath = ownEngineMode ? bundleReport.engineBundlePath : null;
  if (ownEngineMode && (ownEngineBundle === null || ownEngineBundlePath === null)) {
    throw new Error("own-engine mode produced no committed engine artifact");
  }

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

  // ── 2b. Sealing: the store holds ciphertext, not the weights ─────────────
  // With RAREXT_WEB4_SEAL=1 the shards on the node are AES-256-GCM ciphertext.
  // The node never holds the model: the plaintext file is not addressable, and
  // the shard bytes hash to the committed ciphertext. A provider opens them in
  // memory with a key delivered out of band.
  const plaintextHash = bundle.model.weightsDigest.replace(/^sha256:/, "");
  const plaintextListed = listed.some((record) => record.hash === plaintextHash);
  let sealedDetail = "";
  if (seal) {
    const rawShard = Buffer.from(
      await (await fetch(`${startBase}/v1/blobs/${bundle.shards[0].hash}/raw`)).arrayBuffer(),
    );
    const shardIsCommittedCiphertext =
      createHash("sha256").update(rawShard).digest("hex") === bundle.shards[0].hash;
    sealedDetail = shardIsCommittedCiphertext
      ? `the node holds ${bundle.sealing?.scheme} ciphertext; the plaintext file ${plaintextHash.slice(0, 12)}… is not stored`
      : "the stored shard does not hash to its commitment";
    phase(
      "sealed",
      bundle.sealing?.scheme === "aes-256-gcm" &&
        bundle.totalBytes !== bundle.model.sizeBytes &&
        shardIsCommittedCiphertext &&
        !plaintextListed,
      sealedDetail,
    );
  } else {
    phase(
      "sealed",
      bundle.sealing === undefined && bundle.totalBytes === bundle.model.sizeBytes,
      "open bundle: the shards are the plaintext bytes (set RAREXT_WEB4_SEAL=1 to store ciphertext)",
    );
  }

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
      "--tee-key-file",
      teeLeaves[0].leafPath,
      "--tee-cert-file",
      teeLeaves[0].certPath,
      "--image-manifest",
      codeManifestPath,
      ...(ownEngineMode
        ? []
        : [
            "--engine-logprobs",
            ...(real
              ? ["--engine-endpoint", process.env.RAREXT_WEB4_ENGINE_ENDPOINT ?? "http://127.0.0.1:11434"]
              : []),
          ]),
      ...(seal ? ["--seal-key-file", sealKeyPath] : []),
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
  // using a shared host Ollama has one engine, so the demo keeps one provider
  // there. RAREXT's own engine has no shared bottleneck: every provider runs
  // its own fetched engine, so own-engine mode uses two providers too.
  let providerBUrl = null;
  let cardB = null;
  if (!real || ownEngineMode) {
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
        "--tee-key-file",
        teeLeaves[1].leafPath,
        "--tee-cert-file",
        teeLeaves[1].certPath,
        "--image-manifest",
        codeManifestPath,
        ...(seal ? ["--seal-key-file", sealKeyPath] : []),
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
    "--bounty",
    String(bounty),
    "--tee-vendor",
    HARDWARE_ROOT_KEY_ID,
    "--tee-chain-depth",
    "3",
    "--tee-boot-stages",
    "firmware,os,app",
    "--tee-boot-measurements",
    `firmware=${teeLeaves[0].measurements.firmware},os=${teeLeaves[0].measurements.os},app=${teeLeaves[0].measurements.app}`,
    "--tee-freshness",
    "challenge",
    "--tee-code",
    providerCards[0].independence.code,
    "--tee-signed-image",
    HARDWARE_ROOT_KEY_ID,
    "--tee-signed-image-depth",
    "2",
    "--require-trace",
    "--require-replay",
    "--registry",
    startBase,
    ...(seal ? ["--seal-key-file", sealKeyPath] : []),
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
      new Set(deployment.labels.operators.split(",")).size === providerUrls.length &&
      deployment.labels.bounty === String(bounty) &&
      deployment.labels.teeVendor === HARDWARE_ROOT_KEY_ID,
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
    // The node settles redemptions through the echo adapter, which signs each
    // movement with its key; the node pins that key id, so an unsigned or
    // mis-signed settlement is refused rather than recorded on faith.
    RAREXT_SETTLEMENT: "echo",
    RAREXT_SETTLEMENT_KEY_FILE: settlementKeyPath,
    RAREXT_SETTLEMENT_KEY: settlementSigner.keyId,
    // The echo adapter also proves each settlement is included in the external
    // ledger's signed checkpoint; the node pins the ledger key and a minimum
    // height, so a stale checkpoint or an unrecorded movement is refused.
    RAREXT_SETTLEMENT_LEDGER_KEY_FILE: ledgerKeyPath,
    RAREXT_SETTLEMENT_LEDGER_KEY: ledgerSigner.keyId,
    RAREXT_SETTLEMENT_LEDGER: "echo-chain",
    RAREXT_SETTLEMENT_LEDGER_HEIGHT: String(ledgerHeight),
    RAREXT_SETTLEMENT_LEDGER_MIN_HEIGHT: String(ledgerHeight),
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
    // The deployment pins a vendor key, so the gateway verifies each provider's
    // machine quote before it will write a run.
    attestations: Object.fromEntries(
      providerUrls.map((url, index) => [url, providerCards[index].independence]),
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

  // ── 9r. Provider receipts: each provider signed what it said, from where ──
  // The transcript carries the provider's OWN signature over the request, the
  // response it returned, its attestation, AND the engine it served with, so the
  // run proves what it said, which enclave it said it from, and on which engine.
  const receipts = publishedBody?.quorum?.providers ?? [];
  const receiptOk =
    receipts.length === providerUrls.length &&
    receipts.every((entry) => {
      const receipt = entry.receipt;
      return (
        receipt?.kind === "rarext.response-receipt.v1" &&
        receipt.response === entry.responseDigest &&
        receipt.request === publishedBody?.request?.digest &&
        entry.attestation !== undefined &&
        receipt.attestation === canonicalDigest(attestationForReceipt(entry.attestation)) &&
        receipt.engine === publishedBody?.engine?.fingerprint &&
        receipt.bundle === publishedBody?.bundle?.digest &&
        publicKeyId(receipt.publicKey) === entry.operator
      );
    }) &&
    verifyRunBody(publishedBody, spec).correct === true;
  // Swapping in a different attestation under the genuine receipt is caught.
  const forgedReceiptBody = {
    ...publishedBody,
    quorum: {
      ...publishedBody.quorum,
      providers: (publishedBody.quorum?.providers ?? []).map((entry, index) =>
        index === 0
          ? { ...entry, attestation: { ...entry.attestation, measurement: "0".repeat(64) } }
          : entry,
      ),
    },
  };
  const forgedReceiptRefused =
    publishedBody !== undefined && verifyRunBody(forgedReceiptBody, spec).correct === false;
  // Dropping an agreeing provider's receipt entirely is refused too: a run that
  // commits a bundle/engine/enclave cannot stand without a signature from every
  // provider it counts.
  const strippedReceiptBody = {
    ...publishedBody,
    quorum: {
      ...publishedBody.quorum,
      providers: (publishedBody.quorum?.providers ?? []).map((entry, index) => {
        if (index !== 0) return entry;
        const copy = { ...entry };
        delete copy.receipt;
        return copy;
      }),
    },
  };
  const strippedReceiptRefused =
    publishedBody !== undefined && verifyRunBody(strippedReceiptBody, spec).correct === false;
  // A forged dissent — an "answered" provider with a different digest and no
  // signature — cannot pad the evidence set either. Dissenters are not payees,
  // so a run cannot be refused on the credit root; the receipt rule is what
  // stops an unsigned voice being recorded as quorum evidence.
  const forgedDissentBody = {
    ...publishedBody,
    quorum: {
      ...publishedBody.quorum,
      responded: (publishedBody.quorum?.providers ?? []).length + 1,
      providers: [
        ...(publishedBody.quorum?.providers ?? []),
        {
          endpoint: "http://127.0.0.1:1",
          responseDigest: "0".repeat(64),
          operator: "0".repeat(64),
          machine: null,
          measurement: null,
        },
      ],
    },
  };
  const forgedDissentRefused =
    publishedBody !== undefined && verifyRunBody(forgedDissentBody, spec).correct === false;
  phase(
    "receipt",
    receiptOk && forgedReceiptRefused && strippedReceiptRefused && forgedDissentRefused,
    receiptOk && forgedReceiptRefused && strippedReceiptRefused && forgedDissentRefused
      ? `${providerUrls.length} provider receipt(s) bind their operator, the run's request/response, their own attestation, the engine they served with, and the bundle they served; a run paired with a different attestation, with an agreeing provider's receipt removed, or padded with an unsigned dissenting provider was refused`
      : `receiptOk=${String(receiptOk)} forgedRefused=${String(forgedReceiptRefused)} strippedRefused=${String(strippedReceiptRefused)} dissentRefused=${String(forgedDissentRefused)}`,
  );

  // ── 9s. A single-provider run still names and binds its provider ─────────
  // Without a quorum the gateway records the one provider that answered: its
  // endpoint, operator, attestation, and own receipt. A run that commits the
  // bundle but omits that signature is refused, so the single-provider path is
  // not an attribution gap.
  let attributeOk = false;
  let attributeDetail = "";
  let singleGateway = null;
  try {
    const singleLedger = join(state, "single-provider-ledger");
    singleGateway = await startGateway({
      deployment,
      ledgerDir: singleLedger,
      host: "127.0.0.1",
      port: 0,
      upstreamApi: "openai",
      upstreams: [providerUrls[0]],
      operators: {
        [providerUrls[0]]:
          providerCards[0].provider.keyId ??
          providerCards[0].provider.handle ??
          providerUrls[0],
      },
      attestations: { [providerUrls[0]]: providerCards[0].independence },
    });
    const singleResponse = await fetch(`${singleGateway.url}/v1/chat/completions`, {
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
    const singleBody = new RunLedger(singleLedger).records()[0]?.body ?? null;
    // The run has no quorum evidence, so verify against the same challenge minus
    // its quorum-only commitments (quorum and the bounty it pays).
    const singleSpec = { ...spec };
    delete singleSpec.quorum;
    delete singleSpec.inferenceBounty;
    const honest =
      singleBody !== null && verifyRunBody(singleBody, singleSpec).correct === true;
    const names =
      singleBody?.quorum === undefined &&
      singleBody?.provider?.endpoint === providerUrls[0] &&
      singleBody?.provider?.operator ===
        (providerCards[0].provider.keyId ?? providerCards[0].provider.handle) &&
      singleBody?.provider?.attestation !== undefined &&
      singleBody?.provider?.receipt !== undefined;
    let unsignedRefused = false;
    if (singleBody !== null) {
      const unsigned = { ...singleBody, provider: { ...singleBody.provider } };
      delete unsigned.provider.receipt;
      unsignedRefused =
        verifyRunBody(unsigned, singleSpec).proof?.failures?.includes("provider.evidence") ===
        true;
    }
    attributeOk = singleResponse.status === 200 && honest && names && unsignedRefused;
    attributeDetail = attributeOk
      ? `non-quorum run names ${String(singleBody?.provider?.endpoint)}, operator ${String(singleBody?.provider?.operator).slice(0, 10)}…, its attestation, and its receipt; removing the receipt was refused (provider.evidence)`
      : `status=${singleResponse.status} honest=${String(honest)} names=${String(names)} unsignedRefused=${String(unsignedRefused)}`;
  } catch (error) {
    attributeDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (singleGateway !== null) await singleGateway.close().catch(() => {});
  }
  phase("attribute", attributeOk, attributeDetail);

  // ── 9t. A required decode trace: missing it is refused ──────────────────
  // The deployment committed `trace: "required"`, so every run must carry a
  // decode trace (native token ids or an engine logprob judgment). An engine
  // provider started WITHOUT --engine-logprobs omits it, and is refused.
  let traceOk = false;
  let traceDetail = "";
  try {
    const runTrace = publishedBody?.response?.body?.rarext_trace;
    const providesTrace =
      runTrace?.kind === "rarext.decode-trace.v1" || runTrace?.kind === "rarext.judgment.v1";
    const requiredCommitted = spec.requireTrace === true;
    const verified = verifyRunBody(publishedBody, spec);
    // Strip the trace: the run now fails exactly the required-trace check.
    const withoutTrace = {
      ...publishedBody,
      response: {
        ...publishedBody.response,
        body: Object.fromEntries(
          Object.entries(publishedBody.response.body).filter(([key]) => key !== "rarext_trace"),
        ),
      },
    };
    const stripped = verifyRunBody(withoutTrace, spec);
    const refused =
      stripped.correct === false &&
      (stripped.proof?.failures ?? []).includes("response.decodeTraceRequired");
    traceOk =
      requiredCommitted &&
      providesTrace &&
      verified.correct === true &&
      verified.details.checks.includes("response.decodeTraceRequired") &&
      refused;
    traceDetail = traceOk
      ? `the deployment required a decode trace (${String(runTrace.kind)}); the run carries one and verifies, and a run with the trace stripped fails the required-trace check`
      : `required=${String(requiredCommitted)} provides=${String(providesTrace)} refused=${String(refused)}`;
  } catch (error) {
    traceOk = false;
    traceDetail = error instanceof Error ? error.message : String(error);
  }
  phase("trace", traceOk, traceDetail);

  // ── 9d. A required replayable run: sampling is refused ──────────────────
  // The deployment committed `replay: "required"`, so the gateway refuses a
  // sampled request (temperature > 0 or no seed) and the run must carry a replay
  // envelope a reader can reproduce.
  let deterministicOk = false;
  let deterministicDetail = "";
  try {
    const ask = (extra) =>
      fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "reproducible?" }],
          max_tokens: 8,
          ...extra,
        }),
      });
    const sampled = await ask({ temperature: 0.7, seed: 1 });
    const unseeded = await ask({ temperature: 0 });
    const runHasEnvelope = publishedBody?.replay != null;
    const verified = verifyRunBody(publishedBody, spec);
    const replayable = verified.proof?.replayable === true;
    const requiredCheck = verified.details.checks.includes("replay.required");
    // A run that dropped its replay envelope fails the required-replay check.
    const noEnvelopeRefused =
      verifyRunBody({ ...publishedBody, replay: null }, spec).proof?.failures?.includes("replay.required") ===
      true;
    deterministicOk =
      spec.requireReplay === true &&
      sampled.status === 422 &&
      unseeded.status === 422 &&
      runHasEnvelope &&
      replayable &&
      requiredCheck &&
      noEnvelopeRefused;
    deterministicDetail = deterministicOk
      ? `the deployment required a replayable run; a sampled request and an unseeded request were refused (422), the run carries a replay envelope, and a run without one fails the required-replay check`
      : `required=${String(spec.requireReplay)} sampled=${sampled.status} unseeded=${unseeded.status} envelope=${String(runHasEnvelope)} replayable=${String(replayable)}`;
  } catch (error) {
    deterministicOk = false;
    deterministicDetail = error instanceof Error ? error.message : String(error);
  }
  phase("deterministic", deterministicOk, deterministicDetail);

  // ── 9e. Determinism class: an independent witness must match token-for-token ─
  // A single run cannot prove the engine's arithmetic: a provider can write any
  // trace and call it deterministic. The deployment commits
  // `determinism: "deterministic-replay"`, so every run must carry a SECOND,
  // independently recorded run — a witness — whose decode trace matches the run
  // token-for-token, signed by a provider outside the run's own provider set.
  let determinismOk = false;
  let determinismDetail = "";
  let determinismGateway = null;
  let witnessProvider = null;
  try {
    // The witness has to be a provider OTHER than the one that produced the run.
    // The native path already runs two providers; an engine path shares the
    // host's Ollama, so start a second provider process for the witness.
    let witnessUrl = providerBUrl;
    if (witnessUrl === null) {
      const witnessPort = await freePort();
      witnessProvider = spawnProcess(
        [
          "apps/runtime/src/cli.ts",
          "provider",
          "--bundle",
          join(state, "model-bundle.json"),
          "--registry",
          baseUrl,
          "--state",
          // Outside the caller's state dir, so a cached engine file never makes
          // the later "the caller keeps no weights" phase see a model.
          providerBState,
          "--port",
          String(witnessPort),
          "--handle",
          "provider-witness",
          ...(ownEngineMode
            ? []
            : [
                "--engine-logprobs",
                ...(real
                  ? ["--engine-endpoint", process.env.RAREXT_WEB4_ENGINE_ENDPOINT ?? "http://127.0.0.1:11434"]
                  : []),
              ]),
          ...(seal ? ["--seal-key-file", sealKeyPath] : []),
        ],
        {},
        (line) => {
          const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
          return match ? match[1].replace(/\/$/, "") : null;
        },
      );
      witnessUrl = await witnessProvider.ready;
    }

    // The deterministic-replay deployment: one provider answers, a DIFFERENT
    // provider is the witness. It commits the same bundle and engine, and the
    // trace + replay requirements the class is built on.
    const determinismDeployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { ...deployment.engine, endpoint: providerUrls[0] },
          model: deployment.model,
          apis: ["openai"],
          models: [deployment.model],
        },
        hardware: deployment.hardware,
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: deployment.labels.bundle,
          shardsRoot: deployment.labels.shardsRoot,
          manifestHash: deployment.labels.manifestHash,
          providers: providerUrls[0],
          operators: providerCards[0].provider.keyId,
          quorum: "1",
          trace: "required",
          replay: "required",
          determinism: "deterministic-replay",
          ...(deployment.labels.engineFingerprint
            ? { engineFingerprint: deployment.labels.engineFingerprint }
            : {}),
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const determinismSpec = runSpecFromChallenge(challengeFor(determinismDeployment));

    determinismGateway = await startGateway({
      deployment: determinismDeployment,
      ledgerDir: join(state, "gateway-determinism"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [providerUrls[0]],
      quorum: 1,
      witnesses: [witnessUrl],
      operators: { [providerUrls[0]]: providerCards[0].provider.keyId },
    });

    const ask = (extra) =>
      fetch(`${determinismGateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: determinismDeployment.model.id,
          messages: [{ role: "user", content: "reproduce the arithmetic" }],
          max_tokens: 8,
          ...extra,
        }),
      });
    const determinismSampled = await ask({ temperature: 0.7, seed: 1 });
    const determinismAccepted = await ask({ temperature: 0, seed: 4242 });

    const determinismLedgerDir = join(state, "gateway-determinism");
    const determinismBody = new RunLedger(determinismLedgerDir).records()[0]?.body ?? null;
    const claim = determinismBody?.determinism ?? null;
    const runTrace = determinismBody?.response?.body?.rarext_trace ?? null;
    const witnessTrace = claim?.witness?.response?.rarext_trace ?? null;
    const traceMatchesTokenForToken =
      runTrace !== null &&
      witnessTrace !== null &&
      runTrace.kind === witnessTrace.kind &&
      Array.isArray(runTrace.tokens) &&
      Array.isArray(witnessTrace.tokens) &&
      runTrace.tokens.length === witnessTrace.tokens.length &&
      runTrace.tokens.every((token, index) => token === witnessTrace.tokens[index]) &&
      (runTrace.kind !== "rarext.judgment.v1" ||
        (Array.isArray(runTrace.logprobs) &&
          Array.isArray(witnessTrace.logprobs) &&
          runTrace.logprobs.length === witnessTrace.logprobs.length &&
          runTrace.logprobs.every((value, index) => value === witnessTrace.logprobs[index])));

    const verified = determinismBody ? verifyRunBody(determinismBody, determinismSpec) : null;
    const stripped = determinismBody
      ? verifyRunBody({ ...determinismBody, determinism: undefined }, determinismSpec)
      : null;
    const selfWitness =
      determinismBody && claim !== null
        ? verifyRunBody(
            {
              ...determinismBody,
              determinism: {
                ...claim,
                witness: {
                  ...claim.witness,
                  provider: { ...claim.witness.provider, endpoint: providerUrls[0] },
                },
              },
            },
            determinismSpec,
          )
        : null;
    const diverged =
      determinismBody && claim !== null
        ? verifyRunBody(
            {
              ...determinismBody,
              determinism: {
                ...claim,
                witness: {
                  ...claim.witness,
                  response: {
                    ...claim.witness.response,
                    rarext_trace: { ...claim.witness.response.rarext_trace, tokens: [1, 2, 3] },
                  },
                },
              },
            },
            determinismSpec,
          )
        : null;

    determinismOk =
      determinismSpec.determinism === "deterministic-replay" &&
      determinismSampled.status === 422 &&
      determinismAccepted.status === 200 &&
      claim?.class === "deterministic-replay" &&
      claim?.witness?.provider?.endpoint?.replace(/\/+$/, "") === witnessUrl.replace(/\/+$/, "") &&
      verified?.correct === true &&
      verified.details.checks.includes("determinism.replayWitness") &&
      traceMatchesTokenForToken &&
      stripped?.correct === false &&
      stripped.proof?.failures?.includes("determinism.replayWitness") === true &&
      selfWitness?.correct === false &&
      diverged?.correct === false;
    determinismDetail = determinismOk
      ? `committed determinism "deterministic-replay": a sampled request was refused (422); the accepted run carried an ` +
        `independent witness from ${String(claim.witness.provider.endpoint)} whose decode trace ` +
        `(${String(runTrace.tokens.length)} ${runTrace.kind === "rarext.judgment.v1" ? "tokens+logprobs" : "token ids"}) ` +
        `matched the run token-for-token; stripping the witness, reusing the run's own provider as witness, and ` +
        `diverging the witness trace were all refused`
      : `class=${String(determinismSpec.determinism)} sampled=${determinismSampled.status} accepted=${determinismAccepted.status} ` +
        `claim=${String(claim?.class)} traceMatch=${String(traceMatchesTokenForToken)} verified=${String(verified?.correct)} ` +
        `failures=${JSON.stringify(verified?.proof?.failures)} stripped=${String(stripped?.correct)} ` +
        `self=${String(selfWitness?.correct)} diverged=${String(diverged?.correct)}`;
  } catch (error) {
    determinismOk = false;
    determinismDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (determinismGateway !== null) await determinismGateway.close().catch(() => {});
    if (witnessProvider !== null) witnessProvider.stop();
  }
  phase("determinism", determinismOk, determinismDetail);

  // ── 9a. The run paid every agreeing operator, and each can prove it ──────
  // The gateway derived the payment from the quorum evidence and the committed
  // bounty; the run commits a ledger root over one receipt per distinct
  // operator. This asks the gateway for the ledger and for one operator's
  // receipts, then checks each receipt against the published root with the same
  // Merkle rule a stranger would use.
  const bytesSha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
  const creditsView = await getJson(`${gateway.url}/v1/rarext/credits`);
  let proofsOk = true;
  let proofDetail = "";
  for (const entry of providerCards) {
    const keyId = entry.provider.keyId;
    if (typeof keyId !== "string" || keyId === "") {
      proofsOk = false;
      proofDetail = "a paid provider named no operator key";
      break;
    }
    const mine = await getJson(`${gateway.url}/v1/rarext/credits/${encodeURIComponent(keyId)}`);
    const receipt = mine.receipts?.[0];
    if (!receipt || !receipt.ledger) {
      proofsOk = false;
      proofDetail = `operator ${keyId.slice(0, 10)}… carries no receipt`;
      break;
    }
    const leaf = creditLeaf(
      {
        keyId: receipt.keyId,
        action: receipt.action,
        bounty: receipt.bounty,
        challengeId: receipt.challengeId,
        artifactHash: receipt.artifactHash,
        at: receipt.at,
      },
      sha256Hex,
    );
    const ok = verifyProof(
      leaf,
      receipt.ledger.proof,
      mine.ledgerRoot,
      receipt.ledger.index,
      bytesSha256,
    );
    if (!ok) {
      proofsOk = false;
      proofDetail = `operator ${keyId.slice(0, 10)}…'s receipt does not prove against the root`;
      break;
    }
  }
  phase(
    "pay",
    publishedBody?.credits?.action === "infer" &&
      publishedBody?.credits?.bounty === bounty &&
      publishedBody?.credits?.paid === providerUrls.length &&
      creditsView.ledgerRoot === publishedBody?.credits?.ledgerRoot &&
      creditsView.count === providerUrls.length &&
      creditsView.byOperator &&
      Object.keys(creditsView.byOperator).length === providerUrls.length &&
      proofsOk,
    proofsOk
      ? `${providerUrls.length} operator(s) paid ${bounty} credit(s) each; every receipt proves against ledger ${String(creditsView.ledgerRoot).slice(0, 12)}…`
      : proofDetail,
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
  // A sealed provider never keeps the model: not in the caller's state (checked
  // above) and not in the provider's own state directory either — the opened
  // bytes live only in memory, or in an ephemeral file the engine loading
  // removes. An open engine provider DOES cache the file, which is why this
  // holds only for a sealed bundle.
  const providerKeepsNoModel = !seal || modelFilesIn(providerState).length === 0;
  phase(
    "weights",
    sourceGone &&
      runtimeStateFiles.length === 0 &&
      providerKeepsNoModel &&
      deployment.model.weightsDigest === bundle.model.weightsDigest,
    (real
      ? `the provider reassembled the GGUF from RAREXT shards; the caller's state has no .gguf`
      : `the source model file was deleted before the provider started; it served ${bundle.shards.length} verified RAREXT blobs`) +
      (seal ? `; the provider state holds no model file` : ""),
  );

  // ── 11. Replay from the committed bundle, not from the provider ──────────
  const fetched = await fetchBundleManifest({ registry: baseUrl, manifestHash });
  const { bytes } = await fetchBundleChunks({
    registry: baseUrl,
    bundle: fetched,
    ...(sealKey === null ? {} : { sealKey }),
  });
  let replayOk = false;
  let replayDetail = "";
  if (!real) {
    const model = JSON.parse(bytes.toString("utf8"));
    if (isXorshiftModel(model)) {
      const replay = runNativeModel(model, { prompt, steps: 24, seed: 4242 });
      // The run recorded the exact token ids it decoded; the replay's trace must
      // digest to the same value, and a different seed must diverge.
      const runTrace = publishedBody?.response?.body?.rarext_trace;
      const { digest: runDigest0, ...runCovered } = runTrace ?? {};
      const traceSelfConsistent =
        Array.isArray(runTrace?.tokens) && runTrace.digest === canonicalDigest(runCovered);
      const replayedTrace = { kind: "rarext.decode-trace.v1", tokens: replay.tokens };
      const traceMatches = traceSelfConsistent && runTrace.digest === canonicalDigest(replayedTrace);
      const diverge = runNativeModel(model, { prompt, steps: 24, seed: 4243 });
      const divergenceDetected =
        canonicalDigest({ kind: "rarext.decode-trace.v1", tokens: diverge.tokens }) !==
        canonicalDigest(replayedTrace);
      replayOk = replay.text === text && traceMatches && divergenceDetected;
      replayDetail = replayOk
        ? `replayed ${JSON.stringify(text.slice(0, 44))}… from the committed model + seed 4242; its decode trace ` +
          `(${replay.tokens.length} tokens) matched, and a different seed diverged`
        : `trace self=${String(traceSelfConsistent)} matches=${String(traceMatches)} diverge=${String(divergenceDetected)}`;
    }
  } else {
    // An engine run is checked at the decode level: the run recorded a token
    // trace (or a token + logprob judgment for an external engine), and replay
    // re-runs on the pinned engine and compares it.
    const replayed = publishedBody
      ? await replayEngineRun({ body: publishedBody, endpoint: providerUrls[0] })
      : null;
    const runTrace = publishedBody?.response?.body?.rarext_trace;
    if (ownEngineMode) {
      // RAREXT's own engine records the generated token ids. Replaying it on the
      // same fetched engine artifact must reproduce the same decode trace.
      const traceRecorded =
        runTrace?.kind === "rarext.decode-trace.v1" &&
        Array.isArray(runTrace.tokens) &&
        runTrace.tokens.length > 0;
      replayOk = traceRecorded && replayed?.ok === true && replayed?.traceMatches === true;
      replayDetail = replayOk
        ? `replayed the GGUF run on RAREXT's own fetched engine; its decode trace (${runTrace.tokens.length} tokens) matched`
        : `trace=${String(traceRecorded)} replay=${String(replayed?.reason ?? replayed?.reproduced)}`;
    } else {
      const judgmentRecorded =
        runTrace?.kind === "rarext.judgment.v1" && Array.isArray(runTrace.tokens) && runTrace.tokens.length > 0;
      replayOk = judgmentRecorded && replayed?.ok === true && replayed?.traceMatches === true;
      replayDetail = replayOk
        ? `replayed the GGUF run on the pinned engine; its decode judgment (${runTrace.tokens.length} tokens with logprobs) matched`
        : `judgment=${String(judgmentRecorded)} replay=${String(replayed?.reason ?? replayed?.reproduced)}`;
    }
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

  // ── 12b. The operators are paid, and one moves credits to another key ────
  // The run is anchored and attested. Each provider registers its own key with
  // the node and claims the inference credit the run committed; the node
  // recomputes the payment from the run and records it. Then the first operator
  // moves credits to a fresh key: a signed debit and credit that sum to zero,
  // proved against the whole-ledger root, with a second spend refused.
  const operatorSigners = providerCards.map((_, index) => {
    const dir = index === 0 ? providerState : providerBState;
    const stored = JSON.parse(readFileSync(join(dir, "provider-identity.json"), "utf8"));
    return new AgentSigner(stored.privateKey);
  });
  const transferRecipient = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);

  const registerIdentity = async (handle, signer) => {
    const response = await fetch(`${baseUrl}/v1/identities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, publicKey: signer.publicKey }),
    });
    if (!response.ok) throw new Error(`register ${handle}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };
  const claimInference = async (operatorKeyId, signer) => {
    const claim = {
      kind: "rarext.inference-work.v1",
      operator: operatorKeyId,
      runDigest,
      at: new Date().toISOString(),
    };
    const response = await fetch(`${baseUrl}/v1/work/inference`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...claim, signature: signer.sign(claim) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const statementFor = (keyId) => getJson(`${baseUrl}/v1/work/statement?keyId=${encodeURIComponent(keyId)}`);

  let settleOk = true;
  let settleDetail = "";
  let settledPayerKeyId = null;
  let settledRecipientKeyId = null;
  try {
    const paid = [];
    for (const [index, cardEntry] of providerCards.entries()) {
      const signer = operatorSigners[index];
      const identity = await registerIdentity(`web4-operator-${index}`, signer);
      if (identity.keyId !== cardEntry.provider.keyId) {
        throw new Error(`registered ${identity.keyId}, but the card names ${cardEntry.provider.keyId}`);
      }
      const claim = await claimInference(cardEntry.provider.keyId, signer);
      if (claim.status !== 201) {
        throw new Error(`claim ${index}: HTTP ${claim.status} ${JSON.stringify(claim.body)}`);
      }
      paid.push(cardEntry.provider.keyId);
    }
    const earned = (await statementFor(paid[0])).credits.earned;
    if (earned !== bounty) throw new Error(`operator 0 earned ${earned}, expected ${bounty}`);

    const recipient = await registerIdentity("web4-treasury", transferRecipient);
    settledPayerKeyId = paid[0];
    settledRecipientKeyId = recipient.keyId;
    const amount = 5;
    const instruction = {
      kind: "rarext.credit-transfer.v1",
      from: paid[0],
      to: recipient.keyId,
      amount,
      nonce: `demo-${Date.now()}`,
      at: new Date().toISOString(),
    };
    const transferred = await fetch(`${baseUrl}/v1/work/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...instruction, signature: operatorSigners[0].sign(instruction) }),
    });
    const transferText = await transferred.text();
    if (transferred.status !== 201) throw new Error(`transfer: HTTP ${transferred.status} ${transferText}`);
    const transfer = JSON.parse(transferText);
    const received = transfer.receipts.find((entry) => entry.keyId === recipient.keyId);
    const proofOk =
      received !== undefined &&
      received.ledger != null &&
      verifyProof(
        creditLeaf(
          {
            keyId: received.keyId,
            action: received.action,
            bounty: received.bounty,
            challengeId: received.challengeId,
            artifactHash: received.artifactHash,
            at: received.at,
          },
          sha256Hex,
        ),
        received.ledger.proof,
        received.ledger.root,
        received.ledger.index,
        bytesSha256,
      ) === true;

    const payer = await statementFor(paid[0]);
    const payee = await statementFor(recipient.keyId);
    const overspend = { ...instruction, amount: bounty * 1000, nonce: `demo-${Date.now()}-2` };
    const refused = await fetch(`${baseUrl}/v1/work/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...overspend, signature: operatorSigners[0].sign(overspend) }),
    });

    settleOk =
      payer.credits.net === bounty - amount &&
      payee.credits.net === amount &&
      proofOk &&
      refused.status === 402;
    settleDetail =
      `${paid.length} operator(s) settled ${bounty} credit(s); operator 0 moved ${amount} to a fresh key ` +
      `(net ${payer.credits.net}) with proof ${String(proofOk)}; an overspend was refused (${refused.status})`;
  } catch (error) {
    settleOk = false;
    settleDetail = error instanceof Error ? error.message : String(error);
  }
  phase("settle", settleOk, settleDetail);

  // ── 12g. Off-ledger settlement: credits leave the ledger for a reference ─
  // A redemption removes credits from the ledger against a committed external
  // reference — the ledger-side half of a cash-out. It is a debit with no
  // matching credit, so the ledger total drops; the same credits cannot be
  // redeemed twice, and the receipt proves against the whole-ledger root.
  let redeemOk = false;
  let redeemDetail = "";
  try {
    if (settledRecipientKeyId === null) throw new Error("no settled key to redeem from");
    const reference = `chain:tx:0x${canonicalDigest({ run: runDigest, at: Date.now() }).slice(0, 40)}`;
    const amount = 5;
    const instruction = {
      kind: "rarext.credit-redemption.v1",
      from: settledRecipientKeyId,
      amount,
      reference,
      nonce: `redeem-${Date.now()}`,
      at: new Date().toISOString(),
    };
    const redeem = (body) =>
      fetch(`${baseUrl}/v1/work/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, signature: transferRecipient.sign(body) }),
      });
    const redeemed = await redeem(instruction);
    const redeemText = await redeemed.text();
    if (redeemed.status !== 201) throw new Error(`redeem: HTTP ${redeemed.status} ${redeemText}`);
    const redemption = JSON.parse(redeemText);
    const receipt = redemption.receipts[0];
    const proofOk =
      receipt?.ledger != null &&
      verifyProof(
        creditLeaf(
          {
            keyId: receipt.keyId,
            action: receipt.action,
            bounty: receipt.bounty,
            challengeId: receipt.challengeId,
            artifactHash: receipt.artifactHash,
            at: receipt.at,
          },
          sha256Hex,
        ),
        receipt.ledger.proof,
        receipt.ledger.root,
        receipt.ledger.index,
        bytesSha256,
      ) === true;

    const after = await statementFor(settledRecipientKeyId);
    const again = { ...instruction, reference: `${reference}-again`, nonce: `redeem-${Date.now()}-2` };
    const refused = await redeem(again);

    // The node settled the redemption through the echo adapter and recorded a
    // settlement receipt bound to the external reference.
    const settlement = redemption.settlement;
    const settlements = await getJson(
      `${baseUrl}/v1/work/settlement?keyId=${encodeURIComponent(settledRecipientKeyId)}`,
    );
    const inclusionOk =
      settlement?.inclusion?.checkpoint?.ledger === "echo-chain" &&
      settlement.inclusion.checkpoint.height === ledgerHeight &&
      settlement.inclusion.checkpoint.publicKey != null &&
      verifySettlementInclusion(
        settlement.binding,
        settlement.inclusion,
        ledgerSigner.keyId,
        ledgerHeight,
      ) === true &&
      // A stale checkpoint (height below the pin) is refused.
      verifySettlementInclusion(
        settlement.binding,
        {
          ...settlement.inclusion,
          checkpoint: { ...settlement.inclusion.checkpoint, height: ledgerHeight - 1 },
        },
        ledgerSigner.keyId,
        ledgerHeight,
      ) === false &&
      // A checkpoint for a different state is refused by the Merkle path.
      verifySettlementInclusion(
        settlement.binding,
        {
          ...settlement.inclusion,
          checkpoint: { ...settlement.inclusion.checkpoint, root: "f".repeat(64) },
        },
        ledgerSigner.keyId,
        ledgerHeight,
      ) === false;
    const settlementOk =
      settlement?.adapter === "echo" &&
      settlement.settlementId === `echo:${reference}` &&
      settlement.reference === reference &&
      settlement.amount === amount &&
      settlement.signer === settlementSigner.keyId &&
      verifySettlementReceipt(settlement, settlementSigner.keyId, {
        ledgerKeyId: ledgerSigner.keyId,
        minHeight: ledgerHeight,
      }) === true &&
      // The movement must be included in the pinned external ledger's state.
      verifySettlementReceipt({ ...settlement, inclusion: null }, settlementSigner.keyId, {
        ledgerKeyId: ledgerSigner.keyId,
      }) === false &&
      inclusionOk &&
      // Editing the amount breaks the binding and the signature with it.
      verifySettlementReceipt({ ...settlement, amount: amount + 1 }, settlementSigner.keyId) === false &&
      settlements?.settlements?.some((entry) => entry.settlementId === `echo:${reference}`) === true;

    redeemOk =
      redemption.balance === 0 &&
      redemption.redemption.reference === reference &&
      after.credits.net === 0 &&
      proofOk &&
      settlementOk &&
      refused.status === 402;
    redeemDetail =
      `redeemed ${amount} credit(s) against ${reference.slice(0, 22)}… (net ${after.credits.net}, ` +
      `ledger supply ${redemption.supply}); settled via the ${String(settlement?.adapter)} adapter ` +
      `(${String(settlement?.settlementId).slice(0, 24)}…), signed by the pinned adapter key ` +
      `${String(settlement?.signer).slice(0, 10)}… and included in the external ledger's signed checkpoint ` +
      `(${String(settlement?.inclusion?.checkpoint?.ledger)} at height ${String(settlement?.inclusion?.checkpoint?.height)}, ` +
      `proved against ${String(settlement?.inclusion?.checkpoint?.root).slice(0, 12)}…; a stale checkpoint, a different ` +
      `state root, an unrecorded movement, and a tampered amount were all refused); ` +
      `proof ${String(proofOk)}; a second redemption was refused (${refused.status})`;
  } catch (error) {
    redeemOk = false;
    redeemDetail = error instanceof Error ? error.message : String(error);
  }
  phase("redeem", redeemOk, redeemDetail);

  // ── 12c. Machine independence: one box is not two ────────────────────────
  // Each provider card attests a machine, signed by the operator's own key. A
  // deployment can demand its quorum over distinct machines. The two demo
  // providers run on one host, so they attest the same machine — and a
  // machine-independent quorum over them is refused. A single-machine quorum is
  // still satisfiable.
  let independenceOk = false;
  let independenceDetail = "";
  try {
    const providerAlive = await getJson(`${providerUrls[0]}/health`).then(() => true).catch(() => false);
    if (!providerAlive) throw new Error("provider A is not answering at the independence phase");
    const machines = providerCards.map((entry) => entry.independence?.machine);
    const attestationsPresent = providerCards.every(
      (entry) =>
        typeof entry.independence?.machine === "string" &&
        /^[0-9a-f]{64}$/.test(entry.independence.measurement),
    );
    if (!attestationsPresent) throw new Error("a provider card attests no machine identity");

    const refuseArgs = [
      "deploy",
      "--web4",
      ...providerUrls.flatMap((url) => ["--provider", url]),
      "--quorum",
      String(providerUrls.length),
      "--independence",
      "machine",
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "machine-deploy"),
      "--json",
    ];
    const refusedDeploy = providerUrls.length >= 2 ? await runCli(refuseArgs) : null;

    // A quorum of one machine is satisfied: the rule is about distinctness, not
    // about forbidding a small deployment.
    const single = await runCli([
      "deploy",
      "--web4",
      "--provider",
      providerUrls[0],
      "--quorum",
      "1",
      "--independence",
      "machine",
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "machine-deploy-single"),
      "--json",
    ]);
    const singleDeployment =
      single.status === 0 ? JSON.parse(single.stdout).deployment : null;

    if (providerUrls.length >= 2) {
      const collided = machines[0] === machines[1];
      const refused =
        refusedDeploy.status !== 0 &&
        /distinct machines/.test((refusedDeploy.stderr || "") + (refusedDeploy.stdout || ""));
      independenceOk =
        collided &&
        refused &&
        singleDeployment?.labels.independence === "machine" &&
        singleDeployment.labels.machines.split(",").length === 1;
      independenceDetail =
        `both providers attest machine ${String(machines[0]).slice(0, 20)}…; a 2-machine quorum was refused, ` +
        `a 1-machine quorum committed`;
    } else {
      independenceOk =
        singleDeployment?.labels.independence === "machine" &&
        singleDeployment.labels.machines.split(",").length === 1;
      independenceDetail = `the provider attests machine ${String(machines[0]).slice(0, 20)}…; the quorum is met`;
    }

    // The machine is not just a label. A machine-independent run must present
    // each provider's OWN signed machine quote, and the machine the run records
    // must be the one that quote binds. Run a single-machine quorum with the
    // vendor pinned, then show an unsigned gateway and a stripped quote are both
    // refused.
    let machineGateway = null;
    let machineOk = false;
    let machineDetail = "";
    try {
      const machineQuoteDeployment = commitDeployment(
        buildDeployment({
          probe: {
            engine: { ...deployment.engine, endpoint: providerUrls[0] },
            model: deployment.model,
            apis: ["openai"],
            models: [deployment.model],
          },
          hardware: deployment.hardware,
          placement: "web4",
          labels: {
            execution: "web4",
            bundle: deployment.labels.bundle,
            shardsRoot: deployment.labels.shardsRoot,
            manifestHash: deployment.labels.manifestHash,
            providers: providerUrls[0],
            operators: providerCards[0].provider.keyId,
            machines: providerCards[0].independence.machine,
            independence: "machine",
            quorum: "1",
            teeVendor: HARDWARE_ROOT_KEY_ID,
            fixture: "loopback",
          },
          createdAt: "2026-11-07T00:00:00.000Z",
        }),
      );
      const machineQuoteSpec = runSpecFromChallenge(challengeFor(machineQuoteDeployment));
      const askMachine = (url) =>
        fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: machineQuoteDeployment.model.id,
            messages: [{ role: "user", content: "signed machine?" }],
            max_tokens: 8,
            temperature: 0,
          }),
        });

      machineGateway = await startGateway({
        deployment: machineQuoteDeployment,
        ledgerDir: join(state, "gateway-machine"),
        port: 0,
        upstreamApi: "openai",
        upstreams: [providerUrls[0]],
        quorum: 1,
        operators: { [providerUrls[0]]: providerCards[0].provider.keyId },
        machines: { [providerUrls[0]]: providerCards[0].independence.machine },
        attestations: { [providerUrls[0]]: providerCards[0].independence },
      });
      const accepted = await askMachine(machineGateway.url);
      const machineBody = new RunLedger(join(state, "gateway-machine")).records()[0]?.body ?? null;
      const entry = machineBody?.quorum?.providers?.[0] ?? null;
      const signedMachine =
        entry !== null &&
        verifyProviderQuote(entry.attestation) !== null &&
        entry.attestation?.machine === entry.machine &&
        entry.attestation?.machine === providerCards[0].independence.machine;
      const verified = machineBody ? verifyRunBody(machineBody, machineQuoteSpec).correct : false;
      // A run whose agreeing provider presents no signed quote cannot attest a
      // machine, so it fails the same quorum check.
      const stripped =
        machineBody !== null
          ? verifyRunBody(
              {
                ...machineBody,
                quorum: {
                  ...machineBody.quorum,
                  providers: machineBody.quorum.providers.map((provider) => ({
                    ...provider,
                    attestation: undefined,
                  })),
                },
              },
              machineQuoteSpec,
            ).correct
          : null;

      // A gateway given no signed attestations cannot meet the quorum at all.
      await machineGateway.close();
      machineGateway = await startGateway({
        deployment: machineQuoteDeployment,
        ledgerDir: join(state, "gateway-machine-unsigned"),
        port: 0,
        upstreamApi: "openai",
        upstreams: [providerUrls[0]],
        quorum: 1,
        operators: { [providerUrls[0]]: providerCards[0].provider.keyId },
        machines: { [providerUrls[0]]: providerCards[0].independence.machine },
      });
      const unsigned = await askMachine(machineGateway.url);

      machineOk =
        accepted.status === 200 &&
        signedMachine &&
        verified &&
        stripped === false &&
        unsigned.status === 503;
      machineDetail =
        `the run's machine ${String(entry?.machine).slice(0, 18)}… is bound by the provider's signed quote ` +
        `(verified=${String(signedMachine)}); a run whose quote is stripped was refused by the verifier, ` +
        `and a gateway with no signed attestations was refused (${unsigned.status})`;
    } catch (error) {
      machineOk = false;
      machineDetail = error instanceof Error ? error.message : String(error);
    } finally {
      if (machineGateway !== null) await machineGateway.close().catch(() => {});
    }

    independenceOk = independenceOk && machineOk;
    independenceDetail = `${independenceDetail}; ${machineDetail}`;
  } catch (error) {
    independenceOk = false;
    independenceDetail = error instanceof Error ? error.message : String(error);
  }
  phase("independence", independenceOk, independenceDetail);

  // ── 12d0. The engine is a RAREXT artifact, not the box's ─────────────────
  // The model weights are RAREXT blobs; so is the ENGINE. The engine module is
  // sharded into RAREXT under one committed digest, and a provider fetches and
  // verifies it before serving. A different engine (the built-in one) would emit
  // a different trace, so the served trace proves which engine ran; a tampered
  // artifact is refused before any inference.
  let engineArtifactOk = false;
  let engineArtifactDetail = "";
  let engineArtifactProvider = null;
  try {
    const engineSource = Buffer.from(
      [
        "module.exports.run = function (model, input) {",
        "  var steps = Math.max(1, Math.min(input.steps || 4, 4));",
        "  var tokens = [];",
        "  for (var i = 0; i < steps; i++) { tokens.push(i % model.vocab.length); }",
        "  return { text: tokens.map(function (t) { return model.vocab[t]; }).join(''), seed: 1, steps: steps, tokens: tokens };",
        "};",
      ].join("\n"),
    );
    const { bundle: engineBundle, chunks } = buildEngineBundle({
      source: engineSource,
      name: "rarext-demo-engine",
      engineVersion: "1",
      chunkBytes: 32,
    });
    if (verifyEngineBundle(engineBundle).length > 0) throw new Error("the engine bundle is invalid");
    await uploadEngineBundle({ registry: baseUrl, bundle: engineBundle, chunks });

    // A tampered engine artifact (digest does not match the bytes) is refused.
    const tampered = { ...engineBundle, artifactDigest: `sha256:${"0".repeat(64)}` };
    const { digest: _tamperDigest, ...tamperCovered } = tampered;
    const tamperRefused = await fetchEngineArtifact({
      registries: [baseUrl],
      bundle: { ...tampered, digest: canonicalDigest(tamperCovered) },
    })
      .then(() => false)
      .catch(() => true);

    if (!real) {
      // The native class runs the FETCHED engine — the served trace is the
      // fetched engine's (0,1,2,3), not the built-in engine's.
      engineArtifactProvider = await startProvider({
        bundle,
        registry: baseUrl,
        stateDir: join(state, "engine-artifact-provider"),
        port: 0,
        engineBundle,
        ...(sealKey === null ? {} : { sealKey }),
      });
      const engineHealth = await getJson(`${engineArtifactProvider.url}/health`);
      const fingerprintFolds =
        engineHealth.engineFingerprint ===
        engineDescriptorFingerprint({
          name: "rarext-demo-engine",
          version: "1",
          digest: engineBundle.artifactDigest,
        });
      const engineAnswer = await fetch(`${engineArtifactProvider.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "run the RAREXT engine" }],
          max_tokens: 4,
          temperature: 0,
        }),
      });
      const engineJson = await engineAnswer.json();
      const engineTokens = engineJson?.rarext_trace?.tokens;
      const fetchedEngineRan = Array.isArray(engineTokens) && engineTokens.join(",") === "0,1,2,3";
      engineArtifactOk =
        fingerprintFolds && engineAnswer.status === 200 && fetchedEngineRan && tamperRefused;
      engineArtifactDetail = engineArtifactOk
        ? `the engine is a RAREXT artifact: ${engineBundle.shards.length} shard(s) under ${engineBundle.artifactDigest.slice(0, 18)}…; ` +
          `the provider fetched and verified it, its digest is folded into the engine fingerprint, it served the FETCHED ` +
          `engine (trace ${String(engineTokens)}), and a tampered artifact was refused`
        : `fingerprintFolds=${String(fingerprintFolds)} status=${engineAnswer.status} tokens=${JSON.stringify(engineTokens)} ` +
          `tamperRefused=${String(tamperRefused)}`;
    } else if (ownEngineMode) {
      // The MAIN bundle already runs on RAREXT's own engine in this mode. Every
      // provider fetched and verified `ownEngineBundle` and serves with no engine
      // endpoint. Prove the served trace came from that artifact, reproduce it,
      // and refuse a tampered artifact — without uploading a second copy of the
      // weights.
      const ownHealth = await getJson(`${providerUrl}/health`);
      const fingerprintFolds =
        ownHealth.engineFingerprint ===
        engineDescriptorFingerprint({
          name: ownEngineBundle.name,
          version: ownEngineBundle.engineVersion,
          digest: ownEngineBundle.artifactDigest,
        });
      const askOwn = () =>
        fetch(`${providerUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: bundle.model.id,
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 2,
            temperature: 0,
            seed: 7,
          }),
        });
      const firstAnswer = await askOwn();
      const firstJson = await firstAnswer.json();
      const secondJson = await (await askOwn()).json();
      const traceA = firstJson?.rarext_trace?.tokens;
      const traceB = secondJson?.rarext_trace?.tokens;
      const traceKind = firstJson?.rarext_trace?.kind;
      const deterministic =
        traceKind === "rarext.decode-trace.v1" &&
        Array.isArray(traceA) &&
        traceA.length === 2 &&
        traceA.every((token) => Number.isSafeInteger(token)) &&
        JSON.stringify(traceA) === JSON.stringify(traceB);
      engineArtifactOk =
        fingerprintFolds && firstAnswer.status === 200 && deterministic && tamperRefused;
      engineArtifactDetail = engineArtifactOk
        ? `the engine is RAREXT's own GGUF artifact (${ownEngineBundle.shards.length} shard(s) under ` +
          `${ownEngineBundle.artifactDigest.slice(0, 18)}…): every provider fetched and verified it, ran it over ` +
          `the committed GGUF with NO engine endpoint (no Ollama/llama.cpp/container), folded its digest into the ` +
          `engine fingerprint, reproduced trace ${JSON.stringify(traceA)} twice, and refused a tampered artifact`
        : `fingerprintFolds=${String(fingerprintFolds)} status=${firstAnswer.status} kind=${String(traceKind)} ` +
          `traceA=${JSON.stringify(traceA)} traceB=${JSON.stringify(traceB)} tamperRefused=${String(tamperRefused)}`;
    } else {
      // The engine class CAN be RAREXT's own. RAREXT's GGUF engine artifact
      // parses the committed GGUF and runs the transformer in the provider's
      // process: no Ollama, no llama.cpp, no native addon, no container. Build a
      // second model bundle that names the RAREXT engine, upload it, and serve
      // it with NO engine endpoint.
      const ggufBytes = readFileSync(gguf);
      const { bundle: ownBundle, chunks: ownChunks } = buildModelBundle({
        bytes: ggufBytes,
        model: {
          ...bundle.model,
          id: `${bundle.model.id}-rarext-engine`,
          sizeBytes: null,
          weightsDigest: null,
        },
        execution: { kind: "engine", engine: "rarext", engineModel: null },
        chunkBytes: 8 * 1024 * 1024,
        ...(sealKey === null ? {} : { sealKey }),
      });
      await uploadBundle({ registry: baseUrl, bundle: ownBundle, chunks: ownChunks });

      const ownEngine = buildEngineBundle({
        source: readFileSync(new URL("../apps/runtime/engines/rarext-gguf-engine.js", import.meta.url)),
        name: "rarext-gguf-engine",
        engineVersion: "1",
        runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
        chunkBytes: 1024 * 1024,
      });
      await uploadEngineBundle({
        registry: baseUrl,
        bundle: ownEngine.bundle,
        chunks: ownEngine.chunks,
      });

      engineArtifactProvider = await startProvider({
        bundle: ownBundle,
        registry: baseUrl,
        stateDir: join(state, "own-gguf-engine"),
        port: 0,
        engineBundle: ownEngine.bundle,
        ...(sealKey === null ? {} : { sealKey }),
      });
      const ownHealth = await getJson(`${engineArtifactProvider.url}/health`);
      const fingerprintFolds =
        ownHealth.engineFingerprint ===
        engineDescriptorFingerprint({
          name: "rarext-gguf-engine",
          version: "1",
          digest: ownEngine.bundle.artifactDigest,
        });
      const askOwn = () =>
        fetch(`${engineArtifactProvider.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: ownBundle.model.id,
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 2,
            temperature: 0,
            seed: 7,
          }),
        });
      const firstAnswer = await askOwn();
      const firstJson = await firstAnswer.json();
      const secondJson = await (await askOwn()).json();
      const traceA = firstJson?.rarext_trace?.tokens;
      const traceB = secondJson?.rarext_trace?.tokens;
      const deterministic =
        Array.isArray(traceA) &&
        traceA.length === 2 &&
        traceA.every((token) => Number.isSafeInteger(token)) &&
        JSON.stringify(traceA) === JSON.stringify(traceB);
      engineArtifactOk =
        fingerprintFolds && firstAnswer.status === 200 && deterministic && tamperRefused;
      engineArtifactDetail = engineArtifactOk
        ? `the engine is RAREXT's own GGUF artifact (${ownEngine.bundle.shards.length} shard(s) under ` +
          `${ownEngine.bundle.artifactDigest.slice(0, 18)}…): the provider fetched and verified it, ran it over the ` +
          `committed GGUF with NO engine endpoint (no Ollama/llama.cpp/container), folded its digest into the engine ` +
          `fingerprint, reproduced trace ${JSON.stringify(traceA)} twice, and refused a tampered artifact`
        : `fingerprintFolds=${String(fingerprintFolds)} status=${firstAnswer.status} traceA=${JSON.stringify(traceA)} ` +
          `traceB=${JSON.stringify(traceB)} tamperRefused=${String(tamperRefused)}`;
    }
  } catch (error) {
    engineArtifactOk = false;
    engineArtifactDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (engineArtifactProvider !== null) await engineArtifactProvider.close().catch(() => {});
  }
  phase("engine", engineArtifactOk, engineArtifactDetail);

  // ── 12d. Measurement allowlist: the attestation is checked, not believed ─
  // The provider card attests a measurement (the software/image digest). A
  // deployment can approve a set of measurements, and then a provider running
  // anything else cannot count. `deploy --measure` refuses an allowlist that
  // does not cover the providers it is adopting.
  let measureOk = false;
  let measureDetail = "";
  try {
    const approved = providerCards[0].independence?.measurement;
    if (!/^[0-9a-f]{64}$/.test(approved)) throw new Error("the provider attests no measurement");
    const deployWithMeasure = (measure) =>
      runCli([
        "deploy",
        "--web4",
        ...providerUrls.flatMap((url) => ["--provider", url]),
        "--quorum",
        String(providerUrls.length),
        "--measure",
        measure,
        "--registry",
        baseUrl,
        "--allow-loopback",
        "--out",
        join(state, `measure-${measure.slice(0, 8)}`),
        "--json",
      ]);
    const good = await deployWithMeasure(approved);
    const goodDeployment = good.status === 0 ? JSON.parse(good.stdout).deployment : null;
    const refused = await deployWithMeasure("0".repeat(64));
    measureOk =
      goodDeployment?.labels.measurements === approved &&
      refused.status !== 0 &&
      /measurement/.test((refused.stderr || "") + (refused.stdout || ""));
    measureDetail =
      `provider attests measurement ${String(approved).slice(0, 16)}…; an allowlist naming it was ` +
      `committed, an allowlist without it was refused`;
  } catch (error) {
    measureOk = false;
    measureDetail = error instanceof Error ? error.message : String(error);
  }
  phase("measure", measureOk, measureDetail);

  // ── 12f. Machine quote: a vendor-signed claim the deployment checks ──────
  // Each provider's machine claim is signed by a vendor key the deployment pins.
  // The run records the quotes and the verifier recomputes them; a quote that
  // does not verify under the pinned key — or a pin the providers cannot satisfy
  // — is refused.
  let quoteOk = false;
  let quoteDetail = "";
  try {
    const anchorKeyId = HARDWARE_ROOT_KEY_ID;
    const runBody = publishedBody ?? localRecord?.body ?? null;
    const requiredStages = ["firmware", "os", "app"];
    // Each leaf signs its own quote; each leaf -> os -> firmware -> vendor-root
    // chain reaches the SHIPPED hardware root, depth three, naming every stage.
    const cardsQuote = providerCards.every(
      (entry, index) =>
        entry.independence?.quote !== undefined &&
        verifyProviderQuote(entry.independence) === teeLeaves[index].keyId &&
        verifyProviderChain(entry.independence) === anchorKeyId &&
        providerChainDepth(entry.independence) === 3 &&
        requiredStages.every((stage) => providerBootStages(entry.independence).includes(stage)),
    );
    // A chain rooted somewhere else: the leaf is genuine, but certified by an
    // attacker that is not the hardware root — refused.
    const attacker = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const wrongCert = issueProviderCertificate({
      subject: providerCards[0].independence.quote.publicKey,
      issuerSigner: attacker,
    });
    const wrongChain = {
      ...providerCards[0].independence,
      quote: { ...providerCards[0].independence.quote, chain: [wrongCert] },
    };
    const chainRefused = verifyProviderChain(wrongChain) !== anchorKeyId;
    // A chain that reaches the vendor root but never measured the boot: it has no
    // stage names, so the measured-boot requirement refuses it.
    const { chain: stagelessChain } = issueHardwareChain(providerCards[0].independence.quote.publicKey);
    const stageless = {
      ...providerCards[0].independence,
      quote: { ...providerCards[0].independence.quote, chain: stagelessChain },
    };
    const stagelessRefused =
      verifyProviderChain(stageless) === anchorKeyId &&
      !providerBootStages(stageless).includes("firmware");
    // Each stage's measurement matches the approved one; a chain running
    // different firmware carries a different firmware measurement.
    const measurementsPinned = providerCards.every(
      (entry, index) =>
        providerStageMeasurements(entry.independence).firmware === teeLeaves[index].measurements.firmware &&
        providerStageMeasurements(entry.independence).os === teeLeaves[index].measurements.os &&
        providerStageMeasurements(entry.independence).app === teeLeaves[index].measurements.app,
    );
    const { chain: otherFirmware } = issueMeasuredBootChain(
      providerCards[0].independence.quote.publicKey,
      { firmware: "0".repeat(64) },
    );
    const wrongMeasure = {
      ...providerCards[0].independence,
      quote: { ...providerCards[0].independence.quote, chain: otherFirmware },
    };
    const wrongMeasurementRefused =
      providerStageMeasurements(wrongMeasure).firmware !== teeLeaves[0].measurements.firmware;
    // Freshness: the gateway challenged each provider with one nonce, and the run
    // records the nonce-bound attestations. A run whose providers carry a
    // different nonce (a replayed attestation) is refused.
    const nonces = (runBody?.quorum?.providers ?? []).map((entry) => entry.attestation?.challenge);
    const freshnessOk =
      spec.teeFreshness === "challenge" &&
      nonces.length === providerUrls.length &&
      nonces.every((value) => typeof value === "string" && value !== "") &&
      new Set(nonces).size === 1;
    const freshnessRefused =
      runBody !== null &&
      verifyRunBody(
        {
          ...runBody,
          quorum: {
            ...runBody.quorum,
            providers: (runBody.quorum?.providers ?? []).map((entry, index) =>
              index === 0
                ? { ...entry, attestation: { ...entry.attestation, challenge: "00".repeat(32) } }
                : entry,
            ),
          },
        },
        spec,
      ).correct === false;
    // The enclave's own code: every provider runs the same code, the deployment
    // pins that digest, and a code the providers do not run is refused.
    const codePinned =
      typeof providerCards[0].independence?.code === "string" &&
      providerCards.every((entry) => entry.independence?.code === providerCards[0].independence.code) &&
      spec.teeCodeMeasurement === providerCards[0].independence.code &&
      (runBody?.quorum?.providers ?? []).every(
        (entry) => entry.attestation?.code === providerCards[0].independence.code,
      );
    const wrongCode = await runCli([
      "deploy",
      "--web4",
      ...providerUrls.flatMap((url) => ["--provider", url]),
      "--quorum",
      String(providerUrls.length),
      "--tee-vendor",
      HARDWARE_ROOT_KEY_ID,
      "--tee-code",
      "0".repeat(64),
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "quote-badcode"),
      "--json",
    ]);
    const codeRefused =
      wrongCode.status !== 0 &&
      /code measurement/.test((wrongCode.stderr || "") + (wrongCode.stdout || ""));
    // The code digest is bound to a VENDOR-SIGNED image manifest whose chain
    // terminates at the SHIPPED hardware root. The deployment pins the root, so a
    // manifest signed by a bare (self-rooted) key is refused even though valid.
    const manifestOk =
      spec.teeSignedImage === HARDWARE_ROOT_KEY_ID &&
      spec.teeSignedImageDepth === 2 &&
      providerCards.every((entry) => {
        const info = verifyImageManifest(entry.independence?.image);
        return (
          info !== null &&
          info.rootKeyId === HARDWARE_ROOT_KEY_ID &&
          info.vendorKeyId === manifestLeaf.keyId &&
          info.chainDepth >= 2 &&
          info.image === providerCards[0].independence.code &&
          // The measured boot's app stage IS the signed image.
          providerStageMeasurements(entry.independence).app === info.image
        );
      }) &&
      (runBody?.quorum?.providers ?? []).every((entry) => {
        const info = verifyImageManifest(entry.attestation?.image);
        return (
          info !== null &&
          info.rootKeyId === HARDWARE_ROOT_KEY_ID &&
          info.chainDepth >= 2 &&
          providerStageMeasurements(entry.attestation).app === info.image
        );
      });
    // The same leaf key with no chain: a real signature, but self-rooted, so its
    // root is the leaf and not the pinned hardware root.
    const bareInfo = verifyImageManifest(bareManifest);
    const bareRefused =
      bareInfo !== null &&
      bareInfo.vendorKeyId === manifestLeaf.keyId &&
      bareInfo.rootKeyId !== HARDWARE_ROOT_KEY_ID;
    // A manifest signed DIRECTLY by the anchor: the root matches, but it presents
    // no chain, so a pinned minimum depth refuses it too.
    const rootSignedManifest = signImageManifest(
      { image: runtimeCodeMeasurement(), runtime: "rarext-runtime" },
      hardwareRootSigner(),
    );
    const rootSignedInfo = verifyImageManifest(rootSignedManifest);
    const depthRefused =
      rootSignedInfo !== null &&
      rootSignedInfo.rootKeyId === HARDWARE_ROOT_KEY_ID &&
      rootSignedInfo.chainDepth === 0;
    // A boot chain whose app stage is NOT the signed image: both attestations are
    // individually valid, but they disagree about the code, so the run is refused.
    const { chain: incoherentChain } = issueMeasuredBootChain(
      providerCards[0].independence.quote.publicKey,
      { app: "0".repeat(64) },
    );
    const incoherentAttestation = {
      ...providerCards[0].independence,
      quote: { ...providerCards[0].independence.quote, chain: incoherentChain },
    };
    const appMismatchRefused =
      verifyProviderChain(incoherentAttestation) === HARDWARE_ROOT_KEY_ID &&
      providerStageMeasurements(incoherentAttestation).app !==
        verifyImageManifest(incoherentAttestation.image).image &&
      verifyRunBody(
        {
          ...runBody,
          quorum: {
            ...runBody.quorum,
            providers: (runBody.quorum?.providers ?? []).map((entry, index) =>
              index === 0 ? { ...entry, attestation: incoherentAttestation } : entry,
            ),
          },
        },
        spec,
      ).correct === false;
    const wrongSignedImage = await runCli([
      "deploy",
      "--web4",
      ...providerUrls.flatMap((url) => ["--provider", url]),
      "--quorum",
      String(providerUrls.length),
      "--tee-vendor",
      HARDWARE_ROOT_KEY_ID,
      "--tee-signed-image",
      "0".repeat(64),
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "quote-badimage"),
      "--json",
    ]);
    const signedImageRefused =
      wrongSignedImage.status !== 0 &&
      /signed-image/.test((wrongSignedImage.stderr || "") + (wrongSignedImage.stdout || ""));
    // A depth the providers cannot satisfy (their chains are depth 2) is refused
    // at deploy time, so a shallow manifest cannot slip through.
    const wrongDepth = await runCli([
      "deploy",
      "--web4",
      ...providerUrls.flatMap((url) => ["--provider", url]),
      "--quorum",
      String(providerUrls.length),
      "--tee-vendor",
      HARDWARE_ROOT_KEY_ID,
      "--tee-signed-image",
      HARDWARE_ROOT_KEY_ID,
      "--tee-signed-image-depth",
      "3",
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "quote-baddepth"),
      "--json",
    ]);
    const depthCliRefused =
      wrongDepth.status !== 0 &&
      /signed-image-depth/.test((wrongDepth.stderr || "") + (wrongDepth.stdout || ""));
    // A vendor pin the providers cannot satisfy is refused at deploy time.
    const wrongPin = await runCli([
      "deploy",
      "--web4",
      ...providerUrls.flatMap((url) => ["--provider", url]),
      "--quorum",
      String(providerUrls.length),
      "--tee-vendor",
      "0".repeat(64),
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "quote-badpin"),
      "--json",
    ]);
    const runAttested =
      Array.isArray(runBody?.quorum?.providers) &&
      runBody.quorum.providers.every((entry) => entry.attestation !== undefined);

    quoteOk =
      deployment.labels.teeVendor === anchorKeyId &&
      spec.teeVendor === anchorKeyId &&
      spec.teeChainDepth === 3 &&
      Array.isArray(spec.teeBootStages) &&
      requiredStages.every((stage) => spec.teeBootStages.includes(stage)) &&
      cardsQuote &&
      chainRefused &&
      stagelessRefused &&
      measurementsPinned &&
      spec.teeStageMeasurements?.firmware === teeLeaves[0].measurements.firmware &&
      wrongMeasurementRefused &&
      freshnessOk &&
      freshnessRefused &&
      codePinned &&
      codeRefused &&
      manifestOk &&
      bareRefused &&
      depthRefused &&
      depthCliRefused &&
      appMismatchRefused &&
      signedImageRefused &&
      runAttested &&
      wrongPin.status !== 0 &&
      /machine quote/.test((wrongPin.stderr || "") + (wrongPin.stdout || ""));
    quoteDetail =
      `vendor root ${anchorKeyId.slice(0, 14)}… pinned at depth 3; each provider's leaf -> os -> firmware -> root ` +
      `chain measures every stage to the approved value; a nonce-freshness challenge bound one nonce across the run; ` +
      `the enclave's code digest is bound to an image manifest whose chain reaches the hardware root at depth 2, and ` +
      `the boot chain's app stage equals that signed image; a manifest signed directly by the root, a boot chain whose ` +
      `app stage is not the signed image, a chain rooted elsewhere, a chain with no boot stages, a chain running ` +
      `unapproved firmware, a replayed (stale) attestation, unapproved enclave code, and a manifest whose chain never ` +
      `reaches the root were refused`;
  } catch (error) {
    quoteOk = false;
    quoteDetail = error instanceof Error ? error.message : String(error);
  }
  phase("quote", quoteOk, quoteDetail);

  // ── 12d1b. Memory isolation: a host-readable enclave is refused ──────────
  // The software-only enclave's own host root can read its memory. A deployment
  // can demand that its provider's VENDOR-SIGNED image certify the host root is
  // excluded; a provider whose signed image does not carry the capability is
  // refused, so memory isolation is a checked, vendor-certified capability rather
  // than an assumption about the operator's box.
  let isolationOk = false;
  let isolationDetail = "";
  let isolationGateway = null;
  try {
    const isolationDeployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { ...deployment.engine, endpoint: providerUrls[0] },
          model: deployment.model,
          apis: ["openai"],
          models: [deployment.model],
        },
        hardware: deployment.hardware,
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: deployment.labels.bundle,
          shardsRoot: deployment.labels.shardsRoot,
          manifestHash: deployment.labels.manifestHash,
          providers: providerUrls[0],
          operators: providerCards[0].provider.keyId,
          machines: providerCards[0].independence.machine,
          independence: "machine",
          quorum: "1",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          teeSignedImageDepth: "2",
          teeCodeMeasurement: providerCards[0].independence.code,
          teeIsolation: "host-root-excluded",
          ...(deployment.labels.engineFingerprint
            ? { engineFingerprint: deployment.labels.engineFingerprint }
            : {}),
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const isolationSpec = runSpecFromChallenge(challengeFor(isolationDeployment));
    const manifestIsolated =
      verifyImageManifest(providerCards[0].independence.image)?.isolation === "host-root-excluded";

    // The deploy CLI refuses a host-readable fleet before any run happens.
    const refusedDeploy = await runCli([
      "deploy",
      "--web4",
      "--provider",
      providerUrls[0],
      "--quorum",
      "1",
      "--tee-vendor",
      HARDWARE_ROOT_KEY_ID,
      "--tee-signed-image",
      HARDWARE_ROOT_KEY_ID,
      "--tee-signed-image-depth",
      "2",
      "--tee-isolation",
      "host-root-excluded",
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "isolation-deploy"),
      "--json",
    ]);
    const deployRefused =
      refusedDeploy.status !== 0 &&
      /--tee-isolation is not certified/.test(
        (refusedDeploy.stderr || "") + (refusedDeploy.stdout || ""),
      );

    isolationGateway = await startGateway({
      deployment: isolationDeployment,
      ledgerDir: join(state, "gateway-isolation"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [providerUrls[0]],
      quorum: 1,
      operators: { [providerUrls[0]]: providerCards[0].provider.keyId },
      machines: { [providerUrls[0]]: providerCards[0].independence.machine },
      attestations: { [providerUrls[0]]: providerCards[0].independence },
    });
    const refusedRun = await fetch(`${isolationGateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: isolationDeployment.model.id,
        messages: [{ role: "user", content: "can the host read this?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });

    isolationOk =
      isolationSpec.teeIsolation === "host-root-excluded" &&
      !manifestIsolated &&
      deployRefused &&
      refusedRun.status === 503 &&
      new RunLedger(join(state, "gateway-isolation")).records().length === 0;
    isolationDetail = isolationOk
      ? `the deployment demanded vendor-certified memory isolation ("host-root-excluded"); the providers' signed ` +
        `images do not certify it, so deploy --tee-isolation refused the fleet and the gateway refused the run ` +
        `(${refusedRun.status}) rather than treat a host-readable box as confidential`
      : `spec=${String(isolationSpec.teeIsolation)} manifestIsolated=${String(manifestIsolated)} ` +
        `deployRefused=${String(deployRefused)} run=${refusedRun.status}`;
  } catch (error) {
    isolationOk = false;
    isolationDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (isolationGateway !== null) await isolationGateway.close().catch(() => {});
  }
  phase("isolation", isolationOk, isolationDetail);

  // ── 12d2. Root rotation: the trust root can move, and stale roots are refused
  // The trust anchor is a shipped key, but it is not static forever: each
  // retirement is a signed, append-only step from the CURRENT root to the next.
  // A quote must present a chain that reaches the root in force; a quote still
  // rooted at a retired anchor is stale once the deployment has learned the move.
  let rotateOk = false;
  let rotateDetail = "";
  try {
    const newRoot = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const rotation = issueRootRotation({
      fromSigner: hardwareRootSigner(),
      nextSigner: newRoot,
      epoch: 1,
      previous: null,
      issuedAt: "2026-11-07T00:00:00.000Z",
    });
    const rootChain = {
      kind: ROOT_CHAIN_KIND,
      anchor: HARDWARE_ROOT_KEY_ID,
      rotations: [rotation],
    };
    const chainInfo = verifyRootChain(rootChain, HARDWARE_ROOT_KEY_ID);
    const chainOk =
      chainInfo !== null && chainInfo.current === newRoot.keyId && chainInfo.epoch === 1;

    // The live providers still terminate at the retired anchor: valid at epoch 0,
    // stale once epoch 1 is pinned.
    const anchorCurrent =
      verifyProviderRootChain(providerCards[0].independence, HARDWARE_ROOT_KEY_ID, 0)?.current ===
      HARDWARE_ROOT_KEY_ID;
    const anchorStale =
      verifyProviderRootChain(providerCards[0].independence, HARDWARE_ROOT_KEY_ID, 1) === null;

    // A certificate chain that terminates at the NEW root, carried with the
    // rotation chain that proves it is the current one.
    const leafQuote = providerCards[0].independence.quote;
    const platform = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const rotatedChain = [
      issueProviderCertificate({ subject: leafQuote.publicKey, issuerSigner: platform }),
      issueProviderCertificate({ subject: platform.publicKey, issuerSigner: newRoot }),
    ];
    const rotatedAttestation = {
      ...providerCards[0].independence,
      quote: { ...leafQuote, chain: rotatedChain, rootChain },
    };
    const rooted = verifyProviderRootChain(rotatedAttestation, HARDWARE_ROOT_KEY_ID, 1);
    const rotatedAccepted =
      rooted !== null && rooted.current === newRoot.keyId && rooted.epoch === 1;

    // Revoking the new root refuses a quote that terminates at it.
    const revokedRotation = issueRootRotation({
      fromSigner: hardwareRootSigner(),
      nextSigner: newRoot,
      epoch: 1,
      previous: null,
      revoke: [newRoot.keyId],
    });
    const revokedAttestation = {
      ...rotatedAttestation,
      quote: {
        ...rotatedAttestation.quote,
        rootChain: { ...rootChain, rotations: [revokedRotation] },
      },
    };
    const revokedRefused =
      verifyProviderRootChain(revokedAttestation, HARDWARE_ROOT_KEY_ID, 1) === null;

    // Claiming a new root whose key does not match its advertised key id is a
    // forged handover: the chain is refused.
    const tamperedChain = verifyRootChain(
      { ...rootChain, rotations: [{ ...rotation, nextPublicKey: leafQuote.publicKey }] },
      HARDWARE_ROOT_KEY_ID,
    );
    const tamperRefused = tamperedChain === null;

    // A deployment that has learned epoch 1 refuses the live (stale) providers
    // at deploy time.
    const staleDeploy = await runCli([
      "deploy",
      "--web4",
      ...providerUrls.flatMap((url) => ["--provider", url]),
      "--quorum",
      String(providerUrls.length),
      "--tee-vendor",
      HARDWARE_ROOT_KEY_ID,
      "--tee-root-epoch",
      "1",
      "--registry",
      baseUrl,
      "--allow-loopback",
      "--out",
      join(state, "rotate-stale"),
      "--json",
    ]);
    const staleRefused =
      staleDeploy.status !== 0 &&
      /reachable from every provider's root chain/.test(
        (staleDeploy.stderr || "") + (staleDeploy.stdout || ""),
      );

    rotateOk =
      chainOk && anchorCurrent && anchorStale && rotatedAccepted && revokedRefused && tamperRefused && staleRefused;
    rotateDetail = rotateOk
      ? `the shipped anchor rotated to a new root signed by the retiring root (epoch 1); a quote chaining to the new root was accepted, while a quote still rooted at the retired anchor, a chain revoked at the new root, a handover with a mismatched key, and a deploy pinning epoch 1 over stale providers were all refused`
      : `chain=${String(chainOk)} anchorCurrent=${String(anchorCurrent)} stale=${String(anchorStale)} accepted=${String(rotatedAccepted)} revoked=${String(revokedRefused)} tamper=${String(tamperRefused)} staleDeploy=${String(staleRefused)}`;
  } catch (error) {
    rotateDetail = error instanceof Error ? error.message : String(error);
  }
  phase("rotate", rotateOk, rotateDetail);

  // ── 12e. Engine pin: a replay refuses a provider whose engine changed ────
  // An arbitrary GGUF cannot be reproduced bit-for-bit by the protocol alone.
  // What the protocol does instead: pin the serving engine in the deployment
  // (name, version, digest → one fingerprint), record it in the run, and refuse
  // to call it a replay unless the provider's present engine matches.
  let enginePinOk = false;
  let enginePinDetail = "";
  let badEngineProvider = null;
  try {
    const pin = deployment.labels.engineFingerprint;
    const healthA = await getJson(`${providerUrls[0]}/health`);
    const runBody = publishedBody ?? localRecord?.body ?? null;
    const specHasPin = spec.engineFingerprint === pin;
    const runRecordsPin = runBody?.engine?.fingerprint === pin;
    const providerMatches = healthA.engineFingerprint === pin;

    // The verifier recomputes the pin: a run naming another engine is refused.
    const swappedOk =
      runBody !== null &&
      verifyRunBody(
        { ...runBody, engine: { ...runBody.engine, fingerprint: "0".repeat(64) } },
        spec,
      ).correct === false;

    writeJsonFile(join(state, "run.json"), runBody);

    // A provider running a different engine build is refused by replay. Native
    // only: an engine provider would reload the whole model just to answer
    // /health, which the demo does not pay for twice.
    let liveRefusal = true;
    let liveDetail = "the verifier refused a run that named another engine";
    if (!real) {
      const badPort = await freePort();
      badEngineProvider = spawnProcess(
        [
          "apps/runtime/src/cli.ts",
          "provider",
          "--bundle",
          join(state, "model-bundle.json"),
          "--registry",
          baseUrl,
          "--state",
          join(state, "provider-badengine"),
          "--port",
          String(badPort),
          ...(seal && sealKeyPath !== null ? ["--seal-key-file", sealKeyPath] : []),
          "--engine-version",
          "other-engine",
        ],
        {},
        (line) => {
          const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
          return match ? match[1].replace(/\/$/, "") : null;
        },
      );
      const badUrl = await badEngineProvider.ready;
      const refused = await runCli([
        "replay",
        "--transcript",
        join(state, "run.json"),
        "--endpoint",
        badUrl,
        "--json",
      ]);
      liveRefusal =
        refused.status !== 0 && /engine/.test((refused.stderr || "") + (refused.stdout || ""));
      liveDetail = "a provider on another engine was refused by replay";
    }

    enginePinOk =
      typeof pin === "string" &&
      /^[0-9a-f]{64}$/.test(pin) &&
      specHasPin &&
      runRecordsPin &&
      providerMatches &&
      swappedOk &&
      liveRefusal;
    enginePinDetail =
      `engine ${String(pin).slice(0, 16)}… pinned in the deployment and the run; the provider matches; ` +
      liveDetail;
  } catch (error) {
    enginePinOk = false;
    enginePinDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (badEngineProvider !== null) badEngineProvider.stop();
  }
  phase("engine-pin", enginePinOk, enginePinDetail);

  // ── 12h. Enclave: the process on the wire never holds the plaintext ──────
  // The model is sealed to an enclave's public key. A forwarding provider holds
  // only the committed ciphertext and forwards inference to the enclave, which
  // alone unwraps and decrypts. No plaintext key file is written by the bundle.
  let enclaveOk = false;
  let enclaveDetail = "";
  let enclaveProc = null;
  let forwarderProc = null;
  try {
    const enclavePubPath = join(state, "enclave-pub.pem");
    const enclaveKeyPath = join(state, "enclave-key.pem");
    const enclaveKeys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(enclavePubPath, enclaveKeys.publicKey);
    writeFileSync(enclaveKeyPath, enclaveKeys.privateKey, { mode: 0o600 });

    const enclaveOut = join(state, "enclave-bundle");
    const sealed = await runCli([
      "bundle",
      "--native",
      "--model",
      "enclave-proof",
      "--vocab",
      "RAREXT,enclave,sealed,weights,never,plaintext",
      "--steps",
      "8",
      "--seal-to",
      enclavePubPath,
      "--registry",
      baseUrl,
      "--out",
      enclaveOut,
      "--chunk-bytes",
      "97",
      "--json",
    ]);
    if (sealed.status !== 0) throw new Error(`enclave bundle failed: ${sealed.stderr || sealed.stdout}`);
    const sealedReport = JSON.parse(sealed.stdout);
    const enclaveBundle = sealedReport.bundle;
    const bundleJson = join(enclaveOut, "model-bundle.json");

    const readyUrl = (line) => {
      const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
      return match ? match[1].replace(/\/$/, "") : null;
    };
    enclaveProc = spawnProcess(
      [
        "apps/runtime/src/cli.ts",
        "provider",
        "--bundle",
        bundleJson,
        "--registry",
        baseUrl,
        "--state",
        join(state, "enclave-state"),
        "--port",
        String(await freePort()),
        "--enclave-key-file",
        enclaveKeyPath,
        "--tee-key-file",
        teeLeaves[0].leafPath,
        "--tee-cert-file",
        teeLeaves[0].certPath,
      ],
      {},
      readyUrl,
    );
    const enclaveUrl = await enclaveProc.ready;

    forwarderProc = spawnProcess(
      [
        "apps/runtime/src/cli.ts",
        "provider",
        "--bundle",
        bundleJson,
        "--registry",
        baseUrl,
        "--state",
        join(state, "forwarder-state"),
        "--port",
        String(await freePort()),
        "--enclave-endpoint",
        enclaveUrl,
      ],
      {},
      readyUrl,
    );
    const forwarderUrl = await forwarderProc.ready;

    const forwarderHealth = await getJson(`${forwarderUrl}/health`);
    const forwarderCard = await getJson(`${forwarderUrl}/v1/provider-card`);
    const answer = await fetch(`${forwarderUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: enclaveBundle.model.id,
        messages: [{ role: "user", content: "who holds the key?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    const answerBody = await answer.json();
    const text = String(answerBody?.choices?.[0]?.message?.content ?? "");

    // A confidential prompt: the caller seals it to the enclave's public key and
    // posts CIPHERTEXT to the forwarder, which never sees the plaintext.
    const attestation = await getJson(`${enclaveUrl}/v1/attestation`);
    const secret = "the operator must never read this prompt";
    const request = {
      model: enclaveBundle.model.id,
      messages: [{ role: "user", content: secret }],
      max_tokens: 8,
      temperature: 0,
    };
    const sealedPrompt = sealRequest(attestation.enclavePublicKey, request);
    const sealedAnswer = await fetch(`${forwarderUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: enclaveBundle.model.id, confidential: sealedPrompt.sealed }),
    });
    const sealedJson = await sealedAnswer.json();
    const opened = openResponse(sealedPrompt.key, sealedJson.confidential);
    const openedText = String(opened?.choices?.[0]?.message?.content ?? "");
    const plainAnswer = await fetch(`${enclaveUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const plainText = String((await plainAnswer.json())?.choices?.[0]?.message?.content ?? "");
    const ciphertextOnly = !JSON.stringify(sealedPrompt.sealed).includes(secret);

    // The signed attestation binds the encryption key it publishes, so a caller
    // only seals to a key the attested enclave actually holds — a substituted
    // (man-in-the-middle) key is refused before any secret is encrypted to it.
    const keyBound = attestationBindsEnclaveKey(attestation.attestation, attestation.enclavePublicKey);
    const impostor = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const substitutedRefused = attestationBindsEnclaveKey(attestation.attestation, impostor.publicKey) === false;

    enclaveOk =
      sealedReport.sealKeyPath === null &&
      enclaveBundle.sealing?.wrap?.scheme === "rsa-oaep-sha256" &&
      forwarderHealth.holdsKey === false &&
      forwarderHealth.bundle === enclaveBundle.digest &&
      forwarderCard.bundle?.sealed === true &&
      text.length > 0 &&
      ciphertextOnly &&
      openedText.length > 0 &&
      openedText === plainText &&
      keyBound &&
      substitutedRefused;
    enclaveDetail =
      `the bundle is sealed to an enclave key; the forwarder holds ciphertext (holdsKey=${String(forwarderHealth.holdsKey)}); ` +
      `the attestation binds the encryption key (a substituted key is refused); a sealed prompt matched the plaintext ` +
      `answer with the prompt never on the wire: ${JSON.stringify(openedText.slice(0, 40))}`;
  } catch (error) {
    enclaveOk = false;
    enclaveDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (forwarderProc !== null) forwarderProc.stop();
    if (enclaveProc !== null) enclaveProc.stop();
  }
  phase("enclave", enclaveOk, enclaveDetail);

  // ── 12m. Mirrors: a provider serves even when its primary registry is down ─
  // The bundle is content-addressed, so any mirror holds the same bytes. A
  // provider given a DEAD primary and a live mirror fetches from the mirror.
  let mirrorOk = false;
  let mirrorDetail = "";
  let mirrorNode = null;
  let mirrorProvider = null;
  try {
    mirrorNode = spawnApi({ PORT: "0", HOST: "127.0.0.1", RAREXT_DATA: "none", RAREXT_BLOB_DIR: blobDir });
    const mirrorUrl = await mirrorNode.ready;
    const deadUrl = `http://127.0.0.1:${await freePort()}`;
    mirrorProvider = spawnProcess(
      [
        "apps/runtime/src/cli.ts",
        "provider",
        "--bundle",
        join(state, "model-bundle.json"),
        "--registry",
        deadUrl,
        "--mirror-registry",
        mirrorUrl,
        "--state",
        join(state, "mirror-provider"),
        "--port",
        String(await freePort()),
        ...(seal && sealKeyPath !== null ? ["--seal-key-file", sealKeyPath] : []),
        "--tee-key-file",
        teeLeaves[0].leafPath,
        "--tee-cert-file",
        teeLeaves[0].certPath,
      ],
      {},
      (line) => {
        const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
        return match ? match[1].replace(/\/$/, "") : null;
      },
    );
    const mirrorProviderUrl = await mirrorProvider.ready;
    const answer = await fetch(`${mirrorProviderUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "mirror" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    const text = String((await answer.json())?.choices?.[0]?.message?.content ?? "");
    mirrorOk = answer.ok && text.length > 0;
    mirrorDetail = `a provider served ${modelId} with a DEAD primary registry (${deadUrl}) by falling back to a mirror (${mirrorUrl})`;
  } catch (error) {
    mirrorOk = false;
    mirrorDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (mirrorProvider !== null) mirrorProvider.stop();
    if (mirrorNode !== null) mirrorNode.stop();
  }
  phase("mirror", mirrorOk, mirrorDetail);

  // ── 13. A corrupted shard is refused by a fresh provider ─────────────────
  const victim = bundle.shards[0].hash;
  writeFileSync(join(blobDir, victim), Buffer.from("not the committed bytes"));
  const refused = await runCli([
    "provider",
    "--bundle",
    join(state, "model-bundle.json"),
    "--registry",
    baseUrl,
    ...(seal && sealKeyPath !== null ? ["--seal-key-file", sealKeyPath] : []),
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
