import { execFile } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";

import {
  MAX_GENERATIVE_OUTPUT_LENGTH,
  generateTokens,
  isXorshiftModel,
} from "../../../packages/core/src/ai.ts";
import type { XorshiftModel } from "../../../packages/core/src/ai.ts";
import { attestationForReceipt } from "./certificates.ts";
import { comparableCompletion } from "./completion.ts";
import { runtimeCodeMeasurement } from "./code-measurement.ts";
import { canonicalDigest, sha256Hex } from "./digest.ts";
import { verifyImageManifest } from "./image-manifest.ts";
import type { ImageManifest, IsolationClass } from "./image-manifest.ts";
import { engineDescriptorFingerprint } from "./engine-pin.ts";
import { fetchEngineArtifact, loadEngine } from "./engine-bundle.ts";
import type { EngineBundle, NativeEngine } from "./engine-bundle.ts";
import {
  fetchBundleChunks,
  fetchBundleCiphertext,
  fetchBundleManifest,
  buildProviderCard,
  bundleManifestHash,
  PROVIDER_MACHINE_KIND,
  providerQuotePayload,
  unwrapSealKey,
  verifyModelBundle,
} from "./model-bundle.ts";
import type { ProviderCertificate, ProviderIndependence } from "./model-bundle.ts";
import { enclaveKeyDigest, openRequest, sealResponse } from "./confidential.ts";
import type { RootChain } from "./root-chain.ts";
import type { SealedRequest } from "./confidential.ts";
import type { ModelBundle, ProviderCard } from "./model-bundle.ts";
import { normalizeEndpoint } from "./manifest.ts";
import type { ApiShape } from "./types.ts";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface ProviderOptions {
  bundle: ModelBundle;
  registry: string;
  stateDir: string;
  /** Required for `execution.kind: "engine"`. The engine must already run here. */
  engineEndpoint?: string;
  host?: string;
  port?: number;
  /** URL clients should use when the bind host is not dialable. */
  publicUrl?: string;
  providerHandle?: string | null;
  /**
   * The machine identity this provider attests. Defaults to a host fingerprint,
   * so two providers on one box attest the same machine and a deployment that
   * requires distinct machines refuses them. An operator on its own hardware
   * passes a stable id; a TEE deployment would derive it from the enclave.
   */
  machine?: string | null;
  /**
   * The measurement the provider attests. Defaults to a digest of the machine
   * identity; an operator running an approved image passes the image's
   * measurement, which a deployment's allowlist can then require.
   */
  measurement?: string | null;
  /**
   * The measurement of the code this process is running. Defaults to a digest of
   * the runtime's own source, so a deployment that pins one refuses an enclave
   * running other code.
   */
  codeMeasurement?: string | null;
  /**
   * A vendor-signed image manifest vouching for the running code. The provider
   * refuses to start unless the manifest is valid AND its image is the code this
   * process actually runs, then binds that manifest into its attestation.
   */
  imageManifest?: ImageManifest;
  /**
   * The memory-isolation capability this provider claims for its running image.
   * `host-root-excluded` asserts the host root cannot read this process's memory;
   * a software-only process must NOT set it. The claim is covered by the signed
   * quote, and the vendor image manifest must certify it too, so a deployment
   * that demands isolation refuses a host-readable enclave.
   */
  isolation?: IsolationClass | null;
  /**
   * The key that opens a sealed bundle. The provider decrypts the shards in
   * memory and never writes plaintext weights to disk; without the key a sealed
   * bundle is refused before any model is loaded.
   */
  sealKey?: Uint8Array;
  /**
   * The serving engine's version and image digest, when the operator knows them.
   * They are folded into the engine fingerprint a run pins and a replay checks.
   */
  engineVersion?: string | null;
  engineDigest?: string | null;
  /**
   * The ENGINE as a RAREXT artifact. When present, the provider fetches every
   * shard from RAREXT, verifies it against the committed engine digest, and runs
   * the fetched engine for the native class — so the engine is a RAREXT artifact,
   * not whatever the box happens to have. A tampered shard or a module with no
   * engine interface is refused before the provider serves. The artifact digest
   * is folded into the engine fingerprint, binding runs and replays to it.
   */
  engineBundle?: EngineBundle;
  /**
   * The vendor/attestation key that signs this provider's machine quote. In a
   * real TEE this key lives in the chip; here the operator supplies it, and a
   * deployment pins its key id. Without it the card carries an unsigned machine
   * claim (allowlist-checkable, but not quote-verifiable).
   */
  teeSigner?: { sign(payload: unknown): string; publicKey: unknown; suite: string };
  /**
   * Certificates from the teeSigner's leaf key up to the trust anchor, so the
   * quote's chain of trust can be checked against a pinned root.
   */
  teeChain?: ProviderCertificate[];
  /**
   * An append-only root rotation/revocation chain from the pinned anchor to the
   * root that issued `teeChain`. It lets a verifier learn the CURRENT root and
   * which roots are revoked, so a quote rooted at a retired root is refused.
   */
  teeRootChain?: RootChain;
  /**
   * The enclave's RSA private key. With it, a bundle sealed to that enclave is
   * unwrapped and served inside this process (the enclave). Without it the
   * process cannot open the model.
   */
  enclaveKey?: import("node:crypto").KeyObject | string;
  /**
   * Forward inference to an enclave instead of loading the model. The provider
   * verifies the committed CIPHERTEXT and proxies to the enclave, so the
   * operator's serving process never holds the plaintext weights.
   */
  enclaveEndpoint?: string;
  /**
   * Ask the engine for per-token logprobs and record a decode JUDGMENT, so an
   * engine run is checked at the decode level rather than the text level alone.
   */
  engineLogprobs?: boolean;
  /**
   * Extra registries to fetch the manifest and shards from. A bundle is
   * content-addressed, so any mirror serves the same bytes; naming one means a
   * single registry outage does not stop this provider.
   */
  mirrors?: string[];
  /** How the engine loads a verified file. Injected in tests; Ollama in production. */
  engineCreate?: EngineCreate;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface Provider {
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
  card: ProviderCard;
  bundle: ModelBundle;
  /** The reassembled model bytes after every shard was verified. */
  modelBytes: Buffer;
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(request: IncomingMessage, limit = MAX_REQUEST_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`request body above ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function lastUserText(body: Record<string, unknown>): string {
  if (typeof body.prompt === "string") return body.prompt;
  if (Array.isArray(body.prompt)) return body.prompt.map(String).join("\n");

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) =>
          isRecord(part) && typeof part.text === "string" ? part.text : "",
        )
        .filter((text) => text !== "")
        .join("\n");
    }
  }
  return messages.map((message) => (isRecord(message) ? String(message.content ?? "") : "")).join("\n");
}

function requestedSteps(body: Record<string, unknown>, fallback: number): number {
  const raw = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
  const steps = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
  return Math.max(1, Math.min(steps, 4096));
}

function longestToken(model: XorshiftModel): number {
  return model.vocab.reduce((longest, token) => Math.max(longest, token.length), 0);
}

/** Run the committed native model. The prompt selects the seed; the seed is committed too. */
export function runNativeModel(
  model: XorshiftModel,
  input: { prompt: string; steps: number; seed?: number | null },
): { text: string; seed: number; steps: number; tokens: number[] } {
  const seed =
    typeof input.seed === "number" && Number.isSafeInteger(input.seed)
      ? input.seed >>> 0
      : parseInt(sha256Hex(input.prompt).slice(0, 8), 16) >>> 0;

  const bound = Math.floor(MAX_GENERATIVE_OUTPUT_LENGTH / Math.max(1, longestToken(model)));
  const steps = Math.max(1, Math.min(input.steps, bound));
  const tokens = generateTokens(model, seed, steps);
  return {
    text: tokens.map((token) => model.vocab[token]).join(""),
    seed,
    steps,
    tokens,
  };
}

/**
 * What a run commits about its decode. The native class records the token ids it
 * emitted; an engine that exposes per-token logprobs records a JUDGMENT — the
 * token sequence and each token's logprob — so an engine run can be checked at
 * the decode level too, not only at the text level. An engine that exposes
 * neither records nothing, which is honest.
 */
export type TraceData =
  | { kind: "rarext.decode-trace.v1"; tokens: number[] }
  | { kind: "rarext.judgment.v1"; tokens: string[]; logprobs: number[] };

/**
 * The decode trace a run records: the trace fields plus a digest over them. A
 * replay re-runs and refuses when the digest diverges. The digest covers the
 * trace WITHOUT the digest field, so the verifier recomputes it the same way.
 */
export function decodeTrace(trace: TraceData | null): Record<string, unknown> {
  if (trace === null) return {};
  return { rarext_trace: { ...trace, digest: canonicalDigest(trace) } };
}

/**
 * The base64 header a provider returns: its operator key's signature over the
 * request digest, the comparable response digest, its own attestation, AND the
 * engine it served with. A gateway that relays the answer cannot fabricate it,
 * cannot pair the answer with a different enclave, and cannot attribute it to a
 * different engine — so a verifier sees the provider's own claim about where it
 * ran, not just the deployment's, and a provider whose engine changed is refused.
 */
function responseReceiptHeader(
  signer: AgentSigner,
  requestBody: unknown,
  responseBody: Record<string, unknown>,
  attestation: unknown,
  engine: string | null,
  bundle: string | null,
): string {
  const payload = {
    kind: "rarext.response-receipt.v1",
    request: canonicalDigest(requestBody),
    response: canonicalDigest(comparableCompletion(responseBody)),
    ...(attestation === undefined
      ? {}
      : { attestation: canonicalDigest(attestationForReceipt(attestation)) }),
    ...(engine === null ? {} : { engine }),
    ...(bundle === null ? {} : { bundle }),
  };
  const receipt = {
    ...payload,
    signature: signer.sign(payload),
    publicKey: signer.publicKey,
    suite: signer.suite,
  };
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
}

function parseNativeModel(bytes: Buffer): XorshiftModel {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("native model bytes are not valid JSON");
  }
  if (!isXorshiftModel(value)) {
    throw new Error("native model bytes are not a committed xorshift32 model");
  }
  return value;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96) || "model";
}

interface ProviderIdentity {
  kind: "rarext.provider-identity.v1";
  handle: string | null;
  privateKey: NodeJsonWebKey;
  publicKey: NodeJsonWebKey;
  createdAt: string;
}

/**
 * A provider's own key. The card it serves is signed with this key, so the
 * operator identity in a quorum is a key id that anyone can verify, not a
 * string the provider asked to be called. The key persists in the provider's
 * state directory; deleting it gives the provider a new identity.
 */
function loadProviderIdentity(stateDir: string, handle: string | null): ProviderIdentity {
  const path = join(stateDir, "provider-identity.json");
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as ProviderIdentity;
  }

  const { privateKey, publicKey } = generateAgentKeypair("ecdsa-p256");
  // The SDK's JsonWebKey is structurally a JWK but does not carry Node's index
  // signature; the bytes on disk are the same, so bridge the types here rather
  // than widening the persisted identity to `unknown`.
  const identity: ProviderIdentity = {
    kind: "rarext.provider-identity.v1",
    handle,
    privateKey: privateKey as unknown as NodeJsonWebKey,
    publicKey: publicKey as unknown as NodeJsonWebKey,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, JSON.stringify(identity, null, 2));
  return identity;
}

/**
 * How a provider hands a verified file to its engine. Injected so a test can
 * watch the file's lifecycle without an engine installed; production uses the
 * Ollama CLI.
 */
export type EngineCreate = (input: {
  engineModel: string;
  file: string;
  modelfile: string;
  engineEndpoint: string;
}) => Promise<void>;

const defaultEngineCreate: EngineCreate = async (input) => {
  const host = new URL(normalizeEndpoint(input.engineEndpoint));
  const ollamaHost = `${host.hostname}:${host.port || "11434"}`;
  // Ollama's `/api/create` accepts model names and uploaded files, not a path
  // on the provider's disk. The provider has the verified file, so it uses the
  // engine's own CLI, which does. No shell is involved: argv is an array, and
  // the Modelfile is written by this process.
  try {
    await promisify(execFile)(
      "ollama",
      ["create", input.engineModel, "-f", input.modelfile],
      {
        env: { ...process.env, OLLAMA_HOST: ollamaHost },
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (error) {
    const detail =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? error.message)
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`engine refused to create ${input.engineModel}: ${detail.slice(-1000)}`);
  }
};

async function materializeEngineModel(input: {
  bundle: ModelBundle;
  bytes: Buffer;
  stateDir: string;
  engineEndpoint: string;
  log: (message: string) => void;
  /** A sealed bundle is opened only long enough for the engine to load it. */
  sealed?: boolean;
  engineCreate?: EngineCreate;
}): Promise<string> {
  if (input.bundle.execution.kind !== "engine") {
    throw new Error("materializeEngineModel requires an engine execution");
  }
  const engine = input.bundle.execution.engine;
  if (engine !== "ollama") {
    throw new Error(
      `engine execution is implemented for Ollama only; ${engine} must load the fetched file itself`,
    );
  }

  const format = input.bundle.model.format ?? "bin";
  const sealed = input.sealed === true;
  // A sealed model is written to a mode-0600 file under the OS temp directory —
  // never the provider's state dir, never a cached artifact — and the whole
  // directory is removed after the engine has loaded it. The plaintext is on
  // disk only for the load, which is what feeding a file-based engine costs.
  const directory = sealed
    ? mkdtempSync(join(tmpdir(), "rarext-sealed-engine-"))
    : join(input.stateDir, "models");
  if (!sealed) mkdirSync(directory, { recursive: true });
  const file = join(directory, `${sanitizeFilePart(input.bundle.id)}.${sanitizeFilePart(format)}`);

  if (sealed) {
    writeFileSync(file, input.bytes, { mode: 0o600 });
    input.log(
      `opened ${input.bytes.length} sealed bytes into an ephemeral file the provider never keeps`,
    );
  } else {
    const expected = input.bundle.model.weightsDigest?.replace(/^sha256:/, "") ?? "";
    let write = true;
    if (existsSync(file)) {
      write = sha256Hex(readFileSync(file)) !== expected;
    }
    if (write) {
      writeFileSync(file, input.bytes);
      input.log(`wrote ${input.bytes.length} verified bytes to ${file}`);
    } else {
      input.log(`reusing verified model file ${file}`);
    }
  }

  const engineModel = input.bundle.execution.engineModel ?? input.bundle.id;
  input.log(`asking ${engine} to create ${engineModel} from the verified file`);
  const modelfile = join(directory, `${sanitizeFilePart(engineModel)}.Modelfile`);
  writeFileSync(modelfile, `FROM ${file}\n`);

  const create = input.engineCreate ?? defaultEngineCreate;
  try {
    await create({ engineModel, file, modelfile, engineEndpoint: input.engineEndpoint });
  } finally {
    if (sealed) {
      rmSync(directory, { recursive: true, force: true });
      input.log(`removed the ephemeral sealed file for ${engineModel}`);
    }
  }

  return engineModel;
}

/**
 * Start a provider: fetch every shard from RAREXT, verify the committed digest,
 * load the model, and serve an OpenAI-compatible endpoint. The original model
 * file is never read; only RAREXT storage supplies the bytes.
 */
/**
 * A forwarding provider: it verifies the committed CIPHERTEXT of a sealed
 * bundle and proxies inference to an enclave, holding no key and loading no
 * model. This is the operator-privacy path — the serving process the network
 * talks to never sees plaintext weights; only the enclave, whose attestation the
 * card carries, can open them.
 */
async function startEnclaveProxy(options: ProviderOptions, enclaveEndpoint: string): Promise<Provider> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.bundle.sealing === undefined) {
    throw new Error("a forwarding provider needs a sealed bundle");
  }

  const manifestHash = bundleManifestHash(options.bundle);
  const registries = [options.registry, ...(options.mirrors ?? [])];
  const manifest = await fetchBundleManifest({
    registry: options.registry,
    registries,
    manifestHash,
    fetchImpl,
  });
  if (manifest.digest !== options.bundle.digest) {
    throw new Error(`registry returned bundle ${manifest.digest}, expected ${options.bundle.digest}`);
  }
  // Prove the committed ciphertext is served — without any key.
  const { bytes: ciphertext } = await fetchBundleCiphertext({
    registry: options.registry,
    registries,
    bundle: options.bundle,
    fetchImpl,
    onShard: (index, size) => log(`  shard ${index + 1}/${options.bundle.shards.length} ${size} bytes`),
  });
  log(`verified ${ciphertext.length} bytes of ciphertext; this process holds no key`);

  const enclave = normalizeEndpoint(enclaveEndpoint);
  const enclaveHealth = await fetchImpl(`${enclave}/health`, { signal: AbortSignal.timeout(15_000) });
  if (!enclaveHealth.ok) {
    throw new Error(`the enclave at ${enclave} is not healthy: HTTP ${enclaveHealth.status}`);
  }
  const health = (await enclaveHealth.json()) as {
    bundle?: unknown;
    weightsDigest?: unknown;
  };
  if (health.bundle !== options.bundle.digest || health.weightsDigest !== options.bundle.model.weightsDigest) {
    throw new Error(`the enclave at ${enclave} does not serve this bundle`);
  }
  let enclaveAttestation: ProviderIndependence | undefined;
  try {
    const response = await fetchImpl(`${enclave}/v1/attestation`, { signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const body = (await response.json()) as { attestation?: ProviderIndependence | null };
      enclaveAttestation = body.attestation ?? undefined;
    }
  } catch {
    enclaveAttestation = undefined;
  }

  const identity = loadProviderIdentity(options.stateDir, options.providerHandle ?? null);
  const signer = new AgentSigner(identity.privateKey as unknown as NodeJsonWebKey);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  let card: ProviderCard | null = null;
  let boundUrl = "";

  function cardFor(): ProviderCard {
    if (card !== null) return card;
    card = buildProviderCard({
      bundle: options.bundle,
      manifestHash,
      endpoint: boundUrl,
      provider: {
        handle: options.providerHandle ?? identity.handle ?? null,
        keyId: signer.keyId,
        publicKey: signer.publicKey,
        suite: signer.suite,
      },
      ...(enclaveAttestation === undefined ? {} : { independence: enclaveAttestation }),
      apis: ["openai"] as ApiShape[],
      sign: (payload) => signer.sign(payload),
    });
    return card;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          bundle: options.bundle.digest,
          weightsDigest: options.bundle.model.weightsDigest,
          execution: options.bundle.execution.kind,
          enclave,
          holdsKey: false,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/provider-card") {
        sendJson(response, 200, cardFor());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/attestation") {
        sendJson(response, 200, {
          role: "forwarder",
          bundle: options.bundle.digest,
          attestation: enclaveAttestation ?? null,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/bundle") {
        sendJson(response, 200, options.bundle);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [
            {
              id: options.bundle.model.id,
              object: "model",
              created: Math.floor(Date.parse(options.bundle.createdAt) / 1000),
              owned_by: "rarext-enclave-forwarder",
              digest: options.bundle.model.weightsDigest?.replace(/^sha256:/, "") ?? null,
            },
          ],
        });
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/completions")
      ) {
        const raw = await readBody(request);
        const upstream = await fetchImpl(`${enclave}${url.pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
          signal: AbortSignal.timeout(120_000),
        });
        const text = await upstream.text();
        const headers: Record<string, string> = {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          "x-rarext-enclave": "forwarded",
        };
        // The forwarder signs its own receipt over what it returned, so the
        // gateway's record of this operator's answer is verifiable too.
        if (upstream.ok) {
          try {
            const parsed = JSON.parse(text) as unknown;
            if (isRecord(parsed)) {
              headers["x-rarext-receipt"] = responseReceiptHeader(
                signer,
                JSON.parse(raw) as unknown,
                parsed,
                cardFor().independence,
                // The forwarder runs no engine of its own; it does not claim one.
                null,
                options.bundle.digest,
              );
            }
          } catch {
            // A non-JSON body (a stream) carries no receipt.
          }
        }
        response.writeHead(upstream.status, headers);
        response.end(text);
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = address !== null && typeof address === "object" ? address.port : port;
  const dialHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  boundUrl = options.publicUrl ?? `http://${dialHost}:${actualPort}`;
  log(`forwarding to enclave ${enclave}; this process holds ciphertext and no key`);

  return {
    server,
    port: actualPort,
    url: boundUrl,
    card: cardFor(),
    bundle: options.bundle,
    // The forwarder's "model bytes" are the verified CIPHERTEXT, never plaintext.
    modelBytes: ciphertext,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startProvider(options: ProviderOptions): Promise<Provider> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;

  const bundleErrors = verifyModelBundle(options.bundle);
  if (bundleErrors.length > 0) {
    throw new Error(`refusing to serve an invalid model bundle: ${bundleErrors.join("; ")}`);
  }

  // A forwarding provider holds no key and loads no model; it verifies the
  // committed ciphertext and proxies to an enclave that alone can open it.
  if (options.enclaveEndpoint !== undefined) {
    return startEnclaveProxy(options, options.enclaveEndpoint);
  }

  // The enclave opens a bundle sealed to it: the data key is unwrapped with the
  // enclave's private key, and never leaves this process.
  const sealKey =
    options.enclaveKey !== undefined && options.bundle.sealing?.wrap !== undefined
      ? unwrapSealKey(options.bundle, options.enclaveKey)
      : options.sealKey;

  const manifestHash = bundleManifestHash(options.bundle);
  // The manifest must be in RAREXT too, so a reader can fetch the same list of
  // shards this provider used rather than trusting the card's copy.
  const registries = [options.registry, ...(options.mirrors ?? [])];
  const manifest = await fetchBundleManifest({
    registry: options.registry,
    registries,
    manifestHash,
    fetchImpl,
  });
  if (manifest.digest !== options.bundle.digest) {
    throw new Error(
      `registry returned bundle ${manifest.digest}, expected ${options.bundle.digest}`,
    );
  }

  log(
    `fetching ${options.bundle.shards.length} shard(s) / ${options.bundle.totalBytes} bytes ` +
      `for ${options.bundle.model.id} from ${options.registry}` +
      (options.bundle.sealing === undefined ? "" : ` (sealed, ${options.bundle.sealing.scheme})`),
  );
  const { bytes } = await fetchBundleChunks({
    registry: options.registry,
    registries,
    bundle: options.bundle,
    fetchImpl,
    ...(sealKey === undefined ? {} : { sealKey }),
    onShard: (index, size) => log(`  shard ${index + 1}/${options.bundle.shards.length} ${size} bytes`),
  });
  log(
    `verified ${bytes.length} bytes against ${options.bundle.model.weightsDigest}` +
      (options.bundle.sealing === undefined ? "" : " (opened in memory; the RAREXT store never holds plaintext)"),
  );

  // The engine the provider will RUN. When it is a RAREXT artifact, fetch and
  // verify it first: a shard that does not hash to the committed engine, or a
  // module that exposes no engine, stops the provider before it serves anything.
  let loadedEngine: NativeEngine | null = null;
  if (options.engineBundle !== undefined) {
    if (options.bundle.execution.kind !== "native") {
      throw new Error("a RAREXT engine artifact runs the native class; the engine class loads a model into a local engine");
    }
    const source = await fetchEngineArtifact({ registries, bundle: options.engineBundle });
    loadedEngine = loadEngine(source);
    log(
      `loaded engine ${options.engineBundle.name}@${options.engineBundle.engineVersion} ` +
        `(${options.engineBundle.artifactDigest.slice(0, 18)}…) from ${options.engineBundle.shards.length} RAREXT shard(s)`,
    );
  }

  let native: XorshiftModel | null = null;
  let engineModel: string | null = null;
  if (options.bundle.execution.kind === "native") {
    native = parseNativeModel(bytes);
  } else {
    if (options.engineEndpoint === undefined) {
      throw new Error("an engine bundle needs --engine-endpoint so the provider can load the model");
    }
    engineModel = await materializeEngineModel({
      bundle: options.bundle,
      bytes,
      stateDir: options.stateDir,
      engineEndpoint: options.engineEndpoint,
      log,
      ...(options.bundle.sealing === undefined ? {} : { sealed: true }),
      ...(options.engineCreate === undefined ? {} : { engineCreate: options.engineCreate }),
    });
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  let card: ProviderCard | null = null;
  let boundUrl = "";

  // The card is signed by the provider's own key. Its `keyId` is derived from
  // that key, so a quorum that counts distinct operators is counting distinct
  // signing keys, not labels.
  const identity = loadProviderIdentity(options.stateDir, options.providerHandle ?? null);
  const signer = new AgentSigner(identity.privateKey as unknown as NodeJsonWebKey);

  /**
   * Sign the receipt for one response: the operator's own key over the request
   * digest and the comparable response digest. The gateway that relays the answer
   * cannot fabricate this, so the transcript proves what the provider said.
   */
  const receiptHeader = (requestBody: unknown, responseBody: Record<string, unknown>): string =>
    responseReceiptHeader(
      signer,
      requestBody,
      responseBody,
      cardFor().independence,
      engineFingerprint,
      options.bundle.digest,
    );

  // The machine this provider attests, bound to the key that signs the card. The
  // default is the host, so co-located providers collide and a machine-independent
  // challenge can tell they are one box.
  const machine =
    options.machine ?? `host:${hostname()}:${platform()}:${arch()}`;
  const measurement =
    options.measurement ?? sha256Hex(`rarext.machine.v1\n${machine}`);
  // The code this process runs. With a vendor-signed image manifest, the code
  // identity is bound to the vendor's signature, and the provider refuses to run
  // if the manifest does not vouch for the code it is actually running.
  let codeMeasurement: string;
  let imageManifest: ImageManifest | undefined;
  if (options.imageManifest !== undefined) {
    const info = verifyImageManifest(options.imageManifest);
    if (info === null) {
      throw new Error("refusing to start: the image manifest is not a valid vendor-signed manifest");
    }
    const running = runtimeCodeMeasurement();
    if (info.image !== running) {
      throw new Error("refusing to start: the running code is not the signed image");
    }
    codeMeasurement = info.image;
    imageManifest = options.imageManifest;
  } else {
    codeMeasurement = options.codeMeasurement ?? runtimeCodeMeasurement();
  }

  // The engine this provider actually serves with, and the one value a run pins.
  // When the engine is a RAREXT artifact, its name/version/digest ARE the
  // artifact's, so the fingerprint folds the engine-bundle digest into every run
  // and a replay refuses an engine that does not match the committed artifact.
  const engineDescriptor =
    options.engineBundle !== undefined
      ? {
          name: options.engineBundle.name,
          version: options.engineBundle.engineVersion,
          digest: options.engineBundle.artifactDigest,
        }
      : {
          name:
            options.bundle.execution.kind === "engine"
              ? options.bundle.execution.engine
              : "rarext-native",
          version:
            options.engineVersion ??
            (options.bundle.execution.kind === "engine" ? null : "xorshift32"),
          digest: options.engineDigest ?? null,
        };
  const engineFingerprint = engineDescriptorFingerprint(engineDescriptor);

  function cardFor(): ProviderCard {
    if (card !== null) return card;
    card = buildProviderCard({
      bundle: options.bundle,
      manifestHash,
      endpoint: boundUrl,
      provider: {
        handle: options.providerHandle ?? identity.handle ?? null,
        keyId: signer.keyId,
        publicKey: signer.publicKey,
        suite: signer.suite,
      },
      independence: (() => {
        const body: Omit<ProviderIndependence, "quote"> = {
          kind: PROVIDER_MACHINE_KIND,
          scheme: options.teeSigner === undefined ? "software-image" : "tee",
          machine,
          measurement,
          code: codeMeasurement,
          ...(options.isolation === undefined || options.isolation === null
            ? {}
            : { isolation: options.isolation }),
          ...(imageManifest === undefined ? {} : { image: imageManifest }),
          // Bind the enclave's encryption key into the signed attestation, so a
          // caller can verify the key it seals to belongs to this enclave.
          ...(options.enclaveKey === undefined
            ? {}
            : { enclaveKey: enclaveKeyDigest(options.enclaveKey) }),
          issuedAt: new Date().toISOString(),
        };
        if (options.teeSigner === undefined) return body;
        return {
          ...body,
          quote: {
            signature: options.teeSigner.sign(providerQuotePayload(body)),
            publicKey: options.teeSigner.publicKey,
            suite: options.teeSigner.suite,
            ...(options.teeChain === undefined ? {} : { chain: options.teeChain }),
            ...(options.teeRootChain === undefined ? {} : { rootChain: options.teeRootChain }),
          },
        };
      })(),
      apis: ["openai"] as ApiShape[],
      sign: (payload) => signer.sign(payload),
    });
    return card;
  }

  async function complete(
    body: Record<string, unknown>,
    shape: "chat" | "completions" = "chat",
  ): Promise<{ text: string; seed: number | null; steps: number; trace: TraceData | null }> {
    const prompt = lastUserText(body);

    if (native !== null) {
      const seed =
        typeof body.seed === "number" && Number.isSafeInteger(body.seed)
          ? (body.seed as number)
          : null;
      const steps = requestedSteps(
        body,
        options.bundle.execution.kind === "native" ? options.bundle.execution.defaultSteps : 32,
      );
      // The engine is the RAREXT artifact when one was committed: the provider
      // runs what it fetched and verified, not a local implementation.
      const result = loadedEngine !== null
        ? loadedEngine.run(native, { prompt, steps, seed })
        : runNativeModel(native, { prompt, steps, seed });
      if (
        result === null ||
        typeof result !== "object" ||
        typeof result.text !== "string" ||
        !Number.isSafeInteger(result.seed) ||
        !Number.isSafeInteger(result.steps) ||
        !Array.isArray(result.tokens) ||
        !result.tokens.every((token) => Number.isSafeInteger(token))
      ) {
        throw new Error("the RAREXT engine artifact returned a malformed native result");
      }
      return {
        text: result.text,
        seed: result.seed,
        steps: result.steps,
        trace: { kind: "rarext.decode-trace.v1", tokens: result.tokens },
      };
    }

    if (engineModel === null || options.engineEndpoint === undefined) {
      throw new Error("engine model was not materialized");
    }
    const upstream = await fetchImpl(
      `${normalizeEndpoint(options.engineEndpoint)}/v1/${shape === "chat" ? "chat/completions" : "completions"}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          model: engineModel,
          stream: false,
          // Ask for per-token logprobs when enabled, so the run records a decode
          // judgment; an engine that ignores the field simply records none.
          ...(options.engineLogprobs === true ? { logprobs: true } : {}),
        }),
        signal: AbortSignal.timeout(600_000),
      },
    );
    if (!upstream.ok) {
      throw new Error(`engine returned HTTP ${upstream.status} ${await upstream.text()}`);
    }
    const json = (await upstream.json()) as {
      choices?: Array<{
        message?: { content?: unknown };
        text?: unknown;
        logprobs?: { content?: Array<{ token?: unknown; logprob?: unknown }> };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text =
      shape === "chat"
        ? String(json.choices?.[0]?.message?.content ?? "")
        : String(json.choices?.[0]?.text ?? "");

    // A decode judgment, when the engine exposes token logprobs.
    const content = json.choices?.[0]?.logprobs?.content;
    let trace: TraceData | null = null;
    if (Array.isArray(content) && content.length > 0) {
      const tokens: string[] = [];
      const logprobs: number[] = [];
      for (const entry of content) {
        if (typeof entry?.token !== "string" || typeof entry?.logprob !== "number") {
          tokens.length = 0;
          break;
        }
        tokens.push(entry.token);
        logprobs.push(entry.logprob);
      }
      if (tokens.length > 0) trace = { kind: "rarext.judgment.v1", tokens, logprobs };
    }
    return { text, seed: null, steps: json.usage?.completion_tokens ?? 0, trace };
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          bundle: options.bundle.digest,
          weightsDigest: options.bundle.model.weightsDigest,
          execution: options.bundle.execution.kind,
          engine: engineDescriptor,
          engineFingerprint,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/provider-card") {
        sendJson(response, 200, cardFor());
        return;
      }

      // The machine attestation on its own, so a forwarding provider can adopt
      // the enclave's identity (quote and chain included) without the card.
      if (request.method === "GET" && url.pathname === "/v1/attestation") {
        const nonce = url.searchParams.get("nonce");
        const base = cardFor().independence;
        // A challenged attestation: bind the verifier's fresh nonce into a
        // freshly-signed quote, so a replayed (stale) quote is refused.
        let attestation: unknown = base ?? null;
        if (
          nonce !== null &&
          /^[0-9a-f]{16,128}$/.test(nonce) &&
          base !== undefined &&
          options.teeSigner !== undefined
        ) {
          const body: Omit<ProviderIndependence, "quote"> = {
            kind: base.kind,
            scheme: base.scheme,
            machine: base.machine,
            measurement: base.measurement,
            ...(base.isolation === undefined ? {} : { isolation: base.isolation }),
            ...(base.code === undefined ? {} : { code: base.code }),
            ...(base.image === undefined ? {} : { image: base.image }),
            ...(base.enclaveKey === undefined ? {} : { enclaveKey: base.enclaveKey }),
            issuedAt: base.issuedAt,
            challenge: nonce,
          };
          attestation = {
            ...body,
            quote: {
              signature: options.teeSigner.sign(providerQuotePayload(body)),
              publicKey: options.teeSigner.publicKey,
              suite: options.teeSigner.suite,
              ...(options.teeChain === undefined ? {} : { chain: options.teeChain }),
              ...(options.teeRootChain === undefined ? {} : { rootChain: options.teeRootChain }),
            },
          };
        }
        sendJson(response, 200, {
          role: "enclave",
          bundle: options.bundle.digest,
          attestation,
          // The enclave's public key, so a caller can seal a prompt to it.
          enclavePublicKey:
            options.enclaveKey === undefined
              ? null
              : createPublicKey(options.enclaveKey).export({ type: "spki", format: "pem" }),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/bundle") {
        sendJson(response, 200, options.bundle);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [
            {
              id: options.bundle.model.id,
              object: "model",
              created: Math.floor(Date.parse(options.bundle.createdAt) / 1000),
              owned_by: "rarext-provider",
              digest: options.bundle.model.weightsDigest?.replace(/^sha256:/, "") ?? null,
            },
          ],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const modelId = options.bundle.model.id;

        // A sealed prompt: only the enclave opens it, runs it, and seals the
        // answer under the caller's key. Anything relaying this request — a
        // forwarding provider, a gateway, a log — sees ciphertext.
        if (isRecord(body.confidential)) {
          if (options.enclaveKey === undefined) {
            sendJson(response, 400, {
              error: "this provider holds no enclave key; it cannot open a confidential request",
            });
            return;
          }
          let opened: { body: unknown; key: Buffer };
          try {
            opened = openRequest(options.enclaveKey, body.confidential as unknown as SealedRequest);
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : "cannot open the confidential request",
            });
            return;
          }
          const inner = isRecord(opened.body) ? opened.body : {};
          const result = await complete(inner);
          const created = Math.floor(Date.now() / 1000);
          const promptWords = lastUserText(inner).split(/\s+/).filter(Boolean).length;
          const sealedPayload = {
            model: modelId,
            confidential: sealResponse(opened.key, {
              id: `chatcmpl-${sha256Hex(`${created}:${result.text}`).slice(0, 24)}`,
              object: "chat.completion",
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: result.text },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: promptWords,
                completion_tokens: result.steps,
                total_tokens: promptWords + result.steps,
              },
              ...decodeTrace(result.trace),
            }),
          };
          response.setHeader("x-rarext-receipt", receiptHeader(body, sealedPayload));
          sendJson(response, 200, sealedPayload);
          return;
        }

        const result = await complete(body);
        const created = Math.floor(Date.now() / 1000);

        if (body.stream === true) {
          sendSse(response, [
            {
              id: `chatcmpl-${sha256Hex(`${created}:${result.text}`).slice(0, 24)}`,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: result.text },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-final",
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]);
          return;
        }

        response.setHeader("x-rarext-bundle", options.bundle.digest);
        if (result.seed !== null) response.setHeader("x-rarext-seed", String(result.seed));
        const completionBody = {
          id: `chatcmpl-${sha256Hex(`${created}:${result.text}`).slice(0, 24)}`,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.text },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: lastUserText(body).split(/\s+/).filter(Boolean).length,
            completion_tokens: result.steps,
            total_tokens:
              lastUserText(body).split(/\s+/).filter(Boolean).length + result.steps,
          },
          ...decodeTrace(result.trace),
        };
        response.setHeader("x-rarext-receipt", receiptHeader(body, completionBody));
        sendJson(response, 200, completionBody);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/completions") {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const result = await complete(body, "completions");
        const created = Math.floor(Date.now() / 1000);
        if (body.stream === true) {
          sendSse(response, [
            {
              id: "cmpl-final",
              object: "text_completion",
              created,
              model: options.bundle.model.id,
              choices: [{ index: 0, text: result.text, finish_reason: "stop" }],
            },
          ]);
          return;
        }
        const textCompletion = {
          id: "cmpl-final",
          object: "text_completion",
          created,
          model: options.bundle.model.id,
          choices: [{ index: 0, text: result.text, finish_reason: "stop" }],
          usage: {
            prompt_tokens: lastUserText(body).split(/\s+/).filter(Boolean).length,
            completion_tokens: result.steps,
            total_tokens: result.steps,
          },
          ...decodeTrace(result.trace),
        };
        response.setHeader("x-rarext-receipt", receiptHeader(body, textCompletion));
        sendJson(response, 200, textCompletion);
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const boundPort = address !== null && typeof address === "object" ? address.port : port;
  boundUrl = (options.publicUrl ?? `http://${host}:${boundPort}`).replace(/\/+$/, "");
  cardFor();

  return {
    server,
    port: boundPort,
    url: boundUrl,
    card: card ?? cardFor(),
    bundle: options.bundle,
    modelBytes: bytes,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Load a bundle from a file or the registry manifest hash. */
export async function loadProviderBundle(input: {
  bundlePath?: string;
  registry?: string;
  manifestHash?: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelBundle> {
  if (input.bundlePath !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(input.bundlePath, "utf8"));
    } catch (error) {
      throw new Error(
        `cannot read bundle ${input.bundlePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const errors = verifyModelBundle(value);
    if (errors.length > 0) throw new Error(`invalid bundle: ${errors.join("; ")}`);
    return value as ModelBundle;
  }

  if (input.registry === undefined || input.manifestHash === undefined) {
    throw new Error("pass --bundle <path>, or --registry with --manifest-hash");
  }
  return fetchBundleManifest({
    registry: input.registry,
    manifestHash: input.manifestHash,
    fetchImpl: input.fetchImpl,
  });
}


