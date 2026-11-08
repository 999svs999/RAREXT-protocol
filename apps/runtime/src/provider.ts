import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sha256Hex } from "./digest.ts";

import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";

import {
  MAX_GENERATIVE_OUTPUT_LENGTH,
  generate,
  isXorshiftModel,
} from "../../../packages/core/src/ai.ts";
import type { XorshiftModel } from "../../../packages/core/src/ai.ts";
import { sha256Hex } from "./digest.ts";
import {
  fetchBundleChunks,
  fetchBundleManifest,
  buildProviderCard,
  bundleManifestHash,
  PROVIDER_MACHINE_KIND,
  verifyModelBundle,
} from "./model-bundle.ts";
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
   * The key that opens a sealed bundle. The provider decrypts the shards in
   * memory and never writes plaintext weights to disk; without the key a sealed
   * bundle is refused before any model is loaded.
   */
  sealKey?: Uint8Array;
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
): { text: string; seed: number; steps: number } {
  const seed =
    typeof input.seed === "number" && Number.isSafeInteger(input.seed)
      ? input.seed >>> 0
      : parseInt(sha256Hex(input.prompt).slice(0, 8), 16) >>> 0;

  const bound = Math.floor(MAX_GENERATIVE_OUTPUT_LENGTH / Math.max(1, longestToken(model)));
  const steps = Math.max(1, Math.min(input.steps, bound));
  return { text: generate(model, seed, steps), seed, steps };
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

async function materializeEngineModel(input: {
  bundle: ModelBundle;
  bytes: Buffer;
  stateDir: string;
  engineEndpoint: string;
  log: (message: string) => void;
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
  const directory = join(input.stateDir, "models");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${sanitizeFilePart(input.bundle.id)}.${sanitizeFilePart(format)}`);

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

  const engineModel = input.bundle.execution.engineModel ?? input.bundle.id;
  const endpoint = normalizeEndpoint(input.engineEndpoint);
  input.log(`asking ${engine} to create ${engineModel} from the verified file`);

  // Ollama's `/api/create` accepts model names and uploaded files, not a path
  // on the provider's disk. The provider already has the verified file, so it
  // uses the engine's own CLI, which does. No shell is involved: argv is an
  // array, and the Modelfile is written by this process.
  const modelfile = join(directory, `${sanitizeFilePart(engineModel)}.Modelfile`);
  writeFileSync(modelfile, `FROM ${file}\n`);

  const host = new URL(endpoint);
  const ollamaHost = `${host.hostname}:${host.port || "11434"}`;
  try {
    await promisify(execFile)(
      "ollama",
      ["create", engineModel, "-f", modelfile],
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
    throw new Error(`engine refused to create ${engineModel}: ${detail.slice(-1000)}`);
  }

  return engineModel;
}

/**
 * Start a provider: fetch every shard from RAREXT, verify the committed digest,
 * load the model, and serve an OpenAI-compatible endpoint. The original model
 * file is never read; only RAREXT storage supplies the bytes.
 */
export async function startProvider(options: ProviderOptions): Promise<Provider> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;

  const bundleErrors = verifyModelBundle(options.bundle);
  if (bundleErrors.length > 0) {
    throw new Error(`refusing to serve an invalid model bundle: ${bundleErrors.join("; ")}`);
  }

  const manifestHash = bundleManifestHash(options.bundle);
  // The manifest must be in RAREXT too, so a reader can fetch the same list of
  // shards this provider used rather than trusting the card's copy.
  const manifest = await fetchBundleManifest({
    registry: options.registry,
    manifestHash,
    fetchImpl,
  });
  if (manifest.digest !== options.bundle.digest) {
    throw new Error(
      `registry returned bundle ${manifest.digest}, expected ${options.bundle.digest}`,
    );
  }

  // A sealed bundle may only be served natively: the engine path materializes
  // the weights to a file for the engine's own loader, which would put plaintext
  // on disk. That would defeat the point of sealing, so it is refused rather
  // than silently leaked.
  if (options.bundle.sealing !== undefined && options.bundle.execution.kind === "engine") {
    throw new Error(
      "an engine bundle cannot serve sealed weights: the engine loads from a file. " +
        "Sealed inference is native-only today.",
    );
  }

  log(
    `fetching ${options.bundle.shards.length} shard(s) / ${options.bundle.totalBytes} bytes ` +
      `for ${options.bundle.model.id} from ${options.registry}` +
      (options.bundle.sealing === undefined ? "" : ` (sealed, ${options.bundle.sealing.scheme})`),
  );
  const { bytes } = await fetchBundleChunks({
    registry: options.registry,
    bundle: options.bundle,
    fetchImpl,
    ...(options.sealKey === undefined ? {} : { sealKey: options.sealKey }),
    onShard: (index, size) => log(`  shard ${index + 1}/${options.bundle.shards.length} ${size} bytes`),
  });
  log(
    `verified ${bytes.length} bytes against ${options.bundle.model.weightsDigest}` +
      (options.bundle.sealing === undefined ? "" : " (opened in memory; no plaintext on disk)"),
  );

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
      apis: ["openai"] as ApiShape[],
      sign: (payload) => signer.sign(payload),
    });
    return card;
  }

  async function complete(
    body: Record<string, unknown>,
    shape: "chat" | "completions" = "chat",
  ): Promise<{ text: string; seed: number | null; steps: number }> {
    const prompt = lastUserText(body);

    if (native !== null) {
      const seed =
        typeof body.seed === "number" && Number.isSafeInteger(body.seed)
          ? (body.seed as number)
          : null;
      const result = runNativeModel(native, {
        prompt,
        steps: requestedSteps(
          body,
          options.bundle.execution.kind === "native" ? options.bundle.execution.defaultSteps : 32,
        ),
        seed,
      });
      return { text: result.text, seed: result.seed, steps: result.steps };
    }

    if (engineModel === null || options.engineEndpoint === undefined) {
      throw new Error("engine model was not materialized");
    }
    const upstream = await fetchImpl(
      `${normalizeEndpoint(options.engineEndpoint)}/v1/${shape === "chat" ? "chat/completions" : "completions"}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, model: engineModel, stream: false }),
        signal: AbortSignal.timeout(600_000),
      },
    );
    if (!upstream.ok) {
      throw new Error(`engine returned HTTP ${upstream.status} ${await upstream.text()}`);
    }
    const json = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text =
      shape === "chat"
        ? String(json.choices?.[0]?.message?.content ?? "")
        : String(json.choices?.[0]?.text ?? "");
    return { text, seed: null, steps: json.usage?.completion_tokens ?? 0 };
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
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/provider-card") {
        sendJson(response, 200, cardFor());
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
        const result = await complete(body);
        const modelId = options.bundle.model.id;
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
        sendJson(response, 200, {
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
        });
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
        sendJson(response, 200, {
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
        });
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


