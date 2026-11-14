import { execFile } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir, totalmem } from "node:os";
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
import {
  ENGINE_ARTIFACT_RUNTIME,
  ENGINE_ARTIFACT_RUNTIME_GGUF,
  ENGINE_ARTIFACT_RUNTIME_WASM,
  ENGINE_ARTIFACT_RUNTIME_WORKER,
  engineBundleMatchesRef,
  fetchEngineArtifact,
  fetchEngineBundleManifest,
  loadEngine,
} from "./engine-bundle.ts";
import type { EngineBundle, GgufModel, HfModel, NativeEngine } from "./engine-bundle.ts";
import { responseFormatDfa, type ByteDfa } from "./grammar.ts";
import { chatPromptFromTemplate, type ChatTemplateInfo } from "./chat-template.ts";
import { unsupportedContentMessage, unsupportedContentPart } from "./engines.ts";
import {
  fetchBundleChunks,
  fetchBundleChunksToFile,
  fileReader,
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
import { hostCapabilityCommitment, normalizeEndpoint } from "./manifest.ts";
import type { ApiShape } from "./types.ts";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * The resident bound a streaming provider commits to: the metadata chunk cache
 * (2 MiB) plus the largest tensor row, the tokenizer strings, and slack. It is
 * what the host-capability commitment checks against memory, instead of the
 * whole container.
 */
const STREAM_RESIDENT_BYTES = 8 * 1024 * 1024;

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
  /** Host memory this provider may assume, in bytes (default: the real host). */
  hostMemoryBytes?: number;
  /** Override the memory reserve the capability check uses. */
  reserveBytes?: number;
  /** Start even if the committed weights exceed host memory (streaming engine). */
  allowOversizeModel?: boolean;
  /**
   * Verify the container to disk and read the rows on demand, so a model larger
   * than host memory can be served within the resident bound below.
   */
  streamWeights?: boolean;
  /** The resident bound a streaming provider commits to (default 8 MiB). */
  streamResidentBytes?: number;
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
  /** True when the weights were verified to disk and are read on demand. */
  streaming: boolean;
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

/** The decoding controls an OpenAI-compatible request may carry. */
export interface DecodingParams {
  temperature: number;
  topK: number;
  topP: number;
  /** Drop tokens below this fraction of the best token's probability (0 = off). */
  minP: number;
  /** Locally-typical mass to keep (1 = off). */
  typicalP: number;
  /** Additive per-token bias as [tokenId, bias] pairs, from OpenAI's logit_bias. */
  logitBias: Array<[number, number]>;
  repetitionPenalty: number;
  presencePenalty: number;
  frequencyPenalty: number;
  stop: string[];
  /** Report the model's own per-token log-probabilities. */
  logprobs: boolean;
  /** How many alternatives to include per token (0-20). */
  topLogprobs: number;
}

/**
 * OpenAI's `logit_bias` is an object keyed by token id string. A token id must
 * be a non-negative safe integer, the bias a finite number clamped to
 * [-100, 100], and at most 1024 entries are honoured — a hostile body cannot
 * grow the work per token without bound or reach a token that does not exist.
 */
function parseLogitBias(raw: unknown): Array<[number, number]> {
  if (!isRecord(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (out.length >= 1024) break;
    if (!/^\d+$/.test(key)) continue;
    const id = Number(key);
    if (!Number.isSafeInteger(id)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out.push([id, Math.min(100, Math.max(-100, value))]);
  }
  return out;
}

/**
 * Read the decoding controls from a request body, with the OpenAI defaults.
 *
 * Every field is optional and clamped to a range the engine can honour, so a
 * hostile or sloppy client cannot make a run unbounded (top_k is capped) or
 * non-finite (NaN/Infinity fall back). `stop` is a string or up to eight
 * strings; more than eight are ignored rather than rejected.
 */
export function decodingParams(body: Record<string, unknown>): DecodingParams {
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const rawTopK = num(body.top_k, 0);
  const rawStop = body.stop;
  const stop: string[] = [];
  if (typeof rawStop === "string" && rawStop.length > 0) {
    stop.push(rawStop);
  } else if (Array.isArray(rawStop)) {
    for (const entry of rawStop) {
      if (typeof entry === "string" && entry.length > 0 && stop.length < 8) stop.push(entry);
    }
  }
  return {
    temperature: Math.max(0, num(body.temperature, 0)),
    topK: rawTopK > 0 ? Math.min(4096, Math.floor(rawTopK)) : 0,
    topP: Math.min(1, Math.max(0, num(body.top_p, 1))),
    minP: Math.min(1, Math.max(0, num(body.min_p, 0))),
    typicalP: Math.min(1, Math.max(0, num(body.typical_p, 1))),
    logitBias: parseLogitBias(body.logit_bias),
    repetitionPenalty: Math.max(0.01, num(body.repetition_penalty, 1)),
    presencePenalty: num(body.presence_penalty, 0),
    frequencyPenalty: num(body.frequency_penalty, 0),
    stop,
    // Chat completions take a boolean plus `top_logprobs`; the legacy
    // completions endpoint takes an integer. Accept both.
    logprobs: body.logprobs === true || (typeof body.logprobs === "number" && body.logprobs > 0),
    topLogprobs: Math.max(
      0,
      Math.min(
        20,
        Math.floor(
          typeof body.top_logprobs === "number"
            ? body.top_logprobs
            : typeof body.logprobs === "number"
              ? body.logprobs
              : 0,
        ),
      ),
    ),
  };
}

/** Truncate at the earliest stop sequence. The stop text is not returned. */
export function applyStop(text: string, stop: string[]): { text: string; stopped: boolean } {
  let at = -1;
  for (const sequence of stop) {
    const found = text.indexOf(sequence);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  return at < 0 ? { text, stopped: false } : { text: text.slice(0, at), stopped: true };
}

/** One generated token's confidence, with the alternatives the engine named. */
export interface RunLogprob {
  token: number;
  text: string;
  logprob: number;
  top: Array<{ token: number; text: string; logprob: number }>;
}

/**
 * Map an engine's numeric logprobs to text with the engine's own tokenizer.
 *
 * The ids are authoritative; `text` is a convenience for the OpenAI-shaped
 * response. A token whose bytes only make sense inside a longer sequence
 * decodes to a replacement character on its own — the logprob is still exact.
 * A malformed entry drops the whole block rather than reporting partial
 * confidence, so a response is either fully evidenced or silent.
 */
function decodeTokenTexts(engine: NativeEngine | null, model: unknown, ids: number[]): string[] {
  if (engine === null) return ids.map(() => "");
  if (typeof engine.decodeTokens === "function") {
    try {
      const out = engine.decodeTokens(model, ids);
      if (Array.isArray(out) && out.length === ids.length) {
        return out.map((text) => (typeof text === "string" ? text : ""));
      }
    } catch {
      // Fall through to the one-at-a-time path below.
    }
  }
  if (typeof engine.decode !== "function") return ids.map(() => "");
  return ids.map((id) => {
    try {
      return engine.decode!(model, [id]);
    } catch {
      return "";
    }
  });
}

function engineLogprobs(
  result: unknown,
  engine: NativeEngine | null,
  model: unknown,
): RunLogprob[] | undefined {
  const entries = isRecord(result) ? result.logprobs : undefined;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  // Validate first, collecting every id, so the model is tokenized ONCE for the
  // whole block instead of once per token and once per alternative.
  const ids: number[] = [];
  const numeric: Array<{
    token: number;
    logprob: number;
    top: Array<{ token: number; logprob: number }>;
  }> = [];
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.token !== "number" ||
      !Number.isSafeInteger(entry.token) ||
      typeof entry.logprob !== "number" ||
      !Number.isFinite(entry.logprob)
    ) {
      return undefined;
    }
    const top: Array<{ token: number; logprob: number }> = [];
    if (Array.isArray(entry.top)) {
      for (const alt of entry.top) {
        if (
          !isRecord(alt) ||
          typeof alt.token !== "number" ||
          !Number.isSafeInteger(alt.token) ||
          typeof alt.logprob !== "number" ||
          !Number.isFinite(alt.logprob)
        ) {
          continue;
        }
        top.push({ token: alt.token, logprob: alt.logprob });
      }
    }
    numeric.push({ token: entry.token, logprob: entry.logprob, top });
    ids.push(entry.token);
    for (const alt of top) ids.push(alt.token);
  }
  const texts = decodeTokenTexts(engine, model, ids);
  let at = 0;
  return numeric.map((entry) => {
    const text = texts[at++] ?? "";
    const top = entry.top.map((alt) => ({ ...alt, text: texts[at++] ?? "" }));
    return { token: entry.token, text, logprob: entry.logprob, top };
  });
}

/** The decoded prefix after each id, from the engine if it can do it in one parse. */
function tokenPrefixes(
  engine: NativeEngine | null,
  model: unknown,
  tokens: number[],
): string[] | null {
  const decodePrefixes = engine?.decodePrefixes;
  if (engine === null || typeof decodePrefixes !== "function") return null;
  try {
    const out = decodePrefixes.call(engine, model, tokens);
    return Array.isArray(out) &&
      out.length === tokens.length &&
      out.every((text) => typeof text === "string")
      ? out
      : null;
  } catch {
    return null;
  }
}

/**
 * Split a completion into one delta per generated token.
 *
 * Prefixes, not per-token decodes, are the source of truth: a token can carry
 * part of a UTF-8 character, so its delta is `prefix[i] - prefix[i-1]`. If the
 * engine cannot decode prefixes, or the prefixes disagree with the final text
 * (a stop sequence cut mid-token), the answer streams as one delta rather than
 * sending text the caller never received. Tokens cut away by a stop are dropped,
 * which keeps the chunk count aligned with what the non-stream response would
 * have said.
 */
function tokenDeltas(
  tokens: number[],
  finalText: string,
  prefixes: string[] | null,
): string[] {
  const fallback = finalText === "" ? [] : [finalText];
  if (tokens.length === 0 || prefixes === null || prefixes.length !== tokens.length) {
    return fallback;
  }
  const deltas: string[] = [];
  let previous = "";
  for (const prefix of prefixes) {
    if (!prefix.startsWith(previous)) return fallback;
    if (prefix.length === finalText.length) {
      if (prefix !== finalText) return fallback;
      deltas.push(prefix.slice(previous.length));
      return deltas;
    }
    if (prefix.length > finalText.length) return fallback;
    deltas.push(prefix.slice(previous.length));
    previous = prefix;
  }
  if (previous === finalText) return deltas;
  if (!finalText.startsWith(previous)) return fallback;
  deltas.push(finalText.slice(previous.length));
  return deltas;
}

/** One chat-shaped logprob entry. */
function chatLogprobEntry(entry: RunLogprob): Record<string, unknown> {
  return {
    token: entry.text,
    logprob: entry.logprob,
    bytes: null,
    top_logprobs: entry.top.map((alt) => ({
      token: alt.text,
      logprob: alt.logprob,
      bytes: null,
    })),
  };
}

/** `choices[0].logprobs` for the chat shape, or nothing when none were asked for. */
function chatLogprobs(result: { logprobs?: RunLogprob[] }): Record<string, unknown> {
  if (result.logprobs === undefined) return {};
  return { logprobs: { content: result.logprobs.map(chatLogprobEntry) } };
}

/**
 * The logprob block for ONE streamed chunk. It is emitted only when the delta
 * count matches the logprob count, so a chunk never claims confidence for a
 * different token than the one it carries.
 */
function chatChunkLogprobs(
  result: { logprobs?: RunLogprob[] },
  index: number,
  deltaCount: number,
): Record<string, unknown> {
  const entries = result.logprobs;
  if (entries === undefined || entries.length !== deltaCount) return {};
  const entry = entries[index];
  return entry === undefined ? {} : { logprobs: { content: [chatLogprobEntry(entry)] } };
}

/** The legacy-completions logprob block for one streamed chunk. */
function completionChunkLogprobs(
  result: { logprobs?: RunLogprob[] },
  index: number,
  deltaCount: number,
): Record<string, unknown> {
  const entries = result.logprobs;
  if (entries === undefined || entries.length !== deltaCount) return {};
  const entry = entries[index];
  if (entry === undefined) return {};
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += entries[i]?.text.length ?? 0;
  const alternatives: Record<string, number> = {};
  for (const alt of entry.top) alternatives[alt.text] = alt.logprob;
  return {
    logprobs: {
      tokens: [entry.text],
      text_offset: [offset],
      token_logprobs: [entry.logprob],
      top_logprobs: [alternatives],
    },
  };
}

/** `choices[0].logprobs` for the legacy completions shape. */
function completionLogprobs(result: { logprobs?: RunLogprob[] }): Record<string, unknown> {
  if (result.logprobs === undefined) return {};
  const tokens: string[] = [];
  const offsets: number[] = [];
  const tokenLogprobs: number[] = [];
  const topLogprobs: Array<Record<string, number>> = [];
  let offset = 0;
  for (const entry of result.logprobs) {
    tokens.push(entry.text);
    offsets.push(offset);
    offset += entry.text.length;
    tokenLogprobs.push(entry.logprob);
    const alternatives: Record<string, number> = {};
    for (const alt of entry.top) alternatives[alt.text] = alt.logprob;
    topLogprobs.push(alternatives);
  }
  return {
    logprobs: {
      tokens,
      text_offset: offsets,
      token_logprobs: tokenLogprobs,
      top_logprobs: topLogprobs,
    },
  };
}

/** How many completions the request asks for (1-8; `n` is capped). */
function requestedChoices(body: Record<string, unknown>): number {
  const raw = body.n;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? Math.min(8, raw) : 1;
}

/** Whether a streaming request asked for a final usage chunk. */
function wantsStreamUsage(body: Record<string, unknown>): boolean {
  return body.stream === true && isRecord(body.stream_options) && body.stream_options.include_usage === true;
}

function promptTokenCount(body: Record<string, unknown>): number {
  return lastUserText(body).split(/\s+/).filter(Boolean).length;
}

/** Aggregate usage across choices, in the OpenAI chat shape. */
function fixedUsage(
  promptTokens: number,
  results: Array<{ steps: number }>,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const completionTokens = results.reduce((total, choice) => total + choice.steps, 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * The body for choice `index`. With `n > 1` every choice gets its own seed, so
 * the choices differ when sampling and remain individually reproducible; the
 * base seed is the one the client sent, or the prompt-derived default the native
 * model uses.
 */
function choiceBody(body: Record<string, unknown>, index: number, n: number): Record<string, unknown> {
  if (n === 1) return body;
  const base =
    typeof body.seed === "number" && Number.isSafeInteger(body.seed)
      ? body.seed >>> 0
      : parseInt(sha256Hex(lastUserText(body)).slice(0, 8), 16) >>> 0;
  return { ...body, seed: (base + index) >>> 0 };
}

/** A declared function tool, in the OpenAI `tools` shape. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** How the request asks the model to use tools. */
export interface ToolChoice {
  mode: "none" | "auto" | "required";
  /** When set, only this function may be called. */
  name?: string;
}

/** Read `tools`, accepting only well-formed function declarations. */
export function parseTools(raw: unknown): ToolSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolSpec[] = [];
  for (const entry of raw) {
    if (out.length >= 128) break;
    if (!isRecord(entry) || entry.type !== "function" || !isRecord(entry.function)) continue;
    const fn = entry.function;
    if (typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: fn.parameters,
    });
  }
  return out;
}

/** Read `tool_choice`: "none", "auto", "required", or a named function. */
export function parseToolChoice(raw: unknown): ToolChoice {
  if (raw === "none") return { mode: "none" };
  if (raw === "required") return { mode: "required" };
  if (isRecord(raw) && raw.type === "function" && isRecord(raw.function) && typeof raw.function.name === "string") {
    return { mode: "required", name: raw.function.name };
  }
  return { mode: "auto" };
}

/** Render the message transcript, including assistant tool calls and results. */
export function renderMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : "user";
    let content = typeof message.content === "string" ? message.content : "";
    if (Array.isArray(message.content)) {
      content = message.content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .filter((text) => text !== "")
        .join("\n");
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      content += message.tool_calls
        .map((call) =>
          isRecord(call) && isRecord(call.function) && typeof call.function.name === "string"
            ? `{"name":"${call.function.name}","arguments":${typeof call.function.arguments === "string" ? call.function.arguments : "{}"}}`
            : "",
        )
        .join("");
    }
    lines.push(role === "tool" ? `tool result: ${content}` : `${role}: ${content}`);
  }
  return lines.join("\n");
}

/**
 * RAREXT extension: pin the token ids the run emits, for structured output such
 * as a tool call. The engine still runs a forward pass per token, so the trace
 * and logprobs stay real; this constrains the output, it does not skip the model.
 */
export function pinnedTokens(body: Record<string, unknown>): number[] | undefined {
  const raw = body.pinned_tokens;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: number[] = [];
  for (const id of raw) {
    if (out.length >= 4096) break;
    if (!Number.isSafeInteger(id) || (id as number) < 0) {
      throw new Error("pinned_tokens must be non-negative integers");
    }
    out.push(id as number);
  }
  return out.length === 0 ? undefined : out;
}

/**
 * The prompt when tools are declared: the transcript, the tool schemas, and an
 * instruction to answer with one JSON tool call. This is what a chat template
 * does; RAREXT renders it explicitly so the exact prompt is committed and a
 * replay re-issues it.
 */
export function toolsPrompt(body: Record<string, unknown>, tools: ToolSpec[], choice: ToolChoice): string | null {
  if (tools.length === 0 || choice.mode === "none") return null;
  const transcript = renderMessages(body.messages);
  const schemas = tools
    .map((tool) => `${tool.name}: ${tool.description ?? ""} parameters ${JSON.stringify(tool.parameters ?? { type: "object", properties: {} })}`)
    .join("\n");
  const must = choice.name === undefined ? "" : ` You must call the function "${choice.name}".`;
  return (
    `${transcript}\n\ntools:\n${schemas}\n\n` +
    `To call a tool, reply with ONLY a JSON object of the form ` +
    `{"name": "<tool name>", "arguments": { ... }} and nothing else. ` +
    `If no tool is needed, reply with the answer as text.${must}`
  ).trim();
}

/** Every balanced-brace JSON object that parses, in order of appearance. */
export function jsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let at = start; at < text.length; at += 1) {
      const ch = text[at]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            out.push(JSON.parse(text.slice(start, at + 1)));
          } catch {
            // Not valid JSON; keep scanning.
          }
          // Skip past this object, so a nested brace is not re-reported as a
          // separate candidate.
          start = at;
          break;
        }
      }
    }
  }
  return out;
}

/** One parsed tool call, ready for the OpenAI response shape. */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function callsFromValue(value: unknown, names: Set<string>): ParsedToolCall[] {
  const list: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tool_calls)
      ? value.tool_calls
      : [value];
  const out: ParsedToolCall[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : entry;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    if (name === undefined || !names.has(name)) continue;
    const args = fn.arguments;
    const argsString = typeof args === "string" ? args : JSON.stringify(args ?? {});
    out.push({
      id: `call_${sha256Hex(`${name}:${argsString}:${out.length}`).slice(0, 24)}`,
      name,
      arguments: argsString,
    });
  }
  return out;
}

/**
 * Extract tool calls from a completion. Only functions the request declared (and
 * the named one, when `tool_choice` pinned it) are accepted, so a model cannot
 * call a tool the caller never offered. A text answer yields no calls.
 */
export function extractToolCalls(text: string, tools: ToolSpec[], choice: ToolChoice): ParsedToolCall[] {
  if (tools.length === 0 || choice.mode === "none") return [];
  const names = new Set(choice.name === undefined ? tools.map((tool) => tool.name) : [choice.name]);
  for (const value of jsonObjects(text)) {
    const calls = callsFromValue(value, names);
    if (calls.length > 0) return calls.slice(0, 8);
  }
  return [];
}

/**
 * Compile `response_format` to a byte DFA, cached by its canonical form: the
 * same request shape compiles once. `json_object` accepts any JSON value; a
 * `json_schema` must be `strict` and is compiled property-by-property. `null`
 * means the request asked for free text.
 */
const dfaCache = new Map<string, ByteDfa>();
export function responseFormatDfaFor(body: Record<string, unknown>): ByteDfa | null {
  const format = body.response_format;
  if (format === undefined || format === null) return null;
  if (isRecord(format) && (format.type === "text" || format.type === "json_object" || format.type === "json_schema")) {
    const key = JSON.stringify(format);
    const cached = dfaCache.get(key);
    if (cached !== undefined) return cached;
    const dfa = responseFormatDfa(format);
    if (dfa !== null) {
      if (dfaCache.size >= 64) dfaCache.clear();
      dfaCache.set(key, dfa);
    }
    return dfa;
  }
  return null;
}

/**
 * The container's chat template, if the engine exposes one and the model is a
 * container. A non-GGUF model (the xorshift native model) has none, and a
 * malformed template never breaks a request — it falls back to the explicit
 * prompt.
 */
function containerChatTemplate(engine: NativeEngine | null, model: unknown): ChatTemplateInfo | null {
  if (engine === null || typeof engine.chatTemplate !== "function") return null;
  try {
    return engine.chatTemplate(model);
  } catch {
    return null;
  }
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
  | { kind: "rarext.judgment.v1"; tokens: string[]; logprobs: number[] }
  | { kind: "rarext.output-trace.v1"; outputDigest: string };

/**
 * EVERY engine records a replayable trace. An engine that exposes token ids gets
 * a decode trace; an engine that hides them (a wasm or custom engine returning
 * only text) still gets an output trace: a digest of the exact completion text,
 * so a replay that produces a different string is refused bit-for-bit rather than
 * passing on a text coincidence.
 */
export function traceFor(result: { text: string; tokens: unknown }): TraceData {
  if (Array.isArray(result.tokens) && result.tokens.length > 0) {
    return { kind: "rarext.decode-trace.v1", tokens: result.tokens as number[] };
  }
  return { kind: "rarext.output-trace.v1", outputDigest: canonicalDigest({ text: result.text }) };
}

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
    streaming: false,
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
  const streamWeights = options.streamWeights === true || process.env.RAREXT_STREAM_WEIGHTS === "1";
  const streamingEligible =
    options.bundle.execution.kind === "engine" && options.bundle.execution.engine === "rarext";
  if (streamWeights && !streamingEligible) {
    throw new Error(
      'streaming weights needs the RAREXT GGUF engine (execution.engine "rarext"); ' +
        "another engine would hold the container itself",
    );
  }
  if (streamWeights && options.bundle.sealing !== undefined) {
    throw new Error("a sealed bundle cannot be streamed: it must be opened in memory");
  }
  const onShard = (index: number, size: number): void =>
    log(`  shard ${index + 1}/${options.bundle.shards.length} ${size} bytes`);
  let bytes: Buffer;
  let streamedReader: ReturnType<typeof fileReader> | null = null;
  let streamedPath: string | null = null;
  if (streamWeights) {
    mkdirSync(options.stateDir, { recursive: true });
    streamedPath = join(options.stateDir, `weights-${options.bundle.digest.slice(0, 16)}.gguf`);
    const written = await fetchBundleChunksToFile({
      registry: options.registry,
      registries,
      bundle: options.bundle,
      fetchImpl,
      path: streamedPath,
      onShard,
    });
    streamedReader = fileReader(streamedPath);
    bytes = Buffer.alloc(0);
    log(
      `verified ${written.bytes} bytes against ${options.bundle.model.weightsDigest} and wrote them to disk; ` +
        "the provider will read rows on demand",
    );
  } else {
    ({ bytes } = await fetchBundleChunks({
      registry: options.registry,
      registries,
      bundle: options.bundle,
      fetchImpl,
      ...(sealKey === undefined ? {} : { sealKey }),
      onShard,
    }));
    log(
      `verified ${bytes.length} bytes against ${options.bundle.model.weightsDigest}` +
        (options.bundle.sealing === undefined ? "" : " (opened in memory; the RAREXT store never holds plaintext)"),
    );
  }

  // The host-capability commitment: do not read a container the host cannot
  // hold. This is what keeps "6/7/8 GB classes: shipped: false" honest rather
  // than a claim the runtime would try and fail to honour.
  if (options.enclaveEndpoint === undefined) {
    const commitment = hostCapabilityCommitment(
      options.bundle.model,
      { memoryBytes: options.hostMemoryBytes ?? totalmem() },
      {
        ...(options.reserveBytes === undefined ? {} : { reserveBytes: options.reserveBytes }),
        streaming: streamedReader !== null,
        ...(streamedReader === null
          ? {}
          : { residentBytes: options.streamResidentBytes ?? STREAM_RESIDENT_BYTES }),
        allowOversize: options.allowOversizeModel === true,
        overrideEnv: process.env.RAREXT_ALLOW_OVERSIZE_MODEL,
      },
    );
    if (!commitment.allowed) throw new Error(commitment.reason);
    if (commitment.verdict !== "fits") {
      log(`host capability: ${commitment.verdict} — ${commitment.reason}`);
    }
  }

  // The engine the provider will RUN. When it is a RAREXT artifact, fetch and
  // verify it first: a shard that does not hash to the committed engine, or a
  // module that exposes no engine, stops the provider before it serves anything.
  // The RAREXT-native engine class: the provider runs its own fetched GGUF
  // engine over the committed weights. There is no external engine to load
  // into, so no engine endpoint is required and no weights are written to disk.
  const ownGguf =
    options.bundle.execution.kind === "engine" && options.bundle.execution.engine === "rarext";

  // The engine can be committed BY THE MODEL BUNDLE (`execution.artifact`), so a
  // provider needs no out-of-band `--engine-bundle` flag: it fetches the exact
  // engine the bundle names and refuses a substituted manifest or artifact.
  const committedEngine =
    options.bundle.execution.kind === "engine"
      ? (options.bundle.execution.artifact ?? null)
      : null;
  let engineBundle = options.engineBundle ?? null;
  if (engineBundle === null && committedEngine !== null) {
    engineBundle = await fetchEngineBundleManifest({
      registries,
      manifestHash: committedEngine.manifestHash,
      fetchImpl,
    });
    const mismatches = engineBundleMatchesRef(engineBundle, committedEngine);
    if (mismatches.length > 0) {
      throw new Error(
        `the fetched engine does not match the engine artifact this bundle commits: ${mismatches.join("; ")}`,
      );
    }
    log(
      `fetched the engine this bundle commits: ${engineBundle.name}@${engineBundle.engineVersion} ` +
        `(${engineBundle.artifactDigest.slice(0, 18)}…)`,
    );
  }

  // A third-party engine that needs no container: a WebAssembly module
  // instantiated in-process, or a native (JS) engine program run on a sandboxed
  // worker thread.
  const ownSandbox =
    options.bundle.execution.kind === "engine" &&
    engineBundle !== null &&
    (engineBundle.runtime === ENGINE_ARTIFACT_RUNTIME_WASM ||
      engineBundle.runtime === ENGINE_ARTIFACT_RUNTIME_WORKER);

  let loadedEngine: NativeEngine | null = null;
  if (engineBundle !== null) {
    if (options.bundle.execution.kind === "native") {
      if (engineBundle.runtime !== ENGINE_ARTIFACT_RUNTIME) {
        throw new Error("the native class needs a native engine artifact");
      }
    } else if (ownSandbox) {
      // Any wasm module implementing the ABI is accepted.
    } else if (ownGguf) {
      if (engineBundle.runtime !== ENGINE_ARTIFACT_RUNTIME_GGUF) {
        throw new Error("the RAREXT GGUF class needs a GGUF engine artifact");
      }
    } else {
      throw new Error(
        "a RAREXT engine artifact runs the native class or the RAREXT GGUF class; a third-party engine loads a model into itself",
      );
    }
    const source = await fetchEngineArtifact({ registries, bundle: engineBundle });
    loadedEngine = loadEngine(source, engineBundle.runtime);
    log(
      `loaded engine ${engineBundle.name}@${engineBundle.engineVersion} ` +
        `(${engineBundle.artifactDigest.slice(0, 18)}…) from ${engineBundle.shards.length} RAREXT shard(s)`,
    );
  }

  let native: XorshiftModel | null = null;
  let engineModel: string | null = null;
  let gguf: GgufModel | HfModel | null = null;
  let wasmModel: unknown = null;
  if (options.bundle.execution.kind === "native") {
    native = parseNativeModel(bytes);
  } else if (ownSandbox) {
    if (loadedEngine === null) {
      throw new Error("a sandboxed engine needs its committed artifact");
    }
    // The committed model bytes are handed to the sandboxed engine: GGUF, or the
    // RAREXT-native "RXHF" container built from safetensors, so an engine that
    // reads the weights gets the right container kind.
    const isContainer =
      bytes.length >= 4 &&
      bytes[0] === 0x52 && bytes[1] === 0x58 && bytes[2] === 0x48 && bytes[3] === 0x46;
    wasmModel = isContainer ? { kind: "hf", bytes } : { kind: "gguf", bytes };
  } else if (ownGguf) {
    if (loadedEngine === null) {
      throw new Error("the RAREXT GGUF class needs --engine-bundle so the engine is a committed artifact");
    }
    if (streamedReader !== null) {
      // Bounded memory: the engine reads the header and every tensor row through
      // the reader instead of indexing a resident buffer.
      gguf = {
        kind: "gguf",
        readAt: streamedReader.readAt,
        sizeBytes: streamedReader.sizeBytes,
        chunkBytes: 65536,
        cacheChunks: 32,
      };
    } else {
      // The verified bytes stay in memory. The fetched engine parses them: GGUF,
      // or the RAREXT-native "RXHF" container built from safetensors.
      const isContainer =
        bytes.length >= 4 &&
        bytes[0] === 0x52 && bytes[1] === 0x58 && bytes[2] === 0x48 && bytes[3] === 0x46;
      gguf = isContainer ? { kind: "hf", bytes } : { kind: "gguf", bytes };
    }
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
    engineBundle !== null
      ? {
          name: engineBundle.name,
          version: engineBundle.engineVersion,
          digest: engineBundle.artifactDigest,
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
  ): Promise<{
    text: string;
    seed: number | null;
    steps: number;
    trace: TraceData | null;
    finishReason: "stop" | "length";
    /** Per-token confidence, when the caller asked and the engine reports it. */
    logprobs?: RunLogprob[];
    /** One text delta per generated token, when the request streams. */
    deltas?: string[];
  }> {
    const tools = parseTools(body.tools);
    const toolChoice = parseToolChoice(body.tool_choice);
    const toolPrompt = toolsPrompt(body, tools, toolChoice);
    // The prompt is the model's OWN chat template when the container declares
    // one, rendered through the interpreter; otherwise the explicit transcript
    // (with tools) or the last user turn. The exact prompt is what request.body
    // commits, so a replay re-issues it either way.
    const templateInfo =
      shape === "chat"
        ? containerChatTemplate(loadedEngine, native !== null ? native : gguf ?? wasmModel)
        : null;
    let prompt: string;
    if (templateInfo !== null) {
      try {
        prompt = chatPromptFromTemplate(templateInfo, body.messages, tools, { addGenerationPrompt: true });
      } catch {
        prompt = toolPrompt ?? lastUserText(body);
      }
    } else {
      prompt = toolPrompt ?? lastUserText(body);
    }
    const decoding = decodingParams(body);
    const pinned = pinnedTokens(body);
    if (pinned !== undefined && loadedEngine === null) {
      throw new Error("pinned_tokens needs the RAREXT engine");
    }
    // response_format compiles to a constrained decode; the model can only emit
    // a document the schema accepts.
    const grammarDfa = pinned === undefined ? responseFormatDfaFor(body) : null;
    if (grammarDfa !== null && loadedEngine === null) {
      throw new Error("response_format needs the RAREXT engine");
    }

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
      const runSteps = pinned === undefined ? steps : Math.max(steps, pinned.length + 1);
      const result = loadedEngine !== null
        ? await loadedEngine.run(native, {
            prompt,
            steps: runSteps,
            seed,
            temperature: decoding.temperature,
            topK: decoding.topK,
            topP: decoding.topP,
            minP: decoding.minP,
            typicalP: decoding.typicalP,
            logitBias: decoding.logitBias,
            repetitionPenalty: decoding.repetitionPenalty,
            presencePenalty: decoding.presencePenalty,
            frequencyPenalty: decoding.frequencyPenalty,
            stop: decoding.stop,
            logprobs: decoding.logprobs,
            topLogprobs: decoding.topLogprobs,
            ...(pinned === undefined ? {} : { pinnedTokens: pinned }),
            ...(grammarDfa === null ? {} : { grammarDfa }),
          })
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
      const stopped = applyStop(result.text, decoding.stop);
      const logprobs = engineLogprobs(result, loadedEngine, native);
      const deltas =
        body.stream === true
          ? tokenDeltas(
              result.tokens,
              stopped.text,
              loadedEngine !== null
                ? tokenPrefixes(loadedEngine, native, result.tokens)
                : (() => {
                    const cumulative: string[] = [];
                    let text = "";
                    for (const token of result.tokens) {
                      text += native.vocab[token] ?? "";
                      cumulative.push(text);
                    }
                    return cumulative;
                  })(),
            )
          : undefined;
      return {
        text: stopped.text,
        seed: result.seed,
        steps: result.steps,
        trace: traceFor(result),
        finishReason:
          stopped.stopped || (result as { finishReason?: string }).finishReason === "stop"
            ? "stop"
            : "length",
        ...(logprobs === undefined ? {} : { logprobs }),
        ...(deltas === undefined ? {} : { deltas }),
      };
    }

    if (gguf !== null || wasmModel !== null) {
      if (loadedEngine === null) throw new Error("the RAREXT engine was not loaded");
      const seed =
        typeof body.seed === "number" && Number.isSafeInteger(body.seed)
          ? (body.seed as number)
          : null;
      const steps = requestedSteps(body, 32);
      const runSteps = pinned === undefined ? steps : Math.max(steps, pinned.length + 1);
      // The provider runs the engine it fetched from RAREXT over the weights it
      // fetched from RAREXT. No Ollama, llama.cpp, native addon, or container.
      const result = await loadedEngine.run(gguf ?? wasmModel, {
        prompt,
        steps: runSteps,
        seed,
        temperature: decoding.temperature,
        topK: decoding.topK,
        topP: decoding.topP,
        minP: decoding.minP,
        typicalP: decoding.typicalP,
        logitBias: decoding.logitBias,
        repetitionPenalty: decoding.repetitionPenalty,
        presencePenalty: decoding.presencePenalty,
        frequencyPenalty: decoding.frequencyPenalty,
        stop: decoding.stop,
        logprobs: decoding.logprobs,
        topLogprobs: decoding.topLogprobs,
        ...(pinned === undefined ? {} : { pinnedTokens: pinned }),
        ...(grammarDfa === null ? {} : { grammarDfa }),
      });
      if (
        result === null ||
        typeof result !== "object" ||
        typeof result.text !== "string" ||
        !Number.isSafeInteger(result.seed) ||
        !Number.isSafeInteger(result.steps) ||
        !Array.isArray(result.tokens) ||
        !result.tokens.every((token) => Number.isSafeInteger(token))
      ) {
        throw new Error("the RAREXT engine returned a malformed result");
      }
      const stopped = applyStop(result.text, decoding.stop);
      const logprobs = engineLogprobs(result, loadedEngine, gguf ?? wasmModel);
      const deltas =
        body.stream === true
          ? tokenDeltas(
              result.tokens,
              stopped.text,
              tokenPrefixes(loadedEngine, gguf ?? wasmModel, result.tokens),
            )
          : undefined;
      return {
        text: stopped.text,
        seed: result.seed,
        steps: result.steps,
        trace: traceFor(result),
        finishReason:
          stopped.stopped || (result as { finishReason?: string }).finishReason === "stop"
            ? "stop"
            : "length",
        ...(logprobs === undefined ? {} : { logprobs }),
        ...(deltas === undefined ? {} : { deltas }),
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
    const stopped = applyStop(text, decoding.stop);
    return {
      text: stopped.text,
      seed: null,
      steps: json.usage?.completion_tokens ?? 0,
      trace,
      finishReason: stopped.stopped ? "stop" : "length",
      // A third-party engine's ids are not ours to decode; stream its text as
      // one delta rather than guessing token boundaries.
      ...(body.stream === true ? { deltas: stopped.text === "" ? [] : [stopped.text] } : {}),
    };
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
              // What this provider will do, stated rather than discovered by
              // failing. Multimodal input is refused by name: no vision or audio
              // tower is implemented, and the weights carry none.
              capabilities: {
                chat: true,
                completions: true,
                streaming: true,
                embeddings: loadedEngine !== null && typeof loadedEngine.embed === "function",
                tools: true,
                response_format: true,
                logprobs: true,
                grammar: true,
                multimodal: false,
                multimodal_note:
                  "image and audio parts are refused with code unsupported_content_part: no vision or audio " +
                  "tower is implemented in this runtime, and the committed weights carry none",
                weights_streaming: streamedReader !== null,
              },
            },
          ],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/embeddings") {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const modelId = options.bundle.model.id;

        if (loadedEngine === null || typeof loadedEngine.embed !== "function") {
          sendJson(response, 400, {
            error: "this deployment's engine exposes no embedding matrix",
          });
          return;
        }
        // The engine reads the token embedding matrix from the same verified
        // bytes it serves completions from; there is no second model.
        const embeddingModel = gguf ?? wasmModel ?? native;
        if (embeddingModel === null) {
          sendJson(response, 400, { error: "no native model is loaded for embeddings" });
          return;
        }

        // OpenAI accepts a string, an array of strings, a token-id array, an
        // array of token-id arrays, and an array of token counts.
        const raw = body.input;
        const inputs: Array<{ text?: string; ids?: number[] }> = [];
        const asIds = (value: unknown): number[] | null =>
          Array.isArray(value) && value.length > 0 && value.every((id) => Number.isSafeInteger(id))
            ? (value as number[])
            : null;
        if (typeof raw === "string") {
          inputs.push({ text: raw });
        } else if (Array.isArray(raw)) {
          const single = asIds(raw);
          if (single !== null) {
            inputs.push({ ids: single });
          } else {
            for (const entry of raw) {
              if (typeof entry === "string") {
                inputs.push({ text: entry });
              } else {
                const ids = asIds(entry);
                if (ids === null) {
                  sendJson(response, 400, {
                    error: "input must be a string, an array of strings, or token id arrays",
                  });
                  return;
                }
                inputs.push({ ids });
              }
            }
          }
        } else {
          sendJson(response, 400, {
            error: "input must be a string, an array of strings, or token id arrays",
          });
          return;
        }
        if (inputs.length === 0) {
          sendJson(response, 400, { error: "input must not be empty" });
          return;
        }

        let promptTokens = 0;
        const vectors: number[][] = [];
        try {
          for (const entry of inputs) {
            const result = loadedEngine.embed.call(loadedEngine, embeddingModel, entry);
            if (
              result === null ||
              typeof result !== "object" ||
              !Array.isArray(result.embedding) ||
              !result.embedding.every((value) => typeof value === "number" && Number.isFinite(value))
            ) {
              throw new Error("the engine returned a malformed embedding");
            }
            vectors.push(result.embedding);
            promptTokens += Number.isSafeInteger(result.tokens) ? result.tokens : 0;
          }
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "embedding failed",
          });
          return;
        }

        const encodeBase64 = (vector: number[]): string =>
          Buffer.from(Float32Array.from(vector).buffer).toString("base64");
        const asBase64 = body.encoding_format === "base64";
        const payload = {
          object: "list",
          data: vectors.map((vector, index) => ({
            object: "embedding",
            index,
            embedding: asBase64 ? encodeBase64(vector) : vector.map((value) => value),
          })),
          model: modelId,
          usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
          // The vectors are recomputable: same committed bytes, same input,
          // same numbers. The trace digest binds the response to the model.
          rarext_bundle: options.bundle.digest,
        };
        response.setHeader("x-rarext-receipt", receiptHeader(body, payload));
        sendJson(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const modelId = options.bundle.model.id;

        // A multimodal part is a capability question, answered precisely: this
        // deployment's weights have no vision or audio tower, so the request is
        // refused by name rather than answered from the text around the image.
        const unsupported = unsupportedContentPart(body.messages);
        if (unsupported !== null) {
          sendJson(response, 400, {
            error: {
              message: unsupportedContentMessage(unsupported),
              type: "invalid_request_error",
              code: "unsupported_content_part",
              param: "messages",
            },
          });
          return;
        }

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
          const sealedUnsupported = unsupportedContentPart(inner.messages);
          if (sealedUnsupported !== null) {
            sendJson(response, 400, {
              error: {
                message: unsupportedContentMessage(sealedUnsupported),
                type: "invalid_request_error",
                code: "unsupported_content_part",
                param: "messages",
              },
            });
            return;
          }
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
                  finish_reason: result.finishReason,
                  ...chatLogprobs(result),
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

        const n = requestedChoices(body);
        const results: Array<Awaited<ReturnType<typeof complete>>> = [];
        for (let index = 0; index < n; index += 1) {
          results.push(await complete(choiceBody(body, index, n)));
        }
        const result = results[0]!;
        const created = Math.floor(Date.now() / 1000);
        const usage = fixedUsage(promptTokenCount(body), results);
        const tools = parseTools(body.tools);
        const toolChoice = parseToolChoice(body.tool_choice);

        if (body.stream === true) {
          const chunks: unknown[] = [];
          results.forEach((choice, index) => {
            const found = extractToolCalls(choice.text, tools, toolChoice);
            const calls =
              body.parallel_tool_calls === false ? found.slice(0, 1) : found;
            if (calls.length > 0) {
              chunks.push({
                id: `chatcmpl-tool-${index}`,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index,
                    delta: {
                      role: "assistant",
                      tool_calls: calls.map((call, at) => ({
                        index: at,
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.arguments },
                      })),
                    },
                    finish_reason: null,
                  },
                ],
              });
              chunks.push({
                id: n === 1 ? "chatcmpl-final" : `chatcmpl-final-${index}`,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [{ index, delta: {}, finish_reason: "tool_calls" }],
                // The stream carries the decode trace too, so a gateway or a
                // client can record and replay what was actually decoded.
                ...decodeTrace(choice.trace),
              });
              return;
            }
            const deltas = choice.deltas ?? (choice.text === "" ? [] : [choice.text]);
            const id = `chatcmpl-${sha256Hex(`${created}:${choice.text}`).slice(0, 24)}`;
            deltas.forEach((delta, at) => {
              chunks.push({
                id,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index,
                    delta: { ...(at === 0 ? { role: "assistant" } : {}), content: delta },
                    finish_reason: null,
                    ...chatChunkLogprobs(choice, at, deltas.length),
                  },
                ],
              });
            });
            // The final chunk carries the truth about how the choice ended; the
            // content chunks always say `null`.
            chunks.push({
              id: n === 1 ? "chatcmpl-final" : `chatcmpl-final-${index}`,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [{ index, delta: {}, finish_reason: choice.finishReason }],
              // The stream carries the decode trace too, so a gateway or a
              // client can record and replay what was actually decoded.
              ...decodeTrace(choice.trace),
            });
          });
          if (wantsStreamUsage(body)) {
            chunks.push({
              id: "chatcmpl-usage",
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [],
              usage,
            });
          }
          sendSse(response, chunks);
          return;
        }

        response.setHeader("x-rarext-bundle", options.bundle.digest);
        if (result.seed !== null) response.setHeader("x-rarext-seed", String(result.seed));
        const choiceResults = n === 1 ? [result] : results;
        // OpenAI's `parallel_tool_calls: false` means at most one tool call.
        const maxToolCalls = body.parallel_tool_calls === false ? 1 : undefined;
        const chatChoices = choiceResults.map((choice, index) => {
          const found = extractToolCalls(choice.text, tools, toolChoice);
          const calls = maxToolCalls === undefined ? found : found.slice(0, maxToolCalls);
          const trace = n === 1 ? {} : decodeTrace(choice.trace);
          if (calls.length > 0) {
            // A tool call is the message: content is null, and the finish reason
            // says so instead of pretending the run stopped on its own.
            return {
              index,
              message: {
                role: "assistant",
                content: null,
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              },
              finish_reason: "tool_calls",
              ...trace,
            };
          }
          return {
            index,
            message: { role: "assistant", content: choice.text },
            finish_reason: choice.finishReason,
            ...chatLogprobs(choice),
            // Each choice carries its own trace, so a multi-choice answer is as
            // replayable as a single one.
            ...trace,
          };
        });
        const completionBody = {
          id: `chatcmpl-${sha256Hex(`${created}:${result.text}`).slice(0, 24)}`,
          object: "chat.completion",
          created,
          model: modelId,
          choices: chatChoices,
          usage,
          ...decodeTrace(result.trace),
        };
        response.setHeader("x-rarext-receipt", receiptHeader(body, completionBody));
        sendJson(response, 200, completionBody);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/completions") {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const n = requestedChoices(body);
        const results: Array<Awaited<ReturnType<typeof complete>>> = [];
        for (let index = 0; index < n; index += 1) {
          results.push(await complete(choiceBody(body, index, n), "completions"));
        }
        const result = results[0]!;
        const created = Math.floor(Date.now() / 1000);
        const promptTokens = promptTokenCount(body);
        const completionTokens = results.reduce((total, choice) => total + choice.steps, 0);
        // The legacy completions endpoint reports total as the completion count
        // (its historical shape here), for one choice or many.
        const usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: completionTokens,
        };
        if (body.stream === true) {
          const chunks: unknown[] = [];
          results.forEach((choice, index) => {
            const deltas = choice.deltas ?? (choice.text === "" ? [] : [choice.text]);
            deltas.forEach((text, at) => {
              chunks.push({
                id: "cmpl-stream",
                object: "text_completion",
                created,
                model: options.bundle.model.id,
                choices: [
                  {
                    index,
                    text,
                    finish_reason: null,
                    ...completionChunkLogprobs(choice, at, deltas.length),
                  },
                ],
              });
            });
            chunks.push({
              id: n === 1 ? "cmpl-final" : `cmpl-final-${index}`,
              object: "text_completion",
              created,
              model: options.bundle.model.id,
              choices: [{ index, text: "", finish_reason: choice.finishReason }],
              ...decodeTrace(choice.trace),
            });
          });
          if (wantsStreamUsage(body)) {
            chunks.push({
              id: "cmpl-usage",
              object: "text_completion",
              created,
              model: options.bundle.model.id,
              choices: [],
              usage,
            });
          }
          sendSse(response, chunks);
          return;
        }
        const textCompletion = {
          id: "cmpl-final",
          object: "text_completion",
          created,
          model: options.bundle.model.id,
          choices:
            n === 1
              ? [
                  {
                    index: 0,
                    text: result.text,
                    finish_reason: result.finishReason,
                    ...completionLogprobs(result),
                  },
                ]
              : results.map((choice, index) => ({
                  index,
                  text: choice.text,
                  finish_reason: choice.finishReason,
                  ...completionLogprobs(choice),
                  ...decodeTrace(choice.trace),
                })),
          usage,
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
    streaming: streamedReader !== null,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (streamedReader !== null) {
        streamedReader.close();
        if (streamedPath !== null) {
          try {
            rmSync(streamedPath, { force: true });
          } catch {
            // A leftover temp file is not worth failing a shutdown over.
          }
        }
      }
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


