import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Worker } from "node:worker_threads";

import { canonicalize } from "../../../packages/core/src/canonical.ts";
import { canonicalDigest, sha256Hex } from "./digest.ts";
import { bundleShardsRoot } from "./model-bundle.ts";
import type { BundleShard, EngineArtifactRef } from "./model-bundle.ts";

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
 * What this does NOT do here: execute a raw ELF/Mach-O image. Doing that needs a
 * kernel/OS sandbox (a container runtime, seccomp/sandbox-exec, or a VM), which
 * this environment does not provide, so the provider refuses it rather than run
 * machine code unsandboxed. A foreign engine program runs on a sandboxed worker
 * thread, and a foreign binary runs as WebAssembly — both are portable artifacts,
 * so neither needs a host capability. The protocol shape — shard, commit, fetch,
 * verify, refuse-on-mismatch, bind into the run — is the same either way.
 *
 * RAREXT ships four runtimes in this repository:
 *   - `rarext.native-engine.node-cjs.v1` — the xorshift32 class.
 *   - `rarext.gguf-engine.node-cjs.v1` — RAREXT's own GGUF/RXHF transformer
 *     (`apps/runtime/engines/rarext-gguf-engine.js`), so a model needs no Ollama,
 *     no llama.cpp, and no container runtime on the provider.
 *   - `rarext.wasm-engine.wasm.v1` — a foreign engine shipped as WebAssembly,
 *     instantiated with an empty import object.
 *   - `rarext.worker-engine.node-cjs.v1` — a foreign engine program run on a
 *     worker thread inside `node:vm` with no `require`, `process`, or filesystem.
 *
 * All four are in `PORTABLE_ENGINE_RUNTIMES`: they run with nothing but the
 * provider process, which is what lets the AI live on the network.
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
/**
 * A third-party engine shipped as a WebAssembly module. It is instantiated inside
 * the provider process with an empty import object — no OS process, no syscall
 * surface, no container runtime — and driven through a tiny C-style ABI. This is
 * how a NON-RAREXT engine binary runs with nothing but the provider.
 */
export const ENGINE_ARTIFACT_RUNTIME_WASM = "rarext.wasm-engine.wasm.v1";
/**
 * A non-RAREXT NATIVE engine program shipped as a self-contained JS module and
 * executed on a dedicated WORKER THREAD inside a `node:vm` context that has no
 * `require`, no `process`, no filesystem and no network. This is the host path for
 * a native engine binary you can actually run without a container: a Node/JS
 * engine program (or a wasm/JS shim around one), isolated in its own thread.
 */
export const ENGINE_ARTIFACT_RUNTIME_WORKER = "rarext.worker-engine.node-cjs.v1";
export type EngineArtifactRuntime =
  | typeof ENGINE_ARTIFACT_RUNTIME
  | typeof ENGINE_ARTIFACT_RUNTIME_GGUF
  | typeof ENGINE_ARTIFACT_RUNTIME_WASM
  | typeof ENGINE_ARTIFACT_RUNTIME_WORKER;

/**
 * Every runtime RAREXT can carry is PORTABLE: a JS module run in a sandboxed vm,
 * a wasm module, or a native program run on a sandboxed worker. None requires a
 * host capability (container runtime, GPU, TEE), which is what lets the AI live
 * on the network rather than on a particular box. A runtime that needed the host
 * to launch an ELF/Mach-O image would not be in this set.
 */
export const PORTABLE_ENGINE_RUNTIMES: readonly EngineArtifactRuntime[] = [
  ENGINE_ARTIFACT_RUNTIME,
  ENGINE_ARTIFACT_RUNTIME_GGUF,
  ENGINE_ARTIFACT_RUNTIME_WASM,
  ENGINE_ARTIFACT_RUNTIME_WORKER,
] as const;

/** Whether a runtime can run with nothing but the provider process — no host
 *  container runtime, no accelerator, no hardware root of trust. */
export function isPortableEngineRuntime(runtime: string): boolean {
  return (PORTABLE_ENGINE_RUNTIMES as readonly string[]).includes(runtime);
}

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
  if (
    value.runtime !== ENGINE_ARTIFACT_RUNTIME &&
    value.runtime !== ENGINE_ARTIFACT_RUNTIME_GGUF &&
    value.runtime !== ENGINE_ARTIFACT_RUNTIME_WASM &&
    value.runtime !== ENGINE_ARTIFACT_RUNTIME_WORKER
  ) {
    errors.push(
      `engine bundle runtime must be "${ENGINE_ARTIFACT_RUNTIME}", "${ENGINE_ARTIFACT_RUNTIME_GGUF}", "${ENGINE_ARTIFACT_RUNTIME_WASM}" or "${ENGINE_ARTIFACT_RUNTIME_WORKER}"`,
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
    input: {
      prompt: string;
      steps: number;
      seed?: number | null;
      temperature?: number;
      /** Keep only the k most likely tokens before sampling (0 = no limit). */
      topK?: number;
      /** Nucleus mass to keep before sampling (1 = no limit). */
      topP?: number;
      /** Drop tokens below this fraction of the best token's probability (0 = off). */
      minP?: number;
      /** Locally-typical mass to keep (1 = off). */
      typicalP?: number;
      /** Additive per-token bias, as [tokenId, value] pairs. */
      logitBias?: Array<[number, number]>;
      /** Divide a repeated token's positive logit (1 = no penalty). */
      repetitionPenalty?: number;
      /** Subtract once per repeated token from its logit. */
      presencePenalty?: number;
      /** Subtract once per repetition of a token from its logit. */
      frequencyPenalty?: number;
      /** Sequences that end the run; the sequence itself is not returned. */
      stop?: string[];
      /** Report the model's own log-probability for every generated token. */
      logprobs?: boolean;
      /** How many alternatives to include per token (0-20). */
      topLogprobs?: number;
      /**
       * Fix the emitted token ids (a RAREXT extension for structured output).
       * Each pinned token still goes through a forward pass.
       */
      pinnedTokens?: number[];
      /** A compiled byte-level language: tokens that leave it are refused. */
      grammarDfa?: { accept: number[]; table: number[] };
      /**
       * Identity of the model bytes, so a worker runtime keeps the weights
       * resident instead of cloning them across the thread boundary per request.
       */
      modelKey?: string;
      /**
       * Observational per-token callback: called after a token is chosen for
       * this run. It cannot change the run — the tokens, logprobs and trace are
       * identical with or without it. Used to put bytes on the wire mid-decode.
       */
      onToken?: (at: number, tokenId: number, prefix: string) => void;
    },
  ): {
    text: string;
    seed: number;
    steps: number;
    tokens: number[];
    /** Why the run ended, when the engine reports it. */
    finishReason?: "stop" | "length";
    /** Per-token confidence, aligned with `tokens`, when requested. */
    logprobs?: Array<{
      token: number;
      logprob: number;
      top: Array<{ token: number; logprob: number }>;
    }>;
    /** The context bound the engine held the run to. */
    contextLength?: number;
    /** Prompt tokens actually evaluated after any context truncation. */
    promptTokens?: number;
    /** True when the prompt had to be shortened to fit the context. */
    promptTruncated?: boolean;
    /** The prompt token ids evaluated after truncation. */
    promptIds?: number[];
    /** True when the container was read on demand rather than held resident. */
    streaming?: boolean;
    /** Peak bytes the streaming loader held, when it streamed. */
    residentBytes?: number;
  };
  /** Tokenize text with the model's own tokenizer, for tests and verifiers. */
  encode?(model: unknown, text: string): number[];
  /** Decode token ids with the model's own tokenizer. */
  decode?(model: unknown, ids: number[]): string;
  /** The exact bytes a token contributes to the decoded output. */
  tokenBytes?(model: unknown, id: number): number[];
  /** Dequantize a run of rows in one parse, for verification and benchmarks. */
  dequantRows?(
    model: unknown,
    name: string,
    start?: number,
    count?: number,
  ): { values: Float32Array; rows: number; cols: number };
  /** Reads/bytes/peak-resident accounting for a streaming (or resident) model. */
  streamStats?(model: unknown): {
    streaming: boolean;
    reads: number;
    bytesRead: number;
    peakResidentBytes: number | null;
  };
  /**
   * The container's own chat template and special tokens, or null when it
   * declares none (the caller then falls back to an explicit prompt).
   */
  chatTemplate?(model: unknown): {
    template: string;
    bos: string | null;
    eos: string | null;
    addBos: boolean;
  } | null;
  /** Decode many single-token ids with one parse of the model. */
  decodeTokens?(model: unknown, ids: number[]): string[];
  /** The decoded prefix after each id, with one parse of the model. */
  decodePrefixes?(model: unknown, ids: number[]): string[];
  /**
   * A mean-pooled, L2-normalized embedding from the model's own token embedding
   * matrix. Deterministic: the same bytes and input give the same vector.
   */
  embed?(
    model: unknown,
    input: { text?: string; ids?: number[] },
  ): { embedding: number[]; dimensions: number; tokens: number };
  /** Present on the GGUF runtime: dequantize one committed row for inspection. */
  dequantTensor?(model: unknown, name: string, row?: number): Float32Array;
  /** Present on the GGUF runtime: parse a RAREXT "RXHF" container header. */
  parseContainer?(bytes: Uint8Array): {
    kv: Record<string, unknown>;
    dataStart: number;
    tensors: Record<
      string,
      { name: string; type: number; cols: number; rows: number; rowBytes: number; offset: number }
    >;
  };
  /** Present on the GGUF runtime: the parsed header/KV/tensor table. */
  parseGguf?(bytes: Uint8Array): {
    kv: Record<string, unknown>;
    dataStart: number;
    tensors: Record<
      string,
      { name: string; type: number; cols: number; rows: number; rowBytes: number; offset: number }
    >;
  };
  /** Present on the GGUF runtime: the rotary-position primitive, for tests. */
  rope?(
    vector: Float32Array,
    heads: number,
    headDim: number,
    nRot: number,
    position: number,
    base: number,
    neox: boolean,
    factors?: Float32Array | null,
    attn?: number,
    freqScale?: number,
  ): void;
  /** Present on the GGUF runtime: the LongRoPE set a run would use, for tests. */
  ropeFactors?(
    model: unknown,
    input: { prompt: string; steps: number },
  ): { set: "long" | "short"; values: number[] } | null;
  /** Present on the wasm runtime: the instantiated module's exports. */
  wasm?: WebAssembly.Exports;
  /**
   * Present on the native-lm runtime: the container's own declaration of what
   * it is (architecture, parameter count, context, lineage, training record).
   */
  describe?(model: unknown): {
    kind: string;
    label: string;
    architecture: string;
    family: string;
    parameters: number;
    contextLength: number;
    dim: number;
    hidden: number;
    vocab: number;
    quantization: string | null;
    format: string;
    lineage: Record<string, unknown>;
    training: Record<string, unknown>;
  };
  /** Present on the GGUF runtime: LayerNorm (Phi-2), for tests. */
  layerNorm?(
    out: Float32Array,
    x: Float32Array,
    weight: Float32Array,
    bias: Float32Array | undefined,
    eps: number,
  ): Float32Array;
}

/** A model handle for the GGUF runtime: the verified bytes, nothing else. */
export interface GgufModel {
  kind: "gguf";
  /** The whole container. Absent when the model streams through `readAt`. */
  bytes?: Uint8Array;
  /**
   * A bounded reader: `readAt(offset, length)` returns at most `length` bytes,
   * so the engine can serve a container larger than memory. `chunkBytes` and
   * `cacheChunks` bound the metadata cache.
   */
  readAt?: (offset: number, length: number) => Uint8Array;
  sizeBytes?: number;
  chunkBytes?: number;
  cacheChunks?: number;
}

/** A model handle for a RAREXT-native container ("RXHF") built from safetensors. */
export interface HfModel {
  kind: "hf";
  bytes: Uint8Array;
}

/**
 * Evaluate a fetched engine artifact into a runnable engine. The module runs in
 * a fresh `node:vm` context with no `require` and no filesystem, and must export
 * a `run(model, input)` function. A module that exposes no engine is refused.
 */
/**
 * Instantiate a third-party engine shipped as WebAssembly. The module runs
 * inside the provider process with an EMPTY import object: it cannot read the
 * filesystem, open sockets, or spawn anything — so no container runtime, no
 * VM, and no OS process is needed to execute a foreign engine binary.
 *
 * ABI the module must export:
 *   memory                     linear memory
 *   run(promptPtr, len, steps, seed) -> i32   pointer to a NUL-terminated UTF-8 result
 *   alloc(size) -> ptr         optional; required to receive the prompt/model bytes
 *   dealloc(ptr, size)         optional
 *   load(modelPtr, len) -> i32 optional; receives the committed model bytes
 */
export function loadWasmEngine(source: Uint8Array): NativeEngine {
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(new WebAssembly.Module(source as unknown as BufferSource), {});
  } catch (error) {
    throw new Error(
      `the wasm engine artifact failed to instantiate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const exported = instance.exports as Record<string, unknown>;
  if (!(exported.memory instanceof WebAssembly.Memory)) {
    throw new Error("the wasm engine artifact must export its linear memory");
  }
  const runFn = exported.run;
  if (typeof runFn !== "function") {
    throw new Error("the wasm engine artifact must export run(promptPtr, len, steps, seed)");
  }
  const memory = exported.memory;
  const alloc = typeof exported.alloc === "function" ? (exported.alloc as (size: number) => number) : null;
  const dealloc =
    typeof exported.dealloc === "function" ? (exported.dealloc as (ptr: number, size: number) => void) : null;
  const loadFn = typeof exported.load === "function" ? (exported.load as (ptr: number, len: number) => number) : null;
  const view = (): Uint8Array => new Uint8Array(memory.buffer);

  const place = (data: Uint8Array): { ptr: number; len: number } => {
    if (alloc === null || data.length === 0) return { ptr: 0, len: 0 };
    const ptr = alloc(data.length);
    view().set(data, ptr);
    return { ptr, len: data.length };
  };

  return {
    run(model, input) {
      const prompt = new TextEncoder().encode(String(input.prompt == null ? "" : input.prompt));
      const promptRef = place(prompt);
      if (loadFn !== null) {
        const modelBytes = (model as { bytes?: Uint8Array } | null)?.bytes;
        if (modelBytes instanceof Uint8Array) {
          const modelRef = place(modelBytes);
          if (modelRef.ptr !== 0) loadFn(modelRef.ptr, modelRef.len);
        }
      }
      const steps = Math.max(1, Math.min(Number(input.steps) || 16, 256));
      const seed = Number.isSafeInteger(input.seed) ? (input.seed as number) : 0;
      const outPtr = (runFn as (a: number, b: number, c: number, d: number) => number)(
        promptRef.ptr,
        promptRef.len,
        steps,
        seed,
      );
      let text = "";
      if (typeof outPtr === "number" && outPtr > 0) {
        const bytes = view();
        let end = outPtr;
        while (end < bytes.length && bytes[end] !== 0) end += 1;
        text = new TextDecoder().decode(bytes.subarray(outPtr, end));
      }
      if (dealloc !== null && promptRef.ptr !== 0) dealloc(promptRef.ptr, promptRef.len);
      return { text, seed, steps, tokens: [] };
    },
    wasm: instance.exports,
  };
}

/**
 * The bootstrap a native engine runs under: a dedicated worker thread whose only
 * job is to evaluate the engine module inside a `node:vm` context that has no
 * `require`, no `process`, no filesystem and no network — so a foreign native
 * engine program runs isolated, without a container.
 */
/** A host-provided dense matrix-vector kernel: `y = A·x`, row-major Float32. */
export type HostMatvec = (
  a: Float32Array,
  rows: number,
  cols: number,
  x: Float32Array,
  y: Float32Array,
) => void;

/**
 * An OPTIONAL accelerator for the engine's dense matvec.
 *
 * The engine artifact is pure JavaScript and must run on a bare provider: this
 * addon is a capability the *host* may offer, never a requirement. When it is
 * present the engine hands its already-dequantized Float32 matrices to the
 * platform BLAS (Accelerate on macOS), which uses the CPU's vector units
 * instead of one scalar multiply-add at a time. When it is absent — or fails to
 * load, or rejects a buffer — the engine takes the identical scalar path.
 *
 * Set `RAREXT_MATVEC_ADDON` to point at a different build; by default the
 * in-repo `native/matvec.node` is used when it exists.
 */
const NATIVE_MATVEC_PATH: string | null = (() => {
  if (typeof process === "undefined") return null;
  const configured = process.env.RAREXT_MATVEC_ADDON;
  if (configured !== undefined && configured !== "") return configured;
  try {
    const bundled = fileURLToPath(new URL("../../../native/matvec.node", import.meta.url));
    return existsSync(bundled) ? bundled : null;
  } catch {
    return null;
  }
})();

function loadHostMatvec(path: string | null): HostMatvec | null {
  if (path === null) return null;
  try {
    const addon = createRequire(import.meta.url)(path) as { matvec?: unknown };
    return typeof addon.matvec === "function" ? (addon.matvec as HostMatvec) : null;
  } catch {
    // A missing or unloadable addon is not an error: it is a host without the
    // accelerator, and the engine has its own portable path.
    return null;
  }
}

const HOST_MATVEC = loadHostMatvec(NATIVE_MATVEC_PATH);

/**
 * A provider's own cap on the engine's Float32 weight copies, in bytes. The
 * engine copies a matrix once and reuses it for every token, so the cache is a
 * speed/memory trade the host — which knows its own RAM — should size.
 */
const HOST_DENSE_BUDGET_BYTES: number | null = (() => {
  if (typeof process === "undefined") return null;
  const mb = Number(process.env.RAREXT_DENSE_BUDGET_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1000 * 1000) : null;
})();

/** The host knobs the sandboxed engine may read, when this host sets them. */
const HOST_ENGINE_GLOBALS: Record<string, unknown> = {
  ...(HOST_MATVEC === null ? {} : { hostMatvec: HOST_MATVEC }),
  ...(HOST_DENSE_BUDGET_BYTES === null ? {} : { hostDenseBudgetBytes: HOST_DENSE_BUDGET_BYTES }),
};

/**
 * The same knobs for a worker. A function cannot cross a thread boundary, so the
 * worker loads the addon itself from `addonPath` and only values are passed here.
 */
const WORKER_HOST_GLOBALS: Record<string, unknown> = {
  ...(HOST_DENSE_BUDGET_BYTES === null ? {} : { hostDenseBudgetBytes: HOST_DENSE_BUDGET_BYTES }),
};

/** The addon a worker should load for itself, or null when the host has none. */
export const HOST_MATVEC_ADDON_PATH: string | null =
  HOST_MATVEC === null ? null : NATIVE_MATVEC_PATH;

const WORKER_ENGINE_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const module = { exports: {} };
// The host accelerator, if this host has one. Loaded in the worker's own realm
// and injected into the sandbox; a failure just means the engine's own JS path.
let hostMatvec = null;
if (typeof workerData.addonPath === "string" && workerData.addonPath !== "") {
  try {
    const addon = require(workerData.addonPath);
    if (typeof addon.matvec === "function") hostMatvec = addon.matvec;
  } catch (addonError) {
    hostMatvec = null;
  }
}
const sandbox = {
  module,
  exports: module.exports,
  TextEncoder,
  TextDecoder,
  console,
  Math,
  JSON,
  ...(hostMatvec === null ? {} : { hostMatvec: hostMatvec }),
  ...(workerData.hostGlobals || {}),
};
vm.runInNewContext(workerData.code, sandbox, { timeout: 10000, filename: "rarext-engine.js" });
const run = module.exports.run;
if (typeof run !== "function") {
  parentPort.postMessage({ ok: false, error: "the engine artifact exports no run(model, input)" });
} else {
  // One worker holds the model across requests: a 400 MB weights buffer is
  // cloned once, not once per question. A new modelKey replaces it.
  let heldModel;
  let heldKey;
  parentPort.on("message", async (message) => {
    const id = message && message.id;
    try {
      if (message && message.model !== undefined) {
        heldModel = message.model;
        heldKey = message.modelKey;
      }
      const input = Object.assign({}, message && message.input);
      // A function cannot cross a thread boundary; the worker replaces it with
      // a port write, so the main thread can put each token on the wire while
      // this thread is still decoding. The token sequence is unaffected.
      if (input.streamTokens === true) {
        delete input.streamTokens;
        input.onToken = function (at, tokenId, prefix) {
          parentPort.postMessage({ id: id, type: "token", at: at, tokenId: tokenId, prefix: prefix });
        };
      }
      const result = await run(heldModel, input);
      parentPort.postMessage({ id: id, ok: true, result: result });
    } catch (error) {
      parentPort.postMessage({ id: id, ok: false, error: String((error && error.message) || error) });
    }
  });
  parentPort.postMessage({ ok: true, ready: true });
}
`;

/**
 * Run a non-RAREXT native (JS) engine on a worker thread, isolated in a vm.
 * `run` resolves asynchronously (the provider awaits the result), so it is cast
 * to the synchronous interface the other runtimes expose.
 *
 * The worker is kept alive between runs. That matters twice: the model is
 * cloned across the thread boundary only when its `modelKey` changes, and an
 * `onToken` callback in `input` turns the decode into a live stream — the main
 * thread stays free to write each token while the worker is still thinking.
 */
export function loadWorkerEngine(source: Uint8Array): NativeEngine {
  const code = new TextDecoder().decode(source);
  let worker: Worker | null = null;
  let booting: Promise<Worker> | null = null;
  let heldModelKey: string | null = null;
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();

  function reset(): void {
    worker = null;
    booting = null;
    heldModelKey = null;
  }

  function boot(): Promise<Worker> {
    if (worker !== null && booting !== null) return booting;
    const created = new Worker(WORKER_ENGINE_BOOTSTRAP, {
      eval: true,
      workerData: {
        code,
        addonPath: HOST_MATVEC_ADDON_PATH,
        hostGlobals: WORKER_HOST_GLOBALS,
      },
      // The model lives on this thread as an external ArrayBuffer; V8's old-gen
      // limit does not cover it, but leave headroom for the JS side of a run.
      resourceLimits: { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 64 },
    });
    worker = created;
    booting = new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown): void => {
        const reply = message as { ready?: boolean; ok?: boolean; error?: string };
        if (reply.ready === true) {
          created.off("message", onMessage);
          resolve();
        } else if (reply.ok === false) {
          created.off("message", onMessage);
          reject(new Error(reply.error ?? "the engine worker failed to load"));
        }
      };
      created.on("message", onMessage);
      created.once("error", (error) => {
        reset();
        reject(error);
      });
      created.once("exit", () => {
        reset();
        reject(new Error("the engine worker exited before it was ready"));
      });
    }).then(() => created);
    return booting;
  }

  return {
    run(
      model: unknown,
      input: { prompt: string; steps: number; seed?: number | null; temperature?: number },
    ) {
      const asRecord = input as unknown as Record<string, unknown>;
      const onToken =
        typeof asRecord.onToken === "function"
          ? (asRecord.onToken as (at: number, tokenId: number, prefix: string) => void)
          : undefined;
      const modelKey = typeof asRecord.modelKey === "string" ? asRecord.modelKey : undefined;
      const rest: Record<string, unknown> = { ...asRecord };
      delete rest.onToken;
      delete rest.modelKey;
      if (onToken !== undefined) rest.streamTokens = true;

      const job = async (): Promise<unknown> => {
        const target = await boot();
        const id = nextId;
        nextId += 1;
        const sendModel = modelKey === undefined || modelKey !== heldModelKey;
        if (sendModel && modelKey !== undefined) heldModelKey = modelKey;
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("the native engine worker timed out"));
          }, 600_000);
          const cleanup = (): void => {
            clearTimeout(timer);
            target.off("message", onMessage);
            target.off("error", onError);
            target.off("exit", onExit);
          };
          const onMessage = (message: unknown): void => {
            const reply = message as {
              id?: number;
              type?: string;
              at?: number;
              tokenId?: number;
              prefix?: string;
              ok?: boolean;
              error?: string;
              result?: unknown;
            };
            if (reply.id !== id) return;
            if (reply.type === "token") {
              if (onToken !== undefined && typeof reply.prefix === "string") {
                onToken(reply.at ?? 0, reply.tokenId ?? 0, reply.prefix);
              }
              return;
            }
            cleanup();
            if (reply.ok === true) resolve(reply.result);
            else reject(new Error(reply.error ?? "the native engine worker failed"));
          };
          const onError = (error: Error): void => {
            cleanup();
            reject(new Error(`the native engine worker failed: ${error.message}`));
          };
          const onExit = (): void => {
            cleanup();
            reject(new Error("the native engine worker exited before answering"));
          };
          target.on("message", onMessage);
          target.on("error", onError);
          target.on("exit", onExit);
          target.postMessage({
            id,
            ...(sendModel ? { model } : {}),
            ...(modelKey === undefined ? {} : { modelKey }),
            input: rest,
          });
        });
      };

      // One decode at a time per worker: the engine has a single model resident
      // and no shared mutable state to protect, and this keeps token events from
      // two runs interleaving on the port.
      const result = queue.then(job, job);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result as never;
    },
  } as unknown as NativeEngine;
}

export function loadEngine(
  source: Uint8Array,
  runtime: EngineArtifactRuntime = ENGINE_ARTIFACT_RUNTIME,
): NativeEngine {
  if (runtime === ENGINE_ARTIFACT_RUNTIME_WASM) return loadWasmEngine(source);
  if (runtime === ENGINE_ARTIFACT_RUNTIME_WORKER) return loadWorkerEngine(source);
  const module = { exports: {} as { run?: unknown } };
  const sandbox: Record<string, unknown> = {
    module,
    exports: module.exports,
    TextEncoder,
    TextDecoder,
    console,
    Math,
    JSON,
    ...HOST_ENGINE_GLOBALS,
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
    parseGguf?: unknown;
    parseContainer?: unknown;
    rope?: unknown;
    layerNorm?: unknown;
    ropeFactors?: unknown;
    encode?: unknown;
    decode?: unknown;
    tokenBytes?: unknown;
    dequantRows?: unknown;
    streamStats?: unknown;
    chatTemplate?: unknown;
    decodeTokens?: unknown;
    decodePrefixes?: unknown;
    embed?: unknown;
    describe?: unknown;
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
    ...(typeof exports.parseGguf === "function"
      ? { parseGguf: exports.parseGguf as NonNullable<NativeEngine["parseGguf"]> }
      : {}),
    ...(typeof exports.parseContainer === "function"
      ? { parseContainer: exports.parseContainer as NonNullable<NativeEngine["parseContainer"]> }
      : {}),
    ...(typeof exports.rope === "function"
      ? { rope: exports.rope as NonNullable<NativeEngine["rope"]> }
      : {}),
    ...(typeof exports.layerNorm === "function"
      ? { layerNorm: exports.layerNorm as NonNullable<NativeEngine["layerNorm"]> }
      : {}),
    ...(typeof exports.ropeFactors === "function"
      ? { ropeFactors: exports.ropeFactors as NonNullable<NativeEngine["ropeFactors"]> }
      : {}),
    ...(typeof exports.encode === "function"
      ? { encode: exports.encode as NonNullable<NativeEngine["encode"]> }
      : {}),
    ...(typeof exports.decode === "function"
      ? { decode: exports.decode as NonNullable<NativeEngine["decode"]> }
      : {}),
    ...(typeof exports.tokenBytes === "function"
      ? { tokenBytes: exports.tokenBytes as NonNullable<NativeEngine["tokenBytes"]> }
      : {}),
    ...(typeof exports.streamStats === "function"
      ? { streamStats: exports.streamStats as NonNullable<NativeEngine["streamStats"]> }
      : {}),
    ...(typeof exports.dequantRows === "function"
      ? { dequantRows: exports.dequantRows as NonNullable<NativeEngine["dequantRows"]> }
      : {}),
    ...(typeof exports.chatTemplate === "function"
      ? { chatTemplate: exports.chatTemplate as NonNullable<NativeEngine["chatTemplate"]> }
      : {}),
    ...(typeof exports.decodeTokens === "function"
      ? { decodeTokens: exports.decodeTokens as NonNullable<NativeEngine["decodeTokens"]> }
      : {}),
    ...(typeof exports.decodePrefixes === "function"
      ? { decodePrefixes: exports.decodePrefixes as NonNullable<NativeEngine["decodePrefixes"]> }
      : {}),
    ...(typeof exports.embed === "function"
      ? { embed: exports.embed as NonNullable<NativeEngine["embed"]> }
      : {}),
    ...(typeof exports.describe === "function"
      ? { describe: exports.describe as NonNullable<NativeEngine["describe"]> }
      : {}),
  };
}

/** A stable id for an engine bundle, for logging and pinning. */
export function engineBundleId(bundle: EngineBundle): string {
  return `${bundle.name}@${bundle.engineVersion}:${bundle.artifactDigest.slice(0, 18)}`;
}

/**
 * The reference a MODEL BUNDLE commits to name its engine: the artifact digest,
 * the runtime, and the manifest hash a provider can fetch. This is what makes the
 * engine part of the model identity instead of an out-of-band flag.
 */
export function engineArtifactRef(
  bundle: EngineBundle,
  manifestHash: string,
): EngineArtifactRef {
  return {
    id: engineBundleId(bundle),
    name: bundle.name,
    engineVersion: bundle.engineVersion,
    runtime: bundle.runtime,
    artifactDigest: bundle.artifactDigest,
    manifestHash,
  };
}

/** Problems between a fetched engine bundle and the reference a model committed. */
export function engineBundleMatchesRef(bundle: EngineBundle, ref: EngineArtifactRef): string[] {
  const errors: string[] = [];
  if (bundle.name !== ref.name) errors.push(`engine name ${bundle.name} != committed ${ref.name}`);
  if (bundle.engineVersion !== ref.engineVersion) {
    errors.push(`engine version ${bundle.engineVersion} != committed ${ref.engineVersion}`);
  }
  if (bundle.runtime !== ref.runtime) errors.push(`engine runtime ${bundle.runtime} != committed ${ref.runtime}`);
  if (bundle.artifactDigest !== ref.artifactDigest) {
    errors.push(`engine artifact ${bundle.artifactDigest} != committed ${ref.artifactDigest}`);
  }
  return errors;
}

/**
 * Fetch an engine-bundle manifest by the hash a model bundle committed, verify
 * the blob hashes to that manifest, and verify the bundle is well formed. This
 * lets a provider serve a bundle with no `--engine-bundle` flag: the engine is
 * wherever the model says it is, and a substituted manifest or artifact is
 * refused rather than silently run.
 */
export async function fetchEngineBundleManifest(input: {
  registries: readonly string[];
  manifestHash: string;
  fetchImpl?: typeof fetch;
}): Promise<EngineBundle> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const attempts: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(input.manifestHash)) {
    throw new Error("engine manifestHash must be a sha256 hex digest");
  }
  for (const base of input.registries) {
    const registry = base.replace(/\/+$/, "");
    try {
      const response = await fetchImpl(`${registry}/v1/blobs/${input.manifestHash}/raw`);
      if (!response.ok) {
        attempts.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const manifest = Buffer.from(await response.arrayBuffer());
      if (sha256Hex(manifest) !== input.manifestHash) {
        attempts.push(`${base}: manifest bytes do not hash to the committed hash`);
        continue;
      }
      const parsed = JSON.parse(manifest.toString("utf8")) as unknown;
      const problems = verifyEngineBundle(parsed);
      if (problems.length > 0) {
        attempts.push(`${base}: invalid engine bundle (${problems.join("; ")})`);
        continue;
      }
      return parsed as EngineBundle;
    } catch (error) {
      attempts.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `the committed engine bundle ${input.manifestHash} is missing or invalid at every registry: ` +
      attempts.join("; "),
  );
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
