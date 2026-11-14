/**
 * `rarext.cloud-model.v1` — a cloud AI declared by CAPABILITY, not by weights.
 *
 * RAREXT's future model is a service: it lives at an endpoint, it is operated by
 * someone, and what matters is what it can do (streaming, tools, structured
 * output, logprobs, modalities, context) — not the tensor layout, quantization,
 * or architecture behind it. This card is that contract, and it is deliberately
 * unable to carry the vocabulary of a local weight file.
 *
 * The point is to stop importing the assumptions of existing AI stacks: a model
 * here has no `format`, no `quantization`, no `architecture`, no
 * `weightsDigest`, and no `parameters`. If a caller passes one, the builder
 * refuses, because a RAREXT cloud model is not a file — it is a commitment by a
 * provider about behaviour. Anyone who *does* want to pin weights can still do
 * so with an opaque `attestation.digest`, which RAREXT never interprets.
 *
 * The card is content-addressed: `identity` is the digest of the claims, so a
 * reader can commit and compare a model's contract the same way it commits a
 * deployment or a run.
 */

import { canonicalize } from "../../../packages/core/src/canonical.ts";
import { sha256Hex } from "./digest.ts";
import type { DeploymentCommitment, EngineName } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const CLOUD_MODEL_KIND = "rarext.cloud-model.v1";

/** How a client or control plane talks to a cloud model. */
export type CloudProtocol =
  /** RAREXT's own architecture-free wire (`rarext.cloud-infer.v1`). */
  | "rarext-cloud"
  /** An OpenAI-compatible endpoint (a compatibility protocol, not the future). */
  | "openai"
  /** An Anthropic-compatible endpoint (a compatibility protocol). */
  | "anthropic";

/** A modality named by a model card. Free-form on purpose: the wire is text. */
export type Modality = string;

export interface CloudCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  parallel_tool_calls: boolean;
  /** Structured output (`response_format`: JSON object / JSON schema). */
  response_format: boolean;
  logprobs: boolean;
  embeddings: boolean;
  context_length: number | null;
  max_output_tokens: number | null;
  /** Modalities accepted on input. `["text"]` is the floor; never empty. */
  input_modalities: Modality[];
  /** Modalities a response may contain. */
  output_modalities: Modality[];
}

export interface CloudModelCard {
  kind: typeof CLOUD_MODEL_KIND;
  version: 1;
  /** The provider-scoped model id, exactly as the provider names it. */
  id: string;
  /** A handle for whoever operates it, e.g. `acme-cloud`. Never a secret. */
  provider: string;
  protocol: CloudProtocol;
  /** Where it lives. Host + path only; the key stays in the environment. */
  endpoint: string;
  capabilities: CloudCapabilities;
  /**
   * Who operates the service and any opaque commitment they make. RAREXT stores
   * these but never interprets them — `measurement` may name a TEE or a
   * published card, or be absent.
   */
  operator: { handle: string | null; measurement: string | null } | null;
  /**
   * An opaque, provider-chosen commitment (e.g. a digest of a published model
   * card). RAREXT does not derive or check it; it exists only so a provider CAN
   * pin something without RAREXT assuming a weight format.
   */
  attestation: { scheme: string; digest: string } | null;
  createdAt: string;
  /** `sha256(canonicalize(card without identity))`. */
  identity: string;
}

/** Fields that would describe a local weight file, which a cloud card cannot. */
const FORBIDDEN_FIELDS = [
  "architecture",
  "format",
  "quantization",
  "sizeBytes",
  "weightsDigest",
  "family",
  "parameters",
  "blockCount",
  "layers",
  "tensors",
  "tokenizer",
] as const;

export const DEFAULT_CLOUD_CAPABILITIES: CloudCapabilities = {
  chat: true,
  streaming: true,
  tools: false,
  parallel_tool_calls: false,
  response_format: false,
  logprobs: false,
  embeddings: false,
  context_length: null,
  max_output_tokens: null,
  input_modalities: ["text"],
  output_modalities: ["text"],
};

export interface BuildCloudModelInput {
  id: string;
  provider: string;
  protocol: CloudProtocol;
  endpoint: string;
  capabilities?: Partial<CloudCapabilities>;
  operator?: { handle?: string | null; measurement?: string | null } | null;
  attestation?: { scheme: string; digest: string } | null;
  createdAt?: string;
  /** Any extra field, to be rejected if it describes a local model. */
  [key: string]: unknown;
}

function normalizeEndpoint(value: string): string {
  let endpoint = value.trim();
  if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
  while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
  if (endpoint.endsWith("/v1")) endpoint = endpoint.slice(0, -3);
  return endpoint;
}

function normalizeCapabilities(input: Partial<CloudCapabilities> | undefined): CloudCapabilities {
  const merged: CloudCapabilities = { ...DEFAULT_CLOUD_CAPABILITIES, ...(input ?? {}) };
  // Modalities are never empty: a model that accepts nothing cannot be called.
  if (merged.input_modalities.length === 0) merged.input_modalities = ["text"];
  if (merged.output_modalities.length === 0) merged.output_modalities = ["text"];
  return merged;
}

/** Everything the identity covers: the card minus the identity itself. */
function identityFields(card: CloudModelCard): Record<string, unknown> {
  const { identity: _identity, ...rest } = card;
  return rest as unknown as Record<string, unknown>;
}

export function cloudModelDigest(card: Omit<CloudModelCard, "identity"> | CloudModelCard): string {
  return `sha256:${sha256Hex(canonicalize(identityFields(card as CloudModelCard)))}`;
}

/**
 * Build a card. Refuses — loudly — any field that describes a local weight file:
 * a RAREXT cloud model is declared by capability, and letting an architecture
 * leak in would reintroduce exactly the coupling this contract removes.
 */
export function buildCloudModelCard(input: BuildCloudModelInput): CloudModelCard {
  for (const field of FORBIDDEN_FIELDS) {
    if (input[field] !== undefined) {
      throw new Error(
        `a ${CLOUD_MODEL_KIND} is declared by capability, not by weights: ` +
          `remove "${field}" (RAREXT cloud models are not a file format)`,
      );
    }
  }
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new Error("a cloud model needs an id");
  }
  if (typeof input.provider !== "string" || input.provider.trim() === "") {
    throw new Error("a cloud model needs a provider handle");
  }
  if (input.protocol !== "rarext-cloud" && input.protocol !== "openai" && input.protocol !== "anthropic") {
    throw new Error(`unsupported cloud protocol ${JSON.stringify(input.protocol)}`);
  }
  if (typeof input.endpoint !== "string" || input.endpoint.trim() === "") {
    throw new Error("a cloud model needs an endpoint");
  }
  const partial: Omit<CloudModelCard, "identity"> = {
    kind: CLOUD_MODEL_KIND,
    version: 1,
    id: input.id,
    provider: input.provider,
    protocol: input.protocol,
    endpoint: normalizeEndpoint(input.endpoint),
    capabilities: normalizeCapabilities(input.capabilities),
    operator:
      input.operator === undefined || input.operator === null
        ? null
        : {
            handle: input.operator.handle ?? null,
            measurement: input.operator.measurement ?? null,
          },
    attestation: input.attestation ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return { ...partial, identity: cloudModelDigest(partial) };
}

/** The reasons a value is not a valid card. Empty means valid. */
export function validateCloudModelCard(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["a cloud model card must be an object"];
  for (const field of FORBIDDEN_FIELDS) {
    if (value[field] !== undefined) {
      errors.push(`cloud model cards cannot carry "${field}": declare capability, not weights`);
    }
  }
  if (value.kind !== CLOUD_MODEL_KIND) errors.push(`cloud model card kind must be ${CLOUD_MODEL_KIND}`);
  if (value.version !== 1) errors.push("cloud model card version must be 1");
  if (typeof value.id !== "string" || value.id === "") errors.push("cloud model card id must be a non-empty string");
  if (typeof value.provider !== "string" || value.provider === "") {
    errors.push("cloud model card provider must be a non-empty string");
  }
  if (value.protocol !== "rarext-cloud" && value.protocol !== "openai" && value.protocol !== "anthropic") {
    errors.push("cloud model card protocol must be rarext-cloud, openai or anthropic");
  }
  if (typeof value.endpoint !== "string" || value.endpoint === "") {
    errors.push("cloud model card endpoint must be a non-empty string");
  }
  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) {
    errors.push("cloud model card capabilities must be an object");
  } else {
    for (const flag of [
      "chat",
      "streaming",
      "tools",
      "parallel_tool_calls",
      "response_format",
      "logprobs",
      "embeddings",
    ]) {
      if (typeof capabilities[flag] !== "boolean") errors.push(`cloud model card capabilities.${flag} must be a boolean`);
    }
    for (const size of ["context_length", "max_output_tokens"]) {
      const raw = capabilities[size];
      if (raw !== null && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0)) {
        errors.push(`cloud model card capabilities.${size} must be null or a positive integer`);
      }
    }
    for (const list of ["input_modalities", "output_modalities"]) {
      const items = capabilities[list];
      if (!Array.isArray(items) || items.length === 0 || !items.every((item) => typeof item === "string" && item !== "")) {
        errors.push(`cloud model card capabilities.${list} must be a non-empty list of strings`);
      }
    }
    // A card cannot claim a capability a text-only protocol cannot deliver.
    if (capabilities.tools !== true && capabilities.parallel_tool_calls === true) {
      errors.push("a card cannot allow parallel_tool_calls without tools");
    }
  }
  if (value.operator !== null && value.operator !== undefined) {
    if (!isRecord(value.operator)) {
      errors.push("cloud model card operator must be null or an object");
    } else if (
      (value.operator.handle !== null && typeof value.operator.handle !== "string") ||
      (value.operator.measurement !== null && typeof value.operator.measurement !== "string")
    ) {
      errors.push("cloud model card operator.handle and operator.measurement must be strings or null");
    }
  }
  if (value.attestation !== null && value.attestation !== undefined) {
    if (!isRecord(value.attestation) || typeof value.attestation.scheme !== "string" || typeof value.attestation.digest !== "string") {
      errors.push("cloud model card attestation must be null or { scheme, digest }");
    }
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    errors.push("cloud model card createdAt must be an ISO date");
  }
  if (typeof value.identity !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.identity)) {
    errors.push("cloud model card identity must be a sha256 digest");
  } else if (value.identity !== cloudModelDigest(value as unknown as CloudModelCard)) {
    errors.push("cloud model card identity does not match its contents");
  }
  return errors;
}

/** The protocol a deployment uses, from its engine name or an explicit label. */
export function cloudProtocolFor(engine: EngineName, labels?: Record<string, string>): CloudProtocol {
  const labeled = labels?.upstreamProtocol;
  if (labeled === "rarext-cloud" || labeled === "openai" || labeled === "anthropic") return labeled;
  if (engine === "rarext-cloud") return "rarext-cloud";
  if (engine === "anthropic") return "anthropic";
  return "openai";
}

/**
 * Describe a committed deployment as a cloud model card. This is how an
 * existing signed manifest becomes a capability-declared model: the engine
 * endpoint, model id, and placement are reused, and the capabilities are what
 * this runtime is known to offer for that protocol.
 */
export function cloudModelFromDeployment(
  deployment: DeploymentCommitment,
  options: {
    protocol?: CloudProtocol;
    capabilities?: Partial<CloudCapabilities>;
    providerHandle?: string | null;
    measurement?: string | null;
    createdAt?: string;
  } = {},
): CloudModelCard {
  const protocol = options.protocol ?? cloudProtocolFor(deployment.engine.name, deployment.labels);
  const base: Partial<CloudCapabilities> =
    protocol === "rarext-cloud"
      ? {
          chat: true,
          streaming: true,
          tools: true,
          parallel_tool_calls: true,
          response_format: true,
          logprobs: true,
        }
      : {};
  return buildCloudModelCard({
    id: deployment.model.id,
    provider: options.providerHandle ?? deployment.hardware.device ?? "unknown",
    protocol,
    endpoint: deployment.engine.endpoint,
    capabilities: { ...base, ...(options.capabilities ?? {}), context_length: deployment.model.contextLength },
    operator: { handle: options.providerHandle ?? null, measurement: options.measurement ?? null },
    createdAt: options.createdAt ?? deployment.createdAt,
  });
}
