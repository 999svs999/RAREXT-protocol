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
  Placement,
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

/**
 * Hardware for a deployment whose weights and inference live behind a remote
 * endpoint. The local host's memory is deliberately not recorded: it has no
 * bearing on a model the operator cannot execute here, and recording it would
 * imply a fit check this process never performed.
 */
export function hardwareFromCloud(endpoint: string): HardwareRef {
  let device: string;
  try {
    device = new URL(endpoint).host;
  } catch {
    device = endpoint;
  }

  return {
    backend: "cloud",
    device,
    memoryBytes: null,
    os: "remote",
    arch: "remote",
  };
}

/**
 * Hardware for a provider on the RAREXT network. It is neither this host nor a
 * cloud vendor: the provider is a participant whose card commits the model
 * bundle it fetched from RAREXT storage. This process records no memory
 * because it cannot see the provider's machine.
 */
export function hardwareFromNetwork(endpoint: string): HardwareRef {
  let device: string;
  try {
    device = new URL(endpoint).host;
  } catch {
    device = endpoint;
  }

  return {
    backend: "network",
    device,
    memoryBytes: null,
    os: "network",
    arch: "network",
  };
}

/** True when the endpoint names this machine (or an unspecified interface). */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(normalizeEndpoint(endpoint)).hostname.toLowerCase();
  } catch {
    return false;
  }

  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127\./.test(host)
  );
}

export type MemoryFit = "fits" | "tight" | "too-large" | "unknown";

export interface ModelFit {
  verdict: MemoryFit;
  /** The engine's reported weight size, or null when it reports none. */
  modelBytes: number | null;
  /** Host memory visible to the runtime. */
  memoryBytes: number | null;
  /** Bytes left after the model and the reserve, or null when unknown. */
  headroomBytes: number | null;
  note: string;
}

const GIB = 1024 ** 3;

/**
 * Does the engine's reported weight size fit in this host's memory?
 *
 * This is deliberately a claim about host memory, not VRAM: a discrete GPU may
 * hold a second copy, and an engine such as Strata can stream weights from disk
 * when they do not fit. The verdict is therefore advisory, and `unknown` is a
 * real answer when either side of the comparison is missing.
 */
export function assessModelFit(
  model: ModelRef,
  hardware: HardwareRef,
  options: { reserveBytes?: number } = {},
): ModelFit {
  const modelBytes = model.sizeBytes;
  const memoryBytes = hardware.memoryBytes;

  if (modelBytes === null || memoryBytes === null) {
    return {
      verdict: "unknown",
      modelBytes,
      memoryBytes,
      headroomBytes: null,
      note: "the engine or the host did not report a size, so no fit is claimed",
    };
  }

  const reserve = options.reserveBytes ?? Math.max(GIB, Math.floor(memoryBytes * 0.15));
  const headroom = memoryBytes - modelBytes - reserve;

  if (modelBytes > memoryBytes) {
    return {
      verdict: "too-large",
      modelBytes,
      memoryBytes,
      headroomBytes: headroom,
      note: "weights exceed host memory; the engine must stream from disk or offload",
    };
  }

  if (headroom < 0) {
    return {
      verdict: "tight",
      modelBytes,
      memoryBytes,
      headroomBytes: headroom,
      note: `weights fit, but not with a ${formatBytes(reserve)} reserve for the context and runtime`,
    };
  }

  return {
    verdict: "fits",
    modelBytes,
    memoryBytes,
    headroomBytes: headroom,
    note: `weights leave ${formatBytes(headroom)} after a ${formatBytes(reserve)} reserve`,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const signed = bytes < 0 ? -value : value;
  return `${signed.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function buildDeployment(input: {
  probe: EngineProbe;
  hardware?: HardwareRef;
  placement?: Placement;
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
    ...(input.placement === undefined ? {} : { placement: input.placement }),
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
  "anthropic",
]);
const API_SHAPES = new Set<ApiShape>(["openai", "anthropic"]);
const BACKENDS = new Set<HardwareBackend>([
  "cpu",
  "metal",
  "cuda",
  "rocm",
  "vulkan",
  "cloud",
  "network",
  "unknown",
]);
const PLACEMENTS = new Set<Placement>(["local", "remote", "web4"]);

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
  if (value.placement !== undefined && (typeof value.placement !== "string" || !PLACEMENTS.has(value.placement as Placement))) {
    errors.push(`manifest.placement must be one of ${[...PLACEMENTS].join(", ")} when present`);
  }
  if (value.placement === "remote") {
    if (!isRecord(hardware) || hardware.backend !== "cloud") {
      errors.push('manifest.hardware.backend must be "cloud" for a remote deployment');
    }
    if (isRecord(hardware) && hardware.memoryBytes !== null) {
      errors.push("manifest.hardware.memoryBytes must be null for a remote deployment");
    }
  }

  if (value.placement === "web4") {
    if (!isRecord(hardware) || hardware.backend !== "network") {
      errors.push('manifest.hardware.backend must be "network" for a web4 deployment');
    }
    if (isRecord(hardware) && hardware.memoryBytes !== null) {
      errors.push("manifest.hardware.memoryBytes must be null for a web4 deployment");
    }

    const labels = isRecord(value.labels) ? value.labels : {};
    if (labels.execution !== "web4") {
      errors.push('manifest.labels.execution must be "web4" for a web4 deployment');
    }
    if (typeof labels.bundle !== "string" || !/^[0-9a-f]{64}$/.test(labels.bundle)) {
      errors.push("manifest.labels.bundle must be the 64-hex model bundle digest");
    }
    if (typeof labels.shardsRoot !== "string" || !/^[0-9a-f]{64}$/.test(labels.shardsRoot)) {
      errors.push("manifest.labels.shardsRoot must be the 64-hex shard commitment");
    }
    if (typeof labels.manifestHash !== "string" || !/^[0-9a-f]{64}$/.test(labels.manifestHash)) {
      errors.push("manifest.labels.manifestHash must be the 64-hex bundle manifest address");
    }
    // The whole point of the placement is that the weights are committed bytes.
    // A null digest would make every run omit its bundle reference and leave the
    // challenge with nothing to check the model against.
    if (
      !isRecord(model) ||
      typeof model.weightsDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(model.weightsDigest)
    ) {
      errors.push("manifest.model.weightsDigest must be sha256:<64 hex> for a web4 deployment");
    }
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
