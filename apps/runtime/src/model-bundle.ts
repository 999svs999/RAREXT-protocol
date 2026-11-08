import { createHash } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/canonical.ts";
import { verifyPayload } from "../../../packages/agent-sdk/src/index.ts";
import type { SignatureSuite } from "../../../packages/core/src/types.ts";
import { canonicalDigest, sha256Hex } from "./digest.ts";
import type { ApiShape, EngineName, ModelRef } from "./types.ts";

/**
 * A model that lives on RAREXT.
 *
 * The weights are not a URL and not a vendor id: they are a list of
 * content-addressed blobs. Anyone who holds those blobs can rebuild the exact
 * model file and check it against the bytes the publisher committed. A provider
 * card names the bundle, the provider that serves it, and the endpoint; the
 * runtime refuses a card whose bundle does not hash to the model it claims.
 */
export const MODEL_BUNDLE_KIND = "rarext.model-bundle.v1";
export const MODEL_PROVIDER_KIND = "rarext.model-provider.v1";

/** The execution classes a provider can serve. */
export type ExecutionRef =
  | {
      /** Inference runs in the provider process from committed model bytes. */
      kind: "native";
      /** The committed model class (v1: the deterministic xorshift32 class). */
      modelClass: "xorshift32";
      /** Default token count when a request names none. */
      defaultSteps: number;
    }
  | {
      /** A serving engine on the provider's machine loads the fetched model. */
      kind: "engine";
      engine: EngineName;
      /** Engine-native name the provider creates from the fetched weights. */
      engineModel: string | null;
    };

export interface BundleShard {
  index: number;
  /** sha256 hex of this shard's bytes. */
  hash: string;
  size: number;
}

export interface ModelBundle {
  kind: typeof MODEL_BUNDLE_KIND;
  version: 1;
  id: string;
  model: ModelRef;
  execution: ExecutionRef;
  /** Every shard, in file order. */
  shards: BundleShard[];
  totalBytes: number;
  /** Commitment over the shard list (index, hash, size). */
  shardsRoot: string;
  createdAt: string;
  /** sha256 over the canonical bundle with this field absent. */
  digest: string;
}

export interface ProviderCard {
  kind: typeof MODEL_PROVIDER_KIND;
  version: 1;
  id: string;
  /** Where the provider answers, normalized without a trailing slash. */
  endpoint: string;
  bundle: {
    id: string;
    digest: string;
    shardsRoot: string;
    weightsDigest: string;
    shardCount: number;
    totalBytes: number;
    /** sha256 of the canonical bundle bytes, so a reader can fetch the manifest itself. */
    manifestHash: string;
  };
  model: ModelRef;
  execution: ExecutionRef;
  provider: {
    handle: string | null;
    keyId: string | null;
    publicKey?: unknown;
    suite?: string;
  };
  apis: ApiShape[];
  createdAt: string;
  /**
   * The provider's own signature over the card, when it has an identity. It
   * covers every field except `digest` and itself. A card without one is still
   * self-digested; a card with one proves the operator controls the key it
   * names, which is what makes the quorum's operator identities more than
   * labels.
   */
  signature?: string;
  /** sha256 over the canonical card with `digest` and `signature` absent. */
  digest: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** The commitment over the shard list. Order is part of the commitment. */
export function bundleShardsRoot(shards: BundleShard[]): string {
  return createHash("sha256")
    .update(
      canonicalize(
        shards.map((shard) => ({
          index: shard.index,
          hash: shard.hash,
          size: shard.size,
        })),
      ),
    )
    .digest("hex");
}

export function modelWeightsDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export function bundleDigest(bundle: Omit<ModelBundle, "digest"> | ModelBundle): string {
  const { digest: _digest, ...rest } = bundle as ModelBundle;
  return canonicalDigest(rest);
}

export function bundleManifestBytes(bundle: ModelBundle): Buffer {
  return Buffer.from(canonicalize(bundle), "utf8");
}

export function bundleManifestHash(bundle: ModelBundle): string {
  return sha256Hex(bundleManifestBytes(bundle));
}

export function chunkModelBytes(bytes: Uint8Array, chunkBytes = DEFAULT_CHUNK_BYTES): Buffer[] {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error("chunkBytes must be a positive integer");
  }
  if (bytes.length === 0) throw new Error("a model cannot be empty");

  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(Buffer.from(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length))));
  }
  return chunks;
}

export interface BuildBundleInput {
  bytes: Uint8Array;
  model: ModelRef;
  execution: ExecutionRef;
  id?: string;
  createdAt?: string;
  chunkBytes?: number;
}

/**
 * Split a model file into shards and commit it. The digest is computed from the
 * bytes here, never copied from the caller; a caller that supplies a different
 * `weightsDigest` or `sizeBytes` is refused rather than allowed to relabel the
 * model.
 */
export function buildModelBundle(input: BuildBundleInput): {
  bundle: ModelBundle;
  chunks: Buffer[];
} {
  if (input.bytes.length === 0) throw new Error("a model cannot be empty");

  const digest = modelWeightsDigest(input.bytes);
  if (input.model.sizeBytes !== null && input.model.sizeBytes !== input.bytes.length) {
    throw new Error(
      `model.sizeBytes is ${input.model.sizeBytes} but the file is ${input.bytes.length} bytes`,
    );
  }
  if (input.model.weightsDigest !== null && input.model.weightsDigest !== digest) {
    throw new Error(
      `model.weightsDigest ${input.model.weightsDigest} does not match the file digest ${digest}`,
    );
  }

  const chunks = chunkModelBytes(input.bytes, input.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const shards: BundleShard[] = chunks.map((chunk, index) => ({
    index,
    hash: sha256Hex(chunk),
    size: chunk.length,
  }));

  const id = input.id ?? input.model.id;
  const partial = {
    kind: MODEL_BUNDLE_KIND,
    version: 1,
    id,
    model: {
      ...input.model,
      sizeBytes: input.bytes.length,
      weightsDigest: digest,
    },
    execution: input.execution,
    shards,
    totalBytes: input.bytes.length,
    shardsRoot: bundleShardsRoot(shards),
    createdAt: input.createdAt ?? new Date().toISOString(),
  } satisfies Omit<ModelBundle, "digest">;

  return { bundle: { ...partial, digest: bundleDigest(partial) }, chunks };
}

const EXECUTION_KINDS = new Set(["native", "engine"]);
const ENGINE_NAMES = new Set<EngineName>([
  "ollama",
  "strata",
  "freetoken",
  "openai-compatible",
  "anthropic",
]);

export function executionProblems(execution: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(execution)) return ["execution must be an object"];
  if (typeof execution.kind !== "string" || !EXECUTION_KINDS.has(execution.kind)) {
    errors.push("execution.kind must be native or engine");
    return errors;
  }

  if (execution.kind === "native") {
    if (execution.modelClass !== "xorshift32") {
      errors.push('execution.modelClass must be "xorshift32"');
    }
    if (
      !Number.isSafeInteger(execution.defaultSteps) ||
      (execution.defaultSteps as number) < 1 ||
      (execution.defaultSteps as number) > 4096
    ) {
      errors.push("execution.defaultSteps must be an integer between 1 and 4096");
    }
  } else {
    if (typeof execution.engine !== "string" || !ENGINE_NAMES.has(execution.engine as EngineName)) {
      errors.push(`execution.engine must be one of ${[...ENGINE_NAMES].join(", ")}`);
    }
    if (execution.engineModel !== null && typeof execution.engineModel !== "string") {
      errors.push("execution.engineModel must be a string or null");
    }
  }
  return errors;
}

function modelProblems(model: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(model)) return ["model must be an object"];
  if (typeof model.id !== "string" || model.id.length === 0) errors.push("model.id must be a non-empty string");
  if (typeof model.weightsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(model.weightsDigest)) {
    errors.push("model.weightsDigest must be sha256:<64 hex>");
  }
  if (!Number.isSafeInteger(model.sizeBytes) || (model.sizeBytes as number) < 1) {
    errors.push("model.sizeBytes must be a positive integer");
  }
  return errors;
}

/** Validate a bundle read from a file, a registry, or a provider. */
export function verifyModelBundle(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["bundle must be an object"];
  if (value.kind !== MODEL_BUNDLE_KIND) errors.push(`bundle.kind must be "${MODEL_BUNDLE_KIND}"`);
  if (value.version !== 1) errors.push("bundle.version must be 1");
  if (typeof value.id !== "string" || value.id.length === 0) errors.push("bundle.id must be a non-empty string");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    errors.push("bundle.createdAt must be an ISO timestamp");
  }
  errors.push(...modelProblems(value.model));
  errors.push(...executionProblems(value.execution));

  if (!Array.isArray(value.shards) || value.shards.length === 0) {
    errors.push("bundle.shards must be a non-empty array");
  } else {
    let total = 0;
    value.shards.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`bundle.shards[${index}] must be an object`);
        return;
      }
      if (raw.index !== index) errors.push(`bundle.shards[${index}].index must be ${index}`);
      if (typeof raw.hash !== "string" || !HEX64.test(raw.hash)) {
        errors.push(`bundle.shards[${index}].hash must be a sha256 hex digest`);
      }
      if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 1) {
        errors.push(`bundle.shards[${index}].size must be a positive integer`);
      } else {
        total += raw.size as number;
      }
    });

    if (Number.isSafeInteger(value.totalBytes) && value.totalBytes !== total) {
      errors.push(`bundle.totalBytes is ${value.totalBytes} but the shards sum to ${total}`);
    }
    if (typeof value.shardsRoot === "string" && value.shardsRoot !== bundleShardsRoot(value.shards as BundleShard[])) {
      errors.push("bundle.shardsRoot does not match the shard list");
    }
  }

  if (typeof value.digest !== "string" || !HEX64.test(value.digest)) {
    errors.push("bundle.digest must be a sha256 hex digest");
  } else if (value.digest !== bundleDigest(value as unknown as ModelBundle)) {
    errors.push("bundle.digest does not match the canonical bundle");
  }

  return unique(errors);
}

/** Verify fetched shard bytes against the shard list and the whole-file digest. */
export function verifyBundleChunks(
  bundle: ModelBundle,
  chunks: Uint8Array[],
): { ok: boolean; errors: string[]; bytes: Buffer } {
  const errors: string[] = [];

  if (chunks.length !== bundle.shards.length) {
    errors.push(`expected ${bundle.shards.length} shards, got ${chunks.length}`);
  }

  for (let index = 0; index < Math.min(chunks.length, bundle.shards.length); index++) {
    const shard = bundle.shards[index]!;
    const chunk = chunks[index]!;
    if (chunk.length !== shard.size) {
      errors.push(`shard ${index} is ${chunk.length} bytes, expected ${shard.size}`);
    }
    const hash = sha256Hex(chunk);
    if (hash !== shard.hash) {
      errors.push(`shard ${index} hashes to ${hash}, expected ${shard.hash}`);
    }
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (bytes.length !== bundle.totalBytes) {
    errors.push(`reassembled ${bytes.length} bytes, expected ${bundle.totalBytes}`);
  }
  const digest = modelWeightsDigest(bytes);
  if (digest !== bundle.model.weightsDigest) {
    errors.push(`reassembled model hashes to ${digest}, expected ${bundle.model.weightsDigest}`);
  }

  return { ok: errors.length === 0, errors, bytes };
}

export function reassembleChunks(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

// ---------------------------------------------------------------------------
// Registry transport
// ---------------------------------------------------------------------------

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface UploadBundleInput {
  registry: string;
  bundle: ModelBundle;
  chunks: Uint8Array[];
  fetchImpl?: typeof fetch;
}

export interface UploadedBundle {
  manifestHash: string;
  shardHashes: string[];
}

/**
 * Store every shard and the bundle manifest itself as RAREXT blobs. The shard
 * hash is sent with the bytes, so the node checks the content address instead
 * of believing the uploader.
 */
export async function uploadBundle(input: UploadBundleInput): Promise<UploadedBundle> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = normalizeBase(input.registry);
  const shardHashes: string[] = [];

  for (let index = 0; index < input.chunks.length; index++) {
    const chunk = input.chunks[index]!;
    const shard = input.bundle.shards[index]!;
    const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-rarext-hash": shard.hash,
        "x-rarext-media-type": "application/octet-stream",
      },
      body: Buffer.from(chunk) as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(
        `registry refused shard ${index}: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const record = (await response.json()) as { hash?: unknown };
    if (record.hash !== shard.hash) {
      throw new Error(`registry stored shard ${index} as ${String(record.hash)}, expected ${shard.hash}`);
    }
    shardHashes.push(shard.hash);
  }

  const manifest = bundleManifestBytes(input.bundle);
  const manifestHash = sha256Hex(manifest);
  const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-rarext-hash": manifestHash,
      "x-rarext-media-type": "application/vnd.rarext.model-bundle+json",
    },
    body: manifest as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`registry refused the bundle manifest: HTTP ${response.status} ${await response.text()}`);
  }

  return { manifestHash, shardHashes };
}

export interface FetchBundleInput {
  registry: string;
  bundle: ModelBundle;
  fetchImpl?: typeof fetch;
  onShard?: (index: number, size: number) => void;
}

/**
 * Fetch every shard and verify the whole file before returning it.
 *
 * The file is written once into a buffer of the committed size and the digest
 * is folded in as each shard arrives. A large model is therefore held once, not
 * once as chunks and again as a concatenation.
 */
export async function fetchBundleChunks(input: FetchBundleInput): Promise<{
  bytes: Buffer;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = normalizeBase(input.registry);
  const bytes = Buffer.allocUnsafe(input.bundle.totalBytes);
  const whole = createHash("sha256");
  let offset = 0;

  for (const shard of input.bundle.shards) {
    const response = await fetchImpl(`${registry}/v1/blobs/${shard.hash}/raw`);
    if (!response.ok) {
      throw new Error(`shard ${shard.index} (${shard.hash}) is missing: HTTP ${response.status}`);
    }
    const chunk = Buffer.from(await response.arrayBuffer());
    if (chunk.length !== shard.size || sha256Hex(chunk) !== shard.hash) {
      throw new Error(
        `shard ${shard.index} does not match its commitment ` +
          `(${chunk.length} bytes, sha256 ${sha256Hex(chunk)})`,
      );
    }
    if (offset + chunk.length > bytes.length) {
      throw new Error(`shard ${shard.index} overruns the committed total of ${bytes.length} bytes`);
    }
    chunk.copy(bytes, offset);
    offset += chunk.length;
    whole.update(chunk);
    input.onShard?.(shard.index, chunk.length);
  }

  if (offset !== bytes.length) {
    throw new Error(`reassembled ${offset} bytes, expected ${bytes.length}`);
  }
  const digest = `sha256:${whole.digest("hex")}`;
  if (digest !== input.bundle.model.weightsDigest) {
    throw new Error(
      `reassembled model hashes to ${digest}, expected ${input.bundle.model.weightsDigest}`,
    );
  }

  return { bytes };
}

/** Fetch the bundle manifest by its content address and verify it. */
export async function fetchBundleManifest(input: {
  registry: string;
  manifestHash: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelBundle> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = normalizeBase(input.registry);
  const response = await fetchImpl(`${registry}/v1/blobs/${input.manifestHash}/raw`);
  if (!response.ok) {
    throw new Error(`bundle manifest ${input.manifestHash} is missing: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = sha256Hex(bytes);
  if (hash !== input.manifestHash) {
    throw new Error(`bundle manifest hashes to ${hash}, expected ${input.manifestHash}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("bundle manifest is not valid JSON");
  }
  const errors = verifyModelBundle(value);
  if (errors.length > 0) {
    throw new Error(`bundle manifest is invalid: ${errors.join("; ")}`);
  }
  return value as unknown as ModelBundle;
}

// ---------------------------------------------------------------------------
// Provider cards
// ---------------------------------------------------------------------------

export interface BuildProviderCardInput {
  bundle: ModelBundle;
  manifestHash: string;
  endpoint: string;
  provider?: ProviderCard["provider"];
  apis?: ApiShape[];
  id?: string;
  createdAt?: string;
  /** Sign every field except digest and signature; the key id must match. */
  sign?: (payload: Omit<ProviderCard, "digest" | "signature">) => string;
}

export function providerCardDigest(card: Omit<ProviderCard, "digest"> | ProviderCard): string {
  const { digest: _digest, signature: _signature, ...rest } = card as ProviderCard;
  return canonicalDigest(rest);
}

/** What a provider signs: every card field except the digest and signature. */
export function providerCardPayload(card: ProviderCard): Omit<ProviderCard, "digest" | "signature"> {
  const { digest: _digest, signature: _signature, ...rest } = card;
  return rest;
}

export function buildProviderCard(input: BuildProviderCardInput): ProviderCard {
  const partial = {
    kind: MODEL_PROVIDER_KIND,
    version: 1,
    id: input.id ?? `${input.bundle.id}-provider`,
    endpoint: normalizeBase(input.endpoint),
    bundle: {
      id: input.bundle.id,
      digest: input.bundle.digest,
      shardsRoot: input.bundle.shardsRoot,
      weightsDigest: input.bundle.model.weightsDigest!,
      shardCount: input.bundle.shards.length,
      totalBytes: input.bundle.totalBytes,
      manifestHash: input.manifestHash,
    },
    model: input.bundle.model,
    execution: input.bundle.execution,
    provider: input.provider ?? { handle: null, keyId: null },
    apis: input.apis ?? (["openai"] as ApiShape[]),
    createdAt: input.createdAt ?? new Date().toISOString(),
  } satisfies Omit<ProviderCard, "digest" | "signature">;

  const digest = providerCardDigest(partial);
  const signature = input.sign?.(partial);
  return signature === undefined
    ? { ...partial, digest }
    : { ...partial, digest, signature };
}

export function verifyProviderCard(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["provider card must be an object"];
  if (value.kind !== MODEL_PROVIDER_KIND) errors.push(`provider card kind must be "${MODEL_PROVIDER_KIND}"`);
  if (value.version !== 1) errors.push("provider card version must be 1");
  if (typeof value.id !== "string" || value.id.length === 0) errors.push("provider card id must be non-empty");
  if (typeof value.endpoint !== "string" || !/^https?:\/\//.test(value.endpoint)) {
    errors.push("provider card endpoint must be an http(s) URL");
  }

  const bundle = isRecord(value.bundle) ? value.bundle : null;
  if (bundle === null) {
    errors.push("provider card bundle must be an object");
  } else {
    if (typeof bundle.id !== "string" || bundle.id.length === 0) errors.push("bundle.id must be non-empty");
    if (typeof bundle.digest !== "string" || !HEX64.test(bundle.digest)) errors.push("bundle.digest must be sha256 hex");
    if (typeof bundle.shardsRoot !== "string" || !HEX64.test(bundle.shardsRoot)) {
      errors.push("bundle.shardsRoot must be sha256 hex");
    }
    if (typeof bundle.manifestHash !== "string" || !HEX64.test(bundle.manifestHash)) {
      errors.push("bundle.manifestHash must be sha256 hex");
    }
    if (typeof bundle.weightsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(bundle.weightsDigest)) {
      errors.push("bundle.weightsDigest must be sha256:<64 hex>");
    }
    if (!Number.isSafeInteger(bundle.shardCount) || (bundle.shardCount as number) < 1) {
      errors.push("bundle.shardCount must be a positive integer");
    }
    if (!Number.isSafeInteger(bundle.totalBytes) || (bundle.totalBytes as number) < 1) {
      errors.push("bundle.totalBytes must be a positive integer");
    }
  }

  errors.push(...modelProblems(value.model));
  errors.push(...executionProblems(value.execution));

  if (bundle !== null && isRecord(value.model)) {
    if (value.model.weightsDigest !== bundle.weightsDigest) {
      errors.push("model.weightsDigest does not match bundle.weightsDigest");
    }
  }

  if (!Array.isArray(value.apis) || value.apis.length === 0) {
    errors.push("provider card apis must be a non-empty array");
  } else if (!value.apis.every((api) => api === "openai" || api === "anthropic")) {
    errors.push("provider card apis entries must be openai or anthropic");
  }

  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    errors.push("provider card createdAt must be an ISO timestamp");
  }

  const provider = isRecord(value.provider) ? value.provider : null;
  if (provider === null) {
    errors.push("provider card provider must be an object");
  } else {
    if (provider.handle !== null && typeof provider.handle !== "string") {
      errors.push("provider card provider.handle must be a string or null");
    }
    if (provider.keyId !== null && typeof provider.keyId !== "string") {
      errors.push("provider card provider.keyId must be a string or null");
    }
    if (provider.publicKey !== undefined) {
      if (!isRecord(provider.publicKey)) {
        errors.push("provider card provider.publicKey must be a JWK object");
      }
      if (provider.suite !== "ecdsa-p256" && provider.suite !== "ml-dsa-44" && provider.suite !== "ml-dsa-65") {
        errors.push("provider card provider.suite must name a signature suite");
      }
      if (typeof provider.keyId !== "string" || provider.keyId.length === 0) {
        errors.push("a signed provider card must name its provider.keyId");
      }
      if (typeof value.signature !== "string") {
        errors.push("a provider card with a publicKey must carry a signature");
      } else if (isRecord(provider.publicKey)) {
        // The operator's own key covers the same bytes the digest covers, so a
        // card cannot be re-signed by a publisher claiming someone else's key.
        let verified = false;
        try {
          verified = verifyPayload(
            provider.publicKey as unknown as JsonWebKey,
            providerCardPayload(value as unknown as ProviderCard),
            value.signature,
            provider.suite as SignatureSuite,
          );
        } catch {
          verified = false;
        }
        if (!verified) errors.push("provider card signature does not verify");
      }
    } else if (value.signature !== undefined) {
      errors.push("provider card signature requires provider.publicKey");
    }
  }

  if (typeof value.digest !== "string" || !HEX64.test(value.digest)) {
    errors.push("provider card digest must be sha256 hex");
  } else if (value.digest !== providerCardDigest(value as unknown as ProviderCard)) {
    errors.push("provider card digest does not match the canonical card");
  }

  return unique(errors);
}

/** Fetch a provider card and verify its self-digest before reading any field. */
export async function fetchProviderCard(input: {
  endpoint: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProviderCard> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = normalizeBase(input.endpoint);
  const response = await fetchImpl(`${endpoint}/v1/provider-card`, {
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    throw new Error(`provider card at ${endpoint} returned HTTP ${response.status}`);
  }
  const value: unknown = await response.json();
  const errors = verifyProviderCard(value);
  if (errors.length > 0) {
    throw new Error(`provider card at ${endpoint} is invalid: ${errors.join("; ")}`);
  }
  return value as unknown as ProviderCard;
}

/**
 * Check the card against a bundle manifest fetched independently from the
 * registry. Without this the card's bundle fields are only self-consistent.
 */
export function crossCheckProviderCard(
  card: ProviderCard,
  bundle: ModelBundle,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (bundle.id !== card.bundle.id) {
    errors.push(`bundle id ${bundle.id} does not match the card (${card.bundle.id})`);
  }
  if (bundle.digest !== card.bundle.digest) {
    errors.push(`bundle digest ${bundle.digest} does not match the card (${card.bundle.digest})`);
  }
  if (bundle.shardsRoot !== card.bundle.shardsRoot) {
    errors.push("bundle shardsRoot does not match the card");
  }
  if (bundle.model.weightsDigest !== card.bundle.weightsDigest) {
    errors.push("bundle weightsDigest does not match the card");
  }
  if (bundle.shards.length !== card.bundle.shardCount) {
    errors.push("bundle shardCount does not match the card");
  }
  if (bundle.totalBytes !== card.bundle.totalBytes) {
    errors.push("bundle totalBytes does not match the card");
  }
  if (bundleManifestHash(bundle) !== card.bundle.manifestHash) {
    errors.push("bundle manifestHash does not match the card");
  }
  if (bundle.model.id !== card.model.id) {
    errors.push("bundle model id does not match the card");
  }
  if (canonicalize(bundle.execution) !== canonicalize(card.execution)) {
    errors.push("bundle execution class does not match the card");
  }

  return { ok: errors.length === 0, errors };
}
