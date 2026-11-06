import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { RunLedger } from "./ledger.ts";
import {
  extractSseText,
  openAiChatUrl,
  samplingFromRequest,
  translateAnthropicRequest,
  translateOpenAiResponse,
  usageFromOpenAi,
} from "./engines.ts";
import { RuntimePublisher } from "./publisher.ts";
import { createRunBody, TranscriptTooLargeError } from "./transcript.ts";
import type { DeploymentCommitment, RunRecord } from "./types.ts";
import { MAX_REQUEST_BYTES, RUNTIME_VERSION } from "./types.ts";

export interface GatewayOptions {
  deployment: DeploymentCommitment;
  ledgerDir: string;
  publisher?: RuntimePublisher | null;
  host?: string;
  port?: number;
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

  const baseHeaders = (): Record<string, string> => ({
    "x-rarext-runtime": RUNTIME_VERSION,
    "x-rarext-deployment": deployment.digest,
    "x-rarext-model": deployment.model.id,
  });

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
  ): Promise<RecordedRun> {
    const completedAt = new Date().toISOString();
    const sampling = samplingFromRequest(payload);
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

    const startedAt = new Date().toISOString();
    let upstream: Response;
    try {
      upstream = await fetchImpl(openAiChatUrl(deployment.engine.endpoint), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
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

    if (payload.stream === true) {
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

    const translated = translateAnthropicRequest(payload, deployment.model.id);
    const model = resolveModel(translated);
    if (model === null) {
      sendJson(response, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: `this gateway attests ${deployment.model.id}` },
      });
      return;
    }
    translated.model = model;

    const startedAt = new Date().toISOString();
    let upstream: Response;
    try {
      upstream = await fetchImpl(openAiChatUrl(deployment.engine.endpoint), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(translated),
        signal: AbortSignal.timeout(timeoutMs),
      });
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
    const result = await record("openai", translated, json, usageFromOpenAi(json), startedAt);
    const anthropic = translateOpenAiResponse(json, deployment.model.id);
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
          engine: deployment.engine,
          model: deployment.model,
          ledger: { head: ledger.head(), runs: ledger.records().length },
          publishing: options.publisher ? { handle: options.publisher.handle } : null,
        });
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

  return {
    server,
    port,
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    ledger,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
