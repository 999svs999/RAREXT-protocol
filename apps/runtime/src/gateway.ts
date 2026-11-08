import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { RunLedger } from "./ledger.ts";
import {
  anthropicMessagesUrl,
  extractSseText,
  openAiChatUrl,
  samplingFromRequest,
  translateAnthropicRequest,
  translateOpenAiResponse,
  usageFromAnthropic,
  usageFromOpenAi,
} from "./engines.ts";
import {
  creditLedgerProof,
  creditLedgerRoot,
  creditRoot,
  creditStatement,
  inferenceCreditLedgerRoot,
  inferenceCreditRecords,
} from "../../../packages/core/src/index.ts";
import type { CreditRecordFields } from "../../../packages/core/src/index.ts";
import { RuntimePublisher } from "./publisher.ts";
import { canonicalDigest, sha256Hex } from "./digest.ts";
import { createRunBody, TranscriptTooLargeError } from "./transcript.ts";
import type {
  ApiShape,
  DeploymentCommitment,
  RunInferenceCredits,
  RunQuorum,
  RunRecord,
} from "./types.ts";
import { MAX_REQUEST_BYTES, RUNTIME_VERSION } from "./types.ts";

export interface GatewayOptions {
  deployment: DeploymentCommitment;
  ledgerDir: string;
  publisher?: RuntimePublisher | null;
  host?: string;
  port?: number;
  /** The URL clients should use; required when bound to 0.0.0.0 behind TLS. */
  publicUrl?: string;
  /** Bearer token required on inference and ledger routes, when configured. */
  gatewayToken?: string | null;
  /** Which shape the remote engine speaks. Defaults from the deployment. */
  upstreamApi?: ApiShape;
  /** Auth/protocol headers forwarded to the remote engine. */
  upstreamHeaders?: Record<string, string>;
  /**
   * Every provider endpoint that serves the committed bundle. Absent means the
   * deployment's single engine endpoint. When more than one is named the
   * gateway queries all of them and records who agreed.
   */
  upstreams?: string[];
  /**
   * How many identical responses are required. Defaults to the number of
   * upstreams; 1 keeps the old single-response behaviour.
   */
  quorum?: number;
  /**
   * Operator identity per endpoint, when the deployment committed operators.
   * Agreement is then counted over distinct operators, not just endpoints, so
   * one operator running several providers is still one voice.
   */
  operators?: Record<string, string>;
  upstreamTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface Gateway {
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
  ledger: RunLedger;
  close: () => Promise<void>;
}

interface RecordedRun {
  record: RunRecord | null;
  publicationId: string | null;
  attested: boolean | null;
  error: string | null;
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

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The part of a completion that two providers must agree on. Ids are minted per
 * request, and `created` is a wall clock, so comparing the raw envelopes would
 * report disagreement even when the model said exactly the same thing. The
 * gateway returns and records this comparable shape, so the transcript's
 * response digest is over the answer, not the server's clock.
 */
function comparableResponse(response: Record<string, unknown>): Record<string, unknown> {
  const {
    id: _id,
    created: _created,
    system_fingerprint: _fingerprint,
    ...rest
  } = response;
  return rest;
}

/**
 * The local OpenAI/Anthropic-compatible endpoint.
 *
 * Inference is forwarded unchanged to the engine. Alongside it, the gateway
 * writes an exact transcript to the append-only ledger and (when configured)
 * publishes it to RAREXT. Publishing failures never block a completion: the
 * headers say what happened, and the local ledger still has the record.
 */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const deployment = options.deployment;
  const ledger = new RunLedger(options.ledgerDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const timeoutMs = options.upstreamTimeoutMs ?? 120_000;
  const upstreamApi: ApiShape =
    options.upstreamApi ?? (deployment.engine.name === "anthropic" ? "anthropic" : "openai");
  const upstreamHeaders = options.upstreamHeaders ?? {};
  const gatewayToken = options.gatewayToken ?? null;
  const upstreams =
    options.upstreams !== undefined && options.upstreams.length > 0
      ? [...new Set(options.upstreams)]
      : [deployment.engine.endpoint];
  const quorumRequired = options.quorum ?? upstreams.length;
  const quorumEnabled = options.quorum !== undefined || upstreams.length > 1;

  // The bounty the deployment committed, if any. Payment is a commitment the
  // challenge enforces, not a gateway setting: a run only records credits when
  // the deployment that a verifier checks against names the amount.
  const inferenceBounty = (() => {
    const raw = deployment.labels?.bounty;
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  })();

  function creditInputFor(
    quorum: RunQuorum,
    responseDigest: string,
    completedAt: string,
  ): Parameters<typeof inferenceCreditRecords>[0] {
    return {
      providers: quorum.providers.map((provider) => ({
        responseDigest: provider.responseDigest,
        operator: provider.operator ?? null,
      })),
      responseDigest,
      deploymentDigest: deployment.digest,
      completedAt,
      bounty: inferenceBounty ?? 0,
    };
  }

  /**
   * The payment a quorum run made: one receipt per distinct agreeing operator,
   * committed as a ledger root. Absent when the deployment committed no bounty,
   * or when there is no quorum evidence to pay over.
   */
  function runCredits(
    quorum: RunQuorum | undefined,
    responseDigest: string,
    completedAt: string,
  ): RunInferenceCredits | undefined {
    if (quorum === undefined || inferenceBounty === null) return undefined;
    const input = creditInputFor(quorum, responseDigest, completedAt);
    return {
      action: "infer",
      bounty: inferenceBounty,
      paid: inferenceCreditRecords(input).length,
      ledgerRoot: inferenceCreditLedgerRoot(input, sha256Hex),
    };
  }

  /**
   * Every credit record this node's recorded runs produced, recomputed from the
   * transcripts themselves. The ledger is not a separate book a node can edit:
   * it is a view of the runs, so an operator can recompute it too.
   */
  function allCreditRecords(): CreditRecordFields[] {
    const records: CreditRecordFields[] = [];
    for (const entry of ledger.records()) {
      const body = entry.body;
      if (body.credits === undefined || body.quorum === undefined) continue;
      try {
        records.push(
          ...inferenceCreditRecords({
            providers: body.quorum.providers.map((provider) => ({
              responseDigest: provider.responseDigest,
              operator: provider.operator ?? null,
            })),
            responseDigest: body.response.digest,
            deploymentDigest: body.deployment.digest,
            completedAt: body.completedAt,
            bounty: body.credits.bounty,
          }),
        );
      } catch {
        // A malformed record is skipped rather than breaking the ledger view;
        // the verifier is what rejects it, not this read.
      }
    }
    return records;
  }

  const baseHeaders = (): Record<string, string> => ({
    "x-rarext-runtime": RUNTIME_VERSION,
    "x-rarext-deployment": deployment.digest,
    "x-rarext-model": deployment.model.id,
    "x-rarext-placement": deployment.placement ?? "local",
  });

  function authorized(request: IncomingMessage): boolean {
    if (gatewayToken === null) return true;
    const header = request.headers.authorization ?? "";
    return header === `Bearer ${gatewayToken}`;
  }

  function resolveModel(payload: Record<string, unknown>): string | null {
    const requested = typeof payload.model === "string" ? payload.model : "";
    if (requested === "" || requested === deployment.model.id) return deployment.model.id;
    if (requested.startsWith(`${deployment.model.id}:`)) return deployment.model.id;
    if (deployment.model.id.startsWith(`${requested}:`)) return deployment.model.id;
    return null;
  }

  async function record(
    api: "openai" | "anthropic",
    payload: Record<string, unknown>,
    upstreamResponse: unknown,
    usage: ReturnType<typeof usageFromOpenAi>,
    startedAt: string,
    quorum?: RunQuorum,
  ): Promise<RecordedRun> {
    const completedAt = new Date().toISOString();
    const sampling = samplingFromRequest(payload);
    const credits = runCredits(quorum, canonicalDigest(upstreamResponse), completedAt);
    let record: RunRecord;
    try {
      const body = createRunBody({
        deployment,
        api,
        request: payload,
        response: upstreamResponse,
        usage,
        sampling,
        startedAt,
        completedAt,
        previous: ledger.head(),
        // A run is replayable only when the caller asked for deterministic
        // decoding; a sampled run can be re-hashed but not reproduced.
        replay: sampling.temperature === 0 && sampling.seed !== null,
        ...(quorum === undefined ? {} : { quorum }),
        ...(credits === undefined ? {} : { credits }),
      });
      record = ledger.append(body);
    } catch (error) {
      const message =
        error instanceof TranscriptTooLargeError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      log(`run not recorded: ${message}`);
      return { record: null, publicationId: null, attested: null, error: message };
    }

    if (!options.publisher) {
      return { record, publicationId: null, attested: null, error: null };
    }

    try {
      const publication = await options.publisher.publish(record.body, deployment);
      return {
        record,
        publicationId: publication.id,
        attested: publication.attestation?.correct ?? null,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`run ${record.digest.slice(0, 12)} recorded locally but not published: ${message}`);
      return { record, publicationId: null, attested: null, error: message };
    }
  }

  function runHeaders(result: RecordedRun): Record<string, string> {
    const headers: Record<string, string> = {};
    if (result.record) headers["x-rarext-run"] = result.record.digest;
    if (result.publicationId) headers["x-rarext-publication"] = result.publicationId;
    if (result.attested !== null) headers["x-rarext-attested"] = String(result.attested);
    if (result.error) headers["x-rarext-record-error"] = result.error.slice(0, 300);
    return headers;
  }

  interface QuorumResult {
    response: Record<string, unknown>;
    quorum: RunQuorum;
  }

  type QuorumOutcome = QuorumResult | { error: string; status: number; details?: unknown };

  /**
   * Send the same request to every provider and group the answers by canonical
   * digest. A run is recorded only when at least `quorumRequired` providers
   * returned the same bytes — a disagreement is refused, not averaged away.
   *
   * `accept` is the header the shape expects; `shape` selects the URL. A native
   * Anthropic deployment speaks /v1/messages, everything else /v1/chat/completions.
   */
  async function gather(
    shape: ApiShape,
    body: Record<string, unknown>,
  ): Promise<QuorumOutcome> {
    const operatorFor = (endpoint: string): string | null => options.operators?.[endpoint] ?? null;
    const attempts = await Promise.all(
      upstreams.map(async (endpoint) => {
        const url = shape === "anthropic" ? anthropicMessagesUrl(endpoint) : openAiChatUrl(endpoint);
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              ...upstreamHeaders,
            },
            body: JSON.stringify({ ...body, stream: false }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            return {
              endpoint,
              error: `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
            };
          }
          const json: unknown = await response.json();
          if (!isRecord(json)) {
            return { endpoint, error: "response is not a JSON object" };
          }
          const comparable = comparableResponse(json);
          return {
            endpoint,
            operator: operatorFor(endpoint),
            json: comparable,
            digest: canonicalDigest(comparable),
          };
        } catch (error) {
          return {
            endpoint,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const answered = attempts.filter(
      (attempt): attempt is {
        endpoint: string;
        operator: string | null;
        json: Record<string, unknown>;
        digest: string;
      } => "digest" in attempt,
    );

    const groups = new Map<string, typeof answered>();
    for (const answer of answered) {
      const group = groups.get(answer.digest) ?? [];
      group.push(answer);
      groups.set(answer.digest, group);
    }
    const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const [winner, winnerAnswers] = ranked[0] ?? ["", []];
    const runnerUp = ranked[1]?.[1].length ?? 0;

    // Agreement is counted over distinct operators when the deployment
    // committed them: one operator running five endpoints is still one voice.
    const operatorsSupplied =
      options.operators !== undefined && Object.keys(options.operators).length > 0;
    const agreedOperators = new Set(
      winnerAnswers
        .map((answer) => answer.operator)
        .filter((operator): operator is string => typeof operator === "string" && operator !== ""),
    );
    const operatorsMet = !operatorsSupplied || agreedOperators.size >= quorumRequired;

    if (
      winnerAnswers.length < quorumRequired ||
      (ranked.length > 1 && winnerAnswers.length === runnerUp) ||
      !operatorsMet
    ) {
      const operatorNote = operatorsSupplied
        ? `, ${agreedOperators.size} distinct operator(s)`
        : "";
      return {
        error:
          `provider quorum not met: ${quorumRequired} required, ${winnerAnswers.length} agreed` +
          `${operatorNote}, ${answered.length}/${upstreams.length} answered`,
        status: 503,
        details: {
          required: quorumRequired,
          answered: answered.map((a) => ({
            endpoint: a.endpoint,
            operator: a.operator,
            responseDigest: a.digest,
          })),
          failed: attempts.filter((a) => "error" in a).map((a) => ({ endpoint: a.endpoint, error: a.error })),
        },
      };
    }

    const agreed = answered.filter((answer) => answer.digest === winner);
    return {
      response: winnerAnswers[0]!.json,
      quorum: {
        required: quorumRequired,
        responded: answered.length,
        agreed: agreed.length,
        // Every provider that answered is recorded, including dissent. A
        // verifier can recompute `agreed` from these digests and count the
        // distinct operators among them.
        providers: answered.map((answer) => ({
          endpoint: answer.endpoint,
          responseDigest: answer.digest,
          operator: answer.operator,
        })),
      },
    };
  }

  /**
   * Emit an OpenAI chat-completion stream from an already-agreed complete
   * response. A quorum deployment cannot stream from providers directly — it
   * must compare complete answers first — so the caller gets a stream that is
   * derived from the attested response instead of a pass-through. The run has
   * already been recorded; its digest is in the headers.
   */
  function streamOpenAiAgreed(
    response: ServerResponse,
    agreed: Record<string, unknown>,
    headers: Record<string, string>,
  ): void {
    const choices = Array.isArray(agreed.choices) ? agreed.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(first.message) ? first.message : {};
    const text = typeof message.content === "string" ? message.content : "";
    const finish = typeof first.finish_reason === "string" ? first.finish_reason : "stop";
    const id = `chatcmpl-${String(agreed.id ?? "quorum").toString().slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: deployment.model.id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...baseHeaders(),
      ...headers,
      "x-rarext-mode": "stream",
      "x-rarext-stream": "quorum-agreed",
    });
    response.write(`data: ${chunk({ role: "assistant", content: text }, null)}\n\n`);
    response.write(`data: ${chunk({}, finish)}\n\n`);
    response.end("data: [DONE]\n\n");
  }

  /**
   * The Anthropic shape of the same idea: the agreed message is re-emitted as
   * message_start / content_block_delta / message_stop events. As with OpenAI,
   * comparison happened on complete responses; the stream is a view of the
   * attested answer, not a live provider connection.
   */
  function streamAnthropicAgreed(
    response: ServerResponse,
    agreed: Record<string, unknown>,
    headers: Record<string, string>,
  ): void {
    const content = Array.isArray(agreed.content) ? agreed.content : [];
    const parts = content.filter(isRecord);
    const text = parts
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    const id = typeof agreed.id === "string" ? agreed.id : `msg_${canonicalDigest(agreed).slice(0, 24)}`;
    const usage = isRecord(agreed.usage) ? agreed.usage : {};
    const outputTokens =
      typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : Math.max(1, Math.ceil(text.length / 4));
    const event = (name: string, data: unknown) =>
      `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...baseHeaders(),
      ...headers,
      "x-rarext-mode": "stream",
      "x-rarext-stream": "quorum-agreed",
    });
    response.write(
      event("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: deployment.model.id,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 },
        },
      }),
    );
    response.write(
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    response.write(
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    );
    response.write(event("content_block_stop", { type: "content_block_stop", index: 0 }));
    response.write(
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
    );
    response.end(event("message_stop", { type: "message_stop" }));
  }

  async function handleOpenAi(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("request body must be a JSON object");
      payload = parsed;
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid JSON" });
      return;
    }

    const model = resolveModel(payload);
    if (model === null) {
      sendJson(response, 400, {
        error: `this gateway attests ${deployment.model.id}; it will not serve ${String(payload.model)}`,
      });
      return;
    }
    payload.model = model;
    if (payload.stream !== undefined) payload.stream = payload.stream === true;

    if (upstreamApi !== "openai") {
      sendJson(response, 501, {
        error:
          "this deployment forwards to an Anthropic-compatible upstream; use /v1/messages. " +
          "OpenAI-shaped clients need an OpenAI-compatible engine.",
      });
      return;
    }

    if (quorumEnabled) {
      const startedAt = new Date().toISOString();
      const outcome = await gather("openai", payload);
      if ("error" in outcome) {
        sendJson(response, outcome.status, {
          error: outcome.error,
          ...(outcome.details === undefined ? {} : { evidence: outcome.details }),
        });
        return;
      }
      const result = await record(
        "openai",
        payload,
        outcome.response,
        usageFromOpenAi(outcome.response),
        startedAt,
        outcome.quorum,
      );
      const headers = {
        ...baseHeaders(),
        ...runHeaders(result),
        "x-rarext-quorum": `${outcome.quorum.agreed}/${outcome.quorum.required}`,
      };
      // Comparison already happened on complete responses. A caller that asked
      // to stream gets the agreed answer replayed as SSE, with the same run and
      // quorum evidence. It is never a pass-through of one provider's stream.
      if (payload.stream === true) {
        streamOpenAiAgreed(response, outcome.response, headers);
        return;
      }
      sendJson(response, 200, outcome.response, headers);
      return;
    }

    const startedAt = new Date().toISOString();
    let upstream: Response;
    try {
      upstream = await fetchImpl(openAiChatUrl(deployment.engine.endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...upstreamHeaders,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      sendJson(response, 502, {
        error: `upstream ${deployment.engine.name} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "application/json";
    if (!upstream.ok) {
      const text = await upstream.text();
      response.writeHead(upstream.status, { "content-type": contentType });
      response.end(text);
      return;
    }

    if (payload.stream === true && contentType.includes("text/event-stream")) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...baseHeaders(),
        "x-rarext-mode": "stream",
      });

      const chunks: Buffer[] = [];
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          const buffer = Buffer.from(chunk);
          chunks.push(buffer);
          if (!response.write(buffer)) {
            await new Promise<void>((resolve) => response.once("drain", resolve));
          }
        }
      }
      response.end();

      const data = Buffer.concat(chunks).toString("utf8");
      const result = await record(
        "openai",
        payload,
        { kind: "sse", data },
        null,
        startedAt,
      );
      log(
        `stream run ${result.record?.digest.slice(0, 12) ?? "unrecorded"} (${extractSseText(data).length} chars)` +
          (result.publicationId ? ` -> ${result.publicationId}` : ""),
      );
      return;
    }

    const json = (await upstream.json()) as unknown;
    const result = await record("openai", payload, json, usageFromOpenAi(json), startedAt);
    sendJson(response, 200, json, { ...baseHeaders(), ...runHeaders(result) });
  }

  async function handleAnthropic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("request body must be a JSON object");
      payload = parsed;
    } catch (error) {
      sendJson(response, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: error instanceof Error ? error.message : "invalid JSON" },
      });
      return;
    }

    // A non-quorum gateway has no way to attest a live Anthropic stream, so it
    // still refuses one. A quorum deployment compares complete responses first
    // and replays the agreed answer, which is attestable.
    if (payload.stream === true && !quorumEnabled) {
      sendJson(response, 400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "streaming Anthropic requests are not attested yet — send stream:false (OpenAI streaming is attested)",
        },
      });
      return;
    }

    const nativeAnthropic = upstreamApi === "anthropic";
    const upstreamBody = nativeAnthropic
      ? { ...payload, model: deployment.model.id, stream: false }
      : { ...translateAnthropicRequest(payload, deployment.model.id) };

    const model = resolveModel(upstreamBody);
    if (model === null) {
      sendJson(response, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: `this gateway attests ${deployment.model.id}` },
      });
      return;
    }
    upstreamBody.model = model;

    if (quorumEnabled) {
      const startedAt = new Date().toISOString();
      const outcome = await gather(nativeAnthropic ? "anthropic" : "openai", upstreamBody);
      if ("error" in outcome) {
        sendJson(response, outcome.status, {
          type: "error",
          error: { type: "api_error", message: outcome.error },
          ...(outcome.details === undefined ? {} : { evidence: outcome.details }),
        });
        return;
      }
      const result = nativeAnthropic
        ? await record(
            "anthropic",
            upstreamBody,
            outcome.response,
            usageFromAnthropic(outcome.response),
            startedAt,
            outcome.quorum,
          )
        : await record(
            "openai",
            upstreamBody,
            outcome.response,
            usageFromOpenAi(outcome.response),
            startedAt,
            outcome.quorum,
          );
      const anthropic = nativeAnthropic
        ? outcome.response
        : translateOpenAiResponse(outcome.response, deployment.model.id);
      const headers = {
        ...baseHeaders(),
        ...runHeaders(result),
        "x-rarext-quorum": `${outcome.quorum.agreed}/${outcome.quorum.required}`,
      };
      if (payload.stream === true) {
        streamAnthropicAgreed(response, anthropic, headers);
        return;
      }
      sendJson(response, 200, anthropic, headers);
      return;
    }

    const startedAt = new Date().toISOString();
    let upstream: Response;
    try {
      upstream = await fetchImpl(
        nativeAnthropic ? anthropicMessagesUrl(deployment.engine.endpoint) : openAiChatUrl(deployment.engine.endpoint),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...upstreamHeaders,
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      sendJson(response, 502, {
        type: "error",
        error: { type: "api_error", message: `upstream unreachable: ${error instanceof Error ? error.message : String(error)}` },
      });
      return;
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(response, upstream.status, {
        type: "error",
        error: { type: "api_error", message: text.slice(0, 1000) },
      });
      return;
    }

    const json = (await upstream.json()) as Record<string, unknown>;
    const result = nativeAnthropic
      ? await record("anthropic", upstreamBody, json, usageFromAnthropic(json), startedAt)
      : await record("openai", upstreamBody, json, usageFromOpenAi(json), startedAt);
    const anthropic = nativeAnthropic ? json : translateOpenAiResponse(json, deployment.model.id);
    sendJson(response, 200, anthropic, { ...baseHeaders(), ...runHeaders(result) });
  }

  function handleRuns(response: ServerResponse, limit: number): void {
    const records = ledger.records();
    const selected = records.slice(Math.max(0, records.length - limit)).reverse();
    sendJson(response, 200, {
      deployment: deployment.digest,
      head: ledger.head(),
      count: records.length,
      records: selected.map((record) => {
        const body = record.body;
        return {
          digest: record.digest,
          previous: body?.previous ?? null,
          model: body?.model?.id ?? null,
          requestDigest: body?.request?.digest ?? null,
          responseDigest: body?.response?.digest ?? null,
          bytes: body?.response?.bytes ?? null,
          completedAt: body?.completedAt ?? null,
          text: body?.response?.text ? body.response.text.slice(0, 280) : "",
        };
      }),
    });
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          ok: true,
          runtime: RUNTIME_VERSION,
          deployment: deployment.digest,
          placement: deployment.placement ?? "local",
          engine: deployment.engine,
          model: deployment.model,
          upstreams,
          quorum: { required: quorumRequired, enabled: quorumEnabled },
          bounty: inferenceBounty,
          upstreamApi,
          auth: { gateway: gatewayToken !== null, upstream: Object.keys(upstreamHeaders).length > 0 },
          ledger: { head: ledger.head(), runs: ledger.records().length },
          publishing: options.publisher ? { handle: options.publisher.handle } : null,
        });
        return;
      }

      // Inference and the run ledger are the private surfaces: a public cloud
      // gateway must not let a stranger read prompts or spend the operator's
      // upstream quota. Deployment discovery stays public, like a model card.
      const protectedPath =
        path === "/v1/chat/completions" ||
        path === "/v1/messages" ||
        path.startsWith("/v1/rarext/");
      if (protectedPath && !authorized(request)) {
        sendJson(
          response,
          401,
          { error: "missing or invalid bearer token" },
          { "www-authenticate": 'Bearer realm="rarext-runtime"' },
        );
        return;
      }

      if (request.method === "GET" && path === "/v1/deployment") {
        sendJson(response, 200, deployment, baseHeaders());
        return;
      }

      if (request.method === "GET" && path === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [
            {
              id: deployment.model.id,
              object: "model",
              created: Math.floor(Date.parse(deployment.createdAt) / 1000) || 0,
              owned_by: deployment.engine.name,
              rarext: { deployment: deployment.digest, quantization: deployment.model.quantization },
            },
          ],
        });
        return;
      }

      if (request.method === "GET" && path === "/v1/rarext/runs") {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
        handleRuns(response, limit);
        return;
      }

      if (request.method === "GET" && path === "/v1/rarext/ledger") {
        sendJson(response, 200, ledger.verify(), baseHeaders());
        return;
      }

      // The inference ledger, read from the runs. It is a view, not a book: a
      // reader recomputes the same records from the same transcripts. The root
      // is what a receipt is proved against; the per-operator view hands each
      // operator its own receipts with Merkle inclusion proofs.
      if (request.method === "GET" && path === "/v1/rarext/credits") {
        const records = allCreditRecords();
        const byOperator: Record<string, { credits: number; receipts: number }> = {};
        for (const record of records) {
          const entry = byOperator[record.keyId] ?? { credits: 0, receipts: 0 };
          entry.credits += record.bounty;
          entry.receipts += 1;
          byOperator[record.keyId] = entry;
        }
        sendJson(
          response,
          200,
          {
            action: "infer",
            bounty: inferenceBounty,
            ledgerRoot: creditLedgerRoot(records, sha256Hex),
            count: records.length,
            byOperator,
          },
          baseHeaders(),
        );
        return;
      }

      if (request.method === "GET" && path.startsWith("/v1/rarext/credits/")) {
        const keyId = decodeURIComponent(path.slice("/v1/rarext/credits/".length));
        const records = allCreditRecords();
        const ledgerRoot = creditLedgerRoot(records, sha256Hex);
        const mine = records.filter((record) => record.keyId === keyId);
        sendJson(
          response,
          200,
          {
            keyId,
            ledgerRoot,
            statement: creditStatement(keyId, records),
            receipts: mine.map((record) => {
              const inclusion = creditLedgerProof(records, record, sha256Hex);
              return {
                ...record,
                root: creditRoot(record, sha256Hex),
                ledger:
                  inclusion === null ? null : { root: ledgerRoot, index: inclusion.index, proof: inclusion.proof },
              };
            }),
          },
          baseHeaders(),
        );
        return;
      }

      if (request.method === "GET" && path.startsWith("/v1/rarext/runs/")) {
        const digest = path.slice("/v1/rarext/runs/".length);
        const record = ledger.records().find((entry) => entry.digest === digest);
        if (!record) {
          sendJson(response, 404, { error: "run not found" });
          return;
        }
        sendJson(response, 200, record);
        return;
      }

      if (request.method === "POST" && path === "/v1/chat/completions") {
        await handleOpenAi(request, response);
        return;
      }

      if (request.method === "POST" && path === "/v1/messages") {
        await handleAnthropic(request, response);
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 8790, options.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : (options.port ?? 8790);
  const bindHost = options.host ?? "127.0.0.1";
  const dialHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  const url = options.publicUrl ?? `http://${dialHost}:${port}`;

  return {
    server,
    port,
    url,
    ledger,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
