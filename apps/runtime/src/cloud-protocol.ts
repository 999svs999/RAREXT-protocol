/**
 * `rarext.cloud-infer.v1` — RAREXT's own cloud inference wire.
 *
 * This is the protocol a future RAREXT model speaks. It carries only what an
 * inference *means* — messages, decode controls, tools, structured output in,
 * and text, tool calls, logprobs, usage out — and nothing about tensors,
 * architectures, tokenizers, or weights. A provider can implement it over any
 * stack, and RAREXT never needs to know which.
 *
 * The control plane translates between this wire and the OpenAI/Anthropic
 * surfaces clients use, so a caller sees the familiar shape while the model
 * remains architecture-free. Everything here is pure translation and is unit
 * tested against round trips, so the protocol is a contract rather than a sketch.
 */

export const CLOUD_INFER_KIND = "rarext.cloud-infer.v1";

export interface NativeCloudDecode {
  temperature: number | null;
  top_p: number | null;
  top_k: number | null;
  max_tokens: number | null;
  seed: number | null;
  n: number | null;
  stop: string[];
  logprobs: boolean;
  top_logprobs: number | null;
}

export interface NativeCloudMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface NativeCloudRequest {
  kind: typeof CLOUD_INFER_KIND;
  model: string;
  messages?: NativeCloudMessage[];
  prompt?: string;
  decode: NativeCloudDecode;
  tools: unknown[];
  tool_choice: unknown;
  response_format: unknown;
  stream: boolean;
}

export interface NativeCloudToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface NativeCloudLogprob {
  token: string;
  logprob: number;
  top: Array<{ token: string; logprob: number }>;
}

export interface NativeCloudOutput {
  text: string;
  tool_calls: NativeCloudToolCall[] | null;
  finish_reason: string;
  logprobs: NativeCloudLogprob[] | null;
}

export interface NativeCloudUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface NativeCloudResponse {
  kind: typeof CLOUD_INFER_KIND;
  id: string;
  model: string;
  output: NativeCloudOutput;
  usage: NativeCloudUsage;
  /** An opaque provider commitment RAREXT stores but never interprets. */
  attestation: { scheme: string; digest: string } | null;
}

/** One frame of a native stream: a delta, then a final frame with the reason. */
export interface NativeCloudStreamFrame {
  kind: typeof CLOUD_INFER_KIND;
  id: string;
  model: string;
  delta: { text?: string; tool_calls?: NativeCloudToolCall[] };
  finish_reason: string | null;
  usage?: NativeCloudUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function stopList(value: unknown): string[] {
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item !== "");
  return [];
}

/**
 * An OpenAI-shaped chat/completions request -> the native request. Unknown
 * fields are dropped rather than forwarded: the native wire is a closed
 * contract, which is what keeps it free of any one provider's extensions.
 */
export function toNativeCloudRequest(body: Record<string, unknown>): NativeCloudRequest {
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter(isRecord)
        .map((message): NativeCloudMessage => {
          const mapped: NativeCloudMessage = {
            role: typeof message.role === "string" ? message.role : "user",
            content: message.content ?? "",
          };
          if (message.tool_calls !== undefined) mapped.tool_calls = message.tool_calls;
          if (typeof message.tool_call_id === "string") mapped.tool_call_id = message.tool_call_id;
          if (typeof message.name === "string") mapped.name = message.name;
          return mapped;
        })
    : undefined;

  const request: NativeCloudRequest = {
    kind: CLOUD_INFER_KIND,
    model: typeof body.model === "string" ? body.model : "",
    decode: {
      temperature: asNumber(body.temperature),
      top_p: asNumber(body.top_p),
      top_k: asNumber(body.top_k),
      max_tokens:
        asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens),
      seed: asNumber(body.seed),
      n: asNumber(body.n),
      stop: stopList(body.stop),
      logprobs: body.logprobs === true,
      top_logprobs: asNumber(body.top_logprobs),
    },
    tools: Array.isArray(body.tools) ? body.tools : [],
    tool_choice: body.tool_choice ?? null,
    response_format: body.response_format ?? null,
    stream: body.stream === true,
  };
  if (messages !== undefined) request.messages = messages;
  if (typeof body.prompt === "string") request.prompt = body.prompt;
  return request;
}

/** Native tool calls -> OpenAI `tool_calls`. */
function openAiToolCalls(calls: NativeCloudToolCall[] | null): unknown[] | undefined {
  if (calls === null || calls.length === 0) return undefined;
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
}

/** Native logprobs -> OpenAI `choices[0].logprobs`. */
function openAiLogprobs(entries: NativeCloudLogprob[] | null): Record<string, unknown> | undefined {
  if (entries === null || entries.length === 0) return undefined;
  return {
    content: entries.map((entry) => ({
      token: entry.token,
      logprob: entry.logprob,
      bytes: null,
      top_logprobs: entry.top.map((alternative) => ({
        token: alternative.token,
        logprob: alternative.logprob,
        bytes: null,
      })),
    })),
  };
}

/**
 * A native response -> an OpenAI chat completion. This is what a client sees,
 * so the model can be built any way at all and the caller still gets a shape it
 * knows. `model` falls back to the requested id when the native reply omits one.
 */
export function openAiCompletionFromNative(
  native: NativeCloudResponse,
  fallbackModel: string,
): Record<string, unknown> {
  const toolCalls = openAiToolCalls(native.output.tool_calls);
  const logprobs = openAiLogprobs(native.output.logprobs);
  return {
    id: native.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: native.model === "" ? fallbackModel : native.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls === undefined ? native.output.text : null,
          ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: native.output.finish_reason,
        ...(logprobs === undefined ? {} : { logprobs }),
      },
    ],
    usage: {
      prompt_tokens: native.usage.input_tokens,
      completion_tokens: native.usage.output_tokens,
      total_tokens: native.usage.input_tokens + native.usage.output_tokens,
    },
    // The native reply's opaque commitment rides along, untouched.
    ...(native.attestation === null ? {} : { rarext_cloud_attestation: native.attestation }),
  };
}

/** A native stream frame -> one OpenAI chunk. */
export function openAiChunkFromNativeFrame(
  frame: NativeCloudStreamFrame,
  index: number,
): Record<string, unknown> {
  const toolCalls = openAiToolCalls(frame.delta.tool_calls ?? null);
  const delta: Record<string, unknown> = {};
  if (index === 0) delta.role = "assistant";
  if (frame.delta.text !== undefined) delta.content = frame.delta.text;
  if (toolCalls !== undefined) {
    // OpenAI streamed tool calls carry an index per call.
    delta.tool_calls = toolCalls.map((call, at) => ({ index: at, ...(call as object) }));
  }
  return {
    id: frame.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: frame.model,
    choices: [{ index: 0, delta, finish_reason: frame.finish_reason }],
    ...(frame.usage === null || frame.usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: frame.usage.input_tokens,
            completion_tokens: frame.usage.output_tokens,
            total_tokens: frame.usage.input_tokens + frame.usage.output_tokens,
          },
        }),
  };
}

/**
 * Assemble the non-streaming answer from a native stream, so a streamed run is
 * recorded with the same body a non-streaming one would produce. The text is the
 * concatenation of the text deltas; the finish reason is the last non-null one.
 */
export function assembleNativeStream(frames: NativeCloudStreamFrame[], fallbackModel: string): NativeCloudResponse {
  const first = frames[0];
  const text = frames.map((frame) => frame.delta.text ?? "").join("");
  const toolCalls = frames.flatMap((frame) => frame.delta.tool_calls ?? []);
  const finish =
    [...frames].reverse().find((frame) => frame.finish_reason !== null)?.finish_reason ?? "stop";
  const usage = [...frames].reverse().find((frame) => frame.usage != null)?.usage ?? { input_tokens: 0, output_tokens: 0 };
  return {
    kind: CLOUD_INFER_KIND,
    id: first?.id ?? "cloud-unknown",
    model: first?.model ?? fallbackModel,
    output: {
      text,
      tool_calls: toolCalls.length === 0 ? null : toolCalls,
      finish_reason: finish,
      logprobs: null,
    },
    usage,
    attestation: null,
  };
}

/** Parse the frames of a native SSE body (`data: <json>` lines). */
export function parseNativeStream(sse: string): NativeCloudStreamFrame[] {
  const frames: NativeCloudStreamFrame[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed) && parsed.kind === CLOUD_INFER_KIND) frames.push(parsed as unknown as NativeCloudStreamFrame);
    } catch {
      // A malformed frame is skipped; the caller records what it could read.
    }
  }
  return frames;
}

/** The native endpoint for a cloud model. */
export function nativeCloudUrl(endpoint: string): string {
  let base = endpoint.trim();
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  while (base.endsWith("/")) base = base.slice(0, -1);
  if (base.endsWith("/v1")) base = base.slice(0, -3);
  return `${base}/v1/rarext-cloud/infer`;
}
