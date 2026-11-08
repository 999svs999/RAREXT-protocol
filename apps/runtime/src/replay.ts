import {
  anthropicMessagesUrl,
  extractAnthropicText,
  extractOpenAiText,
  openAiChatUrl,
} from "./engines.ts";
import type { ApiShape, ModelRunBody } from "./types.ts";

export interface ReplayResult {
  /** True only when the run was reproduced by the pinned engine, trace included. */
  ok: boolean;
  reason: string | null;
  /** The provider's present engine fingerprint, when it reported one. */
  engineFingerprint: string | null;
  /** Whether the replayed output matched; null when no replay was attempted. */
  reproduced: boolean | null;
  /**
   * Whether the re-execution's decode trace matched the committed one. Null (or
   * absent) when the run carries no trace (an engine that exposes no token ids).
   */
  traceMatches?: boolean | null;
  replayed: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replay a run against a provider, checking the engine pin first.
 *
 * An arbitrary GGUF cannot be reproduced bit-for-bit by the protocol alone — the
 * weights do not determine the engine's arithmetic. What the protocol CAN do is
 * refuse to call it a replay unless the engine behind the endpoint is the engine
 * the run pinned: the run records `engine.fingerprint`, the provider reports its
 * present engine on `/health`, and a mismatch ends the replay before a single
 * token is generated. Only a matching engine is re-issued, and its output is
 * compared to the committed output.
 */
export async function replayEngineRun(input: {
  body: ModelRunBody;
  endpoint: string;
  api?: ApiShape;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ReplayResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = input.body;

  if (body.replay === null) {
    return {
      ok: false,
      reason: "the run is sampled, not deterministic; there is nothing to replay",
      engineFingerprint: null,
      reproduced: null,
      replayed: null,
    };
  }

  const endpoint = input.endpoint.replace(/\/+$/, "");
  const committed = body.engine.fingerprint ?? null;

  // The pin is checked before anything is generated: a different engine is a
  // different run, and re-issuing would prove nothing about this one.
  let present: string | null = null;
  try {
    const health = await fetchImpl(`${endpoint}/health`, {
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
    if (health.ok) {
      const json = (await health.json()) as { engineFingerprint?: unknown };
      present = typeof json.engineFingerprint === "string" ? json.engineFingerprint : null;
    }
  } catch {
    present = null;
  }

  if (committed !== null) {
    if (present === null) {
      return {
        ok: false,
        reason: "the provider did not report its engine; cannot confirm it is the pinned engine",
        engineFingerprint: null,
        reproduced: null,
        replayed: null,
      };
    }
    if (present !== committed) {
      return {
        ok: false,
        reason:
          `the provider's engine (${present.slice(0, 16)}…) differs from the pinned engine ` +
          `(${committed.slice(0, 16)}…)`,
        engineFingerprint: present,
        reproduced: null,
        replayed: null,
      };
    }
  }

  const api: ApiShape = input.api ?? (body.replay.api === "anthropic" ? "anthropic" : "openai");
  const request = { ...(body.replay.request as Record<string, unknown>), stream: false };
  const url = api === "anthropic" ? anthropicMessagesUrl(endpoint) : openAiChatUrl(endpoint);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(input.headers ?? {}) },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `replay request failed: ${error instanceof Error ? error.message : String(error)}`,
      engineFingerprint: present,
      reproduced: null,
      replayed: null,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `replay request failed: HTTP ${response.status}`,
      engineFingerprint: present,
      reproduced: null,
      replayed: null,
    };
  }

  const json = (await response.json()) as unknown;
  const text = api === "anthropic" ? extractAnthropicText(json) : extractOpenAiText(json);
  const reproduced = text === body.response.text;

  // The decode trace: the re-execution's token ids must digest to the committed
  // trace. A run with a trace whose replay diverges is refused even if the text
  // happened to match — the point is the decode, not just the string.
  const recordedTrace =
    isRecord(body.response.body) && isRecord(body.response.body.rarext_trace)
      ? body.response.body.rarext_trace
      : null;
  const replayedTrace = isRecord(json) && isRecord(json.rarext_trace) ? json.rarext_trace : null;
  let traceMatches: boolean | null = null;
  if (recordedTrace !== null) {
    traceMatches =
      replayedTrace !== null &&
      typeof replayedTrace.digest === "string" &&
      replayedTrace.digest === recordedTrace.digest;
  }

  const ok = reproduced && traceMatches !== false;
  return {
    ok,
    reason:
      traceMatches === false
        ? "the decode trace diverged from the committed trace"
        : reproduced
          ? null
          : "the replayed output differs from the committed output",
    engineFingerprint: present,
    reproduced,
    traceMatches,
    replayed: text,
  };
}
