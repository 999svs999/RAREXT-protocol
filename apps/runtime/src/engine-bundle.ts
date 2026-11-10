import { createHash } from "node:crypto";
import vm from "node:vm";

import { canonicalize } from "../../../packages/core/src/canonical.ts";
import { canonicalDigest, sha256Hex } from "./digest.ts";
import { bundleShardsRoot } from "./model-bundle.ts";
import type { BundleShard } from "./model-bundle.ts";

/**
 * The ENGINE as a RAREXT artifact.
 *
 * The model weights are RAREXT blobs, but the process that turns tokens — the
 * engine — is usually whatever the provider's box already has. That leaves the
 * engine outside the network: a deployment can pin its name/version/digest, but
 * the bytes are not RAREXT's. An engine bundle closes that: the engine artifact
 * is sharded into RAREXT like the weights, under one committed digest, and a
 * provider fetches and verifies it BEFORE it will serve. A tampered shard, a
 * missing artifact, or a module that does not expose the engine interface is
 * refused, so the engine the provider runs is the engine RAREXT committed.
 *
 * What this does NOT do here: execute an arbitrary downloaded native binary in a
 * sandbox. The reference artifact is a JavaScript engine module evaluated in a
 * `node:vm` context (no `require`, no filesystem); a container runtime would let
 * the same shape carry an engine IMAGE and run only the verified bytes. The
 * protocol shape — shard, commit, fetch, verify, refuse-on-mismatch, bind into
 * the run — is the same either way.
 *
 * RAREXT ships two runtimes in this repository:
 *   - `rarext.native-engine.node-cjs.v1` — the xorshift32 class.
 *   - `rarext.gguf-engine.node-cjs.v1` — RAREXT's own GGUF transformer
 *     (`apps/runtime/engines/rarext-gguf-engine.js`), so a GGUF model needs no
 *     Ollama, no llama.cpp, and no container runtime on the provider.
 */

export const ENGINE_BUNDLE_KIND = "rarext.engine-bundle.v1";
/**
 * How the artifact is executed. `node-cjs` is a CommonJS module that assigns
 * `module.exports.run = (model, input) => ({ text, seed, steps, tokens })`.
 *
 * The native runtime runs the committed model in RAREXT's xorshift32 class. The
 * GGUF runtime runs RAREXT's OWN GGUF engine: the artifact parses the GGUF,
 * dequantizes the committed weights, and performs the transformer itself. No
 * Ollama, llama.cpp, native addon, or container runtime is involved.
 */
export const ENGINE_ARTIFACT_RUNTIME = "rarext.native-engine.node-cjs.v1";
export const ENGINE_ARTIFACT_RUNTIME_GGUF = "rarext.gguf-engine.node-cjs.v1";
export type EngineArtifactRuntime =
  | typeof ENGINE_ARTIFACT_RUNTIME
  | typeof ENGINE_ARTIFACT_RUNTIME_GGUF;

export interface EngineBundle {
  kind: typeof ENGINE_BUNDLE_KIND;
  version: 1;
  id: string;
  /** The engine's family name, e.g. "rarext-xorshift". */
  name: string;
  /** The engine's own version string. */
  engineVersion: string;
  /** How the artifact is executed. */
  runtime: EngineArtifactRuntime;
  shards: BundleShard[];
  /** Sum of the shard bytes: the artifact size. */
  totalBytes: number;
  /** Commitment over the shard list. */
  shardsRoot: string;
  /** `sha256:<hex>` of the reassembled artifact. */
  artifactDigest: string;
  createdAt: string;
  /** sha256 over the canonical bundle with this field absent. */
  digest: string;
}

const DEFAULT_CHUNK_BYTES = 1 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function engineBundleDigest(partial: Omit<EngineBundle, "digest">): string {
  return canonicalDigest(partial);
}

function chunkBytes(bytes: Uint8Array, chunkBytes: number): Buffer[] {
  if (chunkBytes <= 0) throw new Error("chunkBytes must be positive");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(Buffer.from(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length))));
  }
  return chunks.length === 0 ? [Buffer.alloc(0)] : chunks;
}

export function buildEngineBundle(input: {
  source: Uint8Array;
  name: string;
  engineVersion: string;
  runtime?: EngineArtifactRuntime;
  id?: string;
  chunkBytes?: number;
  createdAt?: string;
}): { bundle: EngineBundle; chunks: Buffer[] } {
  if (input.source.length === 0) throw new Error("an engine artifact cannot be empty");
  const chunks = chunkBytes(input.source, input.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const shards: BundleShard[] = chunks.map((chunk, index) => ({
    index,
    hash: sha256Hex(chunk),
    size: chunk.length,
  }));
  const partial = {
    kind: ENGINE_BUNDLE_KIND,
    version: 1 as const,
    id: input.id ?? `${input.name}-${input.engineVersion}`,
    name: input.name,
    engineVersion: input.engineVersion,
    runtime: input.runtime ?? ENGINE_ARTIFACT_RUNTIME,
    shards,
    totalBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
    shardsRoot: bundleShardsRoot(shards),
    artifactDigest: `sha256:${createHash("sha256").update(Buffer.from(input.source)).digest("hex")}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
  } satisfies Omit<EngineBundle, "digest">;
  return { bundle: { ...partial, digest: engineBundleDigest(partial) }, chunks };
}

/** Human-readable problems with an engine bundle. Empty means it is well formed. */
export function verifyEngineBundle(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["engine bundle must be an object"];
  if (value.kind !== ENGINE_BUNDLE_KIND) errors.push(`engine bundle kind must be "${ENGINE_BUNDLE_KIND}"`);
  if (typeof value.id !== "string" || value.id.length === 0) errors.push("engine bundle id must be non-empty");
  if (typeof value.name !== "string" || value.name.length === 0) errors.push("engine bundle name must be non-empty");
  if (typeof value.engineVersion !== "string") errors.push("engine bundle engineVersion must be a string");
  if (value.runtime !== ENGINE_ARTIFACT_RUNTIME && value.runtime !== ENGINE_ARTIFACT_RUNTIME_GGUF) {
    errors.push(
      `engine bundle runtime must be "${ENGINE_ARTIFACT_RUNTIME}" or "${ENGINE_ARTIFACT_RUNTIME_GGUF}"`,
    );
  }
  if (typeof value.artifactDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.artifactDigest)) {
    errors.push("engine bundle artifactDigest must be sha256:<hex>");
  }
  if (!Array.isArray(value.shards) || value.shards.length === 0) {
    errors.push("engine bundle must have at least one shard");
    return errors;
  }
  let total = 0;
  for (const raw of value.shards) {
    if (!isRecord(raw)) {
      errors.push("engine bundle shards must be objects");
      continue;
    }
    if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0) errors.push("shard index must be a non-negative integer");
    if (typeof raw.hash !== "string" || !/^[0-9a-f]{64}$/.test(raw.hash)) errors.push("shard hash must be a sha256 hex digest");
    if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 0) errors.push("shard size must be a non-negative integer");
    else total += raw.size as number;
  }
  if (total !== value.totalBytes) errors.push("engine bundle totalBytes must equal the sum of shard sizes");
  const shards = value.shards as BundleShard[];
  if (value.shardsRoot !== bundleShardsRoot(shards)) errors.push("engine bundle shardsRoot does not commit the shard list");
  const { digest, ...covered } = value as Record<string, unknown>;
  if (typeof digest !== "string" || digest !== canonicalDigest(covered)) {
    errors.push("engine bundle digest does not recompute");
  }
  return errors;
}

async function fetchEngineShard(
  registries: readonly string[],
  shard: BundleShard,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const attempts: string[] = [];
  for (const base of registries) {
    try {
      const response = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/blobs/${shard.hash}/raw`);
      if (!response.ok) {
        attempts.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const chunk = Buffer.from(await response.arrayBuffer());
      if (chunk.length !== shard.size || sha256Hex(chunk) !== shard.hash) {
        attempts.push(`${base}: bytes do not match the commitment`);
        continue;
      }
      return chunk;
    } catch (error) {
      attempts.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `engine shard ${shard.index} (${shard.hash}) failed verification or is missing from every registry: ` +
      attempts.join("; "),
  );
}

/**
 * Fetch and verify every engine shard, returning the reassembled artifact bytes.
 * The whole-artifact digest is recomputed and must equal `artifactDigest`, so a
 * shard that is individually valid but belongs to another engine is refused too.
 */
export async function fetchEngineArtifact(input: {
  registries: readonly string[];
  bundle: EngineBundle;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const problems = verifyEngineBundle(input.bundle);
  if (problems.length > 0) throw new Error(`invalid engine bundle: ${problems.join("; ")}`);
  const fetchImpl = input.fetchImpl ?? fetch;
  const bytes = Buffer.allocUnsafe(input.bundle.totalBytes);
  let offset = 0;
  for (const shard of input.bundle.shards) {
    const chunk = await fetchEngineShard(input.registries, shard, fetchImpl);
    if (offset + chunk.length > input.bundle.totalBytes) {
      throw new Error(`engine shard ${shard.index} overruns the committed total`);
    }
    chunk.copy(bytes, offset);
    offset += chunk.length;
  }
  if (offset !== input.bundle.totalBytes) throw new Error("engine artifact is shorter than committed");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== input.bundle.artifactDigest) {
    throw new Error(`engine artifact digest ${digest} does not match the committed ${input.bundle.artifactDigest}`);
  }
  return bytes;
}

/** The interface an engine artifact must expose. `model` is whatever the
 *  runtime class carries: the xorshift32 model, or `{ kind: "gguf", bytes }`. */
export interface NativeEngine {
  run(
    model: unknown,
    input: { prompt: string; steps: number; seed?: number | null; temperature?: number },
  ): { text: string; seed: number; steps: number; tokens: number[] };
  /** Present on the GGUF runtime: dequantize one committed row for inspection. */
  dequantTensor?(model: unknown, name: string, row?: number): Float32Array;
}

/** A model handle for the GGUF runtime: the verified bytes, nothing else. */
export interface GgufModel {
  kind: "gguf";
  bytes: Uint8Array;
}

/**
 * Evaluate a fetched engine artifact into a runnable engine. The module runs in
 * a fresh `node:vm` context with no `require` and no filesystem, and must export
 * a `run(model, input)` function. A module that exposes no engine is refused.
 */
export function loadEngine(source: Uint8Array): NativeEngine {
  const module = { exports: {} as { run?: unknown } };
  const sandbox: Record<string, unknown> = {
    module,
    exports: module.exports,
    TextEncoder,
    TextDecoder,
    console,
    Math,
    JSON,
  };
  try {
    const code = new TextDecoder().decode(source);
    vm.runInNewContext(code, sandbox, { timeout: 10_000, filename: "rarext-engine.js" });
  } catch (error) {
    throw new Error(`the engine artifact failed to load: ${error instanceof Error ? error.message : String(error)}`);
  }
  const exports = module.exports as {
    run?: unknown;
    dequantTensor?: unknown;
  };
  const run = exports.run;
  if (typeof run !== "function") {
    throw new Error("the engine artifact exports no run(model, input) function");
  }
  return {
    run: run as NativeEngine["run"],
    ...(typeof exports.dequantTensor === "function"
      ? { dequantTensor: exports.dequantTensor as NonNullable<NativeEngine["dequantTensor"]> }
      : {}),
  };
}

/** A stable id for an engine bundle, for logging and pinning. */
export function engineBundleId(bundle: EngineBundle): string {
  return `${bundle.name}@${bundle.engineVersion}:${bundle.artifactDigest.slice(0, 18)}`;
}

/**
 * Store every engine shard and the bundle manifest itself as RAREXT blobs. The
 * shard hash is sent with the bytes, so the node checks the content address
 * rather than believing the uploader.
 */
export async function uploadEngineBundle(input: {
  registry: string;
  bundle: EngineBundle;
  chunks: Uint8Array[];
  fetchImpl?: typeof fetch;
}): Promise<{ manifestHash: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = input.registry.replace(/\/+$/, "");
  for (let index = 0; index < input.chunks.length; index += 1) {
    const shard = input.bundle.shards[index]!;
    const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-rarext-hash": shard.hash,
        "x-rarext-media-type": "application/octet-stream",
      },
      body: Buffer.from(input.chunks[index]!) as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`registry refused engine shard ${index}: HTTP ${response.status} ${await response.text()}`);
    }
    const record = (await response.json()) as { hash?: unknown };
    if (record.hash !== shard.hash) {
      throw new Error(`registry stored engine shard ${index} as ${String(record.hash)}, expected ${shard.hash}`);
    }
  }
  const manifest = Buffer.from(canonicalize(input.bundle));
  const manifestHash = sha256Hex(manifest);
  const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-rarext-hash": manifestHash,
      "x-rarext-media-type": "application/vnd.rarext.engine-bundle+json",
    },
    body: manifest as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`registry refused the engine bundle manifest: HTTP ${response.status} ${await response.text()}`);
  }
  return { manifestHash };
}
