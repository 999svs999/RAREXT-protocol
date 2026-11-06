import type { ApiShape, EngineName } from "./types.ts";

/**
 * How the runtime authenticates to the remote engine. The token is never
 * written into the manifest or the transcript: the manifest is published, and a
 * transcript is published opt-in. A published deployment names the endpoint and
 * the model; the operator keeps the key in the environment.
 */
export type UpstreamAuth = "none" | "bearer" | "x-api-key";

export const DEFAULT_UPSTREAM_KEY_ENV = "RAREXT_UPSTREAM_API_KEY";
export const DEFAULT_GATEWAY_TOKEN_ENV = "RAREXT_GATEWAY_TOKEN";
/** Anthropic requires a dated protocol header on every request. */
export const ANTHROPIC_VERSION = "2023-06-01";

export function defaultUpstreamApi(engine: EngineName): ApiShape {
  return engine === "anthropic" ? "anthropic" : "openai";
}

export function defaultUpstreamAuth(api: ApiShape): UpstreamAuth {
  return api === "anthropic" ? "x-api-key" : "bearer";
}

export function parseUpstreamAuth(value: string | undefined, fallback: UpstreamAuth): UpstreamAuth {
  if (value === undefined || value === "") return fallback;
  if (value === "none" || value === "bearer" || value === "x-api-key") return value;
  throw new Error(`--upstream-auth must be one of none, bearer, x-api-key (got "${value}")`);
}

export interface UpstreamShape {
  api: ApiShape;
  auth: UpstreamAuth;
}

/**
 * The upstream shape a remote deployment commits in its labels, so `serve`
 * forwards the same way `deploy` probed without repeating the flags. Only the
 * auth *mode* is recorded; the key itself stays in the environment.
 */
export function upstreamShapeFromLabels(
  labels: Record<string, string> | undefined,
  engine: EngineName,
): UpstreamShape {
  const api: ApiShape =
    labels?.upstreamApi === "anthropic" || labels?.upstreamApi === "openai"
      ? labels.upstreamApi
      : defaultUpstreamApi(engine);
  const auth: UpstreamAuth =
    labels?.upstreamAuth === "none" ||
    labels?.upstreamAuth === "bearer" ||
    labels?.upstreamAuth === "x-api-key"
      ? labels.upstreamAuth
      : defaultUpstreamAuth(api);
  return { api, auth };
}

export function resolveSecret(envName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[envName];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Headers for a request to the remote engine. `api: "anthropic"` always carries
 * the protocol version, because the provider rejects a request without it;
 * auth headers are added only when a token is configured, so a public or
 * private-network endpoint still works without inventing a credential.
 */
export function upstreamHeaders(input: {
  api: ApiShape;
  auth: UpstreamAuth;
  token: string | null;
  extra?: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = { ...(input.extra ?? {}) };

  if (input.api === "anthropic") headers["anthropic-version"] = ANTHROPIC_VERSION;
  if (input.token !== null) {
    if (input.auth === "bearer") headers.authorization = `Bearer ${input.token}`;
    if (input.auth === "x-api-key") headers["x-api-key"] = input.token;
  }

  return headers;
}

/** A secret is never a manifest field; this is what a reader may safely see. */
export interface CloudUpstream {
  api: ApiShape;
  auth: UpstreamAuth;
  keyEnv: string | null;
  tokenPresent: boolean;
}

export function describeUpstream(input: {
  api: ApiShape;
  auth: UpstreamAuth;
  keyEnv: string;
  token: string | null;
}): CloudUpstream {
  return {
    api: input.api,
    auth: input.auth,
    keyEnv: input.auth === "none" ? null : input.keyEnv,
    tokenPresent: input.token !== null,
  };
}
