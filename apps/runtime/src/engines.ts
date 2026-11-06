import type {
  ApiShape,
  EngineName,
  EngineProbe,
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
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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

async function probeOllama(base: string, fetchImpl: typeof fetch): Promise<EngineProbe | null> {
  const tags = await getJson(`${base}/api/tags`, fetchImpl);
  if (!isRecord(tags) || !Array.isArray(tags.models)) return null;

  const versionPayload = await getJson(`${base}/api/version`, fetchImpl);
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
): Promise<EngineProbe | null> {
  const payload = await getJson(`${openAiBase(base)}/models`, fetchImpl);
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;

  const models = payload.data
    .filter(isRecord)
    .map(modelFromOpenAi)
    .filter((model) => model.id.length > 0);

  const versionPayload = await getJson(`${base}/version`, fetchImpl);
  const version =
    isRecord(versionPayload) && typeof versionPayload.version === "string"
      ? versionPayload.version
      : null;

  return {
    engine: {
      name: engineName === "openai-compatible" ? "openai-compatible" : engineName,
      version,
      endpoint: base,
    },
    model: models[0],
    apis: engineName === "strata" || engineName === "freetoken"
      ? ["openai", "anthropic"]
      : ["openai", "anthropic"],
    models,
  };
}

/**
 * Probe an engine and select a model. Ollama is detected by its native
 * `/api/tags`; everything else is treated as OpenAI-compatible, which is the
 * surface Strata and FreeToken both publish.
 */
export async function probeEngine(options: {
  endpoint: string;
  engine?: EngineName;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<EngineProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = normalizeEndpoint(options.endpoint);
  const wanted = options.model;

  const candidates: EngineProbe[] = [];

  if (options.engine === undefined || options.engine === "ollama") {
    const ollama = await probeOllama(base, fetchImpl);
    if (ollama) candidates.push(ollama);
  }

  if (options.engine !== "ollama") {
    const explicit = options.engine ?? "openai-compatible";
    const openai = await probeOpenAi(base, fetchImpl, explicit);
    if (openai) candidates.push(openai);
  }

  if (candidates.length === 0) {
    throw new Error(
      `no serving engine answered at ${base} — expected Ollama's /api/tags or an OpenAI-compatible /v1/models`,
    );
  }

  const probe = candidates[0];
  probe.model = pickModel(probe.models, wanted);
  return probe;
}

export function openAiChatUrl(endpoint: string): string {
  return `${openAiBase(endpoint)}/chat/completions`;
}

export function anthropicMessagesUrl(endpoint: string): string {
  return `${openAiBase(endpoint)}/messages`;
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
  if (body.metadata !== undefined) translated.metadata = body.metadata;

  return translated;
}

/** OpenAI Chat Completions response -> Anthropic Messages response. */
export function translateOpenAiResponse(
  response: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(first.message) ? first.message : {};
  const text = typeof message.content === "string" ? message.content : textFromContent(message.content);
  const usage = isRecord(response.usage) ? response.usage : {};

  return {
    id: typeof response.id === "string" ? response.id : `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: [{ type: "text", text }],
    stop_reason: first.finish_reason === "length" ? "max_tokens" : first.finish_reason ?? null,
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
  return engine === "ollama" || engine === "openai-compatible" || engine === "strata" || engine === "freetoken"
    ? ["openai", "anthropic"]
    : ["openai"];
}
