#!/usr/bin/env node
/**
 * rarext-runtime — deploy a large model behind an OpenAI/Anthropic-compatible
 * endpoint, and publish every inference as a RAREXT-verifiable transcript.
 *
 *   node apps/runtime/src/cli.ts deploy  --endpoint http://127.0.0.1:11434 --model qwen2.5:0.5b
 *   node apps/runtime/src/cli.ts verifier --port 8788
 *   node apps/runtime/src/cli.ts serve   --manifest .rarext-runtime/deployment.json --publish
 *   node apps/runtime/src/cli.ts replay  --transcript run.json --endpoint http://127.0.0.1:11434
 *   node apps/runtime/src/cli.ts verify  --transcript run.json --challenge challenges.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  probeEngine,
  probeEngineCatalog,
  pullOllamaModel,
} from "./engines.ts";
import type { PullProgress } from "./engines.ts";
import {
  DEFAULT_GATEWAY_TOKEN_ENV,
  DEFAULT_UPSTREAM_KEY_ENV,
  defaultUpstreamApi,
  defaultUpstreamAuth,
  describeUpstream,
  parseUpstreamAuth,
  resolveSecret,
  upstreamHeaders,
  upstreamShapeFromLabels,
} from "./cloud.ts";
import type { UpstreamAuth, UpstreamShape } from "./cloud.ts";
import { RunLedger, writeJsonFile } from "./ledger.ts";
import { canonicalDigest } from "./digest.ts";
import { replayEngineRun } from "./replay.ts";
import { imageManifestChainDepth, verifyImageManifest } from "./image-manifest.ts";
import {
  assessModelFit,
  buildDeployment,
  commitDeployment,
  formatBytes,
  hardwareFromCloud,
  hardwareFromHost,
  hardwareFromNetwork,
  isLoopbackEndpoint,
  normalizeEndpoint,
  requireValidDeployment,
} from "./manifest.ts";
import {
  buildModelBundle,
  bundleManifestHash,
  crossCheckProviderCard,
  fetchBundleChunks,
  fetchBundleManifest,
  fetchProviderCard,
  generateSealKey,
  providerBootStages,
  providerChainDepth,
  providerStageMeasurements,
  uploadBundle,
  verifyModelBundle,
  verifyProviderChain,
} from "./model-bundle.ts";
import type { ExecutionRef, ModelBundle, ProviderCertificate } from "./model-bundle.ts";
import { loadProviderBundle, startProvider } from "./provider.ts";
import { challengeFor, challengeIdFor, challengesFile, RuntimePublisher } from "./publisher.ts";
import { AgentSigner, RarextClient } from "../../../packages/agent-sdk/src/index.ts";
import { startGateway } from "./gateway.ts";
import { auditLedger, verifyDeploymentBody, verifyRunBody } from "./transcript.ts";
import { discoverBundle, fetchAnchoredBundles, fetchVerifiedProvidersAcrossRegistries, verifiedProviders, verifiedRemoteDeployments } from "./discovery.ts";
import {
  createVerifierServer,
  runSpecFromChallenge,
  verifierConfig,
  RUNTIME_VERIFIER_MANIFEST,
} from "./verifier.ts";
import type {
  ApiShape,
  DeploymentCommitment,
  EngineName,
  HardwareBackend,
  ModelRef,
  ModelRunBody,
  ModelRunSpec,
  RunProviderAttestation,
  RunRecord,
} from "./types.ts";

const COMMANDS = [
  "plan",
  "bundle",
  "provider",
  "deploy",
  "publish-deployment",
  "anchor",
  "discover",
  "announce",
  "compare",
  "serve",
  "verifier",
  "verify",
  "replay",
  "ledger",
  "inspect",
] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  console.error(`rarext-runtime — AI lives on RAREXT

Usage: node apps/runtime/src/cli.ts <command> [options]

Commands:
  plan      list the engine's models and whether each fits this host's memory
  bundle    shard a model file into RAREXT blobs and write model-bundle.json
  provider  fetch a model bundle from RAREXT, verify it, and serve it
  deploy    probe an engine and write deployment.json + challenges.json + verifiers.json
  publish-deployment  publish the deployment commitment (a model card) to RAREXT
  anchor    anchor pending publications on a RAREXT registry
  discover  verify every model card and run in a bundle, without a server
  announce  publish a provider's card under a model challenge
  compare   verify several providers of one bundle and compare their answers
  serve     serve the attested OpenAI/Anthropic gateway in front of a deployment
  verifier  run the HTTP verifier a RAREXT node calls
  verify    verify a transcript offline against a challenge
  replay    re-run a transcript against the live engine and compare the output
  ledger    verify an append-only run ledger
  inspect   print a manifest's digest and fields

Common options:
  --endpoint <url>      engine base URL (default http://127.0.0.1:11434 for deploy)
  --engine <name>       ollama | strata | freetoken | openai-compatible | anthropic
  --model <id>          engine-native model id
  --remote              commit a cloud deployment; no weights or inference run here
  --web4                commit a RAREXT provider; weights are storage blobs
  --provider <url>      the web4 provider endpoint to adopt (defaults to --endpoint)
  --file <path>         model file to shard with bundle, or native JSON model
  --native              build a deterministic xorshift32 model from --vocab
  --vocab <a,b,c>       comma-separated tokens for --native
  --params <a,b,c>      xorshift32 shifts for --native (default 13,17,5)
  --steps <n>           default token count for a native provider (default 32)
  --execution <kind>    native | engine for a bundle (default engine)
  --engine-model <id>   engine-native name a provider creates (default bundle id)
  --chunk-bytes <n>     shard size for bundle (default 8 MiB)
  --seal                store the shards as ciphertext; write the key beside the bundle
  --seal-key-file <p>   read a seal key (64 hex chars or 32 bytes) for bundle/provider/deploy
  --seal-to <pem>       seal to an enclave: wrap the key to its public key, write no key file
  --enclave-key-file <pem>  this process is the enclave: unwrap the model with its private key
  --enclave-endpoint <url>  forward inference to an enclave; hold ciphertext and no key
  --machine <id>        the machine identity a provider attests (default: host fingerprint)
  --measurement <hex>   the software/image measurement a provider attests (default: machine digest)
  --measure <hex,...>   deploy: allowlist of measurements a provider must match
  --engine-version <v>  the serving engine's version, pinned by its fingerprint
  --engine-digest <hex> the serving engine's image digest, pinned by its fingerprint
  --engine-logprobs     ask the engine for token logprobs and record a decode judgment
  --tee-key-file <p>    the leaf/attestation key that signs a provider's machine quote
  --tee-cert-file <p>   certificates chaining the leaf key up to the trust anchor
  --tee-vendor <keyId>  deploy: the trust-anchor key id a quote's chain must terminate at
  --tee-chain-depth <n> deploy: minimum chain depth (2 = leaf -> platform -> vendor root)
  --tee-boot-stages <list> deploy: measured-boot stages the chain must name (e.g. firmware,os,app)
  --tee-boot-measurements <list> deploy: per-stage measurements (e.g. firmware=<hex>,os=<hex>,app=<hex>)
  --tee-freshness <k>   deploy: "challenge" — require a fresh nonce-bound attestation per run
  --tee-code <hex>      deploy: the enclave code measurement providers must attest
  --code-measurement <hex>  provider: override the measured code digest (default: this runtime)
  --image-manifest <p>      provider: a vendor-signed image manifest vouching for the running code
  --tee-signed-image <keyId>  deploy: the vendor root the image manifest's chain must reach
  --tee-signed-image-depth <n> deploy: minimum image-manifest chain depth (1 = certified by the root)
  --require-trace       deploy: require every run to carry a decode trace (native tokens or engine logprobs)
  --require-replay      deploy: require every run to be replayable (temperature 0 + seed, committed envelope)
  --independence <k>    "machine": require the quorum over distinct provider machines
  --manifest-hash <hex> fetch the bundle manifest by content address
  --verify-shards       download and hash every shard at deploy time
  --allow-loopback      permit --remote/--web4 against 127.0.0.1 (test fixtures only)
  --upstream-api <api>  openai | anthropic (the remote engine's native shape)
  --upstream-auth <a>   none | bearer | x-api-key (default follows the API shape)
  --upstream-key-env <name>  environment variable holding the upstream key
  --manifest <path>     deployment.json (default .rarext-runtime/deployment.json)
  --deployment <id>     serve the verified remote card with this id or digest from --bundle/--registry
  --bundle <path>       a bundle to verify instead of fetching one from --registry
  --state <dir>         runtime state directory (default .rarext-runtime)
  --backend <name>      cpu | metal | cuda | rocm | vulkan | cloud | unknown
  --device <label>      device label recorded in the manifest
  --pull                fetch a missing Ollama model before committing it (local only)
  --out <dir>           where deploy writes files (default .rarext-runtime)
  --port <n>            gateway port (default 8790) or verifier port (default 8788)
  --host <host>         bind host (default 127.0.0.1; use 0.0.0.0 in a cloud container)
  --public-url <url>    URL clients use when the bind host is not dialable
  --gateway-token-env <name>  environment variable holding the gateway bearer token
  --publish             publish run transcripts to RAREXT
  --anchor              anchor after publishing (publish-deployment)
  --registry <url>      RAREXT API base (default http://127.0.0.1:8787; plan reads its cards)
  --mirror-registry <url>  extra registry(ies) a provider fetches the bundle from (repeatable)
  --handle <name>       runtime publication handle (default rarext-runtime)
  --challenge <id>      challenge id to publish under (default derived from manifest)
  --transcript <path>   run record JSON for verify/replay
  --challenge <path>    challenge file for verify (same flag, disambiguated by command)
  --json                machine-readable output
`);
  process.exit(2);
}

function flag(values: Record<string, unknown>, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * A repeatable string option. Node's parseArgs returns an array when the option
 * is declared `multiple`, a single string otherwise; callers want both.
 */
function flags(values: Record<string, unknown>, name: string): string[] {
  const value = values[name];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function bool(values: Record<string, unknown>, name: string): boolean {
  return values[name] === true;
}

/**
 * The registries a command may use: the primary `--registry` plus any
 * `--mirror-registry` values, normalized and de-duplicated. A bundle is
 * content-addressed, so the union of several registries is still verifiable —
 * and naming more than one means no single registry is a hard dependency.
 */
function registryList(values: Record<string, unknown>, primary: string): string[] {
  const all = [primary, ...flags(values, "mirror-registry")].map((entry) =>
    entry.replace(/\/+$/, ""),
  );
  return [...new Set(all.filter((entry) => entry !== ""))];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Read a seal key file: 64 hex characters (what `bundle --seal` writes) or the
 * raw 32 bytes. Anything else is refused rather than hashed into a wrong key.
 */
/**
 * Read a vendor/attestation key file: a JWK private key, or an object with a
 * `privateKey` (what the demo writes). Refused rather than guessed at.
 */
function readTeeSigner(path: string): { sign(payload: unknown): string; publicKey: unknown; suite: string } {
  const value = readJson(path) as Record<string, unknown>;
  const privateKey =
    value.privateKey !== undefined
      ? (value.privateKey as never)
      : (value as never);
  try {
    return new AgentSigner(privateKey);
  } catch (error) {
    throw new Error(`tee key at ${path} is not a usable private key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read a certificate chain file: a JSON array, or `{ "chain": [...] }`. */
function readTeeChain(path: string): ProviderCertificate[] {
  const value = readJson(path) as unknown;
  if (Array.isArray(value)) return value as ProviderCertificate[];
  if (value !== null && typeof value === "object" && Array.isArray((value as { chain?: unknown }).chain)) {
    return (value as { chain: ProviderCertificate[] }).chain;
  }
  throw new Error(`tee certificate chain at ${path} must be an array or { "chain": [ ... ] }`);
}

function readSealKeyFile(path: string): Buffer {
  const raw = readFileSync(path);
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (raw.length === 32) return Buffer.from(raw);
  throw new Error(`seal key at ${path} must be 64 hex characters or 32 raw bytes`);
}

function specFromChallengeFile(path: string): ModelRunSpec {
  const challengeFile = readJson(path) as unknown;
  const challenge =
    typeof challengeFile === "object" && challengeFile !== null && "challenges" in challengeFile
      ? (challengeFile as { challenges: unknown[] }).challenges[0]
      : challengeFile;
  return runSpecFromChallenge(challenge);
}

interface UpstreamOptions {
  api: ApiShape;
  auth: UpstreamAuth;
  keyEnv: string;
  token: string | null;
  headers: Record<string, string>;
}

function upstreamOptions(
  values: Record<string, unknown>,
  engine: EngineName,
  fallback?: UpstreamShape,
): UpstreamOptions {
  const api = (flag(values, "upstream-api") as ApiShape | undefined) ?? fallback?.api ?? defaultUpstreamApi(engine);
  const auth = parseUpstreamAuth(
    flag(values, "upstream-auth"),
    fallback?.auth ?? defaultUpstreamAuth(api),
  );
  const keyEnv = flag(values, "upstream-key-env") ?? DEFAULT_UPSTREAM_KEY_ENV;
  const token = auth === "none" ? null : resolveSecret(keyEnv);
  return {
    api,
    auth,
    keyEnv,
    token,
    headers: upstreamHeaders({ api, auth, token }),
  };
}

function loadBody(path: string): ModelRunBody {
  let value: unknown;

  if (path.endsWith(".jsonl")) {
    // A ledger is one record per line; the latest line is the run a caller
    // usually wants to verify or replay.
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) throw new Error(`ledger is empty: ${path}`);
    value = JSON.parse(lines[lines.length - 1]);
  } else {
    value = readJson(path);
  }

  if (typeof value === "object" && value !== null && "body" in value) {
    return (value as RunRecord).body;
  }
  return value as ModelRunBody;
}

function deploymentFrom(values: Record<string, unknown>): DeploymentCommitment {
  const manifestPath = resolve(flag(values, "manifest") ?? join(flag(values, "state") ?? ".rarext-runtime", "deployment.json"));
  const value = readJson(manifestPath) as unknown;
  const manifest = requireValidDeployment(value);
  const digest = (value as { digest?: unknown }).digest;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)
    ? { ...manifest, digest }
    : commitDeployment(manifest);
}

const DEFAULT_REGISTRY = "http://127.0.0.1:8787";

async function loadBundle(values: Record<string, unknown>): Promise<{ bundle: unknown; source: string }> {
  const bundlePath = flag(values, "bundle");
  if (bundlePath) {
    const path = resolve(bundlePath);
    return { bundle: readJson(path), source: path };
  }

  const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const response = await fetch(`${registry}/v1/bundles/latest`);
  if (!response.ok) {
    throw new Error(`registry returned HTTP ${response.status} for ${registry}/v1/bundles/latest`);
  }
  return { bundle: (await response.json()) as unknown, source: registry };
}

/** A remote card a bundle proves, or a local manifest when none was named. */
async function deploymentForServe(
  values: Record<string, unknown>,
): Promise<{ deployment: DeploymentCommitment; provenance: string | null }> {
  const selector = flag(values, "deployment");
  if (selector === undefined) {
    return { deployment: deploymentFrom(values), provenance: null };
  }
  if (flag(values, "manifest") !== undefined) {
    throw new Error("--deployment reads a published card; omit --manifest, or pass --manifest without --deployment");
  }

  const { bundle, source } = await loadBundle(values);
  const { deployments, error } = verifiedRemoteDeployments(bundle);
  if (deployments.length === 0) throw new Error(error ?? "the bundle carries no verified remote model card");

  const match = deployments.find(
    (entry) => entry.card.deploymentId === selector || entry.deployment.digest === selector,
  );
  if (match === undefined) {
    const available = deployments.map((entry) => entry.card.deploymentId).join(", ");
    throw new Error(`no verified remote card matches "${selector}" (bundle has ${available})`);
  }

  const root =
    typeof bundle === "object" && bundle !== null
      ? (bundle as { manifest?: { root?: unknown } }).manifest?.root
      : undefined;
  const provenance =
    `verified from ${source}` + (typeof root === "string" ? ` root ${root.slice(0, 16)}…` : "");
  return { deployment: match.deployment, provenance };
}

async function commandPlanCatalog(values: Record<string, unknown>): Promise<number> {
  const { bundle, source } = await loadBundle(values);
  const { deployments, error } = verifiedRemoteDeployments(bundle);
  if (deployments.length === 0) throw new Error(error ?? "no verified remote model card");

  const cards = deployments.map(({ card, deployment }) => ({
    deploymentId: card.deploymentId,
    deploymentDigest: deployment.digest,
    modelId: card.modelId,
    quantization: card.quantization,
    engine: card.engine,
    endpoint: deployment.engine.endpoint,
    attested: card.attested,
    verified: card.verified,
    placement: card.placement,
  }));

  if (bool(values, "json")) {
    console.log(JSON.stringify({ placement: "network", source, cards }, null, 2));
    return 0;
  }

  console.log(`network model cards from ${source}`);
  console.log("no host-memory verdict: inference runs at the endpoint, not on this machine");

  const idWidth = Math.max(10, ...cards.map((card) => card.deploymentId.length));
  const modelWidth = Math.max(5, ...cards.map((card) => card.modelId.length));
  const engineWidth = Math.max(6, ...cards.map((card) => card.engine.length));

  console.log("");
  console.log(
    `${"deployment".padEnd(idWidth)}  ${"digest".padEnd(12)}  ${"model".padEnd(modelWidth)}  ` +
      `${"engine".padEnd(engineWidth)}  endpoint`,
  );
  for (const card of cards) {
    console.log(
      `${card.deploymentId.padEnd(idWidth)}  ${card.deploymentDigest.slice(0, 12).padEnd(12)}  ` +
        `${card.modelId.padEnd(modelWidth)}  ${card.engine.padEnd(engineWidth)}  ${card.endpoint}`,
    );
  }
  return 0;
}

async function commandPlan(values: Record<string, unknown>): Promise<number> {
  if (flag(values, "endpoint") === undefined && (flag(values, "registry") !== undefined || flag(values, "bundle") !== undefined)) {
    return commandPlanCatalog(values);
  }

  const remote = bool(values, "remote") || flag(values, "placement") === "remote";
  const endpoint = normalizeEndpoint(
    flag(values, "endpoint") ?? (remote ? "" : "http://127.0.0.1:11434"),
  );
  if (endpoint === "") throw new Error("--endpoint is required with --remote");
  const engine = (flag(values, "engine") as EngineName | undefined) ?? (remote ? "openai-compatible" : undefined);
  const upstream = upstreamOptions(values, engine ?? "openai-compatible");
  const hardware = hardwareFromHost(
    (flag(values, "backend") as HardwareBackend | undefined) ?? "unknown",
    flag(values, "device") ?? null,
  );

  const catalog = await probeEngineCatalog({
    endpoint,
    engine,
    api: remote ? upstream.api : undefined,
    headers: upstream.headers,
  });
  const rows = catalog.models.map((model) => ({
    model,
    fit: remote ? null : assessModelFit(model, hardware),
  }));

  if (bool(values, "json")) {
    console.log(
      JSON.stringify(
        {
          placement: remote ? "remote" : "local",
          engine: catalog.engine,
          hardware: remote ? null : hardware,
          upstream: remote ? describeUpstream(upstream) : null,
          models: rows,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    `engine    ${catalog.engine.name}${catalog.engine.version ? ` ${catalog.engine.version}` : ""} at ${catalog.engine.endpoint}`,
  );
  if (remote) {
    console.log(
      `placement remote — inference runs on ${catalog.engine.endpoint}; this host's memory is not used`,
    );
  } else {
    console.log(
      `hardware  ${hardware.backend}${hardware.device ? ` / ${hardware.device}` : ""} on ${hardware.os} ${hardware.arch}` +
        (hardware.memoryBytes === null ? "" : ` (${formatBytes(hardware.memoryBytes)} host memory)`),
    );
  }

  if (rows.length === 0) {
    console.log("\nthe engine advertises no models — pull or load one first");
    return 0;
  }

  const idWidth = Math.max(5, ...rows.map(({ model }) => model.id.length));
  const quantWidth = Math.max(5, ...rows.map(({ model }) => (model.quantization ?? "-").length));
  const sizeWidth = 10;

  console.log("");
  console.log(
    `${"model".padEnd(idWidth)}  ${"quant".padEnd(quantWidth)}  ${"weights".padStart(sizeWidth)}  ${remote ? "placement" : "fit"}`,
  );
  for (const { model, fit } of rows) {
    console.log(
      `${model.id.padEnd(idWidth)}  ${(model.quantization ?? "-").padEnd(quantWidth)}  ` +
        `${(fit?.modelBytes === null || fit === null ? (model.sizeBytes === null ? "?" : formatBytes(model.sizeBytes)) : formatBytes(fit.modelBytes)).padStart(sizeWidth)}  ` +
        `${fit === null ? "remote" : fit.verdict}`,
    );
  }

  if (!remote) {
    const notes = rows.filter(({ fit }) => fit !== null && fit.verdict !== "fits");
    if (notes.length > 0) {
      console.log("");
      for (const { model, fit } of notes) {
        if (fit !== null) console.log(`${model.id}: ${fit.note}`);
      }
    }
  }

  return 0;
}

function parseIntegerList(value: string | undefined, field: string, count: number): number[] {
  if (value === undefined) throw new Error(`${field} is required`);
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length !== count) {
    throw new Error(`${field} must have ${count} comma-separated integers`);
  }
  return parts.map((part) => {
    const parsed = Number(part);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${field} entries must be integers`);
    return parsed;
  });
}

function modelRefFromFlags(values: Record<string, unknown>, overrides: Partial<ModelRef> = {}): ModelRef {
  const id = flag(values, "model");
  if (id === undefined || id === "") throw new Error("--model is required to name the model");
  const contextLength = flag(values, "context-length");
  return {
    id,
    family: flag(values, "family") ?? null,
    parameters: flag(values, "parameters") ?? null,
    quantization: flag(values, "quantization") ?? null,
    format: flag(values, "format") ?? null,
    sizeBytes: null,
    weightsDigest: null,
    contextLength:
      contextLength === undefined ? null : Number.isSafeInteger(Number(contextLength)) ? Number(contextLength) : null,
    ...overrides,
  };
}

/**
 * Store a model in RAREXT. The bytes are sharded, each shard is uploaded with
 * its sha256, and the bundle commits the shard list plus the whole-file digest.
 * The model file is not registered anywhere else; RAREXT storage is the model.
 */
async function commandBundle(values: Record<string, unknown>): Promise<number> {
  const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const out = resolve(flag(values, "out") ?? ".rarext-runtime");
  const native = bool(values, "native");
  const executionFlag = flag(values, "execution");
  if (executionFlag !== undefined && executionFlag !== "native" && executionFlag !== "engine") {
    throw new Error("--execution must be native or engine");
  }

  let bytes: Buffer;
  let execution: ExecutionRef;
  const overrides: Partial<ModelRef> = {};

  if (native) {
    if (executionFlag === "engine") throw new Error("--native and --execution engine cannot be combined");
    const vocab = (flag(values, "vocab") ?? "alpha,beta,gamma,delta,epsilon,zeta,eta,theta")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "");
    if (vocab.length === 0) throw new Error("--vocab must name at least one token");
    if (vocab.some((token) => token.length > 256)) {
      throw new Error("each --vocab token must be at most 256 characters");
    }

    const params = flag(values, "params") ?? "13,17,5";
    const [a, b, c] = parseIntegerList(params, "--params", 3);
    const model = { kind: "xorshift32", params: { a: a!, b: b!, c: c! }, vocab };
    const file = join(out, "native-model.json");
    writeJsonFile(file, model);
    bytes = readFileSync(file);
    overrides.family = flag(values, "family") ?? "rarext-native";
    overrides.format = flag(values, "format") ?? "json";
    overrides.quantization = flag(values, "quantization") ?? "exact";
    execution = {
      kind: "native",
      modelClass: "xorshift32",
      defaultSteps: Number(flag(values, "steps") ?? 32),
    };
  } else {
    const fileFlag = flag(values, "file");
    if (fileFlag === undefined) {
      throw new Error("--file <model file> is required (or pass --native with --vocab)");
    }
    bytes = readFileSync(resolve(fileFlag));
    const engine = (flag(values, "engine") as EngineName | undefined) ?? "ollama";
    execution =
      executionFlag === "native"
        ? {
            kind: "native",
            modelClass: "xorshift32",
            defaultSteps: Number(flag(values, "steps") ?? 32),
          }
        : {
            kind: "engine",
            engine,
            engineModel: flag(values, "engine-model") ?? flag(values, "model") ?? null,
          };
  }

  // Sealing: the shards stored on RAREXT are AES-256-GCM ciphertext, so the
  // store never holds the weights. The key is written beside the bundle (mode
  // 0600) for the provider, and only its hash is committed in the manifest.
  const sealRequested = bool(values, "seal");
  const sealKeyFlag = flag(values, "seal-key-file");
  const sealTo = flag(values, "seal-to");
  // Sealing to an enclave wraps the data key to the enclave's public key, so NO
  // plaintext key file is written: only the enclave can open the model.
  const wrapPublicKey = sealTo === undefined ? undefined : readFileSync(resolve(sealTo), "utf8");
  let sealKey: Buffer | undefined;
  let sealKeyPath: string | null = null;
  if (sealKeyFlag !== undefined) {
    sealKey = readSealKeyFile(resolve(sealKeyFlag));
    sealKeyPath = resolve(sealKeyFlag);
  } else if (sealRequested || sealTo !== undefined) {
    sealKey = generateSealKey();
    if (sealTo === undefined) {
      sealKeyPath = join(out, "seal.key");
      writeFileSync(sealKeyPath, `${sealKey.toString("hex")}\n`, { mode: 0o600 });
    }
  }

  const chunkBytes = Number(flag(values, "chunk-bytes") ?? 8 * 1024 * 1024);
  const { bundle, chunks } = buildModelBundle({
    bytes,
    model: modelRefFromFlags(values, overrides),
    execution,
    chunkBytes,
    ...(sealKey === undefined ? {} : { sealKey }),
    ...(wrapPublicKey === undefined ? {} : { wrapPublicKey }),
  });
  const errors = verifyModelBundle(bundle);
  if (errors.length > 0) {
    throw new Error(`refusing to store an invalid bundle: ${errors.join("; ")}`);
  }

  const uploaded = await uploadBundle({ registry, bundle, chunks });
  const bundlePath = join(out, "model-bundle.json");
  writeJsonFile(bundlePath, bundle);

  if (bool(values, "json")) {
    console.log(
      JSON.stringify(
        { bundle, manifestHash: uploaded.manifestHash, bundlePath, sealKeyPath },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`bundled ${bundle.model.id} into RAREXT storage at ${registry}`);
  console.log(`  bundle      ${bundle.id}`);
  console.log(`  digest      ${bundle.digest}`);
  console.log(`  weights     ${bundle.model.weightsDigest}`);
  console.log(`  shards      ${bundle.shards.length} (${formatBytes(bundle.totalBytes)})`);
  console.log(`  shardsRoot  ${bundle.shardsRoot}`);
  console.log(`  manifest    ${uploaded.manifestHash}`);
  console.log(`  execution   ${bundle.execution.kind}`);
  if (bundle.sealing !== undefined) {
    console.log(`  sealed      ${bundle.sealing.scheme} (keyCommitment ${bundle.sealing.keyCommitment.slice(0, 16)}…)`);
  }
  console.log(`\nwrote ${bundlePath}`);
  if (sealKeyPath !== null) console.log(`      ${sealKeyPath}  (seal key — deliver to providers out of band)`);
  console.log(`\nnext:`);
  console.log(
    `  node apps/runtime/src/cli.ts provider --bundle ${bundlePath} --registry ${registry} --port 8791` +
      (sealKeyPath === null ? "" : ` --seal-key-file ${sealKeyPath}`),
  );
  return 0;
}

/**
 * Run a provider node. It fetches every shard from RAREXT, verifies the
 * committed digest, and only then loads the model. The original model file is
 * never consulted, so the provider is serving the network's bytes.
 */
async function commandProvider(values: Record<string, unknown>): Promise<number> {
  const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const manifestHash = flag(values, "manifest-hash");
  const bundle = await loadProviderBundle({
    ...(flag(values, "bundle") === undefined ? {} : { bundlePath: resolve(flag(values, "bundle")!) }),
    registry,
    ...(manifestHash === undefined ? {} : { manifestHash }),
  });

  const engineEndpoint =
    flag(values, "engine-endpoint") ??
    (bundle.execution.kind === "engine" ? "http://127.0.0.1:11434" : undefined);
  const out = flag(values, "out") === undefined ? null : resolve(flag(values, "out")!);
  const sealKeyFlag = flag(values, "seal-key-file");
  const sealKey = sealKeyFlag === undefined ? undefined : readSealKeyFile(resolve(sealKeyFlag));

  const provider = await startProvider({
    bundle,
    registry,
    stateDir: resolve(flag(values, "state") ?? ".rarext-provider"),
    ...(engineEndpoint === undefined ? {} : { engineEndpoint }),
    host: flag(values, "host") ?? "127.0.0.1",
    port: flag(values, "port") ? Number(flag(values, "port")) : 8791,
    ...(flag(values, "public-url") === undefined ? {} : { publicUrl: flag(values, "public-url")! }),
    providerHandle: flag(values, "handle") ?? null,
    ...(flag(values, "machine") === undefined ? {} : { machine: flag(values, "machine") }),
    ...(flag(values, "measurement") === undefined ? {} : { measurement: flag(values, "measurement") }),
    ...(flag(values, "code-measurement") === undefined
      ? {}
      : { codeMeasurement: flag(values, "code-measurement") }),
    ...(flag(values, "image-manifest") === undefined
      ? {}
      : { imageManifest: readJson(resolve(flag(values, "image-manifest")!)) as never }),
    ...(flag(values, "engine-version") === undefined
      ? {}
      : { engineVersion: flag(values, "engine-version") }),
    ...(flag(values, "engine-digest") === undefined
      ? {}
      : { engineDigest: flag(values, "engine-digest") }),
    ...(flag(values, "tee-key-file") === undefined
      ? {}
      : { teeSigner: readTeeSigner(resolve(flag(values, "tee-key-file")!)) }),
    ...(flag(values, "tee-cert-file") === undefined
      ? {}
      : { teeChain: readTeeChain(resolve(flag(values, "tee-cert-file")!)) }),
    ...(flag(values, "enclave-key-file") === undefined
      ? {}
      : { enclaveKey: readFileSync(resolve(flag(values, "enclave-key-file")!), "utf8") }),
    ...(flag(values, "enclave-endpoint") === undefined
      ? {}
      : { enclaveEndpoint: flag(values, "enclave-endpoint") }),
    ...(flags(values, "mirror-registry").length === 0
      ? {}
      : { mirrors: flags(values, "mirror-registry") }),
    ...(bool(values, "engine-logprobs") ? { engineLogprobs: true } : {}),
    ...(sealKey === undefined ? {} : { sealKey }),
    log: (message) => console.error(`[provider] ${message}`),
  });

  if (out !== null) writeJsonFile(out, provider.card);
  if (bool(values, "json")) {
    console.log(JSON.stringify({ url: provider.url, card: provider.card, bundle }, null, 2));
  } else {
    console.log(`rarext provider serving ${bundle.model.id} on ${provider.url}`);
    console.log(`  bundle      ${bundle.digest}`);
    console.log(`  weights     ${bundle.model.weightsDigest}`);
    console.log(`  shards      ${bundle.shards.length} verified from ${registry}`);
    console.log(`  execution   ${bundle.execution.kind}`);
    console.log(`  card        ${provider.card.digest}`);
    console.log(`  openai      POST ${provider.url}/v1/chat/completions`);
    console.log(`  card        GET  ${provider.url}/v1/provider-card`);
    if (out !== null) console.log(`\nwrote ${out}`);
  }

  const stop = async () => {
    await provider.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>(() => {});
  return 0;
}

/**
 * Deploy against a RAREXT provider. The provider card is not trusted: its
 * digest is recomputed, the bundle manifest is fetched from RAREXT by its
 * content address, and the two must commit the same weights. `--verify-shards`
 * additionally downloads every shard before a card is adopted.
 */
async function commandDeployWeb4(values: Record<string, unknown>): Promise<number> {
  const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");

  // A deployment can name providers explicitly, discover them from the
  // registry's anchored bundle, or both. Discovery is what lets an operator
  // adopt a provider they have never been told about; the card is still
  // verified here before it is used.
  const named = [...flags(values, "provider")];
  if (flag(values, "endpoint") !== undefined) named.push(flag(values, "endpoint")!);
  if (bool(values, "discover")) {
    const registries = registryList(values, registry);
    const discovered = await fetchVerifiedProvidersAcrossRegistries({
      registries,
      ...(flag(values, "bundle-digest") === undefined
        ? {}
        : { bundleDigest: flag(values, "bundle-digest") }),
    });
    if (discovered.providers.length === 0) {
      throw new Error(
        discovered.errors[0] ?? "no discovered provider card is verifiable",
      );
    }
    for (const { card } of discovered.providers) named.push(card.endpoint);
    console.error(
      `[runtime] discovered ${discovered.providers.length} verified provider(s) across ` +
        `${registries.length} registry(ies) / ${discovered.scanned} anchored bundle(s)`,
    );
    for (const error of discovered.errors) console.error(`[runtime]   ${error}`);
  }

  const endpoints = [...new Set(named.map((endpoint) => normalizeEndpoint(endpoint)).filter((e) => e !== ""))];
  if (endpoints.length === 0) {
    throw new Error(
      "--web4 needs --provider <https://provider.example> or --discover; there is no local default",
    );
  }
  for (const endpoint of endpoints) {
    if (isLoopbackEndpoint(endpoint) && !bool(values, "allow-loopback")) {
      throw new Error(
        `--web4 points at loopback (${endpoint}), which is local compute. ` +
          "Pass --allow-loopback only for a test fixture, or name the provider.",
      );
    }
  }

  const cards = await Promise.all(
    endpoints.map(async (endpoint) => {
      const card = await fetchProviderCard({ endpoint });
      if (normalizeEndpoint(card.endpoint) !== endpoint) {
        throw new Error(
          `provider card names ${card.endpoint}, not the endpoint that served it (${endpoint})`,
        );
      }
      return card;
    }),
  );

  const bundlePath = flag(values, "bundle");
  let bundle: ModelBundle;
  if (bundlePath !== undefined) {
    bundle = await loadProviderBundle({ bundlePath: resolve(bundlePath) });
  } else {
    bundle = await fetchBundleManifest({
      registry,
      manifestHash: flag(values, "manifest-hash") ?? cards[0]!.bundle.manifestHash,
    });
  }

  for (const [index, card] of cards.entries()) {
    const crossCheck = crossCheckProviderCard(card, bundle);
    if (!crossCheck.ok) {
      throw new Error(
        `provider ${endpoints[index]} does not match the RAREXT bundle: ${crossCheck.errors.join("; ")}`,
      );
    }
    if (card.bundle.digest !== bundle.digest) {
      throw new Error(`provider ${endpoints[index]} serves bundle ${card.bundle.digest}, not ${bundle.digest}`);
    }
  }
  if (new Set(cards.map((card) => card.model.id)).size !== 1) {
    throw new Error("providers disagree about the model id; refusing to deploy");
  }

  if (bool(values, "verify-shards")) {
    // For a sealed bundle this opens the shards with the key when one is given;
    // without a key it still verifies the ciphertext against the commitment.
    const deploySealFlag = flag(values, "seal-key-file");
    const deploySealKey =
      deploySealFlag === undefined ? undefined : readSealKeyFile(resolve(deploySealFlag));
    console.error(`[runtime] downloading ${bundle.shards.length} shard(s) from ${registry}`);
    await fetchBundleChunks({
      registry,
      bundle,
      ...(deploySealKey === undefined ? {} : { sealKey: deploySealKey }),
      onShard: (index, size) =>
        console.error(`[runtime]   shard ${index + 1}/${bundle.shards.length} ${size} bytes`),
    });
  }

  const healthFingerprints = await Promise.all(
    endpoints.map(async (endpoint) => {
      const healthResponse = await fetch(`${endpoint}/health`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!healthResponse.ok) {
        throw new Error(`provider ${endpoint} is not healthy: HTTP ${healthResponse.status}`);
      }
      const health = (await healthResponse.json()) as {
        bundle?: unknown;
        weightsDigest?: unknown;
        engineFingerprint?: unknown;
      };
      if (health.bundle !== bundle.digest || health.weightsDigest !== bundle.model.weightsDigest) {
        throw new Error(
          `provider ${endpoint} health does not commit this bundle (bundle ${String(health.bundle)}, ` +
            `weights ${String(health.weightsDigest)})`,
        );
      }
      return typeof health.engineFingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(health.engineFingerprint)
        ? health.engineFingerprint
        : null;
    }),
  );

  // Pin the engine only when every provider reports the same one: a run names a
  // single engine, so a heterogeneous fleet is honestly left unpinned.
  const enginePins = [...new Set(healthFingerprints.filter((pin): pin is string => pin !== null))];
  const enginePin = healthFingerprints.every((pin) => pin !== null) && enginePins.length === 1
    ? enginePins[0]!
    : null;

  const quorumFlag = flag(values, "quorum");
  const quorum = quorumFlag === undefined ? endpoints.length : Number(quorumFlag);
  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > endpoints.length) {
    throw new Error(
      `--quorum must be an integer between 1 and ${endpoints.length} (the number of providers)`,
    );
  }

  // A provider card can name who runs it. When every card does, the deployment
  // commits those identities and the quorum is over operators: two endpoints
  // run by one operator cannot masquerade as two independent answers.
  const operatorIds = cards.map((entry) => entry.provider.keyId ?? entry.provider.handle ?? null);
  const operatorsCommitted = operatorIds.every(
    (id): id is string => typeof id === "string" && id !== "",
  );
  if (operatorsCommitted && new Set(operatorIds).size < quorum) {
    throw new Error(
      `--quorum ${quorum} needs ${quorum} distinct operators, but the providers name only ` +
        `${new Set(operatorIds).size}: ${operatorIds.join(", ")}`,
    );
  }

  // A per-run bounty pays the distinct operators that agreed. It is only
  // meaningful when there are operator identities to pay, so refuse a bounty
  // that would pay nobody.
  const bountyFlag = flag(values, "bounty");
  const bounty = bountyFlag === undefined ? null : Number(bountyFlag);
  if (bounty !== null && (!Number.isSafeInteger(bounty) || bounty <= 0)) {
    throw new Error("--bounty must be a positive integer number of credits");
  }
  if (bounty !== null && !operatorsCommitted) {
    throw new Error("--bounty requires every provider card to name a distinct operator identity");
  }

  // Machine independence: the quorum must be met by agreeing providers that
  // attested distinct machines. The machine ids come from the signed cards, so
  // they are the operators' own claims, committed operator-aligned.
  const independenceFlag = flag(values, "independence");
  if (independenceFlag !== undefined && independenceFlag !== "machine") {
    throw new Error('--independence must be "machine"');
  }
  const independence = independenceFlag === "machine";
  const machineIds = cards.map((entry) => entry.independence?.machine ?? null);
  if (independence) {
    if (!operatorsCommitted) {
      throw new Error("--independence machine requires every provider card to name an operator identity");
    }
    if (!machineIds.every((id): id is string => typeof id === "string" && id !== "")) {
      throw new Error("--independence machine requires every provider card to attest a machine identity");
    }
    if (new Set(machineIds).size < quorum) {
      throw new Error(
        `--independence machine needs ${quorum} distinct machines, but the providers attest only ` +
          `${new Set(machineIds).size}: ${machineIds.join(", ")}`,
      );
    }
  }

  // A measurement allowlist: the deployment approves software images, and a
  // provider running anything else cannot count. Every adopted provider's
  // measurement must be on the list, so a mismatched allowlist is caught here
  // rather than at the first run.
  const measureFlag = flag(values, "measure");
  let allowedMeasurements: string[] | null = null;
  if (measureFlag !== undefined) {
    const list = measureFlag.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    if (list.length === 0) throw new Error("--measure needs at least one sha256 hex measurement");
    if (list.some((entry) => !/^[0-9a-f]{64}$/.test(entry))) {
      throw new Error("--measure entries must be sha256 hex digests");
    }
    if (!operatorsCommitted) {
      throw new Error("--measure requires every provider card to name an operator identity");
    }
    const cardMeasurements = cards.map((entry) => entry.independence?.measurement ?? null);
    const unlisted = cardMeasurements.filter((value) => value === null || !list.includes(value));
    if (unlisted.length > 0) {
      throw new Error(
        `--measure allowlist does not include every provider's measurement: ` +
          `${cardMeasurements.join(", ")}`,
      );
    }
    allowedMeasurements = [...new Set(list)];
  }

  // A pinned vendor key: the deployment accepts machine quotes only from this
  // key. Every adopted provider must present a quote that verifies under it, so
  // a pin the providers cannot satisfy is caught here.
  const teeVendorFlag = flag(values, "tee-vendor");
  let teeVendor: string | null = null;
  if (teeVendorFlag !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(teeVendorFlag)) {
      throw new Error("--tee-vendor must be a sha256 hex key id");
    }
    if (!operatorsCommitted) {
      throw new Error("--tee-vendor requires every provider card to name an operator identity");
    }
    const vendors = cards.map((entry) => verifyProviderChain(entry.independence));
    if (vendors.some((vendor) => vendor !== teeVendorFlag)) {
      throw new Error(
        `--tee-vendor ${teeVendorFlag} does not match every provider's machine quote ` +
          `(${vendors.map((vendor) => vendor ?? "none").join(", ")})`,
      );
    }
    teeVendor = teeVendorFlag;
  }

  // A hardware-rooted attestation: the chain must reach the pinned vendor root
  // AND be at least this deep, so a bare leaf is refused by name.
  const teeChainDepthFlag = flag(values, "tee-chain-depth");
  let teeChainDepth: number | null = null;
  if (teeChainDepthFlag !== undefined) {
    const depth = Number(teeChainDepthFlag);
    if (!Number.isSafeInteger(depth) || depth < 1) {
      throw new Error("--tee-chain-depth must be a positive integer");
    }
    if (teeVendor === null) {
      throw new Error("--tee-chain-depth requires --tee-vendor");
    }
    const depths = cards.map((entry) => providerChainDepth(entry.independence));
    if (depths.some((value) => value < depth)) {
      throw new Error(
        `--tee-chain-depth ${depth} does not hold for every provider chain (${depths.join(", ")})`,
      );
    }
    teeChainDepth = depth;
  }

  // A measured-boot requirement: the chain must name every stage the deployment
  // trusts, so a leaf signed outside the measured boot cannot count.
  const teeBootStagesFlag = flag(values, "tee-boot-stages");
  let teeBootStages: string[] | null = null;
  if (teeBootStagesFlag !== undefined) {
    const stages = teeBootStagesFlag.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    if (stages.length === 0) throw new Error("--tee-boot-stages needs at least one stage name");
    if (teeVendor === null) throw new Error("--tee-boot-stages requires --tee-vendor");
    const missing = stages.filter((stage) =>
      cards.some((entry) => !providerBootStages(entry.independence).includes(stage)),
    );
    if (missing.length > 0) {
      throw new Error(`--tee-boot-stages not present in every provider chain: ${missing.join(", ")}`);
    }
    teeBootStages = stages;
  }

  // Per-stage measurements the deployment approves: the stage names become
  // checked values. A provider whose chain carries a different firmware/OS/app
  // measurement is refused here and at every later layer.
  const teeBootMeasurementsFlag = flag(values, "tee-boot-measurements");
  let teeStageMeasurements: Record<string, string> | null = null;
  if (teeBootMeasurementsFlag !== undefined) {
    const record: Record<string, string> = {};
    for (const entry of teeBootMeasurementsFlag.split(",")) {
      const [stage, measurement] = entry.split("=").map((part) => part.trim());
      if (stage === undefined || stage === "" || measurement === undefined || !/^[0-9a-f]{64}$/.test(measurement)) {
        throw new Error("--tee-boot-measurements entries must be stage=sha256hex");
      }
      record[stage] = measurement;
    }
    if (Object.keys(record).length === 0) throw new Error("--tee-boot-measurements needs at least one stage");
    if (teeBootStages === null) throw new Error("--tee-boot-measurements requires --tee-boot-stages");
    const mismatched = Object.entries(record).filter(([stage, measurement]) =>
      cards.some((entry) => providerStageMeasurements(entry.independence)[stage] !== measurement),
    );
    if (mismatched.length > 0) {
      throw new Error(
        `--tee-boot-measurements not matched by every provider chain: ${mismatched.map(([stage]) => stage).join(", ")}`,
      );
    }
    teeStageMeasurements = record;
  }

  // Freshness: challenge each provider with a nonce so a replayed attestation is
  // refused.
  const teeFreshnessFlag = flag(values, "tee-freshness");
  let teeFreshness: "challenge" | null = null;
  if (teeFreshnessFlag !== undefined) {
    if (teeFreshnessFlag !== "challenge") throw new Error('--tee-freshness must be "challenge"');
    if (teeVendor === null) throw new Error("--tee-freshness requires --tee-vendor");
    teeFreshness = "challenge";
  }

  // The enclave code the deployment approves: every adopted provider must attest
  // it, so an enclave running other code is refused.
  const teeCodeFlag = flag(values, "tee-code");
  let teeCode: string | null = null;
  if (teeCodeFlag !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(teeCodeFlag)) throw new Error("--tee-code must be a sha256 hex digest");
    if (teeVendor === null) throw new Error("--tee-code requires --tee-vendor");
    const mismatched = cards.filter((entry) => entry.independence?.code !== teeCodeFlag);
    if (mismatched.length > 0) {
      throw new Error(
        `--tee-code does not match every provider's code measurement ` +
          `(${cards.map((entry) => entry.independence?.code ?? "none").join(", ")})`,
      );
    }
    teeCode = teeCodeFlag;
  }

  // A vendor-signed image manifest: every adopted provider must present one
  // whose certificate CHAIN terminates at the pinned vendor ROOT, so a manifest
  // signed by a bare operator key cannot satisfy the pin.
  const teeSignedImageFlag = flag(values, "tee-signed-image");
  let teeSignedImage: string | null = null;
  if (teeSignedImageFlag !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(teeSignedImageFlag)) {
      throw new Error("--tee-signed-image must be a sha256 hex key id");
    }
    if (teeVendor === null) throw new Error("--tee-signed-image requires --tee-vendor");
    const unsatisfied = cards.filter((entry) => {
      const info = verifyImageManifest(entry.independence?.image);
      return (
        info === null ||
        info.rootKeyId !== teeSignedImageFlag ||
        (teeCode !== null && info.image !== teeCode)
      );
    });
    if (unsatisfied.length > 0) {
      throw new Error("--tee-signed-image is not satisfied by every provider's image manifest");
    }
    teeSignedImage = teeSignedImageFlag;
  }

  // The minimum certificate-chain depth the image manifest must present, so a
  // manifest signed directly by the anchor with no chain is refused.
  const teeSignedImageDepthFlag = flag(values, "tee-signed-image-depth");
  let teeSignedImageDepth: number | null = null;
  if (teeSignedImageDepthFlag !== undefined) {
    const depth = Number(teeSignedImageDepthFlag);
    if (!Number.isSafeInteger(depth) || depth < 1) {
      throw new Error("--tee-signed-image-depth must be a positive integer");
    }
    if (teeSignedImage === null) {
      throw new Error("--tee-signed-image-depth requires --tee-signed-image");
    }
    const shallow = cards.filter((entry) => imageManifestChainDepth(entry.independence?.image) < depth);
    if (shallow.length > 0) {
      throw new Error(
        `--tee-signed-image-depth ${depth} does not hold for every provider image manifest ` +
          `(${cards.map((entry) => imageManifestChainDepth(entry.independence?.image)).join(", ")})`,
      );
    }
    teeSignedImageDepth = depth;
  }

  const primary = endpoints[0]!;
  const card = cards[0]!;
  const probe = {
    engine: { name: "openai-compatible" as EngineName, version: "web4", endpoint: primary },
    model: card.model,
    apis: ["openai"] as ApiShape[],
    models: [card.model],
  };

  const out = resolve(flag(values, "out") ?? ".rarext-runtime");
  const manifest = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromNetwork(primary),
      placement: "web4",
      id: flag(values, "id"),
      labels: {
        execution: "web4",
        bundle: bundle.digest,
        shardsRoot: bundle.shardsRoot,
        manifestHash: bundleManifestHash(bundle),
        provider: card.id,
        providerCard: card.digest,
        // The full provider set lives in the deployment, so a gateway can fan
        // out and a reader can reproduce agreement without a side channel.
        providers: endpoints.join(","),
        providerCards: cards.map((entry) => entry.digest).join(","),
        quorum: String(quorum),
        // Operator identity is what makes a quorum more than a head count.
        // Commit it when every card names one; the challenge then requires
        // agreement across distinct operators, not just distinct endpoints.
        ...(operatorsCommitted ? { operators: operatorIds.join(",") } : {}),
        // Machine independence commits the operator-aligned machine ids, so a
        // run cannot invent a machine to pass the distinctness rule.
        ...(independence ? { independence: "machine", machines: machineIds.join(",") } : {}),
        // A measurement allowlist commits the approved software images, so the
        // challenge and the verifier can refuse a provider running anything else.
        ...(allowedMeasurements === null ? {} : { measurements: allowedMeasurements.join(",") }),
        // The engine the providers actually serve with: committed so a run
        // records it and a replay can refuse a provider whose engine changed.
        ...(enginePin === null ? {} : { engineFingerprint: enginePin }),
        // The pinned vendor key whose machine quotes the deployment accepts.
        ...(teeVendor === null ? {} : { teeVendor }),
        ...(teeChainDepth === null ? {} : { teeChainDepth: String(teeChainDepth) }),
        ...(teeBootStages === null ? {} : { teeBootStages: teeBootStages.join(",") }),
        ...(teeStageMeasurements === null
          ? {}
          : {
              teeStageMeasurements: Object.entries(teeStageMeasurements)
                .map(([stage, measurement]) => `${stage}=${measurement}`)
                .join(","),
            }),
        ...(teeFreshness === null ? {} : { teeFreshness }),
        ...(teeCode === null ? {} : { teeCodeMeasurement: teeCode }),
        ...(teeSignedImage === null ? {} : { teeSignedImage }),
        ...(teeSignedImageDepth === null
          ? {}
          : { teeSignedImageDepth: String(teeSignedImageDepth) }),
        // A deployment can require every run to carry a decode trace, so a
        // provider or engine cannot silently omit it.
        ...(bool(values, "require-trace") ? { trace: "required" } : {}),
        // A deployment can require every run to be replayable, so a reader can
        // always re-derive the bytes.
        ...(bool(values, "require-replay") ? { replay: "required" } : {}),
        // A bounty makes the run pay the operators that agreed; the challenge
        // commits the amount, so a run cannot invent its own price.
        ...(bounty === null ? {} : { bounty: String(bounty) }),
        ...(endpoints.some((endpoint) => isLoopbackEndpoint(endpoint))
          ? { fixture: "loopback" }
          : {}),
      },
      notes:
        `web4 deployment: the weights are ${bundle.shards.length} RAREXT blob(s) committed as ` +
        `${bundle.model.weightsDigest}; ${cards.length} provider(s) fetched and verified them, ` +
        `and ${quorum} must agree before a run is recorded. No weights or inference run on this host.`,
    }),
  );

  writeJsonFile(join(out, "deployment.json"), manifest);
  writeJsonFile(join(out, "challenges.json"), challengesFile(manifest));
  const verifierUrl = flag(values, "verifier-url") ?? "http://127.0.0.1:8788/verify";
  writeJsonFile(join(out, "verifiers.json"), verifierConfig(verifierUrl));
  writeJsonFile(join(out, "verifier-manifest.json"), RUNTIME_VERIFIER_MANIFEST);

  if (bool(values, "json")) {
    console.log(
      JSON.stringify(
        {
          deployment: manifest,
          challenge: challengeFor(manifest),
          challengeId: challengeIdFor(manifest),
          placement: "web4",
          providers: cards.map((entry, index) => ({ endpoint: endpoints[index], card: entry })),
          quorum,
          bundle,
          files: {
            deployment: join(out, "deployment.json"),
            challenges: join(out, "challenges.json"),
            verifiers: join(out, "verifiers.json"),
          },
          verifierUrl,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`deployment ${manifest.id}`);
  console.log(`  placement ${manifest.placement}`);
  for (const [index, entry] of cards.entries()) {
    console.log(`  provider  ${entry.id} at ${endpoints[index]}`);
  }
  console.log(`  quorum    ${quorum} of ${cards.length} provider(s) must agree`);
  console.log(`  model     ${manifest.model.id}${manifest.model.quantization ? ` (${manifest.model.quantization})` : ""}`);
  console.log(`  weights   ${manifest.model.weightsDigest}`);
  console.log(`  bundle    ${bundle.digest} (${bundle.shards.length} shard(s), ${formatBytes(bundle.totalBytes)})`);
  console.log(`  shards    ${bundle.shardsRoot}`);
  console.log(`  execution ${bundle.execution.kind} — no weights or inference on this host`);
  console.log(`  digest    ${manifest.digest}`);
  console.log(`\nwrote:`);
  console.log(`  ${join(out, "deployment.json")}`);
  console.log(`  ${join(out, "challenges.json")}   (RAREXT_CHALLENGES)`);
  console.log(`  ${join(out, "verifiers.json")}    (RAREXT_VERIFIERS, verifier at ${verifierUrl})`);
  console.log(`\nnext:`);
  console.log(`  node apps/runtime/src/cli.ts serve --manifest ${join(out, "deployment.json")} --publish`);
  return 0;
}

async function commandDeploy(values: Record<string, unknown>): Promise<number> {
  if (bool(values, "web4") || flag(values, "placement") === "web4") {
    return commandDeployWeb4(values);
  }

  const remote = bool(values, "remote") || flag(values, "placement") === "remote";
  const endpointFlag = flag(values, "endpoint");
  if (remote && endpointFlag === undefined) {
    throw new Error("--remote needs --endpoint <https://provider.example>; there is no local default");
  }
  const endpoint = normalizeEndpoint(endpointFlag ?? "http://127.0.0.1:11434");
  const engine =
    (flag(values, "engine") as EngineName | undefined) ?? (remote ? "openai-compatible" : undefined);
  const model = flag(values, "model");
  const out = resolve(flag(values, "out") ?? ".rarext-runtime");
  const backend = (flag(values, "backend") as HardwareBackend | undefined) ?? "unknown";
  const device = flag(values, "device") ?? null;
  const upstream = upstreamOptions(values, engine ?? "openai-compatible");

  if (remote && bool(values, "pull")) {
    throw new Error(
      "--pull is local-only. A cloud deployment never downloads weights onto this host; the provider already holds them.",
    );
  }
  if (remote && isLoopbackEndpoint(endpoint) && !bool(values, "allow-loopback")) {
    throw new Error(
      `--remote points at loopback (${endpoint}), which is local compute. ` +
        "Pass --allow-loopback only for a test fixture, or name the cloud endpoint.",
    );
  }

  let probe;
  try {
    probe = await probeEngine({
      endpoint,
      engine,
      model,
      api: remote ? upstream.api : undefined,
      headers: upstream.headers,
    });
  } catch (error) {
    if (!bool(values, "pull")) throw error;
    if (!model) {
      throw new Error("--pull needs --model so the runtime knows what to fetch");
    }
    if (engine !== undefined && engine !== "ollama") {
      throw new Error(
        `--pull is implemented for Ollama only; pull ${model} with ${engine}'s own installer, then run deploy without --pull`,
      );
    }

    console.error(`[runtime] ${model} is not loaded; pulling it from ${endpoint}`);
    let lastStatus = "";
    await pullOllamaModel({
      endpoint,
      model,
      onProgress: (progress: PullProgress) => {
        if (progress.status === lastStatus) return;
        lastStatus = progress.status;
        const bytes =
          progress.total === null
            ? ""
            : ` (${progress.completed ?? 0}/${progress.total} bytes)`;
        console.error(`[runtime] ${progress.status}${bytes}`);
      },
    });
    probe = await probeEngine({ endpoint, engine, model });
  }
  const manifest = commitDeployment(
    buildDeployment({
      probe,
      hardware: remote ? hardwareFromCloud(endpoint) : hardwareFromHost(backend, device),
      placement: remote ? "remote" : undefined,
      id: flag(values, "id"),
      ...(remote
        ? {
            labels: {
              execution: "cloud",
              upstreamApi: upstream.api,
              upstreamAuth: upstream.auth,
              ...(isLoopbackEndpoint(endpoint) ? { fixture: "loopback" } : {}),
            },
            notes:
              `Remote deployment: inference runs at ${endpoint}. No weights are stored or executed on this host.`,
          }
        : {}),
    }),
  );

  writeJsonFile(join(out, "deployment.json"), manifest);
  writeJsonFile(join(out, "challenges.json"), challengesFile(manifest));
  const verifierUrl = flag(values, "verifier-url") ?? "http://127.0.0.1:8788/verify";
  writeJsonFile(join(out, "verifiers.json"), verifierConfig(verifierUrl));
  writeJsonFile(join(out, "verifier-manifest.json"), RUNTIME_VERIFIER_MANIFEST);

  if (bool(values, "json")) {
    console.log(
      JSON.stringify(
        {
          deployment: manifest,
          challenge: challengeFor(manifest),
          challengeId: challengeIdFor(manifest),
          placement: manifest.placement ?? "local",
          upstream: remote ? describeUpstream(upstream) : null,
          files: {
            deployment: join(out, "deployment.json"),
            challenges: join(out, "challenges.json"),
            verifiers: join(out, "verifiers.json"),
          },
          verifierUrl,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`deployment ${manifest.id}`);
  console.log(`  placement ${manifest.placement ?? "local"}`);
  console.log(`  engine    ${manifest.engine.name}${manifest.engine.version ? ` ${manifest.engine.version}` : ""} at ${manifest.engine.endpoint}`);
  console.log(`  model     ${manifest.model.id}${manifest.model.quantization ? ` (${manifest.model.quantization})` : ""}`);
  console.log(`  weights   ${manifest.model.weightsDigest ?? "not reported by the engine"}`);
  if (remote) {
    console.log(
      `  execution remote — no weights or inference on this host; auth ${upstream.auth}` +
        (upstream.auth === "none" ? "" : ` via $${upstream.keyEnv}${upstream.token === null ? " (unset)" : ""}`),
    );
  } else {
    console.log(`  hardware  ${manifest.hardware.backend}${manifest.hardware.device ? ` / ${manifest.hardware.device}` : ""} on ${manifest.hardware.os} ${manifest.hardware.arch}`);
  }
  console.log(`  digest    ${manifest.digest}`);
  console.log(`\nwrote:`);
  console.log(`  ${join(out, "deployment.json")}`);
  console.log(`  ${join(out, "challenges.json")}   (RAREXT_CHALLENGES)`);
  console.log(`  ${join(out, "verifiers.json")}    (RAREXT_VERIFIERS, verifier at ${verifierUrl})`);
  console.log(`\nnext:`);
  console.log(`  node apps/runtime/src/cli.ts verifier --port 8788`);
  console.log(`  RAREXT_CHALLENGES=${join(out, "challenges.json")} RAREXT_VERIFIERS=${join(out, "verifiers.json")} node apps/api/src/server.ts`);
  console.log(
    `  node apps/runtime/src/cli.ts serve --manifest ${join(out, "deployment.json")} --publish` +
      (remote ? " --host 0.0.0.0 --public-url https://your-gateway.example" : ""),
  );
  return 0;
}

async function commandPublishDeployment(values: Record<string, unknown>): Promise<number> {
  const deployment = deploymentFrom(values);
  const state = resolve(flag(values, "state") ?? ".rarext-runtime");
  const registry = flag(values, "registry") ?? "http://127.0.0.1:8787";
  const handle = flag(values, "handle") ?? "rarext-runtime";
  const challengeId = flag(values, "challenge") ?? challengeIdFor(deployment);

  const publisher = await RuntimePublisher.open({
    baseUrl: registry,
    handle,
    stateDir: state,
    challengeId,
  });
  const publication = await publisher.publishDeployment(deployment);
  const anchor = bool(values, "anchor") ? await publisher.client.anchor() : null;

  if (bool(values, "json")) {
    console.log(JSON.stringify({ publication, anchor }, null, 2));
    return 0;
  }

  console.log(`deployment ${deployment.id} published as ${publication.id.slice(0, 12)}… under ${challengeId}`);
  console.log(`  digest     ${deployment.digest}`);
  console.log(
    `  model      ${deployment.model.id}${deployment.model.quantization ? ` (${deployment.model.quantization})` : ""}`,
  );
  console.log(`  weights    ${deployment.model.weightsDigest ?? "not reported by the engine"}`);
  console.log(`  registry   ${registry}`);
  if (anchor !== null) {
    console.log(`  anchor     ${anchor.root} (${anchor.leafCount} leaf/leaves, version ${anchor.leafVersion ?? "?"})`);
  }
  return 0;
}

async function commandAnchor(values: Record<string, unknown>): Promise<number> {
  const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const client = new RarextClient({ baseUrl: registry });
  const anchor = await client.anchor();

  if (bool(values, "json")) {
    console.log(JSON.stringify(anchor, null, 2));
    return 0;
  }

  console.log(`anchored ${registry}`);
  console.log(`  root         ${anchor.root}`);
  console.log(`  leaves       ${anchor.leafCount} (version ${anchor.leafVersion ?? "?"})`);
  console.log(`  publications ${anchor.publicationIds.length}`);
  for (const id of anchor.publicationIds) console.log(`    ${id}`);
  return 0;
}

async function commandDiscover(values: Record<string, unknown>): Promise<number> {
  let report;
  if (bool(values, "all-anchors")) {
    const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
    const registries = registryList(values, registry);
    const reports = [];
    const perRegistry: Array<{ registry: string; bundles: number; error: string | null }> = [];
    // A provider card and a later run can live in different anchors; they can
    // also live in different registries. Read every batch from every registry
    // and union the verdicts, so no single anchor or registry has to be the
    // one that happens to hold the proof.
    for (const target of registries) {
      try {
        const bundles = await fetchAnchoredBundles({ registry: target });
        perRegistry.push({ registry: target, bundles: bundles.length, error: null });
        reports.push(...bundles.map((bundle) => discoverBundle(bundle)));
      } catch (error) {
        perRegistry.push({
          registry: target,
          bundles: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const latest = reports[0];
    report = {
      root: latest?.root ?? null,
      leafVersion: latest?.leafVersion ?? null,
      // One anchor covers one batch; this view is every batch every registry
      // still serves, so a provider card anchored before a run is not lost.
      cards: reports.flatMap((entry) => entry.cards),
      providers: reports.flatMap((entry) => entry.providers),
      runs: reports.flatMap((entry) => entry.runs),
      registries: perRegistry,
      ok:
        reports.length > 0 &&
        reports.every((entry) => entry.ok) &&
        perRegistry.every((entry) => entry.error === null),
    };
  } else {
    const { bundle } = await loadBundle(values);
    report = discoverBundle(bundle);
  }

  if (bool(values, "json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(
    `bundle root ${String(report.root ?? "").slice(0, 16)}… leafVersion ${report.leafVersion ?? "?"}`,
  );

  if (report.cards.length === 0 && report.providers.length === 0 && report.runs.length === 0) {
    console.log("no model cards, providers, or runs in the bundle");
    return 1;
  }

  if (report.cards.length > 0) {
    const idWidth = Math.max(10, ...report.cards.map((card) => card.deploymentId.length));
    const modelWidth = Math.max(5, ...report.cards.map((card) => card.modelId.length));
    const quantWidth = Math.max(5, ...report.cards.map((card) => (card.quantization ?? "-").length));

    console.log("\nmodel cards");
    console.log(
      `${"deployment".padEnd(idWidth)}  ${"model".padEnd(modelWidth)}  ${"quant".padEnd(quantWidth)}  verdict`,
    );
    for (const card of report.cards) {
      const verdict = card.verified
        ? card.attested
          ? "verified"
          : "verified (attestation missing)"
        : "FAILED";
      console.log(
        `${card.deploymentId.padEnd(idWidth)}  ${card.modelId.padEnd(modelWidth)}  ` +
          `${(card.quantization ?? "-").padEnd(quantWidth)}  ${verdict}`,
      );
      if (card.error) console.log(`  ${card.error}`);
    }
  }

  if (report.providers.length > 0) {
    console.log("\nproviders");
    for (const provider of report.providers) {
      console.log(
        `  ${provider.verified ? "verified" : "FAILED  "}  ${provider.endpoint}  ` +
          `bundle ${provider.bundleDigest.slice(0, 16)}…  ${provider.shardCount} shard(s)`,
      );
      if (provider.error) console.log(`    ${provider.error}`);
    }
  }

  if (report.runs.length > 0) {
    console.log("\nruns");
    for (const run of report.runs) {
      const verdict = run.verified
        ? run.attested
          ? "verified"
          : "verified (attestation missing)"
        : "FAILED";
      const speed =
        run.tokensPerSecond === null ? "" : ` ${run.tokensPerSecond.toFixed(1)} tok/s`;
      console.log(
        `  ${run.runDigest.slice(0, 16)}…  ${run.modelId}${speed}  ${verdict}`,
      );
      if (run.error) console.log(`    ${run.error}`);
    }
  }

  console.log(
    `\n${report.ok ? "PASS" : "FAIL"} — ${report.cards.length} card(s), ` +
      `${report.providers.length} provider(s), ${report.runs.length} run(s) recomputed from the bundle`,
  );
  return report.ok ? 0 : 1;
}

async function commandServe(values: Record<string, unknown>): Promise<number> {
  const { deployment, provenance } = await deploymentForServe(values);
  const verdict = verifyDeploymentBody(deployment, runSpecFromChallenge(challengeFor(deployment)));
  if (!verdict.correct) {
    throw new Error(`refusing to serve a deployment that does not verify: ${verdict.error ?? "unknown error"}`);
  }
  const state = resolve(flag(values, "state") ?? ".rarext-runtime");
  const publish = bool(values, "publish");
  const registry = flag(values, "registry") ?? DEFAULT_REGISTRY;
  const handle = flag(values, "handle") ?? "rarext-runtime";
  const challengeId = flag(values, "challenge") ?? challengeIdFor(deployment);
  const upstream =
    deployment.placement === "remote" || deployment.placement === "web4"
      ? upstreamOptions(
          values,
          deployment.engine.name,
          upstreamShapeFromLabels(deployment.labels, deployment.engine.name),
        )
      : upstreamOptions(values, deployment.engine.name);
  const gatewayTokenEnv = flag(values, "gateway-token-env") ?? DEFAULT_GATEWAY_TOKEN_ENV;
  const gatewayToken = resolveSecret(gatewayTokenEnv);
  const host = flag(values, "host") ?? "127.0.0.1";
  const publicUrl = flag(values, "public-url");

  // A web4 deployment commits its provider set and response threshold in its
  // labels. The gateway uses them directly; an operator override is allowed
  // for a fixture, but the run still records what was actually queried.
  const labels = deployment.labels ?? {};
  const committedProviders = (labels.providers ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const upstreams =
    committedProviders.length > 0
      ? committedProviders
      : [deployment.engine.endpoint];
  const quorumFlag = flag(values, "quorum");
  const quorum =
    quorumFlag !== undefined
      ? Number(quorumFlag)
      : labels.quorum !== undefined
        ? Number(labels.quorum)
        : upstreams.length;

  // `labels.operators` is aligned with `labels.providers`, so the gateway can
  // attach an operator identity to each endpoint it queries. Without it the
  // gateway still records endpoints; with it, agreement is counted per
  // operator and one operator cannot fill the quorum alone.
  const committedOperators = (labels.operators ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const operators =
    committedOperators.length === upstreams.length
      ? Object.fromEntries(upstreams.map((endpoint, index) => [endpoint, committedOperators[index]!]))
      : undefined;

  // The machine ids are committed operator-aligned, so the gateway can attach
  // each endpoint's machine and count the quorum over distinct machines when the
  // deployment demands it.
  const committedMachines = (labels.machines ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const machines =
    committedMachines.length === upstreams.length
      ? Object.fromEntries(upstreams.map((endpoint, index) => [endpoint, committedMachines[index]!]))
      : undefined;

  // When the deployment approves specific measurements, the gateway needs each
  // provider's PRESENT measurement to check it, so it fetches the cards. An
  // unreachable or unmeasured provider is recorded as unmeasured and refused,
  // rather than silently counted.
  let measurements: Record<string, string> | undefined;
  if (labels.measurements !== undefined) {
    const pairs = await Promise.all(
      upstreams.map(async (endpoint) => {
        try {
          const card = await fetchProviderCard({ endpoint });
          return [endpoint, card.independence?.measurement ?? ""] as const;
        } catch {
          return [endpoint, ""] as const;
        }
      }),
    );
    measurements = Object.fromEntries(pairs);
  }

  // When the deployment pins a vendor key, the gateway needs each provider's
  // full quote to verify it, so it fetches the cards' independence blocks.
  let attestations: Record<string, RunProviderAttestation> | undefined;
  if (labels.teeVendor !== undefined) {
    const pairs = await Promise.all(
      upstreams.map(async (endpoint) => {
        try {
          const card = await fetchProviderCard({ endpoint });
          return [endpoint, card.independence] as const;
        } catch {
          return [endpoint, undefined] as const;
        }
      }),
    );
    attestations = Object.fromEntries(
      pairs.filter((pair): pair is readonly [string, NonNullable<(typeof pair)[1]>] => pair[1] !== undefined),
    );
  }

  const publisher = publish
    ? await RuntimePublisher.open({ baseUrl: registry, handle, stateDir: state, challengeId })
    : null;

  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > upstreams.length) {
    throw new Error(
      `quorum must be between 1 and ${upstreams.length} (the committed provider count)`,
    );
  }
  const commitsQuorum = committedProviders.length > 0 || labels.quorum !== undefined;

  const gateway = await startGateway({
    deployment,
    ledgerDir: state,
    publisher,
    host,
    port: flag(values, "port") ? Number(flag(values, "port")) : 8790,
    publicUrl,
    gatewayToken,
    upstreamApi: upstream.api,
    upstreamHeaders: upstream.headers,
    ...(commitsQuorum ? { upstreams, quorum } : {}),
    ...(commitsQuorum && operators !== undefined ? { operators } : {}),
    ...(commitsQuorum && machines !== undefined ? { machines } : {}),
    ...(commitsQuorum && measurements !== undefined ? { measurements } : {}),
    ...(commitsQuorum && attestations !== undefined ? { attestations } : {}),
    log: (message) => console.error(`[runtime] ${message}`),
  });

  console.log(`rarext-runtime serving ${deployment.model.id} on ${gateway.url}`);
  console.log(`  placement  ${deployment.placement ?? "local"}`);
  console.log(`  upstream   ${deployment.engine.endpoint} (${upstream.api})`);
  if (provenance !== null) console.log(`  card       ${provenance}`);
  if (deployment.placement === "remote") {
    console.log("  compute    none on this host — requests are forwarded to the remote engine");
  }
  if (deployment.placement === "web4") {
    const labels = deployment.labels ?? {};
    console.log(`  bundle     ${labels.bundle ?? "?"} (${labels.shardsRoot ?? "?"})`);
    console.log(`  providers  ${upstreams.length} committed, quorum ${quorum}`);
    for (const endpoint of upstreams) console.log(`             ${endpoint}`);
    console.log("  compute    none on this host — the providers fetched verified RAREXT blobs");
  }
  console.log(`  openai     POST ${gateway.url}/v1/chat/completions`);
  console.log(`  anthropic  POST ${gateway.url}/v1/messages`);
  console.log(`  deployment GET  ${gateway.url}/v1/deployment`);
  console.log(`  runs       GET  ${gateway.url}/v1/rarext/runs`);
  console.log(`  ledger     GET  ${gateway.url}/v1/rarext/ledger`);
  console.log(
    `  auth       ${gatewayToken === null ? "off (set " + gatewayTokenEnv + " to require a bearer token)" : `bearer token from ${gatewayTokenEnv}`}`,
  );
  console.log(`  publishing ${publisher ? `as ${handle} under ${challengeId} -> ${registry}` : "off (local ledger only)"}`);
  if (host === "0.0.0.0" && publicUrl === undefined) {
    console.log("  warning    bound to every interface; pass --public-url so clients get the TLS URL");
  }

  const stop = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>(() => {});
  return 0;
}

/**
 * Publish the provider's own card under the model challenge. A publisher does
 * not need to run a deployment to announce a provider; it needs the challenge
 * the provider serves and the endpoint. The card is fetched and cross-checked
 * against the RAREXT bundle before it is signed.
 */
async function commandAnnounce(values: Record<string, unknown>): Promise<number> {
  const endpoint = normalizeEndpoint(flag(values, "endpoint") ?? flags(values, "provider")[0] ?? "");
  if (endpoint === "") throw new Error("--endpoint <provider URL> is required");
  const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");

  const card = await fetchProviderCard({ endpoint });
  if (normalizeEndpoint(card.endpoint) !== endpoint) {
    throw new Error(`provider card names ${card.endpoint}, not ${endpoint}`);
  }
  const bundle = await fetchBundleManifest({
    registry,
    manifestHash: flag(values, "manifest-hash") ?? card.bundle.manifestHash,
  });
  const crossCheck = crossCheckProviderCard(card, bundle);
  if (!crossCheck.ok) {
    throw new Error(`provider card does not match the RAREXT bundle: ${crossCheck.errors.join("; ")}`);
  }

  const challengeId =
    flag(values, "challenge") ??
    (flag(values, "manifest") !== undefined
      ? challengeIdFor(deploymentFrom(values))
      : undefined);
  if (challengeId === undefined) {
    throw new Error("--challenge <id> (or --manifest <deployment.json>) is required");
  }

  const registries = registryList(values, registry);
  const publications: Array<{ registry: string; publication: Awaited<ReturnType<RuntimePublisher["publishProviderCard"]>> }> = [];
  const anchors: Array<{ registry: string; root: string }> = [];
  const handle = flag(values, "handle") ?? "rarext-runtime";
  const stateDir = resolve(flag(values, "state") ?? ".rarext-runtime");

  // Announce to every named registry. The card is the same bytes and the same
  // signature; a reader can verify it from any copy, so no single registry is
  // the gatekeeper for who provides a model.
  for (const target of registries) {
    const publisher = await RuntimePublisher.open({
      baseUrl: target,
      handle,
      stateDir,
      challengeId,
    });
    const publication = await publisher.publishProviderCard(card);
    publications.push({ registry: target, publication });
    if (bool(values, "anchor")) {
      const anchor = await publisher.client.anchor();
      anchors.push({ registry: target, root: anchor.root });
    }
  }
  const publication = publications[0]!.publication;
  const anchor = anchors[0] === undefined ? null : anchors[0];

  if (bool(values, "json")) {
    console.log(JSON.stringify({ publication, publications, anchors, anchor, card, bundle }, null, 2));
    return 0;
  }

  console.log(`provider ${card.id} announced as ${publication.id.slice(0, 12)}… under ${challengeId}`);
  console.log(`  endpoint   ${endpoint}`);
  console.log(`  bundle     ${bundle.digest}`);
  console.log(`  model      ${card.model.id}`);
  if (publications.length > 1) {
    console.log(`  registries ${publications.length}`);
    for (const entry of publications) console.log(`             ${entry.registry}`);
  }
  for (const entry of anchors) console.log(`  anchor     ${entry.registry} ${entry.root}`);
  return 0;
}

/**
 * Compare the providers that serve one bundle: verify every card against the
 * registry manifest, then (when a prompt is given) ask all of them the same
 * question and show whether their canonical responses agree.
 */
async function commandCompare(values: Record<string, unknown>): Promise<number> {
  const registry = (flag(values, "registry") ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const named = [...flags(values, "provider")];
  if (flag(values, "endpoint") !== undefined) named.push(flag(values, "endpoint")!);
  if (bool(values, "discover")) {
    const discovered = await fetchVerifiedProvidersAcrossRegistries({
      registries: registryList(values, registry),
      ...(flag(values, "bundle-digest") === undefined
        ? {}
        : { bundleDigest: flag(values, "bundle-digest") }),
    });
    for (const { card } of discovered.providers) named.push(card.endpoint);
  }

  const endpoints = [...new Set(named.map((entry) => normalizeEndpoint(entry)).filter((e) => e !== ""))];
  if (endpoints.length === 0) throw new Error("--provider or --discover is required");

  const cards = await Promise.all(endpoints.map((endpoint) => fetchProviderCard({ endpoint })));
  const bundle = await fetchBundleManifest({
    registry,
    manifestHash: flag(values, "manifest-hash") ?? cards[0]!.bundle.manifestHash,
  });

  const verified = cards.map((card, index) => {
    const crossCheck = crossCheckProviderCard(card, bundle);
    const endpointMatch = normalizeEndpoint(card.endpoint) === endpoints[index];
    return {
      endpoint: endpoints[index]!,
      cardDigest: card.digest,
      modelId: card.model.id,
      verified: crossCheck.ok && endpointMatch,
      error: !endpointMatch
        ? `card names ${card.endpoint}`
        : crossCheck.ok
          ? null
          : crossCheck.errors.join("; "),
    };
  });

  const quorum = flag(values, "quorum") === undefined ? endpoints.length : Number(flag(values, "quorum"));
  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > endpoints.length) {
    throw new Error(`--quorum must be an integer between 1 and ${endpoints.length}`);
  }

  const prompt = flag(values, "prompt");
  let answers:
    | Array<{ endpoint: string; responseDigest: string | null; text: string | null; error: string | null }>
    | null = null;

  if (prompt !== undefined) {
    const body = {
      model: bundle.model.id,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      stream: false,
      max_tokens: flag(values, "max-tokens") ? Number(flag(values, "max-tokens")) : 64,
    };
    answers = await Promise.all(
      endpoints.map(async (endpoint) => {
        try {
          const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) {
            return {
              endpoint,
              responseDigest: null,
              text: null,
              error: `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
            };
          }
          const json: unknown = await response.json();
          const text =
            typeof json === "object" && json !== null
              ? String(
                  (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
                    ?.message?.content ?? "",
                )
              : "";
          return { endpoint, responseDigest: canonicalDigest(json), text, error: null };
        } catch (error) {
          return {
            endpoint,
            responseDigest: null,
            text: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  const groups = new Map<string, number>();
  for (const answer of answers ?? []) {
    if (answer.responseDigest === null) continue;
    groups.set(answer.responseDigest, (groups.get(answer.responseDigest) ?? 0) + 1);
  }
  const counts = [...groups.values()].sort((a, b) => b - a);
  const best = counts[0] ?? 0;
  const tie = counts.length > 1 && counts[0] === counts[1];
  const agreementOk = answers === null || (best >= quorum && !tie);
  const ok = verified.every((entry) => entry.verified) && agreementOk;

  if (bool(values, "json")) {
    console.log(
      JSON.stringify({ bundle: bundle.digest, quorum, providers: verified, answers, ok }, null, 2),
    );
    return ok ? 0 : 1;
  }

  console.log(`bundle ${bundle.digest} (${bundle.shards.length} shard(s))`);
  for (const entry of verified) {
    console.log(
      `  ${entry.verified ? "verified" : "FAILED  "}  ${entry.endpoint}  card ${entry.cardDigest.slice(0, 16)}…`,
    );
    if (entry.error) console.log(`    ${entry.error}`);
  }
  if (answers !== null) {
    console.log(`\nasked ${answers.length} provider(s) the same prompt; quorum ${quorum}`);
    for (const answer of answers) {
      console.log(
        `  ${answer.responseDigest?.slice(0, 16) ?? "---------------"}…  ${answer.endpoint}` +
          (answer.error ? `  ${answer.error}` : ""),
      );
    }
    console.log(
      agreementOk
        ? `\nPASS — ${best} provider(s) returned the same canonical response`
        : `\nFAIL — largest agreement was ${best}/${answers.length}, quorum ${quorum}${tie ? " (tie)" : ""}`,
    );
  }
  return ok ? 0 : 1;
}

async function commandVerifier(values: Record<string, unknown>): Promise<number> {
  const server = createVerifierServer();
  const port = flag(values, "port") ? Number(flag(values, "port")) : 8788;
  const host = flag(values, "host") ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const bound = address !== null && typeof address === "object" ? address.port : port;
  console.log(`rarext model-run verifier on http://${host}:${bound}/verify`);
  console.log(JSON.stringify(verifierConfig(`http://${host}:${bound}/verify`), null, 2));
  return 0;
}

async function commandVerify(values: Record<string, unknown>): Promise<number> {
  const transcriptPath = flag(values, "transcript");
  if (!transcriptPath) throw new Error("--transcript is required");
  const body = loadBody(resolve(transcriptPath));

  const challengePath = flag(values, "challenge");
  if (!challengePath) throw new Error("--challenge is required");
  const spec = specFromChallengeFile(resolve(challengePath));
  const result = verifyRunBody(body, spec);

  if (bool(values, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.correct ? "PASS" : "FAIL"} — ${result.details.checks.length} checks, transcript ${result.details.transcriptDigest.slice(0, 16)}…`);
    if (result.error) console.log(`  ${result.error}`);
  }
  return result.correct ? 0 : 1;
}

async function commandReplay(values: Record<string, unknown>): Promise<number> {
  const transcriptPath = flag(values, "transcript");
  if (!transcriptPath) throw new Error("--transcript is required");
  const body = loadBody(resolve(transcriptPath));
  if (!body.replay) {
    console.error("transcript has no replay envelope (it was sampled, not deterministic)");
    return 1;
  }

  const endpoint = normalizeEndpoint(flag(values, "endpoint") ?? body.replay.endpoint);
  const api: ApiShape = body.replay.api === "anthropic" ? "anthropic" : "openai";
  const upstream = upstreamOptions(values, api === "anthropic" ? "anthropic" : "openai-compatible");

  // The engine pin is checked first: a provider running a different engine is not
  // the engine the run committed, so its output would prove nothing.
  const result = await replayEngineRun({
    body,
    endpoint,
    api,
    headers: upstream.headers,
  });

  if (bool(values, "json")) {
    console.log(
      JSON.stringify(
        {
          same: result.ok,
          enginePinned: body.engine.fingerprint ?? null,
          enginePresent: result.engineFingerprint,
          reason: result.reason,
          expected: body.response.text,
          replayed: result.replayed,
        },
        null,
        2,
      ),
    );
    return result.ok ? 0 : 1;
  }

  if (result.engineFingerprint !== null && body.engine.fingerprint !== undefined) {
    console.log(
      `${result.engineFingerprint === body.engine.fingerprint ? "engine pinned" : "engine differs"} — ` +
        `${String(body.engine.fingerprint).slice(0, 16)}… vs ${result.engineFingerprint.slice(0, 16)}…`,
    );
  }
  if (result.reproduced === null) {
    console.log(`FAIL — ${result.reason ?? "replay did not run"}`);
    return 1;
  }
  console.log(
    `${result.ok ? "PASS" : "FAIL"} — replay ${result.ok ? "reproduced" : "did NOT reproduce"} ` +
      `the committed output (${String(result.replayed).length} chars)`,
  );
  if (!result.ok) {
    console.log(`  committed: ${JSON.stringify(body.response.text.slice(0, 160))}`);
    console.log(`  replayed:  ${JSON.stringify(String(result.replayed).slice(0, 160))}`);
  }
  return result.ok ? 0 : 1;
}

async function commandLedger(values: Record<string, unknown>): Promise<number> {
  const dir = resolve(flag(values, "state") ?? ".rarext-runtime");
  const ledger = new RunLedger(dir);
  const challengePath = flag(values, "challenge");

  // Without a challenge this is the chain check. With one, every run is also
  // verified against the deployment, so a ledger cannot mix two models under a
  // valid chain and still pass.
  const result = challengePath
    ? auditLedger(ledger.records(), specFromChallengeFile(resolve(challengePath)))
    : ledger.verify();

  if (bool(values, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if ("runs" in result) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} — ${result.count} run(s), chain ${result.chain.ok ? "intact" : "broken"}, ` +
        `${result.runs.filter((run) => run.correct).length}/${result.runs.length} match the challenge, head ${String(result.chain.head).slice(0, 16)}…`,
    );
    for (const error of result.chain.errors) console.log(`  chain [${error.index}] ${error.reason}`);
    for (const run of result.runs) {
      if (!run.correct) console.log(`  run [${run.index}] ${run.digest.slice(0, 16)}… ${run.error ?? "does not match"}`);
    }
  } else {
    console.log(`${result.ok ? "PASS" : "FAIL"} — ${result.count} run(s), head ${String(result.head).slice(0, 16)}…`);
    for (const error of result.errors) console.log(`  [${error.index}] ${error.reason}`);
  }
  return result.ok ? 0 : 1;
}

async function commandInspect(values: Record<string, unknown>): Promise<number> {
  const deployment = deploymentFrom(values);
  console.log(JSON.stringify(deployment, null, 2));
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      endpoint: { type: "string" },
      engine: { type: "string" },
      model: { type: "string" },
      manifest: { type: "string" },
      deployment: { type: "string" },
      state: { type: "string" },
      backend: { type: "string" },
      device: { type: "string" },
      pull: { type: "boolean" },
      remote: { type: "boolean" },
      web4: { type: "boolean" },
      placement: { type: "string" },
      provider: { type: "string", multiple: true },
      discover: { type: "boolean" },
      "all-anchors": { type: "boolean" },
      "bundle-digest": { type: "string" },
      quorum: { type: "string" },
      bounty: { type: "string" },
      prompt: { type: "string" },
      "max-tokens": { type: "string" },
      file: { type: "string" },
      native: { type: "boolean" },
      vocab: { type: "string" },
      params: { type: "string" },
      steps: { type: "string" },
      execution: { type: "string" },
      "engine-model": { type: "string" },
      "chunk-bytes": { type: "string" },
      "manifest-hash": { type: "string" },
      "verify-shards": { type: "boolean" },
      seal: { type: "boolean" },
      "seal-key-file": { type: "string" },
      "seal-to": { type: "string" },
      "enclave-key-file": { type: "string" },
      "enclave-endpoint": { type: "string" },
      machine: { type: "string" },
      measurement: { type: "string" },
      measure: { type: "string" },
      "engine-version": { type: "string" },
      "engine-digest": { type: "string" },
      "engine-logprobs": { type: "boolean" },
      "tee-key-file": { type: "string" },
      "tee-cert-file": { type: "string" },
      "tee-vendor": { type: "string" },
      "tee-chain-depth": { type: "string" },
      "tee-boot-stages": { type: "string" },
      "tee-boot-measurements": { type: "string" },
      "tee-freshness": { type: "string" },
      "tee-code": { type: "string" },
      "code-measurement": { type: "string" },
      "tee-signed-image": { type: "string" },
      "tee-signed-image-depth": { type: "string" },
      "require-trace": { type: "boolean" },
      "require-replay": { type: "boolean" },
      "image-manifest": { type: "string" },
      independence: { type: "string" },
      "engine-endpoint": { type: "string" },
      family: { type: "string" },
      parameters: { type: "string" },
      quantization: { type: "string" },
      format: { type: "string" },
      "context-length": { type: "string" },
      "allow-loopback": { type: "boolean" },
      "upstream-api": { type: "string" },
      "upstream-auth": { type: "string" },
      "upstream-key-env": { type: "string" },
      "gateway-token-env": { type: "string" },
      "public-url": { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      publish: { type: "boolean" },
      anchor: { type: "boolean" },
      registry: { type: "string" },
      "mirror-registry": { type: "string", multiple: true },
      handle: { type: "string" },
      challenge: { type: "string" },
      transcript: { type: "string" },
      bundle: { type: "string" },
      "verifier-url": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (bool(values, "help")) usage();
  const command = positionals[0] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) usage();

  switch (command) {
    case "plan":
      return commandPlan(values);
    case "bundle":
      return commandBundle(values);
    case "provider":
      return commandProvider(values);
    case "deploy":
      return commandDeploy(values);
    case "publish-deployment":
      return commandPublishDeployment(values);
    case "anchor":
      return commandAnchor(values);
    case "discover":
      return commandDiscover(values);
    case "announce":
      return commandAnnounce(values);
    case "compare":
      return commandCompare(values);
    case "serve":
      return commandServe(values);
    case "verifier":
      return commandVerifier(values);
    case "verify":
      return commandVerify(values);
    case "replay":
      return commandReplay(values);
    case "ledger":
      return commandLedger(values);
    case "inspect":
      return commandInspect(values);
    default:
      usage();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
