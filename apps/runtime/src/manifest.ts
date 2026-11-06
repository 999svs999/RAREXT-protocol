import os from "node:os";

import { canonicalDigest } from "./digest.ts";
import type {
  ApiShape,
  DeploymentCommitment,
  DeploymentManifest,
  EngineName,
  EngineProbe,
  HardwareBackend,
  HardwareRef,
  ModelRef,
} from "./types.ts";
import { DEPLOYMENT_KIND } from "./types.ts";

export function normalizeEndpoint(value: string): string {
  let endpoint = value.trim();

  if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = `http://${endpoint}`;
  }

  while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
  // Operators paste the OpenAI base as often as the root. Keep one spelling.
  if (endpoint.endsWith("/v1")) endpoint = endpoint.slice(0, -3);

  return endpoint;
}

export function openAiBase(endpoint: string): string {
  return `${normalizeEndpoint(endpoint)}/v1`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "model";
}

export function deploymentDigest(manifest: DeploymentManifest): string {
  return canonicalDigest(manifest);
}

export function commitDeployment(manifest: DeploymentManifest): DeploymentCommitment {
  return { ...manifest, digest: deploymentDigest(manifest) };
}

export function hardwareFromHost(
  backend: HardwareBackend = "unknown",
  device: string | null = null,
): HardwareRef {
  return {
    backend,
    device,
    memoryBytes: os.totalmem(),
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
  };
}

export function buildDeployment(input: {
  probe: EngineProbe;
  hardware?: HardwareRef;
  apis?: ApiShape[];
  id?: string;
  labels?: Record<string, string>;
  notes?: string;
  createdAt?: string;
}): DeploymentManifest {
  return {
    kind: DEPLOYMENT_KIND,
    id: input.id ?? `${slugify(input.probe.model.id)}-${input.probe.engine.name}`,
    engine: input.probe.engine,
    model: input.probe.model,
    hardware: input.hardware ?? hardwareFromHost(),
    apis: input.apis ?? input.probe.apis,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

const ENGINE_NAMES = new Set<EngineName>([
  "ollama",
  "strata",
  "freetoken",
  "openai-compatible",
]);
const API_SHAPES = new Set<ApiShape>(["openai", "anthropic"]);
const BACKENDS = new Set<HardwareBackend>([
  "cpu",
  "metal",
  "cuda",
  "rocm",
  "vulkan",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, field: string, errors: string[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string or null`);
    return null;
  }
  return value;
}

function nullableNumber(value: unknown, field: string, errors: string[]): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${field} must be a finite number or null`);
    return null;
  }
  return value;
}

/** Validate a manifest read from a file or an engine. Returns human-readable errors. */
export function validateDeployment(value: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(value)) return ["manifest must be an object"];
  if (value.kind !== DEPLOYMENT_KIND) {
    errors.push(`manifest.kind must be "${DEPLOYMENT_KIND}"`);
  }
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 96) {
    errors.push("manifest.id must be a non-empty string of at most 96 characters");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    errors.push("manifest.createdAt must be an ISO timestamp");
  }

  const engine = value.engine;
  if (!isRecord(engine)) {
    errors.push("manifest.engine must be an object");
  } else {
    if (typeof engine.name !== "string" || !ENGINE_NAMES.has(engine.name as EngineName)) {
      errors.push(`manifest.engine.name must be one of ${[...ENGINE_NAMES].join(", ")}`);
    }
    if (typeof engine.endpoint !== "string" || !/^https?:\/\//.test(engine.endpoint)) {
      errors.push("manifest.engine.endpoint must be an http(s) URL");
    }
    nullableString(engine.version, "manifest.engine.version", errors);
  }

  const model = value.model;
  if (!isRecord(model)) {
    errors.push("manifest.model must be an object");
  } else {
    if (typeof model.id !== "string" || model.id.length === 0 || model.id.length > 256) {
      errors.push("manifest.model.id must be a non-empty string of at most 256 characters");
    }
    nullableString(model.family, "manifest.model.family", errors);
    nullableString(model.parameters, "manifest.model.parameters", errors);
    nullableString(model.quantization, "manifest.model.quantization", errors);
    nullableString(model.format, "manifest.model.format", errors);
    nullableString(model.weightsDigest, "manifest.model.weightsDigest", errors);
    nullableNumber(model.sizeBytes, "manifest.model.sizeBytes", errors);
    nullableNumber(model.contextLength, "manifest.model.contextLength", errors);
  }

  const hardware = value.hardware;
  if (!isRecord(hardware)) {
    errors.push("manifest.hardware must be an object");
  } else {
    if (typeof hardware.backend !== "string" || !BACKENDS.has(hardware.backend as HardwareBackend)) {
      errors.push(`manifest.hardware.backend must be one of ${[...BACKENDS].join(", ")}`);
    }
    nullableString(hardware.device, "manifest.hardware.device", errors);
    nullableNumber(hardware.memoryBytes, "manifest.hardware.memoryBytes", errors);
    if (typeof hardware.os !== "string") errors.push("manifest.hardware.os must be a string");
    if (typeof hardware.arch !== "string") errors.push("manifest.hardware.arch must be a string");
  }

  if (!Array.isArray(value.apis) || value.apis.length === 0) {
    errors.push("manifest.apis must be a non-empty array");
  } else {
    for (const api of value.apis) {
      if (typeof api !== "string" || !API_SHAPES.has(api as ApiShape)) {
        errors.push(`manifest.apis entries must be one of ${[...API_SHAPES].join(", ")}`);
      }
    }
  }

  if (value.labels !== undefined) {
    if (!isRecord(value.labels)) {
      errors.push("manifest.labels must be an object of strings");
    } else {
      for (const [key, label] of Object.entries(value.labels)) {
        if (typeof label !== "string") errors.push(`manifest.labels.${key} must be a string`);
      }
    }
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    errors.push("manifest.notes must be a string");
  }

  return errors;
}

/**
 * A deployment is only usable when the model id is named and the endpoint
 * answers. This throws with every error at once rather than the first.
 */
export function requireValidDeployment(value: unknown): DeploymentManifest {
  const errors = validateDeployment(value);
  if (errors.length > 0) {
    throw new Error(`invalid deployment manifest:\n  - ${errors.join("\n  - ")}`);
  }
  return value as DeploymentManifest;
}

export function cloneModel(model: ModelRef): ModelRef {
  return { ...model };
}
