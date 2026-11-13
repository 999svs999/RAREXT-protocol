import { createHash } from "node:crypto";
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
  };
  /** Tokenize text with the model's own tokenizer, for tests and verifiers. */
  encode?(model: unknown, text: string): number[];
  /** Decode token ids with the model's own tokenizer. */
  decode?(model: unknown, ids: number[]): string;
  /** Decode many single-token ids with one parse of the model. */
  decodeTokens?(model: unknown, ids: number[]): string[];
  /** The decoded prefix after each id, with one parse of the model. */
  decodePrefixes?(model: unknown, ids: number[]): string[];
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
  bytes: Uint8Array;
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
const WORKER_ENGINE_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const module = { exports: {} };
const sandbox = { module, exports: module.exports, TextEncoder, TextDecoder, console, Math, JSON };
vm.runInNewContext(workerData.code, sandbox, { timeout: 10000, filename: "rarext-native-engine.js" });
const run = module.exports.run;
if (typeof run !== "function") {
  parentPort.postMessage({ ok: false, error: "the engine artifact exports no run(model, input)" });
} else {
  parentPort.on("message", async (message) => {
    try {
      parentPort.postMessage({ ok: true, result: await run(message.model, message.input) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
    }
  });
  parentPort.postMessage({ ok: true, ready: true });
}
`;

/**
 * Run a non-RAREXT native (JS) engine on a worker thread, isolated in a vm.
 * `run` resolves asynchronously (the provider awaits the result), so it is cast
 * to the synchronous interface the other runtimes expose.
 */
export function loadWorkerEngine(source: Uint8Array): NativeEngine {
  const code = new TextDecoder().decode(source);
  return {
    run(
      model: unknown,
      input: { prompt: string; steps: number; seed?: number | null; temperature?: number },
    ) {
      return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_ENGINE_BOOTSTRAP, {
          eval: true,
          workerData: { code },
          resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
        });
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate();
          fn();
        };
        const timer = setTimeout(
          () => finish(() => reject(new Error("the native engine worker timed out"))),
          600_000,
        );
        worker.on("error", (error) =>
          finish(() => reject(new Error(`the native engine worker failed: ${error.message}`))),
        );
        worker.on("exit", () =>
          finish(() => reject(new Error("the native engine worker exited before answering"))),
        );
        worker.on("message", (message: unknown) => {
          const reply = message as { ok?: boolean; ready?: boolean; error?: string; result?: unknown };
          if (reply.ready === true) {
            worker.postMessage({ model, input });
            return;
          }
          if (reply.ok === true) {
            finish(() =>
              resolve(reply.result as { text: string; seed: number; steps: number; tokens: number[] }),
            );
          } else {
            finish(() => reject(new Error(reply.error ?? "the native engine worker failed")));
          }
        });
      });
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
    decodeTokens?: unknown;
    decodePrefixes?: unknown;
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
    ...(typeof exports.decodeTokens === "function"
      ? { decodeTokens: exports.decodeTokens as NonNullable<NativeEngine["decodeTokens"]> }
      : {}),
    ...(typeof exports.decodePrefixes === "function"
      ? { decodePrefixes: exports.decodePrefixes as NonNullable<NativeEngine["decodePrefixes"]> }
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
