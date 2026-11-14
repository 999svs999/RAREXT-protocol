import type {
  ApiShape,
  EngineName,
  EngineProbe,
  EngineRef,
  ModelRef,
  TokenUsage,
} from "./types.ts";
import { normalizeEndpoint, openAiBase } from "./manifest.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers: Record<string, string> = {},
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function modelFromOllama(raw: Record<string, unknown>): ModelRef {
  const details = isRecord(raw.details) ? raw.details : {};
  return {
    id: String(raw.name ?? raw.model ?? ""),
    family: stringOrNull(details.family) ?? (Array.isArray(details.families) ? stringOrNull(details.families[0]) : null),
    parameters: stringOrNull(details.parameter_size),
    quantization: stringOrNull(details.quantization_level),
    format: stringOrNull(details.format),
    sizeBytes: numberOrNull(raw.size),
    weightsDigest: typeof raw.digest === "string" ? `sha256:${raw.digest}` : null,
    contextLength: numberOrNull(raw.context_length),
  };
}

function modelFromOpenAi(raw: Record<string, unknown>): ModelRef {
  const details = isRecord(raw.details) ? raw.details : {};
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const digest =
    stringOrNull(raw.digest) ??
    stringOrNull(metadata.weightsDigest) ??
    stringOrNull(metadata.digest) ??
    stringOrNull(details.digest);
  return {
    id: String(raw.id ?? raw.name ?? ""),
    family: stringOrNull(details.family) ?? stringOrNull(metadata.family) ?? stringOrNull(raw.owned_by),
    parameters: stringOrNull(details.parameter_size) ?? stringOrNull(metadata.parameters),
    quantization: stringOrNull(details.quantization_level) ?? stringOrNull(metadata.quantization),
    format: stringOrNull(details.format) ?? stringOrNull(metadata.format),
    sizeBytes: numberOrNull(raw.size) ?? numberOrNull(metadata.sizeBytes),
    weightsDigest: digest === null ? null : /^[a-z0-9-]+:/i.test(digest) ? digest : `sha256:${digest}`,
    contextLength:
      numberOrNull(raw.context_length) ??
      numberOrNull(metadata.contextLength) ??
      numberOrNull(details.context_length),
  };
}

function modelFromAnthropic(raw: Record<string, unknown>): ModelRef {
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const digest =
    stringOrNull(raw.digest) ??
    stringOrNull(metadata.weightsDigest) ??
    stringOrNull(metadata.digest);
  return {
    id: String(raw.id ?? raw.name ?? ""),
    family: stringOrNull(metadata.family) ?? stringOrNull(raw.display_name) ?? "anthropic",
    parameters: stringOrNull(metadata.parameters),
    quantization: stringOrNull(metadata.quantization),
    format: stringOrNull(metadata.format),
    sizeBytes: numberOrNull(raw.size) ?? numberOrNull(metadata.sizeBytes),
    weightsDigest: digest === null ? null : /^[a-z0-9-]+:/i.test(digest) ? digest : `sha256:${digest}`,
    contextLength: numberOrNull(metadata.contextLength) ?? numberOrNull(raw.context_length),
  };
}

function pickModel(models: ModelRef[], wanted: string | undefined): ModelRef {
  if (models.length === 0) {
    throw new Error("the engine advertises no models — pull or load one first");
  }
  if (wanted === undefined || wanted === "") {
    if (models.length === 1) return models[0];
    throw new Error(
      `the engine advertises ${models.length} models; name one with --model (${models
        .map((model) => model.id)
        .join(", ")})`,
    );
  }

  const exact = models.find((model) => model.id === wanted);
  if (exact) return exact;

  const tagged = models.find((model) => model.id.startsWith(`${wanted}:`));
  if (tagged) return tagged;

  const caseInsensitive = models.find((model) => model.id.toLowerCase() === wanted.toLowerCase());
  if (caseInsensitive) return caseInsensitive;

  throw new Error(
    `model "${wanted}" is not advertised by the engine (${models.map((model) => model.id).join(", ")})`,
  );
}

async function probeOllama(
  base: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {},
): Promise<EngineProbe | null> {
  const tags = await getJson(`${base}/api/tags`, fetchImpl, DEFAULT_TIMEOUT_MS, headers);
  if (!isRecord(tags) || !Array.isArray(tags.models)) return null;

  const versionPayload = await getJson(`${base}/api/version`, fetchImpl, DEFAULT_TIMEOUT_MS, headers);
  const version =
    isRecord(versionPayload) && typeof versionPayload.version === "string"
      ? versionPayload.version
      : null;

  const models = tags.models
    .filter(isRecord)
    .map(modelFromOllama)
    .filter((model) => model.id.length > 0);

  return {
    engine: { name: "ollama", version, endpoint: base },
    // The caller picks one; this placeholder is replaced by probeEngine.
    model: models[0],
    apis: ["openai", "anthropic"],
    models,
  };
}

async function probeOpenAi(
  base: string,
  fetchImpl: typeof fetch,
  engineName: EngineName,
  headers: Record<string, string> = {},
): Promise<EngineProbe | null> {
  const payload = await getJson(`${openAiBase(base)}/models`, fetchImpl, DEFAULT_TIMEOUT_MS, headers);
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;

  const models = payload.data
    .filter(isRecord)
    .map(modelFromOpenAi)
    .filter((model) => model.id.length > 0);

  const versionPayload = await getJson(`${base}/version`, fetchImpl, DEFAULT_TIMEOUT_MS, headers);
  const version =
    isRecord(versionPayload) && typeof versionPayload.version === "string"
      ? versionPayload.version
      : null;

  return {
    engine: {
      name: engineName,
      version,
      endpoint: base,
    },
    model: models[0],
    apis: engineName === "anthropic" ? ["anthropic"] : ["openai", "anthropic"],
    models,
  };
}

async function probeAnthropic(
  base: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {},
): Promise<EngineProbe | null> {
  // The Anthropic API uses the same `/v1/models` listing shape, but with its
  // own auth and version headers. A provider that speaks only Messages has no
  // listing; the operator then names `--model` and the deploy path still works
  // because `probeEngine` accepts a single explicitly named model.
  const payload = await getJson(`${openAiBase(base)}/models`, fetchImpl, DEFAULT_TIMEOUT_MS, headers);
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;

  const models = payload.data
    .filter(isRecord)
    .map(modelFromAnthropic)
    .filter((model) => model.id.length > 0);

  return {
    engine: { name: "anthropic", version: null, endpoint: base },
    model: models[0],
    apis: ["anthropic"],
    models,
  };
}

export interface EngineCatalog {
  engine: EngineRef;
  apis: ApiShape[];
  /** Every model the engine advertises. */
  models: ModelRef[];
}

/**
 * Probe an engine and list every model it advertises, without choosing one.
 * Ollama is detected by its native `/api/tags`; everything else is treated as
 * OpenAI-compatible, which is the surface Strata and FreeToken both publish.
 */
export async function probeEngineCatalog(options: {
  endpoint: string;
  engine?: EngineName;
  /** Which listing/auth surface the remote endpoint speaks. */
  api?: ApiShape;
  /** Auth and protocol headers for a remote endpoint. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<EngineCatalog> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = normalizeEndpoint(options.endpoint);
  const headers = options.headers ?? {};

  const candidates: EngineCatalog[] = [];
  const api = options.api ?? (options.engine === "anthropic" ? "anthropic" : "openai");

  if (api === "anthropic") {
    const anthropic = await probeAnthropic(base, fetchImpl, headers);
    if (anthropic) candidates.push(anthropic);
  } else {
    if (options.engine === undefined || options.engine === "ollama") {
      const ollama = await probeOllama(base, fetchImpl, headers);
      if (ollama) candidates.push(ollama);
    }

    if (options.engine !== "ollama") {
      const explicit = options.engine ?? "openai-compatible";
      const openai = await probeOpenAi(base, fetchImpl, explicit, headers);
      if (openai) candidates.push(openai);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `no serving engine answered at ${base} — expected Ollama's /api/tags, an OpenAI-compatible /v1/models, ` +
        `or an Anthropic-compatible /v1/models`,
    );
  }

  const probe = candidates[0]!;
  return { engine: probe.engine, apis: probe.apis, models: probe.models };
}

/**
 * Probe an engine and select one model. With no `--model`, a single-model
 * engine is accepted and a multi-model engine is refused rather than guessed.
 */
export async function probeEngine(options: {
  endpoint: string;
  engine?: EngineName;
  model?: string;
  api?: ApiShape;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<EngineProbe> {
  const catalog = await probeEngineCatalog(options);

  return {
    engine: catalog.engine,
    apis: catalog.apis,
    models: catalog.models,
    model: pickModel(catalog.models, options.model),
  };
}

export interface PullProgress {
  /** The engine's own status line, e.g. `pulling manifest`, `verifying sha256 digest`. */
  status: string;
  /** Bytes fetched so far, when the engine reports a layer. */
  completed: number | null;
  /** Total bytes for the layer, when known. */
  total: number | null;
  /** The layer digest the engine is working on, when reported. */
  digest: string | null;
}

function pullProgress(event: Record<string, unknown>): PullProgress {
  return {
    status: typeof event.status === "string" ? event.status : "pulling",
    completed: numberOrNull(event.completed),
    total: numberOrNull(event.total),
    digest: stringOrNull(event.digest),
  };
}

/**
 * Pull a model through Ollama's streaming `/api/pull`.
 *
 * Strata and FreeToken each ship their own downloader, so this deliberately
 * speaks only Ollama's protocol: an engine with no pull API is left to its own
 * installer, and `deploy --pull` refuses to pretend otherwise. The model is
 * re-probed after the stream finishes, so the digest in the deployment is the
 * one the engine reports for the bytes now on disk, not a value invented from
 * the download events.
 */
export async function pullOllamaModel(options: {
  endpoint: string;
  model: string;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: PullProgress) => void;
  /** Milliseconds before the pull is abandoned. Undefined waits indefinitely. */
  timeoutMs?: number;
}): Promise<ModelRef> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = normalizeEndpoint(options.endpoint);

  if (options.model.trim() === "") throw new Error("a model id is required to pull");

  const response = await fetchImpl(`${base}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: options.model, stream: true }),
    ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(
      `the engine at ${base} refused to pull ${options.model}: HTTP ${response.status}` +
        (detail === "" ? "" : ` — ${detail.slice(0, 300)}`),
    );
  }

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;

      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!isRecord(event)) return;
      if (typeof event.error === "string" && event.error.length > 0) {
        throw new Error(`the engine refused to pull ${options.model}: ${event.error}`);
      }
      options.onProgress?.(pullProgress(event));
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line);
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    consume(buffer);
  }

  const probe = await probeOllama(base, fetchImpl);
  if (!probe) {
    throw new Error(`the pull finished but ${base} no longer answers /api/tags`);
  }
  return pickModel(probe.models, options.model);
}

export function openAiChatUrl(endpoint: string): string {
  return `${openAiBase(endpoint)}/chat/completions`;
}

export function anthropicMessagesUrl(endpoint: string): string {
  return `${openAiBase(endpoint)}/messages`;
}

export function openAiEmbeddingsUrl(endpoint: string): string {
  return `${openAiBase(endpoint)}/embeddings`;
}

/** Content-part types that carry text we can actually use. */
const TEXTUAL_PART_TYPES = new Set([
  "text",
  "input_text",
  "output_text",
  "tool_use",
  "tool_result",
  "thinking",
]);

/** A content part the committed weights cannot process. */
export interface UnsupportedContentPart {
  /** The part's `type`, or "(untyped part)" when it did not name one. */
  part: string;
  /** Where it appeared: "message", "tool_result", or "system". */
  where: string;
}

/**
 * Find the first content part that is not text.
 *
 * Both surfaces carry parts as `{ type, … }`: OpenAI uses `image_url`,
 * `input_audio`, `file`; Anthropic uses `image`, `document`, `audio`. RAREXT's
 * committed weights carry no vision or audio tower, so a request that includes
 * one is REFUSED with a capability error naming the part — it is never answered
 * as if the image had been read, and never silently answered from the text
 * around it. `tool_result` content is inspected, because it can itself hold
 * blocks.
 */
export function unsupportedContentPart(messages: unknown): UnsupportedContentPart | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "string") continue;
      if (!isRecord(part)) continue;
      const type = typeof part.type === "string" ? part.type : "";
      if (TEXTUAL_PART_TYPES.has(type)) {
        if (type === "tool_result" && Array.isArray(part.content)) {
          const nested = unsupportedContentPart([{ role: "tool", content: part.content }]);
          if (nested !== null) return { part: nested.part, where: "tool_result" };
        }
        continue;
      }
      return { part: type === "" ? "(untyped part)" : type, where: "message" };
    }
  }
  return null;
}

/** The refusal message for a surface, naming the part and the reason. */
export function unsupportedContentMessage(part: UnsupportedContentPart): string {
  const location = part.where === "message" ? "content parts" : `content in ${part.where}`;
  const verb = part.where === "message" ? "are" : "is";
  return (
    `${part.part} ${location} ${verb} not supported: ` +
    "the committed weights carry no vision or audio tower, so the model cannot read them. " +
    "Remove the part, send text only, or deploy a model that is trained for it."
  );
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

/** Anthropic Messages request -> OpenAI Chat Completions request. */
export function translateAnthropicRequest(
  body: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
  // Refuse a multimodal request here too, so no caller can translate one into a
  // text-only prompt and answer it as if the image had been read.
  const fromSystem = Array.isArray(body.system)
    ? unsupportedContentPart([{ role: "system", content: body.system }])
    : null;
  const part =
    unsupportedContentPart(body.messages) ??
    (fromSystem === null ? null : { part: fromSystem.part, where: "system" });
  if (part !== null) throw new Error(unsupportedContentMessage(part));

  const messages: Array<{ role: string; content: string }> = [];

  if (typeof body.system === "string" && body.system.length > 0) {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const system = textFromContent(body.system);
    if (system.length > 0) messages.push({ role: "system", content: system });
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message) || typeof message.role !== "string") continue;
    messages.push({ role: message.role, content: textFromContent(message.content) });
  }

  const translated: Record<string, unknown> = {
    model: typeof body.model === "string" && body.model.length > 0 ? body.model : fallbackModel,
    messages,
    stream: body.stream === true,
  };

  if (typeof body.max_tokens === "number") translated.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") translated.temperature = body.temperature;
  if (typeof body.top_p === "number") translated.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    translated.stop = body.stop_sequences;
  }
  if (Array.isArray(body.tools)) {
    const tools = body.tools
      .filter(isRecord)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters: tool.input_schema ?? { type: "object", properties: {} },
        },
      }))
      .filter((tool) => typeof tool.function.name === "string" && tool.function.name.length > 0);
    if (tools.length > 0) translated.tools = tools;
  }
  // Anthropic's tool_choice shape -> OpenAI's. `auto` stays `auto`, `any` means
  // "must call some tool" (`required`), and `{type:"tool",name}` pins a function.
  // An OpenAI-shaped string is passed through unchanged.
  if (typeof body.tool_choice === "string") {
    translated.tool_choice = body.tool_choice;
  } else if (isRecord(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === "auto") translated.tool_choice = "auto";
    else if (choice.type === "any") translated.tool_choice = "required";
    else if (choice.type === "none") translated.tool_choice = "none";
    else if (choice.type === "tool" && typeof choice.name === "string") {
      translated.tool_choice = { type: "function", function: { name: choice.name } };
    }
  }
  if (body.metadata !== undefined) translated.metadata = body.metadata;

  return translated;
}

/** OpenAI Chat Completions response -> Anthropic Messages response. */
export function translateOpenAiResponse(
  response: Record<string, unknown>,
  requestedModel: string,
  options: { maxToolCalls?: number } = {},
): Record<string, unknown> {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(first.message) ? first.message : {};
  const text = typeof message.content === "string" ? message.content : textFromContent(message.content);
  const usage = isRecord(response.usage) ? response.usage : {};
  // OpenAI's finish_reason -> Anthropic's stop_reason. `stop` is `end_turn`,
  // not a literal "stop", so a streamed and a complete answer agree.
  const finish = typeof first.finish_reason === "string" ? first.finish_reason : null;
  const allToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
  // Anthropic returns at most one tool_use block when parallel tool use is off
  // (a named tool, or `disable_parallel_tool_use`).
  const toolCalls = options.maxToolCalls === undefined ? allToolCalls : allToolCalls.slice(0, options.maxToolCalls);
  const stopReason =
    toolCalls.length > 0 || finish === "tool_calls"
      ? "tool_use"
      : finish === "length"
        ? "max_tokens"
        : finish === null || finish === "stop"
          ? "end_turn"
          : finish;

  // An assistant turn is text and/or tool_use blocks; a tool call is not text.
  const content: unknown[] = [];
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of toolCalls) {
    const fn = isRecord(call.function) ? call.function : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    let input: unknown = {};
    if (typeof fn.arguments === "string") {
      try {
        input = JSON.parse(fn.arguments);
      } catch {
        input = {};
      }
    }
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" ? call.id : `toolu_${Math.random().toString(36).slice(2, 12)}`,
      name,
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text });

  return {
    id: typeof response.id === "string" ? response.id : `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: numberOrNull(usage.prompt_tokens) ?? 0,
      output_tokens: numberOrNull(usage.completion_tokens) ?? 0,
    },
  };
}

/** The assistant text from an OpenAI-shaped JSON response. */
export function extractOpenAiText(response: unknown): string {
  if (!isRecord(response)) return "";
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  if (isRecord(first.message)) return textFromContent(first.message.content);
  if (typeof first.text === "string") return first.text;
  return "";
}

/** The assistant text from an Anthropic-shaped JSON response. */
export function extractAnthropicText(response: unknown): string {
  if (!isRecord(response)) return "";
  return textFromContent(response.content);
}

/** Best-effort text from an SSE stream, for the human-readable summary only. */
export function extractSseText(raw: string): string {
  let text = "";

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    const choices = Array.isArray(event.choices) ? event.choices : [];
    const delta = isRecord(choices[0]) && isRecord(choices[0].delta) ? choices[0].delta : null;
    if (delta && typeof delta.content === "string") text += delta.content;

    const block = isRecord(event.delta) ? event.delta : null;
    if (block && typeof block.text === "string") text += block.text;
  }

  return text;
}

export function usageFromOpenAi(response: unknown): TokenUsage | null {
  if (!isRecord(response) || !isRecord(response.usage)) return null;
  const usage = response.usage;
  return {
    promptTokens: numberOrNull(usage.prompt_tokens),
    completionTokens: numberOrNull(usage.completion_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
  };
}

export function usageFromAnthropic(response: unknown): TokenUsage | null {
  if (!isRecord(response) || !isRecord(response.usage)) return null;
  const input = numberOrNull(response.usage.input_tokens);
  const output = numberOrNull(response.usage.output_tokens);
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input === null || output === null ? null : input + output,
  };
}

export function samplingFromRequest(body: Record<string, unknown>): {
  temperature: number;
  topP: number | null;
  seed: number | null;
  maxTokens: number | null;
} {
  return {
    temperature:
      typeof body.temperature === "number" && Number.isFinite(body.temperature)
        ? body.temperature
        : 0,
    topP: typeof body.top_p === "number" && Number.isFinite(body.top_p) ? body.top_p : null,
    seed: typeof body.seed === "number" && Number.isSafeInteger(body.seed) ? body.seed : null,
    maxTokens:
      typeof body.max_tokens === "number"
        ? body.max_tokens
        : typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : null,
  };
}

export function supportedApis(engine: EngineName): ApiShape[] {
  // The runtime translates Anthropic Messages to the OpenAI surface, so every
  // engine advertises both to clients regardless of what the engine speaks.
  return engine === "ollama" || engine === "openai-compatible" || engine === "strata" || engine === "freetoken" || engine === "rarext"
    ? ["openai", "anthropic"]
    : ["openai"];
}
