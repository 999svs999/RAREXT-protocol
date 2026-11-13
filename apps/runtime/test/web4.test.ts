import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildContainer,
  convertHfDirectory,
  hparamsSection,
  parseSentencePieceModel,
  quantizeTensor,
  tokenizeSection,
} from "../../../scripts/convert-hf-safetensors.mjs";

import {
  creditLeaf,
  creditLedgerRoot,
  inferenceCreditRecords,
  verifyProof,
} from "../../../packages/core/src/index.ts";
import type { CreditRecordFields } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  generateAgentKeypair,
  publicKeyId,
} from "../../../packages/agent-sdk/src/index.ts";
import { createApp } from "../../api/src/app.ts";
import { createVerifierRegistry } from "../../api/src/verifiers.ts";
import { PlacementRegistry } from "../../api/src/placements.ts";
import { BlobStore } from "../../api/src/storage.ts";
import { RarextStore } from "../../api/src/store.ts";
import { RunLedger } from "../src/ledger.ts";
import { comparableCompletion } from "../src/completion.ts";
import { challengeFor, challengesFile, RuntimePublisher } from "../src/publisher.ts";
import { startGateway } from "../src/gateway.ts";
import { discoverBundle, fetchAnchoredBundles, fetchVerifiedProvidersAcrossRegistries, verifiedProviders } from "../src/discovery.ts";
import {
  bundleManifestHash,
  buildModelBundle,
  buildProviderCard,
  crossCheckProviderCard,
  fetchBundleChunks,
  fetchBundleCiphertext,
  fetchBundleManifest,
  fetchProviderCard,
  generateSealKey,
  unwrapSealKey,
  issueProviderCertificate,
  providerBootStages,
  providerCardDigest,
  providerChainDepth,
  providerStageMeasurements,
  sealKeyCommitment,
  verifyProviderChain,
  verifyProviderQuote,
  uploadBundle,
  verifyModelBundle,
  verifyProviderCard,
  verifyBundleChunks,
} from "../src/model-bundle.ts";
import type { ExecutionRef, ModelBundle } from "../src/model-bundle.ts";
import {
  buildDeployment,
  commitDeployment,
  hardwareFromNetwork,
  validateDeployment,
} from "../src/manifest.ts";
import { chatPromptFromTemplate, renderChatTemplate } from "../src/chat-template.ts";
import {
  jsonObjectDfa,
  schemaDfa,
  dfaAccepts,
  dfaLivePrefix,
  responseFormatDfa,
} from "../src/grammar.ts";
import {
  startProvider,
  traceFor,
  applyStop,
  decodingParams,
  parseTools,
  parseToolChoice,
  extractToolCalls,
  jsonObjects,
} from "../src/provider.ts";
import { replayEngineRun } from "../src/replay.ts";
import {
  attestationBindsEnclaveKey,
  enclaveKeyDigest,
  openResponse,
  sealRequest,
} from "../src/confidential.ts";
import {
  HARDWARE_ROOT_KEY_ID,
  hardwareRootSigner,
  issueHardwareChain,
  issueMeasuredBootChain,
} from "../src/hardware-root.ts";
import {
  ROOT_CHAIN_KIND,
  issueRootRotation,
  verifyProviderRootChain,
  verifyRootChain,
} from "../src/root-chain.ts";
import { runtimeCodeMeasurement } from "../src/code-measurement.ts";
import { attestationForReceipt } from "../src/certificates.ts";
import { engineDescriptorFingerprint } from "../src/engine-pin.ts";
import {
  ENGINE_ARTIFACT_RUNTIME,
  ENGINE_ARTIFACT_RUNTIME_GGUF,
  ENGINE_ARTIFACT_RUNTIME_WASM,
  ENGINE_ARTIFACT_RUNTIME_WORKER,
  buildEngineBundle,
  isPortableEngineRuntime,
  loadWorkerEngine,
  engineArtifactRef,
  fetchEngineArtifact,
  loadEngine,
  uploadEngineBundle,
  verifyEngineBundle,
} from "../src/engine-bundle.ts";
import { canonicalDigest } from "../src/digest.ts";
import { signImageManifest, verifyImageManifest } from "../src/image-manifest.ts";
import { validDecodeTrace, verifyDeploymentBody, verifyRunBody } from "../src/transcript.ts";
import { decodeTraceOf, tracesMatch } from "../src/determinism.ts";
import { createVerifierServer, runSpecFromChallenge, verifierConfig } from "../src/verifier.ts";
import type { EngineProbe, ModelRef, RunProviderAttestation } from "../src/types.ts";

const NATIVE_MODEL = {
  kind: "xorshift32" as const,
  params: { a: 13, b: 17, c: 5 },
  vocab: ["red", "green", "blue", "amber", "violet", "teal", "rose", "slate"],
};

const NATIVE_BYTES = Buffer.from(JSON.stringify(NATIVE_MODEL));

const NATIVE_REF: ModelRef = {
  id: "native-proof",
  family: "rarext-native",
  parameters: "8 tokens",
  quantization: "exact",
  format: "json",
  sizeBytes: null,
  weightsDigest: null,
  contextLength: 64,
};

const NATIVE_EXECUTION: ExecutionRef = {
  kind: "native",
  modelClass: "xorshift32",
  defaultSteps: 12,
};


/** One-tensor GGUF, used to check a single dequantization path in isolation. */
function singleTensorGguf(type: number, dims: number[], data: Buffer): Buffer {
  const u32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value, 0);
    return out;
  };
  const u64 = (value: number): Buffer => {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(BigInt(value), 0);
    return out;
  };
  const str = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([u64(bytes.length), bytes]);
  };
  const header = Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    u32(3),
    u64(1),
    u64(0),
    str("t"),
    u32(dims.length),
    ...dims.map(u64),
    u32(type),
    u64(0),
  ]);
  const dataStart = Math.ceil(header.length / 32) * 32;
  return Buffer.concat([header, Buffer.alloc(dataStart - header.length), data]);
}
/**
 * A tiny, self-contained qwen2 GGUF. It is small enough to build in the test
 * and big enough to exercise the whole RAREXT GGUF engine: header + KV +
 * tensor-info parse, byte-level BPE, RMSNorm, GQA attention, RoPE, SwiGLU, and
 * tied output. Every tensor is F32 so the fixture stays readable.
 */
function tinyGgufModel(
  options: {
    arch?: "qwen2" | "llama" | "gemma" | "mixtral" | "phi3" | "phi2";
    tokenizer?: "gpt2" | "llama";
    /** Force every norm weight to this value (default: random near 1). */
    normValue?: number;
    /** Override `general.architecture` while keeping this layout (negative tests). */
    archOverride?: string;
    /** Quantize weight tensors to this type (default: F32). */
    quant?: "IQ4_NL" | "IQ2_XXS";
    nEmbd?: number;
    nHead?: number;
    nHeadKv?: number;
    nFfn?: number;
    /** Phi-3 rotary dimensions (default: the full head size). */
    nRot?: number;
    /** Phi-3 fused QKV/ffn_up (default) or the equivalent separate tensors. */
    phi3Layout?: "fused" | "separate";
    /** Add Phi LongRoPE short/long factor tensors (all ones). */
    longRope?: boolean;
    /** Phi `rope.scaling.attn_factor` (default: absent). */
    ropeAttnFactor?: number;
    /** Phi `rope.scaling.original_context_length` (default: absent). */
    ropeOrigCtx?: number;
    /** Value written into the LongRoPE short factor tensor (default 1). */
    ropeShortFactor?: number;
    /** Value written into the LongRoPE long factor tensor (default 1). */
    ropeLongFactor?: number;
    /** Declared `<arch>.context_length` (default 64). */
    contextLength?: number;
    /**
     * Append the 256 SentencePiece byte-fallback tokens `<0x00>`..`<0xFF>`, so
     * arbitrary text (JSON punctuation, unicode) round-trips through the
     * fixture's tokenizer. Off by default to keep the base fixture small.
     */
    byteTokens?: boolean;
    /** Write `tokenizer.chat_template`, as a real GGUF carries. */
    chatTemplate?: string;
  } = {},
): Buffer {
  const arch = options.arch ?? "qwen2";
  const tokenizerModel = options.tokenizer ?? "gpt2";
  const isMoe = arch === "mixtral";
  const isPhi3 = arch === "phi3";
  const isPhi2 = arch === "phi2";
  const phi3Fused = isPhi3 && (options.phi3Layout ?? "fused") === "fused";
  const expertCount = 4;
  const byteTokenCount = options.byteTokens === true ? 256 : 0;
  const vocabSize = 32 + byteTokenCount;
  const nEmbd = options.nEmbd ?? 8;
  const nHead = options.nHead ?? 2;
  const nHeadKv = options.nHeadKv ?? 1;
  const nFfn = options.nFfn ?? nEmbd * 2;
  const tokens: string[] =
    tokenizerModel === "llama"
      ? ["\u2581", "a", "b", "c", "d", "e", "f", "g"]
      : ["a", "b", "c", "d", "e", "f", "g", "h"];
  while (tokens.length < 32) tokens.push(`<x${tokens.length}>`);
  for (let byte = 0; byte < byteTokenCount; byte += 1) {
    tokens.push(`<0x${byte.toString(16).toUpperCase().padStart(2, "0")}>`);
  }

  const u32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value, 0);
    return out;
  };
  const u64 = (value: number): Buffer => {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(BigInt(value), 0);
    return out;
  };
  const f32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeFloatLE(value, 0);
    return out;
  };
  const str = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([u64(bytes.length), bytes]);
  };
  const kv = (key: string, type: number, value: Buffer): Buffer =>
    Buffer.concat([str(key), u32(type), value]);
  const array = (elementType: number, values: Buffer[]): Buffer =>
    Buffer.concat([u32(elementType), u64(values.length), ...values]);

  let state = 0x12345678;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  interface TensorSpec {
    name: string;
    dims: number[];
    kind: "weight" | "norm" | "bias" | "factor";
  }
  const kvDim = nHeadKv * (nEmbd / nHead);
  const specs: TensorSpec[] = [
    { name: "token_embd.weight", dims: [nEmbd, vocabSize], kind: "weight" },
    { name: "blk.0.attn_norm.weight", dims: [nEmbd], kind: "norm" },
    ...(isPhi2
      ? ([{ name: "blk.0.attn_norm.bias", dims: [nEmbd], kind: "bias" }] as TensorSpec[])
      : []),
    ...(phi3Fused
      ? ([
          // Phi-3's fused QKV: rows [Q; K; V].
          { name: "blk.0.attn_qkv.weight", dims: [nEmbd, nEmbd + 2 * kvDim], kind: "weight" },
        ] as TensorSpec[])
      : ([
          { name: "blk.0.attn_q.weight", dims: [nEmbd, nEmbd], kind: "weight" },
          { name: "blk.0.attn_k.weight", dims: [nEmbd, kvDim], kind: "weight" },
          { name: "blk.0.attn_v.weight", dims: [nEmbd, kvDim], kind: "weight" },
        ] as TensorSpec[])),
    // Qwen2 and Phi-2 carry attention biases; the other families here do not.
    ...(arch === "qwen2" || isPhi2
      ? ([
          { name: "blk.0.attn_q.bias", dims: [nEmbd], kind: "bias" },
          { name: "blk.0.attn_k.bias", dims: [kvDim], kind: "bias" },
          { name: "blk.0.attn_v.bias", dims: [kvDim], kind: "bias" },
        ] as TensorSpec[])
      : []),
    { name: "blk.0.attn_output.weight", dims: [nEmbd, nEmbd], kind: "weight" },
    ...(isPhi2
      ? ([{ name: "blk.0.attn_output.bias", dims: [nEmbd], kind: "bias" }] as TensorSpec[])
      : []),
    // Phi-2 has no separate FFN norm: its FFN reads the attention norm output.
    ...(isPhi2
      ? []
      : ([{ name: "blk.0.ffn_norm.weight", dims: [nEmbd], kind: "norm" }] as TensorSpec[])),
    // Mixtral replaces the dense FFN with a stacked, routed expert bank.
    ...(isMoe
      ? ([
          { name: "blk.0.ffn_gate_inp.weight", dims: [nEmbd, expertCount], kind: "weight" },
          { name: "blk.0.ffn_gate_exps.weight", dims: [nEmbd, nFfn, expertCount], kind: "weight" },
          { name: "blk.0.ffn_up_exps.weight", dims: [nEmbd, nFfn, expertCount], kind: "weight" },
          { name: "blk.0.ffn_down_exps.weight", dims: [nFfn, nEmbd, expertCount], kind: "weight" },
        ] as TensorSpec[])
      : isPhi2
        ? ([
            // Sequential GELU FFN with biases and no gate.
            { name: "blk.0.ffn_up.weight", dims: [nEmbd, nFfn], kind: "weight" },
            { name: "blk.0.ffn_up.bias", dims: [nFfn], kind: "bias" },
            { name: "blk.0.ffn_down.weight", dims: [nFfn, nEmbd], kind: "weight" },
            { name: "blk.0.ffn_down.bias", dims: [nEmbd], kind: "bias" },
          ] as TensorSpec[])
        : phi3Fused
          ? ([
              // Fused gate/up: first half is the gate, second half the up.
              { name: "blk.0.ffn_up.weight", dims: [nEmbd, 2 * nFfn], kind: "weight" },
              { name: "blk.0.ffn_down.weight", dims: [nFfn, nEmbd], kind: "weight" },
            ] as TensorSpec[])
          : ([
              { name: "blk.0.ffn_gate.weight", dims: [nEmbd, nFfn], kind: "weight" },
              { name: "blk.0.ffn_up.weight", dims: [nEmbd, nFfn], kind: "weight" },
              { name: "blk.0.ffn_down.weight", dims: [nFfn, nEmbd], kind: "weight" },
            ] as TensorSpec[])),
    ...(options.longRope
      ? ([
          { name: "blk.0.rope_factors_long.weight", dims: [((options.nRot ?? nEmbd / nHead) / 2)], kind: "factor" },
          { name: "blk.0.rope_factors_short.weight", dims: [((options.nRot ?? nEmbd / nHead) / 2)], kind: "factor" },
        ] as TensorSpec[])
      : []),
    ...(isPhi2
      ? ([
          // Phi-2 ships a separate output matrix with a bias.
          { name: "output.weight", dims: [nEmbd, vocabSize], kind: "weight" },
          { name: "output.bias", dims: [vocabSize], kind: "bias" },
        ] as TensorSpec[])
      : []),
    { name: "output_norm.weight", dims: [nEmbd], kind: "norm" },
    ...(isPhi2
      ? ([{ name: "output_norm.bias", dims: [nEmbd], kind: "bias" }] as TensorSpec[])
      : []),
  ];

  // IQ4_NL values, matching ggml's kvalues_iq4nl.
  const IQ4NL = [-127, -104, -83, -65, -49, -35, -22, -10, 1, 13, 25, 38, 53, 69, 89, 113];
  const nearestIq4 = (scaled: number): number => {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < IQ4NL.length; index += 1) {
      const distance = Math.abs(IQ4NL[index]! - scaled);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  };
  // Encode rows of 32 floats as IQ4_NL blocks with a fixed half scale 2^-4
  // (0x2c00). The weights are tiny, so this stays well inside the table.
  const quantIq4nl = (values: number[], cols: number): Buffer => {
    const rows = values.length / cols;
    const blocksPerRow = cols / 32;
    const out = Buffer.alloc(rows * blocksPerRow * 18);
    let written = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let block = 0; block < blocksPerRow; block += 1) {
        const base = row * cols + block * 32;
        out.writeUInt16LE(0x2c00, written);
        for (let j = 0; j < 16; j += 1) {
          const low = nearestIq4(values[base + j]! / 0.0625);
          const high = nearestIq4(values[base + j + 16]! / 0.0625);
          out.writeUInt8((high << 4) | low, written + 2 + j);
        }
        written += 18;
      }
    }
    return out;
  };

  const datas: Buffer[] = [];
  let offset = 0;
  const infos: Buffer[] = [];
  for (const spec of specs) {
    const count = spec.dims.reduce((total, dim) => total * dim, 1);
    const values: number[] = [];
    for (let i = 0; i < count; i += 1) {
      let value: number;
      if (spec.kind === "norm") value = options.normValue ?? 1 + (rand() - 0.5) * 0.1;
      else if (spec.kind === "bias") value = (rand() - 0.5) * 0.1;
      else if (spec.kind === "factor") {
        value = spec.name.includes("long") ? (options.ropeLongFactor ?? 1) : (options.ropeShortFactor ?? 1);
      }
      else value = (rand() - 0.5) * 0.2;
      values.push(value);
    }
    const quantIq4 = options.quant === "IQ4_NL" && spec.kind === "weight" && spec.dims[0]! % 32 === 0;
    const quantIq2 = options.quant === "IQ2_XXS" && spec.kind === "weight" && spec.dims[0]! % 256 === 0;
    // An all-zero IQ2_XXS block with d = 1.0 decodes to the constant grid row 0
    // (0x08 * 0.125 = 1.0), which is enough to drive the quant-domain dot path.
    const quantIq2xxs = (dims: number[]): Buffer => {
      const rows = dims.slice(1).reduce((total, dim) => total * dim, 1) || 1;
      const blocks = (rows * dims[0]!) / 256;
      const out = Buffer.alloc(blocks * 66);
      for (let b = 0; b < blocks; b += 1) out.writeUInt16LE(0x3c00, b * 66);
      return out;
    };
    const quantType = quantIq4 ? 20 : quantIq2 ? 16 : 0;
    const data = quantIq4
      ? quantIq4nl(values, spec.dims[0]!)
      : quantIq2
        ? quantIq2xxs(spec.dims)
        : (() => {
            const floats = Buffer.alloc(count * 4);
            for (let i = 0; i < count; i += 1) floats.writeFloatLE(values[i]!, i * 4);
            return floats;
          })();
    datas.push(data);
    infos.push(
      Buffer.concat([
        str(spec.name),
        u32(spec.dims.length),
        ...spec.dims.map(u64),
        u32(quantType), // GGML_TYPE_IQ4_NL / IQ2_XXS vs GGML_TYPE_F32
        u64(offset),
      ]),
    );
    offset += data.length;
  }

  const kvs = [
    kv("general.architecture", 8, str(options.archOverride ?? arch)),
    kv("general.file_type", 4, u32(0)),
    kv(`${arch}.block_count`, 4, u32(1)),
    kv(`${arch}.context_length`, 4, u32(options.contextLength ?? 64)),
    kv(`${arch}.embedding_length`, 4, u32(nEmbd)),
    kv(`${arch}.feed_forward_length`, 4, u32(nFfn)),
    kv(`${arch}.attention.head_count`, 4, u32(nHead)),
    kv(`${arch}.attention.head_count_kv`, 4, u32(nHeadKv)),
    ...(isPhi2
      ? [kv(`${arch}.attention.layer_norm_epsilon`, 6, f32(1e-5))]
      : [kv(`${arch}.attention.layer_norm_rms_epsilon`, 6, f32(1e-6))]),
    kv(`${arch}.rope.freq_base`, 6, f32(10000)),
    ...(isPhi3
      ? [kv(`${arch}.rope.dimension_count`, 4, u32(options.nRot ?? nEmbd / nHead))]
      : []),
    ...(options.ropeAttnFactor !== undefined
      ? [kv(`${arch}.rope.scaling.attn_factor`, 6, f32(options.ropeAttnFactor))]
      : []),
    ...(options.ropeOrigCtx !== undefined
      ? [kv(`${arch}.rope.scaling.original_context_length`, 4, u32(options.ropeOrigCtx))]
      : []),
    ...(isMoe
      ? [
          kv(`${arch}.expert_count`, 4, u32(expertCount)),
          kv(`${arch}.expert_used_count`, 4, u32(2)),
        ]
      : []),
    kv("tokenizer.ggml.model", 8, str(tokenizerModel)),
    kv("tokenizer.ggml.pre", 8, str(arch === "qwen2" ? "qwen2" : "default")),
    kv("tokenizer.ggml.tokens", 9, array(8, tokens.map(str))),
    kv("tokenizer.ggml.token_type", 9, array(5, tokens.map(() => u32(1)))),
    kv("tokenizer.ggml.merges", 9, array(8, [])),
    kv("tokenizer.ggml.bos_token_id", 4, u32(0)),
    kv("tokenizer.ggml.eos_token_id", 4, u32(1)),
    ...(options.chatTemplate === undefined
      ? []
      : [kv("tokenizer.chat_template", 8, str(options.chatTemplate))]),
    ...(tokenizerModel === "llama"
      ? [
          kv(
            "tokenizer.ggml.scores",
            9,
            array(6, tokens.map((_, index) => f32(index === 0 ? 0 : -index * 0.1))),
          ),
          kv("tokenizer.ggml.add_bos_token", 7, Buffer.from([0])),
        ]
      : []),
  ];

  const header = Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    u32(3),
    u64(specs.length),
    u64(kvs.length),
    ...kvs,
    ...infos,
  ]);
  const dataStart = Math.ceil(header.length / 32) * 32;
  const padding = Buffer.alloc(dataStart - header.length);
  return Buffer.concat([header, padding, ...datas]);
}

async function registry() {
  const root = mkdtempSync(join(tmpdir(), "rarext-web4-test-"));
  const blobs = new BlobStore(join(root, "blobs"));
  const server = createApp({
    store: new RarextStore(),
    blobs,
    placements: new PlacementRegistry(join(root, "placements")),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    root,
    blobs,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function publishNative(input: {
  base: string;
  chunkBytes?: number;
}): Promise<{ bundle: ModelBundle; manifestHash: string }> {
  const { bundle, chunks } = buildModelBundle({
    bytes: NATIVE_BYTES,
    model: NATIVE_REF,
    execution: NATIVE_EXECUTION,
    chunkBytes: input.chunkBytes ?? 97,
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  const uploaded = await uploadBundle({ registry: input.base, bundle, chunks });
  return { bundle, manifestHash: uploaded.manifestHash };
}

test("a model is sharded into content-addressed blobs and rebuilt byte-for-byte", async () => {
  const reg = await registry();
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    assert.ok(bundle.shards.length > 1, "the fixture is split across multiple shards");
    assert.equal(bundle.model.sizeBytes, NATIVE_BYTES.length);
    assert.equal(bundle.model.weightsDigest, `sha256:${createHash("sha256").update(NATIVE_BYTES).digest("hex")}`);

    const fetchedManifest = await fetchBundleManifest({
      registry: reg.base,
      manifestHash,
    });
    assert.deepEqual(fetchedManifest, bundle);
    assert.equal(bundleManifestHash(fetchedManifest), manifestHash);

    const { bytes } = await fetchBundleChunks({ registry: reg.base, bundle });
    assert.deepEqual(bytes, NATIVE_BYTES);
    assert.equal(verifyBundleChunks(bundle, bundle.shards.map((_, i) =>
      Buffer.from(`not shard ${i}`))).ok, false);

    // The manifest is itself a blob, so a reader can fetch the shard list from
    // storage instead of trusting a provider's copy of it.
    const listed = (await (await fetch(`${reg.base}/v1/blobs`)).json()) as Array<{ hash: string }>;
    assert.ok(listed.some((record) => record.hash === manifestHash));
    for (const shard of bundle.shards) {
      assert.ok(listed.some((record) => record.hash === shard.hash));
    }
  } finally {
    await reg.close();
  }
});

test("the binary blob route checks the content address it is given", async () => {
  const reg = await registry();
  try {
    const wrong = "0".repeat(64);
    const refused = await fetch(`${reg.base}/v1/blobs/raw`, {
      method: "POST",
      headers: { "x-rarext-hash": wrong },
      body: new Uint8Array(Buffer.from("weights")),
    });
    assert.equal(refused.status, 409);

    const accepted = await fetch(`${reg.base}/v1/blobs/raw`, {
      method: "POST",
      headers: { "x-rarext-media-type": "application/octet-stream" },
      body: new Uint8Array(Buffer.from("weights")),
    });
    assert.equal(accepted.status, 201);
  } finally {
    await reg.close();
  }
});

test("a provider fetches the model from RAREXT, verifies it, and serves it", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const running = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    provider = running;

    assert.deepEqual(running.modelBytes, NATIVE_BYTES);
    assert.equal(running.card.bundle.manifestHash, manifestHash);

    const cardResponse = await fetch(`${running.url}/v1/provider-card`);
    const card = await cardResponse.json();
    assert.deepEqual(verifyProviderCard(card), []);

    const request = (prompt: string) =>
      fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 8,
        }),
      });

    const firstResponse = await request("the same prompt");
    const first = (await firstResponse.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const second = (await (await request("the same prompt")).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const other = (await (await request("a different prompt")).json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    assert.equal(first.choices[0]!.message.content, second.choices[0]!.message.content);
    assert.notEqual(first.choices[0]!.message.content, other.choices[0]!.message.content);
    assert.equal(firstResponse.headers.get("x-rarext-bundle"), bundle.digest);
    assert.equal(first.choices[0]!.message.content.length > 0, true);

    // The legacy completions surface is part of the OpenAI shape too.
    const legacy = await fetch(`${running.url}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, prompt: "the same prompt", max_tokens: 8 }),
    });
    assert.equal(legacy.status, 200);
    const legacyBody = (await legacy.json()) as { choices: Array<{ text: string }> };
    assert.equal(legacyBody.choices[0]!.text, first.choices[0]!.message.content);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a sealed bundle lives on RAREXT as ciphertext and opens only with the key", async () => {
  const reg = await registry();
  const sealKey = generateSealKey();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
    });
    assert.equal(bundle.sealing?.scheme, "aes-256-gcm");
    assert.equal(bundle.sealing?.keyCommitment, sealKeyCommitment(sealKey));
    assert.notEqual(bundle.totalBytes, bundle.model.sizeBytes, "ciphertext is larger than the plaintext");
    await uploadBundle({ registry: reg.base, bundle, chunks });

    // What the node holds is exactly the committed ciphertext: the plaintext
    // model is not in the store, and the raw blob hashes to the shard hash.
    const rawShard = Buffer.from(
      await (await fetch(`${reg.base}/v1/blobs/${bundle.shards[0]!.hash}/raw`)).arrayBuffer(),
    );
    assert.equal(createHash("sha256").update(rawShard).digest("hex"), bundle.shards[0]!.hash);
    assert.equal(rawShard.includes(Buffer.from("xorshift32")), false, "the store never holds the model");
    const listed = (await (await fetch(`${reg.base}/v1/blobs`)).json()) as Array<{ hash: string }>;
    const plaintextHash = createHash("sha256").update(NATIVE_BYTES).digest("hex");
    assert.equal(
      listed.some((record) => record.hash === plaintextHash),
      false,
      "the plaintext file is not addressable in the store",
    );

    // A reader without the key verifies the ciphertext but cannot produce the
    // plaintext; with the key the opened bytes match the model identity.
    const sealedChunks = await Promise.all(
      bundle.shards.map(async (shard) =>
        Buffer.from(await (await fetch(`${reg.base}/v1/blobs/${shard.hash}/raw`)).arrayBuffer()),
      ),
    );
    const withoutKey = verifyBundleChunks(bundle, sealedChunks);
    assert.equal(withoutKey.ok, true, withoutKey.errors.join("; "));
    assert.notDeepEqual(withoutKey.bytes, NATIVE_BYTES);
    const withKey = verifyBundleChunks(bundle, sealedChunks, sealKey);
    assert.equal(withKey.ok, true, withKey.errors.join("; "));
    assert.deepEqual(withKey.bytes, NATIVE_BYTES);

    // The provider refuses without the key, refuses a wrong key by commitment,
    // and serves only when the opened plaintext matches the committed model.
    await assert.rejects(
      startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "nokey"), port: 0 }),
      /sealed/,
    );
    await assert.rejects(
      startProvider({
        bundle,
        registry: reg.base,
        stateDir: join(reg.root, "wrongkey"),
        port: 0,
        sealKey: randomBytes(32),
      }),
      /key commitment/,
    );

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
      sealKey,
    });
    assert.deepEqual(provider.modelBytes, NATIVE_BYTES);
    assert.equal(provider.card.bundle.sealed, true);
    const completion = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "sealed?" }],
        max_tokens: 8,
      }),
    });
    const body = (await completion.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(completion.status, 200);
    assert.ok(body.choices[0]!.message.content.length > 0);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a sealed engine bundle is loaded through an ephemeral file the provider never keeps", async () => {
  const reg = await registry();
  const sealKey = generateSealKey();
  const gguf = Buffer.from("GGUF-fake-weights-for-the-engine-path");
  const stateDir = join(reg.root, "engine");
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let ephemeralFile: string | null = null;
  let existedDuringLoad = false;
  let bytesDuringLoad: Buffer | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: gguf,
      model: { ...NATIVE_REF, id: "sealed-engine", format: "gguf", weightsDigest: null },
      execution: { kind: "engine", engine: "ollama", engineModel: "sealed" },
      chunkBytes: 8,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir,
      port: 0,
      sealKey,
      engineEndpoint: "http://127.0.0.1:1",
      // The injected "engine" watches the file it is handed, the way Ollama's
      // loader would: the plaintext must exist for the load and nowhere else.
      engineCreate: async ({ file, modelfile }) => {
        ephemeralFile = file;
        existedDuringLoad = existsSync(file);
        bytesDuringLoad = readFileSync(file);
        assert.ok(
          !file.startsWith(stateDir),
          "the sealed file must not live in the provider's state dir",
        );
        assert.match(readFileSync(modelfile, "utf8"), /^FROM /);
      },
    });

    assert.equal(provider.card.bundle.sealed, true);
    assert.equal(existedDuringLoad, true, "the engine can read the plaintext while it loads");
    assert.deepEqual(bytesDuringLoad, gguf);
    // ... and it is gone the moment the engine is done, state dir included.
    assert.equal(existsSync(ephemeralFile!), false, "the ephemeral file is removed after the load");
    assert.equal(existsSync(join(stateDir, "models")), false, "no plaintext model is cached");
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider refuses to serve bytes that no longer match their shard", async () => {
  const reg = await registry();
  try {
    const { bundle } = await publishNative({ base: reg.base });
    writeFileSync(join(reg.root, "blobs", bundle.shards[0]!.hash), Buffer.from("tampered"));

    await assert.rejects(
      startProvider({
        bundle,
        registry: reg.base,
        stateDir: join(reg.root, "provider"),
        port: 0,
      }),
      /missing|does not match|failed verification|hashes to/i,
    );
  } finally {
    await reg.close();
  }
});

test("a web4 deployment commits the bundle and every run carries it", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });

    const card = await fetchProviderCard({ endpoint: provider.url });
    const fetchedBundle = await fetchBundleManifest({
      registry: reg.base,
      manifestHash: card.bundle.manifestHash,
    });
    assert.deepEqual(crossCheckProviderCard(card, fetchedBundle), { ok: true, errors: [] });

    const probe: EngineProbe = {
      engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
      model: card.model,
      apis: ["openai"],
      models: [card.model],
    };
    const deployment = commitDeployment(
      buildDeployment({
        probe,
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: fetchedBundle.digest,
          shardsRoot: fetchedBundle.shardsRoot,
          manifestHash: card.bundle.manifestHash,
          provider: card.id,
          providerCard: card.digest,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.bundleDigest, fetchedBundle.digest);
    assert.equal(spec.shardsRoot, fetchedBundle.shardsRoot);
    assert.equal(verifyDeploymentBody(deployment, spec).correct, true);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "prove the bundle" }],
        max_tokens: 10,
      }),
    });
    assert.equal(response.status, 200);
    const completion = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.ok(completion.choices[0]!.message.content.length > 0);

    const records = new RunLedger(join(reg.root, "gateway")).records();
    assert.equal(records.length, 1);
    const body = records[0]!.body;
    assert.ok(body.bundle, "the run names the bundle it was produced from");
    assert.equal(body.bundle!.digest, fetchedBundle.digest);
    assert.equal(body.bundle!.shardsRoot, fetchedBundle.shardsRoot);
    assert.equal(body.bundle!.manifestHash, card.bundle.manifestHash);
    assert.equal(body.bundle!.weightsDigest, fetchedBundle.model.weightsDigest);

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("bundle.digest"));

    // Swapping the bundle in a run is visible even though every other digest
    // in the transcript is untouched.
    const swapped = { ...body, bundle: { ...body.bundle!, digest: "f".repeat(64) } };
    const refused = verifyRunBody(swapped, spec);
    assert.equal(refused.correct, false);
    assert.match(refused.error ?? "", /bundle.digest/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a web4 card whose bundle was swapped is refused", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });

    const lie = `sha256:${"1".repeat(64)}`;
    const relabelled = {
      ...card,
      model: { ...card.model, weightsDigest: lie },
      bundle: { ...card.bundle, weightsDigest: lie },
    };
    assert.ok(verifyProviderCard(relabelled).some((error) => error.includes("digest")));

    // A card can be re-digested over the lie (dropping the operator signature
    // and key, which no longer cover the changed bytes); the independent bundle
    // manifest is what catches it.
    const { digest: _digest, signature: _signature, ...rest } = relabelled;
    const unsigned = {
      ...rest,
      provider: { handle: rest.provider.handle, keyId: rest.provider.keyId },
    };
    const resigned = { ...unsigned, digest: providerCardDigest(unsigned) };
    assert.deepEqual(verifyProviderCard(resigned), []);
    const cross = crossCheckProviderCard(resigned, bundle);
    assert.equal(cross.ok, false);
    assert.ok(cross.errors.some((error) => error.includes("weightsDigest")));
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("web4 manifests must name network hardware and their committed bundle", async () => {
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };

  const local = buildDeployment({
    probe,
    hardware: { backend: "cpu", device: "host", memoryBytes: 8, os: "x", arch: "y" },
    placement: "web4",
    labels: { execution: "web4", bundle: "b".repeat(64), shardsRoot: "c".repeat(64), manifestHash: "d".repeat(64) },
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  const errors = validateDeployment(local);
  assert.ok(errors.some((error) => error.includes('hardware.backend must be "network"')));
  assert.ok(errors.some((error) => error.includes("memoryBytes must be null")));

  const labelled = buildDeployment({
    probe,
    hardware: hardwareFromNetwork("https://provider.example"),
    placement: "web4",
    labels: { execution: "web4", bundle: "b".repeat(64), shardsRoot: "c".repeat(64), manifestHash: "d".repeat(64) },
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  assert.deepEqual(validateDeployment(labelled), []);

  const deployment = commitDeployment(labelled);
  const withoutBundle = runSpecFromChallenge(challengeFor({ ...deployment, labels: undefined }));
  const verdict = verifyDeploymentBody(deployment, withoutBundle);
  assert.equal(verdict.correct, false);
  assert.ok((verdict.proof as { failures?: string[] }).failures?.includes("challenge.bundle"));
});

test("a bundle with an edited shard list is refused before anything is fetched", async () => {
  const reg = await registry();
  try {
    const { bundle } = await publishNative({ base: reg.base });
    const edited = {
      ...bundle,
      shards: bundle.shards.map((shard, index) =>
        index === 0 ? { ...shard, size: shard.size + 1 } : shard,
      ),
    };
    assert.ok(verifyModelBundle(edited).some((error) => error.includes("totalBytes")));
    assert.ok(verifyModelBundle(edited).some((error) => error.includes("shardsRoot")));
    assert.ok(verifyModelBundle(edited).some((error) => error.includes("digest")));
  } finally {
    await reg.close();
  }
});

/** A registry that learns challenges after the fact, plus the real verifier. */
async function verifierRegistry() {
  const root = mkdtempSync(join(tmpdir(), "rarext-web4-card-test-"));
  const verifier = createVerifierServer();
  verifier.listen(0, "127.0.0.1");
  await once(verifier, "listening");
  const verifierPort = (verifier.address() as AddressInfo).port;
  const verifierUrl = `http://127.0.0.1:${verifierPort}/verify`;

  const known = new Map<string, unknown>();
  const blobs = new BlobStore(join(root, "blobs"));
  const server = createApp({
    store: new RarextStore(),
    blobs,
    placements: new PlacementRegistry(join(root, "placements")),
    challenges: {
      list: () => [...known.values()],
      get: (id: string) => known.get(id) ?? null,
    } as never,
    verifiers: createVerifierRegistry(fetch, null, {
      configs: verifierConfig(verifierUrl).verifiers,
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  return {
    root,
    base: `http://127.0.0.1:${port}`,
    learn(challenge: unknown) {
      known.set((challenge as { id: string }).id, challenge);
    },
    async close() {
      server.closeAllConnections();
      verifier.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => verifier.close(() => resolve())),
      ]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a provider card is signed by the provider's own key and rejects tampering", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });

    // The card names a real key and carries a signature over its own bytes.
    assert.equal(typeof card.signature, "string");
    assert.equal(typeof card.provider.publicKey, "object");
    assert.deepEqual(verifyProviderCard(card), []);

    // Change a covered field while keeping the signature: the operator key no
    // longer matches the bytes, so the card is refused even though its
    // self-digest is recomputed to match.
    const tampered = {
      ...card,
      endpoint: "https://evil.example",
    };
    const { digest: _digest, ...payload } = tampered;
    const redigested = { ...payload, digest: providerCardDigest(payload) };
    assert.ok(
      verifyProviderCard(redigested).some((error) => error.includes("signature does not verify")),
    );

    // A card that claims a publicKey but carries no signature is refused.
    const { signature: _dropped, ...unsigned } = card;
    assert.ok(
      verifyProviderCard(unsigned).some((error) => error.includes("must carry a signature")),
    );
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider reuses its persisted identity and a fresh state gets a new one", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    const shared = join(reg.root, "shared-provider");
    first = await startProvider({ bundle, registry: reg.base, stateDir: shared, port: 0 });
    const firstCard = await fetchProviderCard({ endpoint: first.url });
    await first.close();
    first = null;

    // Same state directory, new process: the same operator identity.
    second = await startProvider({ bundle, registry: reg.base, stateDir: shared, port: 0 });
    const secondCard = await fetchProviderCard({ endpoint: second.url });
    assert.equal(secondCard.provider.keyId, firstCard.provider.keyId);

    // A different state directory is a different operator.
    other = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "other-provider"),
      port: 0,
    });
    const otherCard = await fetchProviderCard({ endpoint: other.url });
    assert.notEqual(otherCard.provider.keyId, firstCard.provider.keyId);
  } finally {
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a provider card is published under the challenge and discovered from the bundle", async () => {
  const reg = await verifierRegistry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          provider: card.id,
          providerCard: card.digest,
          providers: provider.url,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const challenge = challengeFor(deployment);
    reg.learn(challenge);

    const publisher = await RuntimePublisher.open({
      baseUrl: reg.base,
      handle: "web4-test-publisher",
      stateDir: join(reg.root, "publisher"),
      challengeId: challenge.id,
    });
    await publisher.publishDeployment(deployment);
    const publication = await publisher.publishProviderCard(card);
    assert.equal(publication.app, "ai-model-run");
    assert.equal(publication.artifact.kind, "ai.model-provider");
    assert.equal(publication.attestation?.correct, true);
    await publisher.client.anchor();

    const latest = await (await fetch(`${reg.base}/v1/bundles/latest`)).json();
    const report = discoverBundle(latest);
    const providerEntry = report.providers.find((entry) => entry.endpoint === provider!.url);
    assert.ok(providerEntry, "the bundle carries the published provider card");
    assert.equal(providerEntry.verified, true);
    assert.equal(providerEntry.attested, true);
    assert.equal(providerEntry.bundleDigest, bundle.digest);

    const discovered = verifiedProviders(latest, bundle.digest);
    assert.equal(discovered.providers.length, 1);
    assert.equal(discovered.providers[0]!.card.digest, card.digest);

    // Provider discovery is only as good as the bytes. An edited card in the
    // same bundle must not be adoptable, even though the registry attested it.
    const tampered = structuredClone(latest) as {
      publications: Array<{ artifact: { kind: string; body: { endpoint?: string } } }>;
    };
    for (const publicationEntry of tampered.publications) {
      if (publicationEntry.artifact.kind === "ai.model-provider") {
        publicationEntry.artifact.body.endpoint = "https://attacker.example";
      }
    }
    assert.equal(verifiedProviders(tampered, bundle.digest).providers.length, 0);

    // An anchor covers one batch. The provider's card was anchored, then a
    // later announcement became a second batch; discovery must read both.
    const reannounced = buildProviderCard({
      bundle,
      endpoint: provider.url,
      manifestHash,
      createdAt: "2026-11-07T00:00:01.000Z",
    });
    await publisher.publishProviderCard(reannounced);
    await publisher.client.anchor();
    const batches = await fetchAnchoredBundles({ registry: reg.base });
    assert.ok(batches.length >= 2, "each anchor is its own batch");
    const across = batches.flatMap(
      (batch) => verifiedProviders(batch, bundle.digest).providers,
    );
    assert.ok(across.length >= 2, "provider cards are found across anchored batches");
    assert.ok(across.every((entry) => entry.card.endpoint === provider!.url));
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("providers are discovered across independent registries; a dead mirror is not fatal", async () => {
  const one = await verifierRegistry();
  const two = await verifierRegistry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: one.base });
    provider = await startProvider({
      bundle,
      registry: one.base,
      stateDir: join(one.root, "provider"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const challenge = challengeFor(deployment);
    one.learn(challenge);
    two.learn(challenge);

    // The same signed card is announced to both registries. Neither copy is
    // privileged: discovery verifies the card's own bytes against the
    // challenge, then unions the registries by card digest.
    for (const [reg, name] of [
      [one, "one"],
      [two, "two"],
    ] as const) {
      const publisher = await RuntimePublisher.open({
        baseUrl: reg.base,
        handle: "multi-registry-publisher",
        stateDir: join(reg.root, `publisher-${name}`),
        challengeId: challenge.id,
      });
      await publisher.publishDeployment(deployment);
      await publisher.publishProviderCard(card);
      await publisher.client.anchor();
    }

    const across = await fetchVerifiedProvidersAcrossRegistries({
      registries: [one.base, two.base, "http://127.0.0.1:1"],
      bundleDigest: bundle.digest,
    });
    assert.equal(across.providers.length, 1, "the same card from two registries is one provider");
    assert.equal(across.providers[0]!.card.digest, card.digest);
    assert.ok(across.scanned >= 2, "both registries were read");
    assert.equal(across.errors.length, 1, "the unreachable mirror is reported, not fatal");
    assert.match(across.errors[0]!, /127\.0\.0\.1:1/);
  } finally {
    if (provider !== null) await provider.close();
    await one.close();
    await two.close();
  }
});

test("a committed bounty pays every distinct agreeing operator, verifiably", async () => {
  const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          bounty: "5",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.inferenceBounty, 5);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "who gets paid?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 200);

    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.ok(body.credits, "the run commits the payment it made");
    assert.equal(body.credits!.action, "infer");
    assert.equal(body.credits!.bounty, 5);
    assert.equal(body.credits!.paid, 2);
    assert.match(body.credits!.ledgerRoot, /^[0-9a-f]{64}$/);

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("credits"));

    // The payment is not taken on faith: editing the root, the bounty, or the
    // paid count moves the run away from what the quorum evidence implies.
    const tamperedRoot = { ...body, credits: { ...body.credits!, ledgerRoot: "0".repeat(64) } };
    assert.equal(verifyRunBody(tamperedRoot, spec).correct, false);
    const tamperedBounty = { ...body, credits: { ...body.credits!, bounty: 6 } };
    assert.equal(verifyRunBody(tamperedBounty, spec).correct, false);
    const tamperedPaid = { ...body, credits: { ...body.credits!, paid: 9 } };
    assert.equal(verifyRunBody(tamperedPaid, spec).correct, false);
    // Paying a dissenter is a different ledger too.
    const payingDissent = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({ ...entry, operator: "operator-a" })),
      },
      credits: body.credits!,
    };
    assert.equal(verifyRunBody(payingDissent, spec).correct, false);

    // An operator can read its own receipts with a Merkle inclusion proof.
    const ledgerView = (await (
      await fetch(`${gateway.url}/v1/rarext/credits`)
    ).json()) as { ledgerRoot: string; count: number; byOperator: Record<string, { credits: number }> };
    assert.equal(ledgerView.ledgerRoot, body.credits!.ledgerRoot);
    assert.equal(ledgerView.count, 2);
    assert.equal(ledgerView.byOperator["operator-a"]!.credits, 5);

    const mine = (await (
      await fetch(`${gateway.url}/v1/rarext/credits/operator-a`)
    ).json()) as {
      statement: { credits: { earned: number } };
      ledgerRoot: string;
      receipts: Array<CreditRecordFields & { ledger: { root: string; index: number; proof: string[] } }>;
    };
    assert.equal(mine.statement.credits.earned, 5);
    assert.equal(mine.receipts.length, 1);
    const receipt = mine.receipts[0]!;
    assert.equal(receipt.keyId, "operator-a");
    assert.equal(receipt.bounty, 5);
    assert.equal(receipt.action, "infer");
    assert.equal(
      verifyProof(
        creditLeaf(receipt, (value) =>
          createHash("sha256")
            .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
            .digest("hex"),
        ),
        receipt.ledger.proof,
        mine.ledgerRoot,
        receipt.ledger.index,
        bytesSha256,
      ),
      true,
      "the operator's receipt proves against the published root",
    );

    // The commitment the gateway published is exactly the one a reader derives
    // from the run alone.
    const derived = creditLedgerRoot(
      inferenceCreditRecords({
        providers: body.quorum!.providers.map((entry) => ({
          responseDigest: entry.responseDigest,
          operator: entry.operator ?? null,
        })),
        responseDigest: body.response.digest,
        deploymentDigest: body.deployment.digest,
        completedAt: body.completedAt,
        bounty: 5,
      }),
      (value) =>
        createHash("sha256")
          .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
          .digest("hex"),
    );
    assert.equal(derived, body.credits!.ledgerRoot);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a run under a bounty with no committed operators cannot be verified", () => {
  // The deployment refuses to commit a bounty without operators to pay, so the
  // challenge never names one and the run cannot invent a payment.
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromNetwork("https://provider.example"),
      placement: "web4",
      labels: {
        execution: "web4",
        bundle: "a".repeat(64),
        shardsRoot: "b".repeat(64),
        manifestHash: "c".repeat(64),
        providers: "https://provider.example",
        quorum: "1",
        bounty: "5",
      },
    }),
  );
  assert.ok(
    validateDeployment(deployment).some((error) => error.includes("labels.bounty requires")),
    "a bounty without operators is refused before it can pay nobody",
  );
});

test("two providers must agree, and the run records the quorum evidence", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });
    const providers = `${first.url},${second.url}`;

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          provider: card.id,
          providerCard: card.digest,
          providers,
          operators: "operator-a,operator-b",
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.quorum, 2);
    assert.deepEqual(spec.operators, ["operator-a", "operator-b"]);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "say the same thing" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-rarext-quorum"), "2/2");

    const records = new RunLedger(join(reg.root, "gateway")).records();
    assert.equal(records.length, 1);
    const body = records[0]!.body;
    assert.ok(body.quorum, "the run carries who answered and who agreed");
    assert.equal(body.quorum!.required, 2);
    assert.equal(body.quorum!.responded, 2);
    assert.equal(body.quorum!.agreed, 2);
    assert.equal(body.quorum!.providers.length, 2);
    assert.equal(new Set(body.quorum!.providers.map((entry) => entry.responseDigest)).size, 1);
    assert.deepEqual(
      body.quorum!.providers.map((entry) => entry.operator),
      ["operator-a", "operator-b"],
      "each provider records the operator it declared",
    );

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("quorum"));

    // Two endpoints run by one operator are one voice: the verifier rejects a
    // claimed agreement that collapses to a single operator.
    const collapsed = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({ ...entry, operator: "operator-a" })),
      },
    };
    assert.equal(verifyRunBody(collapsed, spec).correct, false);
    const unknownOperator = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) => ({
          ...entry,
          operator: index === 0 ? "operator-z" : entry.operator,
        })),
      },
    };
    assert.equal(verifyRunBody(unknownOperator, spec).correct, false);

    // A quorum deployment can still stream: it compares the complete answers
    // first and then replays the agreed one as SSE with the same evidence.
    const streamed = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "say the same thing" }],
        max_tokens: 8,
        temperature: 0,
        stream: true,
      }),
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(streamed.headers.get("x-rarext-quorum"), "2/2");
    assert.equal(streamed.headers.get("x-rarext-stream"), "quorum-agreed");
    const sse = await streamed.text();
    assert.match(sse, /"object":"chat\.completion\.chunk"/);
    assert.match(sse, /data: \[DONE\]/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 2);
    const streamedBody = new RunLedger(join(reg.root, "gateway")).records()[1]!.body;
    assert.equal(streamedBody.quorum?.agreed, 2);
    assert.equal(verifyRunBody(streamedBody, spec).correct, true);

    // Removing the evidence, lowering the count, or detaching the chosen
    // response from the agreeing digests are all visible.
    const { quorum: _quorum, ...withoutQuorum } = body;
    assert.equal(verifyRunBody(withoutQuorum, spec).correct, false);
    assert.equal(
      verifyRunBody({ ...body, quorum: { ...body.quorum!, required: 1 } }, spec).correct,
      false,
    );
    assert.equal(
      verifyRunBody({ ...body, response: { ...body.response, digest: "f".repeat(64) } }, spec).correct,
      false,
    );
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a dissent is recorded as evidence but never counted toward quorum", async () => {
  const reg = await registry();
  const providers: Array<Awaited<ReturnType<typeof startProvider>>> = [];
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    for (const name of ["a", "b", "c"]) {
      providers.push(
        await startProvider({
          bundle,
          registry: reg.base,
          stateDir: join(reg.root, `provider-${name}`),
          port: 0,
        }),
      );
    }
    const card = await fetchProviderCard({ endpoint: providers[0]!.url });
    const endpoints = providers.map((entry) => entry.url);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: endpoints[0]! },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(endpoints[0]!),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: endpoints.join(","),
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.quorum, 2);

    // The third provider answers differently. Two agree, so the run stands —
    // and the transcript carries all three, including the dissent. A real
    // dissenting provider SIGNS its own answer (over the exact request it got
    // and the bundle it served), so the dissent is evidence, not an unsigned
    // claim the gateway invented.
    const dissentSigner = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const dissenting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).startsWith(endpoints[2]!)) return response;
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      body.choices[0]!.message.content = "a different answer";
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const payload = {
        kind: "rarext.response-receipt.v1",
        request: canonicalDigest(requestBody),
        response: canonicalDigest(comparableCompletion(body as Record<string, unknown>)),
        bundle: bundle.digest,
      };
      const receipt = {
        ...payload,
        signature: dissentSigner.sign(payload),
        publicKey: dissentSigner.publicKey,
        suite: dissentSigner.suite,
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-rarext-receipt": Buffer.from(JSON.stringify(receipt), "utf8").toString("base64"),
        },
      });
    };

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: endpoints,
      quorum: 2,
      fetchImpl: dissenting,
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "who agrees?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-rarext-quorum"), "2/2");

    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(body.quorum!.required, 2);
    assert.equal(body.quorum!.responded, 3);
    assert.equal(body.quorum!.agreed, 2);
    assert.equal(body.quorum!.providers.length, 3, "all responders are recorded, dissent included");
    assert.equal(new Set(body.quorum!.providers.map((entry) => entry.responseDigest)).size, 2);

    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier does not take `agreed` on faith: claiming the dissenter
    // agreed is visible, and so is counting one endpoint twice.
    assert.equal(
      verifyRunBody({ ...body, quorum: { ...body.quorum!, agreed: 3 } }, spec).correct,
      false,
    );
    const duplicated = {
      ...body.quorum!,
      providers: [body.quorum!.providers[0]!, { ...body.quorum!.providers[1]!, endpoint: body.quorum!.providers[0]!.endpoint }],
    };
    assert.equal(verifyRunBody({ ...body, quorum: duplicated }, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    for (const entry of providers) await entry.close();
    await reg.close();
  }
});

test("the gateway refuses a quorum met by one operator across two endpoints", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          // The deployment says two operators, but the gateway is configured
          // with one identity for both endpoints. Bytes agree; independence
          // does not, and the run must not be written.
          operators: "operator-a,operator-b",
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-a" },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "who is one voice?" }],
        max_tokens: 8,
      }),
    });
    assert.equal(response.status, 503);
    const refused = (await response.json()) as { error: string };
    assert.match(refused.error, /distinct operator/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a machine-independent quorum refuses keys that attest the same machine", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    // Each provider signs its machine with its own leaf key, so the machine is a
    // signed claim, not a label. One provider attests machine-a, the other
    // machine-b.
    const signerA = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const signerB = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      machine: "machine-a",
      teeSigner: signerA,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      machine: "machine-b",
      teeSigner: signerB,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // Each card attests a machine, bound by its own signed quote.
    assert.equal(cardA.independence?.kind, "rarext.provider-machine.v1");
    assert.match(cardA.independence!.measurement, /^[0-9a-f]{64}$/);
    assert.equal(cardA.independence!.machine, "machine-a");
    assert.equal(cardB.independence!.machine, "machine-b");
    assert.equal(verifyProviderQuote(cardA.independence), signerA.keyId);
    assert.equal(verifyProviderQuote(cardB.independence), signerB.keyId);

    // The deployment commits distinct machines (from cards that attested
    // distinct hosts). A run must then be met by distinct machines.
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          machines: "machine-a,machine-b",
          independence: "machine",
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.independence, "machine");
    assert.deepEqual(spec.machines, ["machine-a", "machine-b"]);

    // The gateway is pointed at two endpoints that both attest machine-a: two
    // operator keys, one box. The second's signed quote is swapped for the
    // first's, so both MACHINES (from the quotes) are machine-a and the run must
    // not be written.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      machines: { [first.url]: "machine-a", [second.url]: "machine-a" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardA.independence! },
    });
    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "one box?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /distinct machine/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
    await gateway.close();
    gateway = null;

    // With distinct SIGNED machines the same quorum is met and the run verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-b"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      machines: { [first.url]: "machine-a", [second.url]: "machine-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-b")).records()[0]!.body;
    assert.deepEqual(
      body.quorum!.providers.map((entry) => entry.machine),
      ["machine-a", "machine-b"],
    );
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);

    // The verifier does not take the machines on faith: a run that claims the
    // quorum with one machine, or a machine the deployment never committed, is
    // refused.
    const collapsed = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({ ...entry, machine: "machine-a" })),
      },
    };
    assert.equal(verifyRunBody(collapsed, spec).correct, false);
    const invented = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) => ({
          ...entry,
          machine: index === 0 ? "machine-z" : entry.machine,
        })),
      },
    };
    assert.equal(verifyRunBody(invented, spec).correct, false);

    // A run whose RECORDED machine disagrees with the machine its own signed
    // quote binds is refused, even when both strings are ones the deployment
    // committed: the machine must be attested, not typed.
    const swappedQuote = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 1 ? { ...entry, attestation: cardA.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swappedQuote, spec).correct, false);
    assert.match(
      verifyRunBody(swappedQuote, spec).error ?? "",
      /quorum/,
    );

    // An agreeing provider with no signed machine quote cannot count.
    const noQuote = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 1 ? { ...entry, attestation: undefined } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(noQuote, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a machine-independent quorum refuses a machine whose quote does not verify", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    // A provider that NAMES a machine but whose quote does not verify: the leaf
    // key signs garbage, so the machine claim is not backed by a valid signature.
    const keypair = generateAgentKeypair("ecdsa-p256");
    const brokenSigner = {
      sign: () => "A".repeat(88),
      publicKey: keypair.publicKey,
      suite: "ecdsa-p256",
    };
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
      machine: "solo-machine",
      teeSigner: brokenSigner,
    });
    // fetchProviderCard refuses an invalid card, so read the raw card to show the
    // machine is NAMED but its quote does not verify.
    const card = (await (await fetch(`${provider.url}/v1/provider-card`)).json()) as {
      independence: RunProviderAttestation;
      provider: { keyId: string | null };
      model: ModelRef;
    };
    assert.equal(card.independence.machine, "solo-machine");
    assert.equal(verifyProviderQuote(card.independence), null, "the quote does not verify");

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: card.provider.keyId!,
          machines: "solo-machine",
          independence: "machine",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: card.provider.keyId! },
      machines: { [provider.url]: "solo-machine" },
      attestations: { [provider.url]: card.independence! },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "signed?" }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    assert.equal(response.status, 503);
    assert.match(((await response.json()) as { error: string }).error, /distinct machine/);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a measurement allowlist refuses a provider running unapproved software", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    second = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0 });
    const card = await fetchProviderCard({ endpoint: first.url });
    const approved = card.independence!.measurement;
    assert.match(approved, /^[0-9a-f]{64}$/);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          // The deployment approves exactly one software image.
          measurements: approved,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.deepEqual(spec.measurements, [approved]);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "approved?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // One provider presents a measurement the deployment never approved.
    const rogue = "0".repeat(64);
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-rogue"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      measurements: { [first.url]: approved, [second.url]: rogue },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unapproved measurement/);
    assert.equal(new RunLedger(join(reg.root, "gateway-rogue")).records().length, 0);
    await gateway.close();
    gateway = null;

    // Both present the approved measurement: the run is met and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      measurements: { [first.url]: approved, [second.url]: approved },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the allowlist rule: swapping in an unapproved
    // measurement is caught.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) => ({
          ...entry,
          measurement: index === 0 ? rogue : entry.measurement,
        })),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a measurement allowlist must be sha256 hex, and needs a quorum of operators", () => {
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromNetwork("https://provider.example"),
      placement: "web4",
      labels: {
        execution: "web4",
        bundle: "a".repeat(64),
        shardsRoot: "b".repeat(64),
        manifestHash: "c".repeat(64),
        providers: "https://provider.example",
        quorum: "1",
        measurements: "not-hex",
      },
    }),
  );
  const errors = validateDeployment(deployment);
  assert.ok(errors.some((error) => error.includes("measurements entries must be sha256 hex")));
  assert.ok(errors.some((error) => error.includes("measurements requires")));
});

test("a run pins the engine, and a replay refuses a provider whose engine differs", async () => {
  const reg = await registry();
  let pinned: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    pinned = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    // A second provider running a different engine build (a different version).
    other = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      engineVersion: "other-engine",
    });
    const health = (await (await fetch(`${pinned.url}/health`)).json()) as { engineFingerprint: string };
    const healthOther = (await (await fetch(`${other.url}/health`)).json()) as { engineFingerprint: string };
    assert.match(health.engineFingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(health.engineFingerprint, healthOther.engineFingerprint);

    const card = await fetchProviderCard({ endpoint: pinned.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: pinned.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(pinned.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: pinned.url,
          operators: "operator-a",
          quorum: "1",
          engineFingerprint: health.engineFingerprint,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.engineFingerprint, health.engineFingerprint);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [pinned.url],
      quorum: 1,
      operators: { [pinned.url]: "operator-a" },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "pinned engine?" }],
        max_tokens: 8,
        temperature: 0,
        seed: 7,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(body.engine.fingerprint, health.engineFingerprint);
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Replay against the pinned provider reproduces the committed output.
    const good = await replayEngineRun({ body, endpoint: pinned.url });
    assert.equal(good.engineFingerprint, health.engineFingerprint);
    assert.equal(good.reproduced, true, good.reason ?? "");
    assert.equal(good.ok, true);

    // A provider on a different engine is refused before a token is generated.
    const bad = await replayEngineRun({ body, endpoint: other.url });
    assert.equal(bad.ok, false);
    assert.equal(bad.reproduced, null);
    assert.match(bad.reason ?? "", /differs from the pinned engine/);

    // The verifier recomputes the pin: a run naming another engine is refused.
    const swapped = { ...body, engine: { ...body.engine, fingerprint: healthOther.engineFingerprint } };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (pinned !== null) await pinned.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a machine quote is checked against a pinned vendor key", async () => {
  const vendor = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      teeSigner: vendor,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      teeSigner: vendor,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // The card carries a vendor quote that verifies under the vendor key.
    assert.equal(cardA.independence?.scheme, "tee");
    assert.ok(cardA.independence?.quote);
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderQuote(cardA.independence), vendor.keyId);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: vendor.keyId,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeVendor, vendor.keyId);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "quoted?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A forged quote: the measurement changes but the vendor signature does not,
    // so it no longer verifies under the pinned key.
    const forged = { ...cardA.independence!, measurement: "0".repeat(64) };
    assert.equal(verifyProviderQuote(forged), null);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-forged"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: forged, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // Both quote under the pinned vendor: the run is met and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.ok(body.quorum!.providers.every((entry) => entry.attestation !== undefined));
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the quote rule: replacing one with a forgery fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: forged } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a machine quote's chain of trust must terminate at the pinned anchor", async () => {
  const anchor = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const attacker = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // The anchor vouches for the leaf key.
  const certificate = issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: anchor });

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      teeSigner: leaf,
      teeChain: [certificate],
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      teeSigner: leaf,
      teeChain: [certificate],
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // The leaf signs the quote; the certificate chains it to the anchor.
    assert.equal(cardA.independence?.quote?.chain?.length, 1);
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderQuote(cardA.independence), leaf.keyId, "the quote is the leaf's");
    assert.equal(verifyProviderChain(cardA.independence), anchor.keyId, "and its root is the anchor");

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          // The deployment pins the ANCHOR, not the leaf.
          teeVendor: anchor.keyId,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeVendor, anchor.keyId);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "chained?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A chain that does not reach the anchor: the leaf is certified by an
    // attacker's key, not the pinned anchor. The quote is genuine, the trust is
    // not — and it is refused.
    const wrongAnchorCert = issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: attacker });
    const wrongAnchor = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: [wrongAnchorCert] },
    };
    assert.equal(verifyProviderChain(wrongAnchor), attacker.keyId);
    assert.notEqual(verifyProviderChain(wrongAnchor), anchor.keyId);

    // A certificate whose signature does not match its issuer is broken.
    const brokenCert = { ...certificate, signature: attacker.sign({ subject: certificate.subject, issuer: certificate.issuer }) };
    const broken = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: [brokenCert] },
    };
    assert.equal(verifyProviderChain(broken), null);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-wrong"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: wrongAnchor, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // With the chain reaching the pinned anchor, the run is met and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the chain: swapping in the attacker-rooted chain
    // fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: wrongAnchor } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("an enclave serves a bundle sealed to it, and a forwarder never holds the key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const otherKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
  const sealKey = generateSealKey();
  const anchor = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const certificate = issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: anchor });

  const reg = await registry();
  let enclave: Awaited<ReturnType<typeof startProvider>> | null = null;
  let forwarder: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: publicKey,
    });
    assert.equal(bundle.sealing?.wrap?.scheme, "rsa-oaep-sha256");
    await uploadBundle({ registry: reg.base, bundle, chunks });

    // The enclave unwraps the data key with its private key; a different key cannot.
    assert.equal(unwrapSealKey(bundle, privateKey).equals(sealKey), true);
    assert.throws(() => unwrapSealKey(bundle, otherKey), /does not unwrap/);

    // A forwarding provider can verify the committed ciphertext but not open it.
    const ciphertext = await fetchBundleCiphertext({ registry: reg.base, bundle });
    assert.notDeepEqual(ciphertext.bytes, NATIVE_BYTES);
    assert.equal(ciphertext.bytes.length, bundle.totalBytes);

    enclave = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: privateKey,
      teeSigner: leaf,
      teeChain: [certificate],
    });

    forwarder = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "forwarder"),
      port: 0,
      enclaveEndpoint: enclave.url,
    });

    // The forwarder holds ciphertext and no key; its card names the bundle but
    // carries the ENCLAVE's attestation.
    const forwarderHealth = (await (await fetch(`${forwarder.url}/health`)).json()) as {
      holdsKey: boolean;
      bundle: string;
    };
    assert.equal(forwarderHealth.holdsKey, false);
    assert.equal(forwarderHealth.bundle, bundle.digest);
    assert.equal(forwarder.card.bundle.sealed, true);
    assert.equal(verifyProviderChain(forwarder.card.independence), anchor.keyId);
    assert.equal(verifyProviderQuote(forwarder.card.independence), leaf.keyId);

    // Inference through the forwarder is the enclave's inference.
    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "who sees the weights?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });
    const viaEnclave = (await (await ask(enclave.url)).json()) as { choices: Array<{ message: { content: string } }> };
    const viaForwarder = (await (await ask(forwarder.url)).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(viaForwarder.choices[0]!.message.content, viaEnclave.choices[0]!.message.content);
    assert.ok(viaForwarder.choices[0]!.message.content.length > 0);

    // An enclave started with the wrong key refuses the bundle.
    await assert.rejects(
      startProvider({
        bundle,
        registry: reg.base,
        stateDir: join(reg.root, "wrong-enclave"),
        port: 0,
        enclaveKey: otherKey,
      }),
      /does not unwrap/,
    );
  } finally {
    if (forwarder !== null) await forwarder.close();
    if (enclave !== null) await enclave.close();
    await reg.close();
  }
});

test("an enclave's attestation binds the encryption key a caller seals to", async () => {
  const enclave = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const impostor = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueMeasuredBootChain(leaf.publicKey, { app: runtimeCodeMeasurement() });

  const sealKey = generateSealKey();
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: enclave.publicKey,
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: enclave.privateKey,
      teeSigner: leaf,
      teeChain: chain,
    });

    const attestation = (await (await fetch(`${provider.url}/v1/attestation`)).json()) as {
      attestation: { enclaveKey?: string; quote?: unknown };
      enclavePublicKey: string;
    };
    assert.match(attestation.enclavePublicKey, /BEGIN PUBLIC KEY/);
    // The signed attestation carries the digest of the very key it published, and
    // the quote covers it, so a caller can check before encrypting anything.
    assert.equal(attestation.attestation.enclaveKey, enclaveKeyDigest(attestation.enclavePublicKey));
    assert.equal(verifyProviderQuote(attestation.attestation), leaf.keyId);
    assert.equal(attestationBindsEnclaveKey(attestation.attestation, attestation.enclavePublicKey), true);
    // A key the operator does not hold — a man in the middle — is refused.
    assert.equal(attestationBindsEnclaveKey(attestation.attestation, impostor.publicKey), false);
    assert.notEqual(enclaveKeyDigest(impostor.publicKey), attestation.attestation.enclaveKey);
    // The card carries the same binding.
    const card = await fetchProviderCard({ endpoint: provider.url });
    assert.deepEqual(verifyProviderCard(card), []);
    assert.equal(attestationBindsEnclaveKey(card.independence, attestation.enclavePublicKey), true);
    assert.equal(attestationBindsEnclaveKey(card.independence, impostor.publicKey), false);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a deployment can demand vendor-certified memory isolation, refusing a host-readable enclave", async () => {
  const reg = await registry();
  let isolated: Awaited<ReturnType<typeof startProvider>> | null = null;
  let plain: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const code = runtimeCodeMeasurement();

    // A vendor-signed image manifest that CERTIFIES host-root-excluded isolation,
    // and one that does not. Both chain to the shipped hardware root.
    const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const manifestChain = issueHardwareChain(manifestLeaf.publicKey).chain;
    const isolatedManifest = signImageManifest(
      { image: code, runtime: "rarext-runtime", isolation: "host-root-excluded" },
      manifestLeaf,
      manifestChain,
    );
    const hostReadableManifest = signImageManifest(
      { image: code, runtime: "rarext-runtime" },
      manifestLeaf,
      manifestChain,
    );
    assert.equal(verifyImageManifest(isolatedManifest)?.isolation, "host-root-excluded");
    assert.equal(verifyImageManifest(hostReadableManifest)?.isolation, null);

    const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const teeChain = issueHardwareChain(leaf.publicKey).chain;
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    isolated = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "isolated"),
      port: 0,
      machine: "iso-machine",
      isolation: "host-root-excluded",
      codeMeasurement: code,
      imageManifest: isolatedManifest,
      enclaveKey: rsa.privateKey,
      teeSigner: leaf,
      teeChain,
    });
    const card = await fetchProviderCard({ endpoint: isolated.url });
    assert.deepEqual(verifyProviderCard(card), []);
    assert.equal(card.independence?.isolation, "host-root-excluded");
    assert.equal(verifyProviderQuote(card.independence), leaf.keyId);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: isolated.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(isolated.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: isolated.url,
          operators: card.provider.keyId!,
          machines: "iso-machine",
          independence: "machine",
          quorum: "1",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          teeSignedImageDepth: "2",
          teeCodeMeasurement: code,
          teeIsolation: "host-root-excluded",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeIsolation, "host-root-excluded");

    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "isolated?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [isolated.url],
      quorum: 1,
      operators: { [isolated.url]: card.provider.keyId! },
      machines: { [isolated.url]: "iso-machine" },
      attestations: { [isolated.url]: card.independence! },
    });
    const ok = await ask(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.equal(body.quorum!.providers[0]!.attestation!.isolation, "host-root-excluded");
    assert.ok(verified.details.checks.includes("quorum"));

    // A recorded attestation that drops the isolation capability is refused: the
    // deployment demanded a vendor-certified host-root-excluded memory.
    const dropped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => ({
          ...entry,
          attestation: { ...entry.attestation!, isolation: undefined },
        })),
      },
    };
    assert.equal(verifyRunBody(dropped, spec).correct, false);

    await gateway.close();
    gateway = null;

    // A software-only provider — a vendor-signed image WITHOUT the isolation
    // capability — cannot satisfy the demand, even though its quote chains to the
    // pinned root.
    plain = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "plain"),
      port: 0,
      machine: "plain-machine",
      codeMeasurement: code,
      imageManifest: hostReadableManifest,
      teeSigner: leaf,
      teeChain,
    });
    const plainCard = await fetchProviderCard({ endpoint: plain.url });
    assert.equal(verifyProviderQuote(plainCard.independence), leaf.keyId);
    assert.equal(plainCard.independence?.isolation, undefined);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-plain"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [plain.url],
      quorum: 1,
      operators: { [plain.url]: plainCard.provider.keyId! },
      machines: { [plain.url]: "plain-machine" },
      attestations: { [plain.url]: plainCard.independence! },
    });
    const refused = await ask(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(
      ((await refused.json()) as { error: string }).error,
      /unverifiable machine quote/,
    );
    assert.equal(new RunLedger(join(reg.root, "gateway-plain")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (isolated !== null) await isolated.close();
    if (plain !== null) await plain.close();
    await reg.close();
  }
});

test("a run that commits an engine must have a provider receipt that signs it", async () => {
  const enclave = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sealKey = generateSealKey();
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueMeasuredBootChain(leaf.publicKey, { app: runtimeCodeMeasurement() });

  const reg = await registry();
  let enclaveNode: Awaited<ReturnType<typeof startProvider>> | null = null;
  let forwarder: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: enclave.publicKey,
    });
    const manifestHash = (await uploadBundle({ registry: reg.base, bundle, chunks })).manifestHash;

    enclaveNode = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: enclave.privateKey,
      teeSigner: leaf,
      teeChain: chain,
    });
    // The forwarder runs no engine of its own, so its receipts omit `engine`.
    forwarder = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "forwarder"),
      port: 0,
      enclaveEndpoint: enclaveNode.url,
    });
    const enclaveEngine = ((await (await fetch(`${enclaveNode.url}/health`)).json()) as {
      engineFingerprint: string;
    }).engineFingerprint;
    const forwarderKeyId = forwarder.card.provider.keyId!;

    const deploy = (engineFingerprint: string | null) =>
      commitDeployment(
        buildDeployment({
          probe: {
            engine: { name: "openai-compatible", version: "web4", endpoint: forwarder!.url },
            model: forwarder!.card.model,
            apis: ["openai"],
            models: [forwarder!.card.model],
          },
          hardware: hardwareFromNetwork(forwarder!.url),
          placement: "web4",
          labels: {
            execution: "web4",
            bundle: bundle.digest,
            shardsRoot: bundle.shardsRoot,
            manifestHash,
            providers: forwarder!.url,
            operators: forwarderKeyId,
            quorum: "1",
            ...(engineFingerprint === null ? {} : { engineFingerprint }),
            fixture: "loopback",
          },
          createdAt: "2026-11-07T00:00:00.000Z",
        }),
      );

    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: forwarder!.card.model.id,
          messages: [{ role: "user", content: "which engine?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 2,
        }),
      });

    // No engine committed: the run is fine even though the receipt omits it.
    const loose = deploy(null);
    assert.deepEqual(validateDeployment(loose), []);
    gateway = await startGateway({
      deployment: loose,
      ledgerDir: join(reg.root, "gateway-loose"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [forwarder.url],
      quorum: 1,
      operators: { [forwarder.url]: forwarderKeyId },
    });
    assert.equal((await ask(gateway.url)).status, 200);
    const looseBody = new RunLedger(join(reg.root, "gateway-loose")).records()[0]!.body;
    assert.equal(verifyRunBody(looseBody, runSpecFromChallenge(challengeFor(loose))).correct, true);
    await gateway.close();
    gateway = null;

    // The SAME run, but the deployment commits an engine the receipt does not
    // sign: the run claims an engine no agreeing provider attested, and is refused.
    const strict = deploy(enclaveEngine);
    assert.deepEqual(validateDeployment(strict), []);
    gateway = await startGateway({
      deployment: strict,
      ledgerDir: join(reg.root, "gateway-strict"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [forwarder.url],
      quorum: 1,
      operators: { [forwarder.url]: forwarderKeyId },
    });
    assert.equal((await ask(gateway.url)).status, 200);
    const strictBody = new RunLedger(join(reg.root, "gateway-strict")).records()[0]!.body;
    assert.equal(strictBody.engine.fingerprint, enclaveEngine);
    assert.equal(
      (strictBody.quorum!.providers[0]!.receipt as { engine?: string }).engine,
      undefined,
      "the forwarding provider's receipt omits the engine",
    );
    const verdict = verifyRunBody(strictBody, runSpecFromChallenge(challengeFor(strict)));
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (forwarder !== null) await forwarder.close();
    if (enclaveNode !== null) await enclaveNode.close();
    await reg.close();
  }
});

test("a sealed prompt is answered without the forwarder ever seeing plaintext", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sealKey = generateSealKey();
  const reg = await registry();
  let enclave: Awaited<ReturnType<typeof startProvider>> | null = null;
  let forwarder: Awaited<ReturnType<typeof startProvider>> | null = null;
  let plain: Awaited<ReturnType<typeof startProvider>> | null = null;
  const forwardedBodies: string[] = [];
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
      sealKey,
      wrapPublicKey: publicKey,
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    enclave = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "enclave"),
      port: 0,
      enclaveKey: privateKey,
    });

    // A fetch seam that records exactly what the forwarder relays to the enclave.
    const capturingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/chat/completions") && typeof init?.body === "string") {
        forwardedBodies.push(init.body);
      }
      return fetch(input, init);
    };
    forwarder = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "forwarder"),
      port: 0,
      enclaveEndpoint: enclave.url,
      fetchImpl: capturingFetch,
    });

    // The enclave publishes the key a caller seals to.
    const attestation = (await (await fetch(`${enclave.url}/v1/attestation`)).json()) as {
      enclavePublicKey: string;
    };
    assert.match(attestation.enclavePublicKey, /BEGIN PUBLIC KEY/);

    const secret = "TOP SECRET PROMPT";
    const request = {
      model: bundle.model.id,
      messages: [{ role: "user", content: secret }],
      max_tokens: 8,
      temperature: 0,
    };
    const { sealed, key } = sealRequest(attestation.enclavePublicKey, request);

    // The caller posts ciphertext to the FORWARDER, which holds no key.
    const response = await fetch(`${forwarder.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, confidential: sealed }),
    });
    assert.equal(response.status, 200);
    const sealedResponse = (await response.json()) as { confidential: { nonce: string; ciphertext: string } };
    assert.ok(sealedResponse.confidential, "the answer comes back sealed");
    const answer = openResponse(key, sealedResponse.confidential) as {
      choices: Array<{ message: { content: string } }>;
    };

    // The same prompt asked in the clear yields the same answer...
    const plainResponse = await fetch(`${enclave.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const plainJson = (await plainResponse.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(answer.choices[0]!.message.content, plainJson.choices[0]!.message.content);

    // ... and what the forwarder relayed never contained the secret.
    assert.equal(forwardedBodies.length, 1);
    assert.equal(forwardedBodies[0]!.includes(secret), false, "the forwarder never sees the prompt");
    assert.match(forwardedBodies[0]!, /"confidential"/);

    // A provider with no enclave key refuses a confidential request by name.
    const plainBundle = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    await uploadBundle({ registry: reg.base, bundle: plainBundle.bundle, chunks: plainBundle.chunks });
    plain = await startProvider({
      bundle: plainBundle.bundle,
      registry: reg.base,
      stateDir: join(reg.root, "plain"),
      port: 0,
    });
    const refused = await fetch(`${plain.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: plainBundle.bundle.model.id, confidential: sealed }),
    });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /no enclave key/);
  } finally {
    if (plain !== null) await plain.close();
    if (forwarder !== null) await forwarder.close();
    if (enclave !== null) await enclave.close();
    await reg.close();
  }
});

test("a machine quote must chain from a hardware (vendor) root of trust", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueHardwareChain(leaf.publicKey);
  assert.equal(chain.length, 2, "leaf -> platform -> vendor root");

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "a"),
      port: 0,
      teeSigner: leaf,
      teeChain: chain,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      teeSigner: leaf,
      teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    // The leaf signs; the chain reaches the SHIPPED vendor root, depth two.
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderChain(cardA.independence), HARDWARE_ROOT_KEY_ID);
    assert.equal(providerChainDepth(cardA.independence), 2);

    // A leaf-only attestation is valid but NOT hardware-rooted: depth zero, and
    // its root is the leaf, not the vendor.
    const leafOnly = {
      ...cardA.independence!,
      quote: {
        signature: cardA.independence!.quote!.signature,
        publicKey: cardA.independence!.quote!.publicKey,
        suite: cardA.independence!.quote!.suite,
      },
    };
    assert.equal(providerChainDepth(leafOnly), 0);
    assert.notEqual(verifyProviderChain(leafOnly), HARDWARE_ROOT_KEY_ID);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          // Pinned to the vendor hardware root, requiring a depth-2 chain.
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeVendor, HARDWARE_ROOT_KEY_ID);
    assert.equal(spec.teeChainDepth, 2);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "hardware rooted?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A leaf-only attestation cannot meet a hardware-rooted quorum.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-leaf"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: leafOnly, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // The vendor-rooted chain satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the depth rule: a leaf-only attestation fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: leafOnly } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a quote's root can rotate, and a stale or revoked root is refused", async () => {
  // The vendor rotates its root. The retirement step is signed by the OLD root,
  // so authority flows from the shipped anchor forward; an unrelated key cannot
  // claim the new root.
  const newRoot = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const rotation = issueRootRotation({
    fromSigner: hardwareRootSigner(),
    nextSigner: newRoot,
    epoch: 1,
    previous: null,
    issuedAt: "2026-11-07T00:00:00.000Z",
  });
  const rootChain = {
    kind: ROOT_CHAIN_KIND as typeof ROOT_CHAIN_KIND,
    anchor: HARDWARE_ROOT_KEY_ID,
    rotations: [rotation],
  };
  const verified = verifyRootChain(rootChain, HARDWARE_ROOT_KEY_ID);
  assert.ok(verified, "the rotation chain verifies from the pinned anchor");
  assert.equal(verified.current, newRoot.keyId);
  assert.equal(verified.epoch, 1);

  // A certificate chain that terminates at the NEW root.
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const platform = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const rotatedChain = [
    issueProviderCertificate({ subject: leaf.publicKey, issuerSigner: platform }),
    issueProviderCertificate({ subject: platform.publicKey, issuerSigner: newRoot }),
  ];

  const reg = await registry();
  let rotated: Awaited<ReturnType<typeof startProvider>> | null = null;
  let stale: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    rotated = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "rotated"),
      port: 0,
      teeSigner: leaf,
      teeChain: rotatedChain,
      teeRootChain: rootChain,
    });
    stale = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "stale"),
      port: 0,
      teeSigner: leaf,
      teeChain: issueHardwareChain(leaf.publicKey).chain,
    });
    const rotatedCard = await fetchProviderCard({ endpoint: rotated.url });
    const staleCard = await fetchProviderCard({ endpoint: stale.url });

    // The rotated quote terminates at the CURRENT root and reaches epoch 1.
    assert.deepEqual(verifyProviderCard(rotatedCard), []);
    assert.equal(verifyProviderChain(rotatedCard.independence), newRoot.keyId);
    const rooted = verifyProviderRootChain(rotatedCard.independence, HARDWARE_ROOT_KEY_ID, 1);
    assert.ok(rooted);
    assert.equal(rooted.current, newRoot.keyId);
    assert.equal(rooted.epoch, 1);

    // A quote that still terminates at the retired anchor is STALE once the
    // deployment has learned the rotation; at epoch 0 it is still accepted.
    assert.equal(verifyProviderRootChain(staleCard.independence, HARDWARE_ROOT_KEY_ID, 0)?.current, HARDWARE_ROOT_KEY_ID);
    assert.equal(verifyProviderRootChain(staleCard.independence, HARDWARE_ROOT_KEY_ID, 1), null);

    // Revoking the new root refuses every quote that terminates at it, even
    // though the chain still reaches it.
    const revokedRotation = issueRootRotation({
      fromSigner: hardwareRootSigner(),
      nextSigner: newRoot,
      epoch: 1,
      previous: null,
      revoke: [newRoot.keyId],
    });
    const revokedCard = {
      ...rotatedCard.independence!,
      quote: {
        ...rotatedCard.independence!.quote!,
        rootChain: {
          kind: ROOT_CHAIN_KIND as typeof ROOT_CHAIN_KIND,
          anchor: HARDWARE_ROOT_KEY_ID,
          rotations: [revokedRotation],
        },
      },
    };
    assert.equal(verifyProviderRootChain(revokedCard, HARDWARE_ROOT_KEY_ID, 1), null);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: rotated.url },
          model: rotatedCard.model,
          apis: ["openai"],
          models: [rotatedCard.model],
        },
        hardware: hardwareFromNetwork(rotated.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: rotated.url,
          operators: rotatedCard.provider.keyId!,
          quorum: "1",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "2",
          teeRootEpoch: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeRootEpoch, 1);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "rotated root?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The rotated provider satisfies the pinned epoch.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-rotated"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [rotated.url],
      quorum: 1,
      operators: { [rotated.url]: rotatedCard.provider.keyId! },
      attestations: { [rotated.url]: rotatedCard.independence! },
    });
    const accepted = await request(gateway.url);
    assert.equal(accepted.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-rotated")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A quote still rooted at the retired anchor is refused as stale.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-stale"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [stale.url],
      quorum: 1,
      operators: { [stale.url]: staleCard.provider.keyId! },
      attestations: { [stale.url]: staleCard.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (rotated !== null) await rotated.close();
    if (stale !== null) await stale.close();
    await reg.close();
  }
});

test("a quote must extend a measured-boot chain through every required stage", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, stages } = issueMeasuredBootChain(leaf.publicKey);
  assert.equal(chain.length, 3, "app -> os -> firmware -> vendor root");
  assert.deepEqual(stages, ["app", "os", "firmware"]);

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    second = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });

    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyProviderChain(cardA.independence), HARDWARE_ROOT_KEY_ID);
    assert.equal(providerChainDepth(cardA.independence), 3);
    assert.deepEqual(providerBootStages(cardA.independence).sort(), ["app", "firmware", "os"]);

    // A chain with no stages at all: it reaches the vendor root but never
    // measured the boot.
    const { chain: stagelessChain } = issueHardwareChain(leaf.publicKey);
    const stageless = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: stagelessChain },
    };
    assert.equal(providerBootStages(stageless).includes("firmware"), false);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.deepEqual(spec.teeBootStages, ["firmware", "os", "app"]);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "measured boot?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A chain that omits the boot stages cannot meet the quorum.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-stageless"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: stageless, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // The measured-boot chain satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the stage rule: a stageless chain fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: stageless } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a deployment pins per-stage measurements, refusing unapproved firmware/os/app", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey);
  for (const value of Object.values(measurements)) assert.match(value, /^[0-9a-f]{64}$/);

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    second = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    assert.deepEqual(providerStageMeasurements(cardA.independence), {
      app: measurements.app,
      os: measurements.os,
      firmware: measurements.firmware,
    });

    // A chain running different firmware: its firmware measurement is not approved.
    const { chain: otherFirmware } = issueMeasuredBootChain(leaf.publicKey, {
      firmware: "0".repeat(64),
    });
    const wrongMeasure = {
      ...cardA.independence!,
      quote: { ...cardA.independence!.quote!, chain: otherFirmware },
    };
    assert.equal(providerStageMeasurements(wrongMeasure).firmware, "0".repeat(64));
    assert.notEqual(providerStageMeasurements(wrongMeasure).firmware, measurements.firmware);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeStageMeasurements!.firmware, measurements.firmware);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "measured?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-wrong"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: wrongMeasure, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: wrongMeasure } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a deterministic run records its decode trace, and replay refuses a divergence", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "trace me" }],
        max_tokens: 8,
        temperature: 0,
        seed: 7,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const trace = (body.response.body as { rarext_trace?: { kind: string; tokens: number[]; digest: string } })
      .rarext_trace;
    assert.ok(trace, "a deterministic run records its decode trace");
    assert.equal(trace!.kind, "rarext.decode-trace.v1");
    assert.ok(trace!.tokens.length > 0);
    assert.match(trace!.digest, /^[0-9a-f]{64}$/);
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Editing the tokens moves the trace digest, which the verifier recomputes.
    const tampered = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, tokens: [...trace!.tokens, 1] },
        },
      },
    };
    assert.equal(verifyRunBody(tampered, spec).correct, false);

    // Replay reproduces the output AND matches the trace.
    const good = await replayEngineRun({ body, endpoint: provider.url });
    assert.equal(good.reproduced, true, good.reason ?? "");
    assert.equal(good.traceMatches, true);
    assert.equal(good.ok, true);

    // A recorded trace the re-execution does not reproduce is refused by name.
    const diverged = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, digest: "0".repeat(64) },
        },
      },
    };
    const bad = await replayEngineRun({ body: diverged, endpoint: provider.url });
    assert.equal(bad.traceMatches, false);
    assert.equal(bad.ok, false);
    assert.match(bad.reason ?? "", /decode trace diverged/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a freshness challenge refuses a replayed attestation", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey);
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    second = await startProvider({
      bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: chain,
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });

    // The provider answers a nonce with a freshly-signed quote bound to it.
    const nonce = "ab".repeat(32);
    const challenged = (await (
      await fetch(`${first.url}/v1/attestation?nonce=${nonce}`)
    ).json()) as { attestation: { challenge?: string; quote?: unknown } };
    assert.equal(challenged.attestation.challenge, nonce);
    assert.ok(challenged.attestation.quote);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeFreshness: "challenge",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeFreshness, "challenge");

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "fresh?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The gateway challenges each provider and records the bound nonce.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    const nonces = body.quorum!.providers.map((entry) => entry.attestation?.challenge);
    assert.ok(nonces.every((value) => typeof value === "string" && value !== ""));
    assert.equal(new Set(nonces).size, 1, "one run, one nonce");
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // The verifier recomputes freshness: a provider bound to another nonce (or
    // none) fails.
    const diverged = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: { ...entry.attestation, challenge: "cd".repeat(32) } } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(diverged, spec).correct, false);
    const missing = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry) => {
          const { challenge: _challenge, ...rest } = entry.attestation!;
          return { ...entry, attestation: rest };
        }),
      },
    };
    assert.equal(verifyRunBody(missing, spec).correct, false);

    // A provider that answers the challenge with a STALE (unchallenged) quote is
    // refused before a run is written.
    const staleFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/attestation?nonce=")) {
        return new Response(JSON.stringify({ attestation: cardA.independence }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(input, init);
    };
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-stale"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      fetchImpl: staleFetch,
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-stale")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("an engine run records a token-logprob judgment, and replay checks it", async () => {
  // A stub engine that returns per-token logprobs, the way Ollama does.
  const stub = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "cmpl",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello world" },
              finish_reason: "stop",
              logprobs: {
                content: [
                  { token: "hello", logprob: -0.1 },
                  { token: " world", logprob: -0.2 },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = (stub.address() as AddressInfo).port;
  const stubUrl = `http://127.0.0.1:${stubPort}`;

  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: Buffer.from("GGUF-fake-for-the-judgment-test"),
      model: { ...NATIVE_REF, id: "engine-judge", format: "gguf", weightsDigest: null },
      execution: { kind: "engine", engine: "ollama", engineModel: "judge" },
      chunkBytes: 8,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "engine"),
      port: 0,
      engineEndpoint: stubUrl,
      engineCreate: async () => {},
      engineLogprobs: true,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash: bundleManifestHash(bundle),
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "judge me" }],
        max_tokens: 4,
        temperature: 0,
        seed: 7,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const trace = (body.response.body as { rarext_trace?: { kind: string; tokens: string[]; logprobs: number[]; digest: string } })
      .rarext_trace;
    assert.ok(trace, "an engine run records its judgment");
    assert.equal(trace!.kind, "rarext.judgment.v1");
    assert.deepEqual(trace!.tokens, ["hello", " world"]);
    assert.deepEqual(trace!.logprobs, [-0.1, -0.2]);
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Editing a logprob moves the digest, which the verifier recomputes.
    const tampered = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, logprobs: [-0.1, -0.9] },
        },
      },
    };
    assert.equal(verifyRunBody(tampered, spec).correct, false);

    // Replay reproduces the text AND the judgment.
    const good = await replayEngineRun({ body, endpoint: provider.url });
    assert.equal(good.reproduced, true, good.reason ?? "");
    assert.equal(good.traceMatches, true);
    assert.equal(good.ok, true);

    const diverged = {
      ...body,
      response: {
        ...body.response,
        body: {
          ...(body.response.body as Record<string, unknown>),
          rarext_trace: { ...trace!, digest: "0".repeat(64) },
        },
      },
    };
    const bad = await replayEngineRun({ body: diverged, endpoint: provider.url });
    assert.equal(bad.traceMatches, false);
    assert.match(bad.reason ?? "", /decode trace diverged/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("a deployment pins the enclave's code measurement, refusing other code", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey);
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a") });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b") });
    // A provider running different code (a different code measurement).
    other = await startProvider({
      ...common,
      stateDir: join(reg.root, "c"),
      codeMeasurement: "0".repeat(64),
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardC = await fetchProviderCard({ endpoint: other.url });
    assert.match(cardA.independence!.code!, /^[0-9a-f]{64}$/);
    assert.equal(cardA.independence!.code, cardB.independence!.code, "same code, same measurement");
    assert.equal(cardC.independence!.code, "0".repeat(64));

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: cardA.independence!.code!,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeCodeMeasurement, cardA.independence!.code);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "code?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The provider running other code is refused before a run is written.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-wrong"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardC.independence!, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-wrong")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The approved code satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.ok(body.quorum!.providers.every((entry) => entry.attestation?.code === cardA.independence!.code));
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes it: swapping in another code fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: { ...entry.attestation, code: "0".repeat(64) } } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("an enclave's image is bound to a vendor-signed manifest", async () => {
  const code = runtimeCodeMeasurement();
  const vendorSigner = hardwareRootSigner();
  const manifest = signImageManifest({ image: code, runtime: "rarext-runtime" }, vendorSigner);
  assert.equal(verifyImageManifest(manifest)?.vendorKeyId, HARDWARE_ROOT_KEY_ID);

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // The measured boot's app stage IS the signed image, so the two attestations agree.
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let foreignProvider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain, imageManifest: manifest };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a") });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b") });

    // A manifest signed by another vendor: valid, but not the pinned vendor.
    const attacker = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const foreign = signImageManifest({ image: code, runtime: "rarext-runtime" }, attacker);
    foreignProvider = await startProvider({ ...common, stateDir: join(reg.root, "c"), imageManifest: foreign });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardC = await fetchProviderCard({ endpoint: foreignProvider.url });
    assert.equal(cardA.independence?.code, code);
    assert.ok(cardA.independence?.image);
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyImageManifest(cardC.independence?.image)?.vendorKeyId, attacker.keyId);

    // A manifest whose image is not the running code refuses to start.
    const wrongImage = signImageManifest({ image: "0".repeat(64), runtime: "x" }, vendorSigner);
    await assert.rejects(
      startProvider({ ...common, stateDir: join(reg.root, "wrong"), imageManifest: wrongImage }),
      /not the signed image/,
    );

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeSignedImage, HARDWARE_ROOT_KEY_ID);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "signed image?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // An image signed by another vendor cannot meet the quorum.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-foreign"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardC.independence!, [second.url]: cardB.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    await gateway.close();
    gateway = null;

    // The vendor-signed image satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-ok"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-ok")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes it: a foreign-signed image fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: { ...entry.attestation, image: foreign } } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (foreignProvider !== null) await foreignProvider.close();
    await reg.close();
  }
});

test("an image manifest's chain must terminate at the pinned hardware root", async () => {
  const code = runtimeCodeMeasurement();
  // The manifest signer is a LEAF, certified up to the shipped hardware root.
  const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain: manifestChain } = issueHardwareChain(manifestLeaf.publicKey);
  const chained = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf, manifestChain);
  // The SAME leaf, signed with no chain: a real signature, but self-rooted.
  const bare = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf);

  const chainedInfo = verifyImageManifest(chained)!;
  assert.equal(chainedInfo.vendorKeyId, manifestLeaf.keyId, "the signer is the leaf");
  assert.equal(chainedInfo.rootKeyId, HARDWARE_ROOT_KEY_ID, "and its chain reaches the hardware root");
  const bareInfo = verifyImageManifest(bare)!;
  assert.equal(bareInfo.vendorKeyId, manifestLeaf.keyId, "same signer");
  assert.equal(bareInfo.rootKeyId, manifestLeaf.keyId, "but a bare leaf is its own root");
  assert.notEqual(bareInfo.rootKeyId, HARDWARE_ROOT_KEY_ID);

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // The app stage must equal the signed image for these attestations to cohere.
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let bareProvider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a"), imageManifest: chained });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b"), imageManifest: chained });
    // A provider whose manifest is real but self-rooted (no chain to the anchor).
    bareProvider = await startProvider({ ...common, stateDir: join(reg.root, "bare"), imageManifest: bare });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardBare = await fetchProviderCard({ endpoint: bareProvider.url });
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyImageManifest(cardA.independence?.image)?.rootKeyId, HARDWARE_ROOT_KEY_ID);
    assert.equal(verifyImageManifest(cardBare.independence?.image)?.rootKeyId, manifestLeaf.keyId);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeSignedImage, HARDWARE_ROOT_KEY_ID);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "rooted image?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A self-rooted (bare-leaf) manifest cannot meet a hardware-rooted pin.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-bare"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, bareProvider.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [bareProvider.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [bareProvider.url]: cardBare.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-bare")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The chain that reaches the pinned root satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-rooted"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-rooted")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the chain: swapping in the bare-leaf manifest fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: cardBare.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (bareProvider !== null) await bareProvider.close();
    await reg.close();
  }
});

test("a pinned image-chain depth refuses a manifest signed directly by the root", async () => {
  const code = runtimeCodeMeasurement();
  // Signed directly by the anchor: the root matches, but the chain is empty.
  const rootSigned = signImageManifest({ image: code, runtime: "rarext-runtime" }, hardwareRootSigner());
  // Signed by a leaf CERTIFIED by the anchor: a real chain.
  const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain: manifestChain } = issueHardwareChain(manifestLeaf.publicKey);
  const chained = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf, manifestChain);

  const rootInfo = verifyImageManifest(rootSigned)!;
  assert.equal(rootInfo.rootKeyId, HARDWARE_ROOT_KEY_ID, "the root-signed manifest reaches the anchor");
  assert.equal(rootInfo.chainDepth, 0, "but it presents no chain");
  assert.equal(verifyImageManifest(chained)!.chainDepth, 2, "the certified leaf presents a chain");

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain, measurements } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let rootProvider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    const common = { bundle, registry: reg.base, port: 0, teeSigner: leaf, teeChain: chain };
    first = await startProvider({ ...common, stateDir: join(reg.root, "a"), imageManifest: chained });
    second = await startProvider({ ...common, stateDir: join(reg.root, "b"), imageManifest: chained });
    rootProvider = await startProvider({ ...common, stateDir: join(reg.root, "root"), imageManifest: rootSigned });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardRoot = await fetchProviderCard({ endpoint: rootProvider.url });
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(verifyImageManifest(cardRoot.independence?.image)?.chainDepth, 0);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeStageMeasurements: `firmware=${measurements.firmware},os=${measurements.os},app=${measurements.app}`,
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          teeSignedImageDepth: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.teeSignedImage, HARDWARE_ROOT_KEY_ID);
    assert.equal(spec.teeSignedImageDepth, 1);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "depth?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // A depth-0 manifest that reaches the pinned root cannot meet a depth-≥1 pin.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-shallow"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, rootProvider.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [rootProvider.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [rootProvider.url]: cardRoot.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-shallow")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The certified chain meets the depth.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-deep"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-deep")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the depth: swapping in the depth-0 manifest fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: cardRoot.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (rootProvider !== null) await rootProvider.close();
    await reg.close();
  }
});

test("the measured boot's app stage must equal the signed image", async () => {
  const code = runtimeCodeMeasurement();
  // A signed image for `code`, chained to the shipped hardware root.
  const manifestLeaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain: manifestChain } = issueHardwareChain(manifestLeaf.publicKey);
  const manifest = signImageManifest({ image: code, runtime: "rarext-runtime" }, manifestLeaf, manifestChain);

  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  // A coherent boot chain: its app stage IS the signed image.
  const { chain: coherentChain } = issueMeasuredBootChain(leaf.publicKey, { app: code });
  // An incoherent one: the app stage is some OTHER measurement.
  const { chain: incoherentChain } = issueMeasuredBootChain(leaf.publicKey, { app: "0".repeat(64) });

  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let incoherent: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0, teeSigner: leaf, teeChain: coherentChain, imageManifest: manifest });
    second = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0, teeSigner: leaf, teeChain: coherentChain, imageManifest: manifest });
    incoherent = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "c"), port: 0, teeSigner: leaf, teeChain: incoherentChain, imageManifest: manifest });

    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: second.url });
    const cardC = await fetchProviderCard({ endpoint: incoherent.url });
    assert.deepEqual(verifyProviderCard(cardA), []);
    assert.equal(providerStageMeasurements(cardA.independence).app, code);
    assert.equal(providerStageMeasurements(cardC.independence).app, "0".repeat(64));

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          operators: "operator-a,operator-b",
          quorum: "2",
          teeVendor: HARDWARE_ROOT_KEY_ID,
          teeChainDepth: "3",
          teeBootStages: "firmware,os,app",
          teeCodeMeasurement: code,
          teeSignedImage: HARDWARE_ROOT_KEY_ID,
          teeSignedImageDepth: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "app == image?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });

    // The incoherent chain measures a different app than the signed image.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-incoherent"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, incoherent.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [incoherent.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [incoherent.url]: cardC.independence! },
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /unverifiable machine quote/);
    assert.equal(new RunLedger(join(reg.root, "gateway-incoherent")).records().length, 0);
    await gateway.close();
    gateway = null;

    // The coherent chain (app == image) satisfies it.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-coherent"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      operators: { [first.url]: "operator-a", [second.url]: "operator-b" },
      attestations: { [first.url]: cardA.independence!, [second.url]: cardB.independence! },
    });
    const ok = await request(gateway.url);
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-coherent")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // The verifier recomputes the binding: swapping in the incoherent chain fails.
    const swapped = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((entry, index) =>
          index === 0 ? { ...entry, attestation: cardC.independence! } : entry,
        ),
      },
    };
    assert.equal(verifyRunBody(swapped, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    if (incoherent !== null) await incoherent.close();
    await reg.close();
  }
});

test("a deployment that requires a decode trace refuses a run without one", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          trace: "required",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.requireTrace, true);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "trace required?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 5,
        }),
      });

    // The native provider emits a trace, so the run is written and verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.ok((body.response.body as { rarext_trace?: unknown }).rarext_trace);
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true);
    // The committed requirement is what the verifier checked, and it passed.
    assert.ok(verified.details.checks.includes("response.decodeTraceRequired"));

    // A run whose response lacks the trace fails that very check.
    const stripped = {
      ...body,
      response: {
        ...body.response,
        body: Object.fromEntries(
          Object.entries(body.response.body as Record<string, unknown>).filter(
            ([key]) => key !== "rarext_trace",
          ),
        ),
      },
    };
    const strippedVerdict = verifyRunBody(stripped, spec);
    assert.equal(strippedVerdict.correct, false);
    assert.ok(
      (strippedVerdict.proof as { failures: string[] }).failures.includes("response.decodeTraceRequired"),
    );
    // With no requirement, that check never runs, so its absence is not a failure.
    assert.equal(
      (verifyRunBody(stripped, { ...spec, requireTrace: undefined }).proof as { failures: string[] }).failures.includes(
        "response.decodeTraceRequired",
      ),
      false,
    );
    await gateway.close();
    gateway = null;

    // A gateway that receives a provider response with the trace stripped refuses
    // the run before writing it.
    const strippingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const json = (await response.json()) as Record<string, unknown>;
      delete (json as { rarext_trace?: unknown }).rarext_trace;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const receipt = response.headers.get("x-rarext-receipt");
      if (receipt !== null) headers["x-rarext-receipt"] = receipt;
      return new Response(JSON.stringify(json), { status: 200, headers });
    };
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-notrace"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
      fetchImpl: strippingFetch,
    });
    const refused = await request(gateway.url);
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /requires a decode trace/);
    assert.equal(new RunLedger(join(reg.root, "gateway-notrace")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a deployment that requires a replayable run refuses a sampled request", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: "operator-a",
          quorum: "1",
          replay: "required",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.requireReplay, true);

    const ask = (url: string, extra: Record<string, unknown>) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "reproducible?" }],
          max_tokens: 8,
          ...extra,
        }),
      });

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: "operator-a" },
    });

    // A sampled request (temperature > 0, or no seed) is refused before a run.
    const sampled = await ask(gateway.url, { temperature: 0.7, seed: 5 });
    assert.equal(sampled.status, 422);
    assert.match(((await sampled.json()) as { error: string }).error, /replayable run/);
    const unseeded = await ask(gateway.url, { temperature: 0 });
    assert.equal(unseeded.status, 422);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);

    // A deterministic request is recorded with a replay envelope and verifies.
    const ok = await ask(gateway.url, { temperature: 0, seed: 5 });
    assert.equal(ok.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.ok(body.replay, "the run carries a replay envelope");
    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true);
    assert.ok(verified.details.checks.includes("replay.required"));
    assert.equal((verified.proof as { replayable: boolean }).replayable, true);
    await gateway.close();
    gateway = null;

    // A run without the envelope fails the required-replay check.
    const sampledBody = { ...body, replay: null };
    const strippedVerdict = verifyRunBody(sampledBody, spec);
    assert.equal(strippedVerdict.correct, false);
    assert.ok((strippedVerdict.proof as { failures: string[] }).failures.includes("replay.required"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider's signed receipt binds the answer, catching a lying gateway", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "p"), port: 0 });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    // An honest gateway records the provider's own signature over the answer.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
    });
    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "receipt?" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });
    assert.equal((await request(gateway.url)).status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const receipt = body.quorum!.providers[0]!.receipt as { response: string; publicKey: unknown };
    assert.ok(receipt, "the run carries the provider's receipt");
    assert.equal(receipt.response, body.quorum!.providers[0]!.responseDigest);
    assert.equal(publicKeyId(receipt.publicKey as never), operatorKeyId);
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A gateway that rewrites the answer but keeps the provider's receipt is
    // caught: the receipt no longer matches the recorded response.
    const lyingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const header = response.headers.get("x-rarext-receipt");
      const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      json.choices[0]!.message.content = "a different answer";
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(header === null ? {} : { "x-rarext-receipt": header }),
        },
      });
    };
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-lie"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
      fetchImpl: lyingFetch,
    });
    assert.equal((await request(gateway.url)).status, 200);
    const liedBody = new RunLedger(join(reg.root, "gateway-lie")).records()[0]!.body;
    assert.equal(verifyRunBody(liedBody, spec).correct, false);
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a run that commits evidence is refused when an agreeing provider presents no receipt", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
    });
    assert.equal(
      (
        await fetch(`${gateway.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: deployment.model.id,
            messages: [{ role: "user", content: "who signed?" }],
            max_tokens: 8,
            temperature: 0,
          }),
        })
      ).status,
      200,
    );
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    // The run commits evidence: a model bundle no provider can be attributed to
    // without a signature.
    assert.equal(body.bundle?.digest, bundle.digest);
    assert.ok(body.quorum!.providers[0]!.receipt, "the honest run carries a receipt");
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Strip the agreeing provider's OWN receipt. Everything else still matches —
    // the exact request, the exact response, the operator, the run's committed
    // bundle — so this is precisely the unattributed run the strict rule exists
    // to refuse.
    const stripped = structuredClone(body);
    delete (stripped.quorum!.providers[0] as { receipt?: unknown }).receipt;
    assert.equal(stripped.quorum!.providers[0]!.receipt, undefined);
    const verdict = verifyRunBody(stripped, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a forged unsigned dissent cannot be admitted as quorum evidence", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
    });
    assert.equal(
      (
        await fetch(`${gateway.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: deployment.model.id,
            messages: [{ role: "user", content: "any dissent?" }],
            max_tokens: 8,
            temperature: 0,
          }),
        })
      ).status,
      200,
    );
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(verifyRunBody(body, spec).correct, true);

    // A gateway invents a dissenting provider — no signature, a different digest,
    // an endpoint the run never called — and raises `responded` to include it.
    // The disagreement is not paid (dissenters are not payees), so only the
    // receipt rule can refuse the padded evidence set.
    const padded = structuredClone(body);
    padded.quorum!.providers.push({
      endpoint: "http://127.0.0.1:1",
      responseDigest: "0".repeat(64),
      operator: "0".repeat(64),
      machine: null,
      measurement: null,
    });
    padded.quorum!.responded = padded.quorum!.providers.length;
    assert.equal(padded.quorum!.providers.length, 2);
    assert.equal(padded.quorum!.agreed, 1);
    const verdict = verifyRunBody(padded, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a non-quorum web4 run records its provider, and refuses an unsigned one", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    // No `quorum` label and no `quorum` option: this is the single-provider
    // path, where the run has no quorum evidence at all.
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.quorum, undefined);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      operators: { [provider.url]: operatorKeyId },
      attestations: { [provider.url]: card.independence! },
    });
    assert.equal(
      (
        await fetch(`${gateway.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: deployment.model.id,
            messages: [{ role: "user", content: "who answered?" }],
            max_tokens: 8,
            temperature: 0,
          }),
        })
      ).status,
      200,
    );
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    assert.equal(body.quorum, undefined);
    assert.ok(body.provider, "a non-quorum run names the one provider that answered");
    assert.equal(body.provider!.endpoint, provider.url);
    assert.equal(body.provider!.operator, operatorKeyId);
    assert.ok(body.provider!.attestation, "the observed attestation is recorded");
    assert.ok(body.provider!.receipt, "the provider's own receipt is recorded");
    assert.equal(verifyRunBody(body, spec).correct, true);

    // Strip the receipt: the run still commits a bundle, but no provider signed
    // it. Without the non-quorum rule this body would verify — the gap this
    // closes is exactly a single-provider run attributed to no one.
    const unsigned = structuredClone(body);
    delete (unsigned.provider as { receipt?: unknown }).receipt;
    const unsignedVerdict = verifyRunBody(unsigned, spec);
    assert.equal(unsignedVerdict.correct, false);
    assert.ok(
      (unsignedVerdict.proof as { failures: string[] }).failures.includes("provider.evidence"),
    );

    // And the provider block itself is required when evidence is committed.
    const naked = structuredClone(body);
    delete naked.provider;
    const nakedVerdict = verifyRunBody(naked, spec);
    assert.equal(nakedVerdict.correct, false);
    assert.ok((nakedVerdict.proof as { failures: string[] }).failures.includes("provider.evidence"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider's receipt binds its own attestation, not just the answer", async () => {
  const leaf = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const { chain } = issueMeasuredBootChain(leaf.publicKey, { app: runtimeCodeMeasurement() });
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "p"),
      port: 0,
      teeSigner: leaf,
      teeChain: chain,
    });
    const card = await fetchProviderCard({ endpoint: provider.url });
    const operatorKeyId = card.provider.keyId!;
    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: provider.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(provider.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: provider.url,
          operators: operatorKeyId,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    const spec = runSpecFromChallenge(challengeFor(deployment));

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [provider.url],
      quorum: 1,
      operators: { [provider.url]: operatorKeyId },
      // The gateway records the provider's attestation, so the receipt binds it.
      attestations: { [provider.url]: card.independence! },
    });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "which enclave?" }],
        max_tokens: 8,
        temperature: 0,
        seed: 3,
      }),
    });
    assert.equal(response.status, 200);
    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const entry = body.quorum!.providers[0]!;
    const receipt = entry.receipt as { attestation: string; response: string };
    assert.ok(entry.attestation, "the run records the provider's attestation");
    assert.equal(
      receipt.attestation,
      canonicalDigest(attestationForReceipt(entry.attestation)),
      "the receipt binds the attestation",
    );
    assert.equal(verifyRunBody(body, spec).correct, true);
    await gateway.close();
    gateway = null;

    // Pairing the genuine answer with a DIFFERENT attestation is caught: the
    // receipt's attestation digest no longer matches what the run records.
    const forged = {
      ...body,
      quorum: {
        ...body.quorum!,
        providers: body.quorum!.providers.map((p, index) =>
          index === 0 ? { ...p, attestation: { ...p.attestation, measurement: "0".repeat(64) } } : p,
        ),
      },
    };
    const forgedVerdict = verifyRunBody(forged, spec);
    assert.equal(forgedVerdict.correct, false);
    assert.ok((forgedVerdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a provider's receipt binds the engine it served with, so a verifier catches a changed engine", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({ bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    // A second provider on a DIFFERENT engine build.
    other = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "b"),
      port: 0,
      engineVersion: "other-engine",
    });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: other.url });
    const operatorA = cardA.provider.keyId!;
    const operatorB = cardB.provider.keyId!;
    const engineA = ((await (await fetch(`${first.url}/health`)).json()) as { engineFingerprint: string })
      .engineFingerprint;
    const engineB = ((await (await fetch(`${other.url}/health`)).json()) as { engineFingerprint: string })
      .engineFingerprint;
    assert.match(engineA, /^[0-9a-f]{64}$/);
    assert.notEqual(engineA, engineB);

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${other.url}`,
          // Both operators are committed so the two runs differ ONLY by engine.
          operators: `${operatorA},${operatorB}`,
          quorum: "1",
          engineFingerprint: engineA,
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.engineFingerprint, engineA);

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "which engine?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 9,
        }),
      });

    // The provider on the committed engine verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-a"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url],
      quorum: 1,
      operators: { [first.url]: operatorA },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const goodBody = new RunLedger(join(reg.root, "gateway-a")).records()[0]!.body;
    assert.equal(goodBody.engine.fingerprint, engineA);
    assert.equal((goodBody.quorum!.providers[0]!.receipt as { engine: string }).engine, engineA);
    assert.equal(verifyRunBody(goodBody, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A provider on a DIFFERENT engine is refused by the VERIFIER — no replay
    // needed — because its receipt signs the engine it actually served with.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-b"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [other.url],
      quorum: 1,
      operators: { [other.url]: operatorB },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const badBody = new RunLedger(join(reg.root, "gateway-b")).records()[0]!.body;
    assert.equal(badBody.engine.fingerprint, engineA, "the run records the committed engine");
    assert.equal((badBody.quorum!.providers[0]!.receipt as { engine: string }).engine, engineB);
    const verdict = verifyRunBody(badBody, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a provider's receipt binds the bundle it served, so a verifier catches other weights", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let other: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    // Two DIFFERENT bundles with the same model id.
    const bundleA = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    const bundleB = buildModelBundle({
      // A valid xorshift model with DIFFERENT parameters: same model id, other weights.
      bytes: Buffer.from(JSON.stringify({ ...NATIVE_MODEL, params: { a: 5, b: 13, c: 17 } })),
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    assert.notEqual(bundleA.bundle.digest, bundleB.bundle.digest);
    const manifestA = (await uploadBundle({ registry: reg.base, bundle: bundleA.bundle, chunks: bundleA.chunks })).manifestHash;
    await uploadBundle({ registry: reg.base, bundle: bundleB.bundle, chunks: bundleB.chunks });

    first = await startProvider({ bundle: bundleA.bundle, registry: reg.base, stateDir: join(reg.root, "a"), port: 0 });
    other = await startProvider({ bundle: bundleB.bundle, registry: reg.base, stateDir: join(reg.root, "b"), port: 0 });
    const cardA = await fetchProviderCard({ endpoint: first.url });
    const cardB = await fetchProviderCard({ endpoint: other.url });
    const operatorA = cardA.provider.keyId!;
    const operatorB = cardB.provider.keyId!;

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: cardA.model,
          apis: ["openai"],
          models: [cardA.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundleA.bundle.digest,
          shardsRoot: bundleA.bundle.shardsRoot,
          manifestHash: manifestA,
          providers: `${first.url},${other.url}`,
          operators: `${operatorA},${operatorB}`,
          quorum: "1",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));

    const request = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "which weights?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 4,
        }),
      });

    // The provider serving the committed bundle verifies.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-a"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url],
      quorum: 1,
      operators: { [first.url]: operatorA },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const goodBody = new RunLedger(join(reg.root, "gateway-a")).records()[0]!.body;
    assert.equal(goodBody.bundle!.digest, bundleA.bundle.digest);
    assert.equal((goodBody.quorum!.providers[0]!.receipt as { bundle: string }).bundle, bundleA.bundle.digest);
    assert.equal(verifyRunBody(goodBody, spec).correct, true);
    await gateway.close();
    gateway = null;

    // A provider serving OTHER weights is refused by the VERIFIER: the receipt
    // signs the bundle it actually served, which is not the committed one.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-b"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [other.url],
      quorum: 1,
      operators: { [other.url]: operatorB },
    });
    assert.equal((await request(gateway.url)).status, 200);
    const badBody = new RunLedger(join(reg.root, "gateway-b")).records()[0]!.body;
    assert.equal(badBody.bundle!.digest, bundleA.bundle.digest, "the run records the committed bundle");
    assert.equal((badBody.quorum!.providers[0]!.receipt as { bundle: string }).bundle, bundleB.bundle.digest);
    const verdict = verifyRunBody(badBody, spec);
    assert.equal(verdict.correct, false);
    assert.ok((verdict.proof as { failures: string[] }).failures.includes("quorum"));
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (other !== null) await other.close();
    await reg.close();
  }
});

test("a provider falls back to a mirror when the primary registry cannot serve", async () => {
  const primary = await registry();
  const mirror = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle, chunks } = buildModelBundle({
      bytes: NATIVE_BYTES,
      model: NATIVE_REF,
      execution: NATIVE_EXECUTION,
      chunkBytes: 97,
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    // The same content-addressed bundle is mirrored to both registries.
    await uploadBundle({ registry: primary.base, bundle, chunks });
    await uploadBundle({ registry: mirror.base, bundle, chunks });

    // Break every shard on the primary: it now serves bytes that do not match.
    for (const shard of bundle.shards) {
      writeFileSync(join(primary.root, "blobs", shard.hash), Buffer.from("corrupt"));
    }

    // With only the primary, the provider refuses to start.
    await assert.rejects(
      startProvider({ bundle, registry: primary.base, stateDir: join(primary.root, "solo"), port: 0 }),
      /from every registry/,
    );

    // With the mirror, it fetches the committed bytes and serves the model.
    provider = await startProvider({
      bundle,
      registry: primary.base,
      mirrors: [mirror.base],
      stateDir: join(primary.root, "mirror"),
      port: 0,
    });
    assert.deepEqual(provider.modelBytes, NATIVE_BYTES);
    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "mirror?" }],
        max_tokens: 8,
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.ok(body.choices[0]!.message.content.length > 0);
  } finally {
    if (provider !== null) await provider.close();
    await mirror.close();
    await primary.close();
  }
});

test("a machine-independent deployment needs distinct machines, or it is invalid", () => {
  const probe: EngineProbe = {
    engine: { name: "openai-compatible", version: "web4", endpoint: "https://provider.example" },
    model: { ...NATIVE_REF, weightsDigest: `sha256:${"a".repeat(64)}` },
    apis: ["openai"],
    models: [],
  };
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromNetwork("https://provider.example"),
      placement: "web4",
      labels: {
        execution: "web4",
        bundle: "a".repeat(64),
        shardsRoot: "b".repeat(64),
        manifestHash: "c".repeat(64),
        providers: "https://p1.example,https://p2.example",
        operators: "op-1,op-2",
        machines: "machine-a,machine-a",
        independence: "machine",
        quorum: "2",
      },
    }),
  );
  assert.ok(
    validateDeployment(deployment).some((error) => error.includes("quorum distinct machines")),
    "two operators on one machine cannot satisfy a machine-independent quorum",
  );
});

test("a disagreeing provider blocks the run instead of averaging it away", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle, manifestHash } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-a"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider-b"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash,
          providers: `${first.url},${second.url}`,
          quorum: "2",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    // A fetch seam that lets the second provider answer with a different body,
    // exactly as a lying operator would.
    const disagreeing: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).startsWith(second!.url)) return response;
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      body.choices[0]!.message.content = "a different answer";
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      upstreams: [first.url, second.url],
      quorum: 2,
      fetchImpl: disagreeing,
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "same question" }],
        max_tokens: 8,
      }),
    });
    assert.equal(response.status, 503);
    const refused = (await response.json()) as { error: string; evidence: { answered: unknown[] } };
    assert.match(refused.error, /quorum not met/);
    assert.equal(refused.evidence.answered.length, 2);
    assert.equal(new RunLedger(join(reg.root, "gateway")).records().length, 0);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a deterministic-replay deployment records an independent witness that matches token-for-token", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "first"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "second"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });
    const operatorA = card.provider.keyId!;

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash: card.bundle.manifestHash,
          providers: first.url,
          operators: operatorA,
          trace: "required",
          replay: "required",
          determinism: "deterministic-replay",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    assert.deepEqual(validateDeployment(deployment), []);
    const spec = runSpecFromChallenge(challengeFor(deployment));
    assert.equal(spec.determinism, "deterministic-replay");
    assert.equal(spec.requireTrace, true);
    assert.equal(spec.requireReplay, true);

    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway"),
      port: 0,
      upstreamApi: "openai",
      witnesses: [second.url],
      operators: { [first.url]: operatorA },
    });

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deployment.model.id,
        messages: [{ role: "user", content: "reproduce the arithmetic" }],
        max_tokens: 8,
        temperature: 0,
        seed: 4242,
      }),
    });
    assert.equal(response.status, 200);

    const body = new RunLedger(join(reg.root, "gateway")).records()[0]!.body;
    const claim = body.determinism;
    assert.ok(claim, "the run carries a determinism claim");
    assert.equal(claim!.class, "deterministic-replay");
    assert.equal(
      claim!.witness.provider.endpoint.replace(/\/+$/, ""),
      second.url.replace(/\/+$/, ""),
      "the witness is the independent provider, not the run's own",
    );

    // The run's trace and the witness's trace are the same tokens.
    const runTrace = (body.response.body as Record<string, unknown>).rarext_trace as {
      kind: string;
      tokens: unknown[];
    };
    const witnessTrace = (claim!.witness.response as Record<string, unknown>).rarext_trace as {
      kind: string;
      tokens: unknown[];
    };
    assert.equal(witnessTrace.kind, runTrace.kind);
    assert.deepEqual(witnessTrace.tokens, runTrace.tokens);

    const verified = verifyRunBody(body, spec);
    assert.equal(verified.correct, true, verified.error);
    assert.ok(verified.details.checks.includes("determinism.replayWitness"));

    // Removing the claim leaves the committed class unbacked.
    const missing = verifyRunBody({ ...body, determinism: undefined }, spec);
    assert.equal(missing.correct, false);
    assert.match(missing.error ?? "", /determinism\.replayWitness/);

    // A witness that is one of the run's own providers is not independent.
    const notIndependent = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: {
            ...claim!.witness,
            provider: { ...claim!.witness.provider, endpoint: first.url },
          },
        },
      },
      spec,
    );
    assert.equal(notIndependent.correct, false);
    assert.match(notIndependent.error ?? "", /determinism\.replayWitness/);

    // A witness for a different request corroborates nothing.
    const otherRequest = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: { ...claim!.witness, request: { model: "someone-else" } },
        },
      },
      spec,
    );
    assert.equal(otherRequest.correct, false);

    // A witness response whose trace diverges breaks both the trace match and
    // the provider receipt that binds it.
    const tamperedTrace = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: {
            ...claim!.witness,
            response: {
              ...(claim!.witness.response as Record<string, unknown>),
              rarext_trace: {
                ...(witnessTrace as unknown as Record<string, unknown>),
                tokens: [987654321],
              },
            },
          },
        },
      },
      spec,
    );
    assert.equal(tamperedTrace.correct, false);

    // A witness receipt with a bad signature is refused.
    const badSignature = verifyRunBody(
      {
        ...body,
        determinism: {
          ...claim!,
          witness: {
            ...claim!.witness,
            receipt: {
              ...(claim!.witness.receipt as Record<string, unknown>),
              signature: "A".repeat(88),
            },
          },
        },
      },
      spec,
    );
    assert.equal(badSignature.correct, false);

    // A challenge that commits the class without a trace/replay requirement is
    // itself invalid: there is nothing to compare or reproduce. The challenge
    // parser refuses it rather than letting a run satisfy it vacuously.
    const malformed = challengeFor(deployment);
    const malformedSpec = malformed.spec as Record<string, unknown>;
    delete malformedSpec.requireTrace;
    delete malformedSpec.requireReplay;
    assert.throws(
      () => runSpecFromChallenge(malformed),
      /requireTrace and challenge\.spec\.requireReplay/,
    );

    // A run may not claim a class the challenge never committed.
    const looseSpec = { ...spec, determinism: undefined, requireTrace: undefined, requireReplay: undefined };
    const uncommitted = verifyRunBody(body, looseSpec);
    assert.equal(uncommitted.correct, false);
    assert.match(uncommitted.error ?? "", /determinism\.replayWitness/);
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("the gateway refuses a deterministic-replay run without an independent witness", async () => {
  const reg = await registry();
  let first: Awaited<ReturnType<typeof startProvider>> | null = null;
  let second: Awaited<ReturnType<typeof startProvider>> | null = null;
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });
    first = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "first"),
      port: 0,
    });
    second = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "second"),
      port: 0,
    });
    const card = await fetchProviderCard({ endpoint: first.url });

    const deployment = commitDeployment(
      buildDeployment({
        probe: {
          engine: { name: "openai-compatible", version: "web4", endpoint: first.url },
          model: card.model,
          apis: ["openai"],
          models: [card.model],
        },
        hardware: hardwareFromNetwork(first.url),
        placement: "web4",
        labels: {
          execution: "web4",
          bundle: bundle.digest,
          shardsRoot: bundle.shardsRoot,
          manifestHash: card.bundle.manifestHash,
          trace: "required",
          replay: "required",
          determinism: "deterministic-replay",
          fixture: "loopback",
        },
        createdAt: "2026-11-07T00:00:00.000Z",
      }),
    );

    const ask = (url: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: deployment.model.id,
          messages: [{ role: "user", content: "reproduce?" }],
          max_tokens: 8,
          temperature: 0,
          seed: 7,
        }),
      });

    // No witness provider configured at all: the gateway refuses rather than
    // record a claim it cannot back.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-none"),
      port: 0,
      upstreamApi: "openai",
    });
    const none = await ask(gateway.url);
    assert.equal(none.status, 503);
    assert.match(((await none.json()) as { error: string }).error, /no independent witness provider/);
    assert.equal(new RunLedger(join(reg.root, "gateway-none")).records().length, 0);
    await gateway.close();
    gateway = null;

    // A witness that is one of the run's own providers is not a witness.
    gateway = await startGateway({
      deployment,
      ledgerDir: join(reg.root, "gateway-self"),
      port: 0,
      upstreamApi: "openai",
      witnesses: [first.url, second.url],
    });
    const self = await ask(gateway.url);
    assert.equal(self.status, 200);
    const body = new RunLedger(join(reg.root, "gateway-self")).records()[0]!.body;
    assert.equal(
      body.determinism!.witness.provider.endpoint.replace(/\/+$/, ""),
      second.url.replace(/\/+$/, ""),
      "the gateway skips its own provider and uses the independent one",
    );
  } finally {
    if (gateway !== null) await gateway.close();
    if (first !== null) await first.close();
    if (second !== null) await second.close();
    await reg.close();
  }
});

test("a GGUF is served by RAREXT's own fetched engine, with no external engine", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = tinyGgufModel();
    const model: ModelRef = {
      id: "tiny-qwen2",
      family: "qwen2",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    // RAREXT's own GGUF engine is itself a sharded RAREXT artifact.
    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    assert.deepEqual(verifyEngineBundle(engineBundle), []);
    assert.ok(engineBundle.shards.length > 1, "the engine artifact is sharded");
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });

    // No engineEndpoint: the provider has no external engine to call. It fetches
    // BOTH the weights and the engine from RAREXT, then runs the fetched engine.
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "own-gguf-engine"),
      port: 0,
      engineBundle,
    });
    const health = (await (await fetch(`${provider.url}/health`)).json()) as {
      engineFingerprint: string;
      execution: string;
    };
    assert.equal(health.execution, "engine");
    assert.equal(
      health.engineFingerprint,
      engineDescriptorFingerprint({
        name: "rarext-gguf-engine",
        version: "1",
        digest: engineBundle.artifactDigest,
      }),
    );

    const ask = async (seed: number): Promise<Response> =>
      fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "ab" }],
          max_tokens: 3,
          temperature: 0,
          seed,
        }),
      });

    const first = await ask(11);
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      rarext_trace?: { kind?: string; tokens?: number[] };
    };
    assert.equal(firstJson.rarext_trace?.kind, "rarext.decode-trace.v1");
    assert.equal(firstJson.rarext_trace?.tokens?.length, 3, "the run records the generated token ids");
    assert.ok(firstJson.rarext_trace?.tokens?.every((token) => Number.isSafeInteger(token)));
    assert.equal(typeof firstJson.choices?.[0]?.message?.content, "string");

    // Greedy decoding is deterministic: a second run on the fetched engine
    // produces the same token-for-token trace a replay would re-check.
    const secondJson = (await (await ask(11)).json()) as {
      rarext_trace?: { tokens?: number[] };
    };
    assert.deepEqual(secondJson.rarext_trace?.tokens, firstJson.rarext_trace?.tokens);

    // The weights stay in memory: the provider never materializes the GGUF on
    // disk, because its own engine parses the verified bytes directly.
    const stateDir = join(reg.root, "own-gguf-engine");
    assert.equal(existsSync(join(stateDir, "models")), false);

    // A GGUF execution cannot be served by a native engine artifact, and a
    // native execution cannot be served by the GGUF artifact. Both are refused.
    const { bundle: nativeBundle } = await publishNative({ base: reg.base });
    await assert.rejects(
      () =>
        startProvider({
          bundle,
          registry: reg.base,
          stateDir: join(reg.root, "own-gguf-wrong-runtime"),
          port: 0,
          engineBundle: { ...engineBundle, runtime: "rarext.native-engine.node-cjs.v1" },
        }),
      /needs a GGUF engine artifact/,
    );
    await assert.rejects(
      () =>
        startProvider({
          bundle: nativeBundle,
          registry: reg.base,
          stateDir: join(reg.root, "native-wrong-runtime"),
          port: 0,
          engineBundle,
        }),
      /needs a native engine artifact/,
    );
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("an OpenAI request controls decoding end to end: temperature, top_k, stop, finish_reason", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    // The SPM fixture decodes to text, so `stop` is testable end to end.
    const bytes = tinyGgufModel({ tokenizer: "llama" });
    const model: ModelRef = {
      id: "tiny-llama",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "decoding"),
      port: 0,
      engineBundle,
    });

    const ask = async (extra: Record<string, unknown>) => {
      const response = await fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "ab" }],
          max_tokens: 8,
          seed: 5,
          ...extra,
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as {
        choices: Array<{
          message: { content: string };
          finish_reason: string;
          logprobs?: {
            content: Array<{
              token: string;
              logprob: number;
              top_logprobs: Array<{ token: string; logprob: number }>;
            }>;
          };
        }>;
        rarext_trace?: { tokens?: number[] };
      };
    };

    const greedy = await ask({ temperature: 0 });
    // top_k=1 restricts the sampler to the most likely token, so a sampled
    // request must reproduce the greedy run token for token.
    const topOne = await ask({ temperature: 0.9, top_k: 1 });
    assert.deepEqual(
      topOne.rarext_trace?.tokens,
      greedy.rarext_trace?.tokens,
      "top_k=1 reproduces greedy over HTTP",
    );

    // A sampled request is reproducible from (seed, top_k, top_p).
    const sampled = await ask({ temperature: 0.9, top_k: 4, top_p: 0.9 });
    const sampledAgain = await ask({ temperature: 0.9, top_k: 4, top_p: 0.9 });
    assert.deepEqual(sampledAgain.rarext_trace?.tokens, sampled.rarext_trace?.tokens);

    // finish_reason is the truth of how the run ended, not a constant.
    const produced = greedy.rarext_trace?.tokens?.length ?? 0;
    assert.equal(greedy.choices[0]!.finish_reason, produced >= 8 ? "length" : "stop");

    // stop truncates at the sequence, drops it from the text, and says so.
    const text = greedy.choices[0]!.message.content;
    assert.ok(text.length >= 2, `the fixture decodes text to stop on (got ${JSON.stringify(text)})`);
    const stop = text.slice(0, 2);
    const stopped = await ask({ temperature: 0, stop: [stop] });
    assert.equal(stopped.choices[0]!.finish_reason, "stop");
    assert.equal(stopped.choices[0]!.message.content, text.slice(0, text.indexOf(stop)));
    assert.equal(stopped.choices[0]!.message.content.includes(stop), false);

    // logprobs: the model's own confidence, one entry per generated token,
    // aligned with the decode trace, and absent unless requested.
    assert.equal(greedy.choices[0]!.logprobs, undefined, "no logprobs unless requested");
    const scored = await ask({ temperature: 0, logprobs: true, top_logprobs: 3 });
    const content = scored.choices[0]!.logprobs?.content;
    assert.ok(Array.isArray(content) && content.length > 0, "logprobs were returned");
    assert.equal(content!.length, scored.rarext_trace?.tokens?.length, "one entry per token");
    assert.equal(
      content!.map((entry) => entry.token).join(""),
      scored.choices[0]!.message.content,
      "the token texts reconstruct the completion",
    );
    for (const entry of content!) {
      assert.ok(Number.isFinite(entry.logprob) && entry.logprob <= 0, `logprob ${entry.logprob} is a log-probability`);
      assert.equal(entry.top_logprobs.length, 3);
      for (let i = 1; i < entry.top_logprobs.length; i += 1) {
        assert.ok(
          entry.top_logprobs[i - 1]!.logprob >= entry.top_logprobs[i]!.logprob,
          "top_logprobs descend",
        );
      }
    }

    // A stop sequence and logprobs describe the same returned sequence. Here the
    // stop cuts at the first token, so nothing is returned — and no confidence
    // for tokens that were dropped is reported either.
    const stoppedScored = await ask({ temperature: 0, stop: [stop], logprobs: true, top_logprobs: 1 });
    assert.equal(stoppedScored.choices[0]!.finish_reason, "stop");
    assert.equal(stoppedScored.choices[0]!.message.content, "");
    assert.equal(
      stoppedScored.choices[0]!.logprobs,
      undefined,
      "no logprobs for tokens the response did not return",
    );

    // The legacy completions endpoint reports the completions-shaped block.
    const legacy = await fetch(`${provider!.url}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, prompt: "ab", max_tokens: 4, temperature: 0, logprobs: 2 }),
    });
    assert.equal(legacy.status, 200);
    const legacyJson = (await legacy.json()) as {
      choices: Array<{
        text: string;
        logprobs?: { tokens: string[]; token_logprobs: number[]; top_logprobs: Array<Record<string, number>> };
      }>;
    };
    const legacyLogprobs = legacyJson.choices[0]!.logprobs;
    assert.ok(legacyLogprobs !== undefined);
    assert.equal(legacyLogprobs!.tokens.length, 4);
    assert.equal(legacyLogprobs!.token_logprobs.length, 4);
    assert.ok(legacyLogprobs!.token_logprobs.every((value) => Number.isFinite(value) && value <= 0));
    assert.ok(legacyLogprobs!.top_logprobs.every((map) => Object.keys(map).length === 2));

    // Streaming is real: one SSE chunk per generated token, plus a final chunk
    // that states how the run ended. The chunks must reconstruct exactly the
    // completion the non-stream endpoint returns for the same request.
    const plainFive = await ask({ temperature: 0, max_tokens: 5 });
    const events = async (response: Response): Promise<unknown[]> => {
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const raw = await response.text();
      const frames = raw.split("\n\n").filter((frame) => frame.startsWith("data: "));
      assert.equal(frames.at(-1), "data: [DONE]");
      return frames.slice(0, -1).map((frame) => JSON.parse(frame.slice("data: ".length)));
    };
    const streamResponse = await fetch(`${provider!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "ab" }],
        max_tokens: 5,
        temperature: 0,
        seed: 5,
        stream: true,
        logprobs: true,
        top_logprobs: 1,
      }),
    });
    assert.equal(streamResponse.status, 200);
    type ChatChunk = {
      choices: Array<{
        delta?: { role?: string; content?: string };
        finish_reason: string | null;
        logprobs?: { content: Array<{ token: string; logprob: number }> };
      }>;
    };
    const chatChunks = (await events(streamResponse)) as ChatChunk[];
    const contentChunks = chatChunks.filter((chunk) => chunk.choices[0]?.delta?.content !== undefined);
    assert.equal(contentChunks.length, 5, "one chunk per generated token");
    assert.equal(
      contentChunks.length,
      plainFive.rarext_trace?.tokens?.length,
      "the chunk count matches the decode trace",
    );
    assert.equal(
      contentChunks.map((chunk) => chunk.choices[0]!.delta!.content).join(""),
      plainFive.choices[0]!.message.content,
      "streamed deltas concatenate to the non-stream completion",
    );
    assert.equal(contentChunks[0]!.choices[0]!.delta!.role, "assistant");
    assert.ok(contentChunks.every((chunk) => chunk.choices[0]!.finish_reason === null));
    assert.ok(
      contentChunks.every((chunk) => {
        const entry = chunk.choices[0]!.logprobs?.content;
        return (
          entry?.length === 1 &&
          entry[0]!.token === chunk.choices[0]!.delta!.content &&
          Number.isFinite(entry[0]!.logprob) &&
          entry[0]!.logprob <= 0
        );
      }),
      "each streamed chunk carries the logprob of the token it delivered",
    );
    const finals = chatChunks.filter((chunk) => chunk.choices[0]?.finish_reason !== null);
    assert.equal(finals.length, 1, "exactly one final chunk");
    assert.equal(finals[0]!.choices[0]!.finish_reason, plainFive.choices[0]!.finish_reason);
    assert.equal(finals[0]!.choices[0]!.finish_reason, "length");
    // The final chunk carries the decode trace, so a stream is replayable too.
    const finalTrace = (finals[0] as { rarext_trace?: { kind?: string; tokens?: number[] } }).rarext_trace;
    assert.equal(finalTrace?.kind, "rarext.decode-trace.v1");
    assert.deepEqual(finalTrace?.tokens, plainFive.rarext_trace?.tokens);

    // A stop that ends the run before any token streams no content chunk, and
    // the final chunk still says "stop".
    const stoppedStream = await fetch(`${provider!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "ab" }],
        max_tokens: 5,
        temperature: 0,
        seed: 5,
        stream: true,
        stop: [stop],
      }),
    });
    const stoppedChunks = (await events(stoppedStream)) as ChatChunk[];
    assert.equal(
      stoppedChunks.filter((chunk) => chunk.choices[0]?.delta?.content !== undefined).length,
      0,
      "no content was streamed for a run that stopped at the first token",
    );
    assert.equal(stoppedChunks.at(-1)!.choices[0]!.finish_reason, "stop");

    // The legacy completions endpoint streams per token too.
    const completionsStream = await fetch(`${provider!.url}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, prompt: "ab", max_tokens: 4, temperature: 0, stream: true }),
    });
    type CompletionChunk = {
      choices: Array<{ text?: string; finish_reason: string | null }>;
    };
    const completionChunks = (await events(completionsStream)) as CompletionChunk[];
    const completionParts = completionChunks.filter(
      (chunk) => chunk.choices[0]?.finish_reason === null && typeof chunk.choices[0]?.text === "string",
    );
    assert.equal(completionParts.length, 4, "one completion chunk per token");
    assert.equal(
      completionParts.map((chunk) => chunk.choices[0]!.text).join(""),
      legacyJson.choices[0]!.text ?? "",
      "streamed text concatenates to the non-stream completion",
    );

    // logit_bias and min_p reach the engine over HTTP.
    const biasedRun = await ask({ temperature: 0, logit_bias: { "3": 100 } });
    assert.equal(biasedRun.rarext_trace?.tokens?.[0], 3, "logit_bias forced the first token");
    const minPRun = await ask({ temperature: 1, seed: 9, min_p: 0.5, logprobs: true, top_logprobs: 1 });
    const minPEntries = minPRun.choices[0]!.logprobs!.content;
    assert.equal(minPEntries.length, minPRun.rarext_trace?.tokens?.length);
    for (const entry of minPEntries) {
      const ratio = Math.exp(entry.logprob - entry.top_logprobs[0]!.logprob);
      assert.ok(ratio >= 0.5 - 1e-9, `min_p kept a token below the floor (${ratio})`);
    }

    // n: one choice per requested index, each with its own trace and seed.
    type MultiResponse = {
      choices: Array<{
        index: number;
        message: { content: string };
        finish_reason: string;
        rarext_trace?: { kind?: string; tokens?: number[] };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const askMulti = async () =>
      (await (
        await fetch(`${provider!.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: bundle.model.id,
            messages: [{ role: "user", content: "ab" }],
            max_tokens: 4,
            temperature: 0.9,
            top_k: 8,
            n: 3,
            seed: 12,
          }),
        })
      ).json()) as MultiResponse;
    const multi = await askMulti();
    assert.deepEqual(multi.choices.map((choice) => choice.index), [0, 1, 2]);
    assert.ok(multi.choices.every((choice) => choice.finish_reason === "length"));
    assert.ok(
      multi.choices.every(
        (choice) => choice.rarext_trace?.kind === "rarext.decode-trace.v1" && choice.rarext_trace.tokens?.length === 4,
      ),
      "every choice carries its own decode trace",
    );
    assert.equal(multi.usage.completion_tokens, 12, "usage sums the choices");
    assert.equal(multi.usage.total_tokens, multi.usage.prompt_tokens + 12);
    const multiAgain = await askMulti();
    assert.deepEqual(
      multiAgain.choices.map((choice) => choice.message.content),
      multi.choices.map((choice) => choice.message.content),
      "each choice is reproducible from its own seed",
    );

    // stream_options.include_usage: a final usage chunk with no choices.
    const usageStream = await fetch(`${provider!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "ab" }],
        max_tokens: 3,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const usageChunks = (await events(usageStream)) as Array<{
      choices: unknown[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }>;
    const usageChunk = usageChunks.at(-1)!;
    assert.equal(usageChunk.choices.length, 0, "the usage chunk carries no choices");
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 });
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

/**
 * Assemble a minimal WebAssembly module that exports `memory` and
 * `run(promptPtr, len, steps, seed) -> i32`, returning a pointer to `text`.
 * This is a foreign engine BINARY, not a JS module: it proves the provider can
 * run a non-RAREXT engine with no container runtime.
 */
function wasmEngineModule(text: string): Uint8Array {
  const uleb = (value: number): number[] => {
    const out: number[] = [];
    let v = value;
    let byte: number;
    do {
      byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      out.push(byte);
    } while (v !== 0);
    return out;
  };
  const utf8 = (value: string): number[] => Array.from(Buffer.from(value, "utf8"));
  const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
  const dataOffset = 16;
  const dataBytes = [...utf8(text), 0];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // type: (i32,i32,i32,i32) -> i32
    ...section(1, [1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
    // function: one function of type 0
    ...section(3, [1, 0]),
    // memory: one page
    ...section(5, [1, 0x00, 0x01]),
    // exports: "memory" (mem 0) and "run" (func 0)
    ...section(7, [
      2,
      ...uleb(6), ...utf8("memory"), 0x02, 0x00,
      ...uleb(3), ...utf8("run"), 0x00, 0x00,
    ]),
    // code: return i32.const dataOffset
    ...section(10, [1, ...uleb(4), 0x00, 0x41, ...uleb(dataOffset), 0x0b]),
    // data: the result string at dataOffset
    ...section(11, [1, 0x00, 0x41, ...uleb(dataOffset), 0x0b, ...uleb(dataBytes.length), ...dataBytes]),
  ]);
}

test("a third-party WebAssembly engine runs with NO container runtime", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = Buffer.from(JSON.stringify({ kind: "xorshift32", params: { a: 13, b: 17, c: 5 }, vocab: ["a", "b"] }));
    const model: ModelRef = {
      id: "wasm-served-model",
      family: "wasm-echo",
      parameters: "tiny",
      quantization: "none",
      format: "json",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };

    // The engine artifact is a wasm BINARY, committed to RAREXT like any other.
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source: wasmEngineModule("wasm engine online"),
      name: "third-party-wasm-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_WASM,
      chunkBytes: 256,
    });
    assert.deepEqual(verifyEngineBundle(engineBundle), []);
    const uploadedEngine = await uploadEngineBundle({
      registry: reg.base,
      bundle: engineBundle,
      chunks: engineChunks,
    });

    const execution: ExecutionRef = {
      kind: "engine",
      engine: "rarext",
      engineModel: null,
      artifact: engineArtifactRef(engineBundle, uploadedEngine.manifestHash),
    };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 256 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "wasm-engine"),
      port: 0,
    });
    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
    });
    const bodyText = await response.text();
    assert.equal(response.status, 200, bodyText);
    const json = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
    assert.equal(
      json.choices?.[0]?.message?.content,
      "wasm engine online",
      "the provider ran the third-party wasm engine in-process",
    );
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a non-RAREXT native engine runs sandboxed on a worker and replays", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    // A foreign "native" engine program: a self-contained JS module. It reports
    // whether the sandbox exposed require/process, so isolation is observable.
    const engineSource = [
      "module.exports.run = function (model, input) {",
      "  var sandboxed = typeof require === 'undefined' && typeof process === 'undefined';",
      "  var prompt = String(input.prompt == null ? '' : input.prompt);",
      "  return { text: 'native shim[' + (sandboxed ? 'sandboxed' : 'exposed') + ']:' + prompt.length,",
      "           seed: 0, steps: Number(input.steps) || 1, tokens: [] };",
      "};",
    ].join("\n");

    const bytes = Buffer.from(JSON.stringify({ kind: "xorshift32", params: { a: 13, b: 17, c: 5 }, vocab: ["a", "b"] }));
    const model: ModelRef = {
      id: "native-engine-model",
      family: "native-shim",
      parameters: "tiny",
      quantization: "none",
      format: "json",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source: Buffer.from(engineSource, "utf8"),
      name: "third-party-native-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_WORKER,
      chunkBytes: 256,
    });
    assert.deepEqual(verifyEngineBundle(engineBundle), []);
    const uploaded = await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });
    const execution: ExecutionRef = {
      kind: "engine",
      engine: "rarext",
      engineModel: null,
      artifact: engineArtifactRef(engineBundle, uploaded.manifestHash),
    };
    const built = buildModelBundle({ bytes, model, execution, chunkBytes: 256 });
    await uploadBundle({ registry: reg.base, bundle: built.bundle, chunks: built.chunks });

    provider = await startProvider({
      bundle: built.bundle,
      registry: reg.base,
      stateDir: join(reg.root, "native-engine"),
      port: 0,
    });
    const health = (await (await fetch(`${provider.url}/health`)).json()) as { engineFingerprint: string };
    const request = {
      model: built.bundle.model.id,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 8,
      temperature: 0,
      seed: 7,
    };
    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const bodyText = await response.text();
    assert.equal(response.status, 200, bodyText);
    const json = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string } }>;
      rarext_trace?: { kind: string; digest: string };
    };
    // The foreign engine ran on a worker thread with no require/process.
    assert.match(json.choices?.[0]?.message?.content ?? "", /^native shim\[sandboxed\]:5$/);
    assert.equal(json.rarext_trace?.kind, "rarext.output-trace.v1");

    const body = {
      replay: { request, api: "openai" as const },
      response: { text: json.choices?.[0]?.message?.content ?? "", body: json },
      engine: { fingerprint: health.engineFingerprint },
    } as unknown as Parameters<typeof replayEngineRun>[0]["body"];
    const replay = await replayEngineRun({ body, endpoint: provider.url });
    assert.equal(replay.ok, true, replay.reason ?? "");
    assert.equal(replay.traceMatches, true);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("an engine that hides its tokens still commits a replayable trace, and a divergent one is refused", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = Buffer.from(JSON.stringify({ kind: "xorshift32", params: { a: 13, b: 17, c: 5 }, vocab: ["a", "b"] }));
    const model: ModelRef = {
      id: "wasm-output-trace",
      family: "wasm-echo",
      parameters: "tiny",
      quantization: "none",
      format: "json",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source: wasmEngineModule("wasm engine online"),
      name: "hiding-wasm-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_WASM,
      chunkBytes: 256,
    });
    const uploaded = await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });
    const execution: ExecutionRef = {
      kind: "engine",
      engine: "rarext",
      engineModel: null,
      artifact: engineArtifactRef(engineBundle, uploaded.manifestHash),
    };
    const built = buildModelBundle({ bytes, model, execution, chunkBytes: 256 });
    await uploadBundle({ registry: reg.base, bundle: built.bundle, chunks: built.chunks });

    provider = await startProvider({
      bundle: built.bundle,
      registry: reg.base,
      stateDir: join(reg.root, "hiding-engine"),
      port: 0,
    });
    const health = (await (await fetch(`${provider.url}/health`)).json()) as { engineFingerprint: string };
    const request = {
      model: built.bundle.model.id,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      temperature: 0,
      seed: 7,
    };
    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const json = (await response.json()) as Record<string, unknown>;
    const trace = json.rarext_trace as { kind: string; outputDigest: string; digest: string } | undefined;

    // The engine exposed no token ids, yet the run is still traceable: an output
    // digest of the exact completion, accepted by the shared trace validator.
    assert.equal(trace?.kind, "rarext.output-trace.v1");
    assert.ok(typeof trace?.outputDigest === "string" && /^[0-9a-f]{64}$/.test(trace.outputDigest));
    assert.equal(validDecodeTrace(json), true, "the output trace is a valid decode trace");
    const decoded = decodeTraceOf(json);
    assert.ok(decoded !== null);
    assert.equal(decoded!.kind, "rarext.output-trace.v1");

    // Two output traces match only when the completion digest matches.
    const other = traceFor({ text: "something else", tokens: [] });
    assert.equal(tracesMatch(decoded!, decodeTraceOf({ rarext_trace: { ...other, digest: canonicalDigest(other) } })!), false);

    const body = {
      replay: { request, api: "openai" as const },
      response: { text: "wasm engine online", body: json },
      engine: { fingerprint: health.engineFingerprint },
    } as unknown as Parameters<typeof replayEngineRun>[0]["body"];

    // A faithful replay re-runs the foreign engine and matches its output digest.
    const good = await replayEngineRun({ body, endpoint: provider.url });
    assert.equal(good.ok, true, good.reason ?? "");
    assert.equal(good.traceMatches, true);

    // A trace the re-execution does not reproduce is refused EVEN THOUGH the
    // text still matches: bit-for-bit enforcement, not a text coincidence.
    const diverged = {
      ...body,
      response: {
        ...body.response,
        body: { ...json, rarext_trace: { ...trace!, digest: "0".repeat(64) } },
      },
    } as unknown as Parameters<typeof replayEngineRun>[0]["body"];
    const bad = await replayEngineRun({ body: diverged, endpoint: provider.url });
    assert.equal(bad.reproduced, true, "the text still matches");
    assert.equal(bad.traceMatches, false);
    assert.equal(bad.ok, false);
    assert.match(bad.reason ?? "", /trace diverged/);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a sandboxed worker engine computes real inference from the committed bytes, and the weights drive it", async () => {
  const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
  const inProcess = loadEngine(source);
  const sandboxed = loadWorkerEngine(source);
  const bytes = tinyGgufModel({ arch: "qwen2", nEmbd: 256, nHead: 4, nHeadKv: 4, nFfn: 512 });
  const model = { kind: "gguf" as const, bytes: new Uint8Array(bytes) };

  // The engine runs on a worker thread with no host engine, yet reproduces the
  // in-process transformer token-for-token from the SAME bytes.
  const workerRun = await sandboxed.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  const localRun = inProcess.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  assert.ok(workerRun.tokens.length > 0, "the sandboxed engine produced a real decode");
  assert.equal(workerRun.tokens.join(","), localRun.tokens.join(","), "the sandboxed engine matches the in-process engine");

  // Different committed weights => a different decode: the output is computed
  // from the bytes, not a constant.
  const mutated = Buffer.from(bytes);
  for (let offset = Math.floor(mutated.length / 3); offset < mutated.length; offset += 7) {
    mutated[offset] = mutated[offset]! ^ 0xff;
  }
  const mutatedRun = await sandboxed.run(
    { kind: "gguf", bytes: new Uint8Array(mutated) },
    { prompt: "a b", steps: 3, temperature: 0 },
  );
  assert.notEqual(mutatedRun.tokens.join(","), workerRun.tokens.join(","), "perturbed weights changed the decode");
});

test("every engine runtime the network carries is portable, so no host capability is a prerequisite", () => {
  // The AI lives on RAREXT: an engine is a portable artifact the network fetches,
  // not something the host must already have (no container runtime, GPU or TEE).
  for (const runtime of [
    ENGINE_ARTIFACT_RUNTIME,
    ENGINE_ARTIFACT_RUNTIME_GGUF,
    ENGINE_ARTIFACT_RUNTIME_WASM,
    ENGINE_ARTIFACT_RUNTIME_WORKER,
  ]) {
    assert.equal(isPortableEngineRuntime(runtime), true, `${runtime} runs with nothing but the provider`);
  }
  assert.equal(isPortableEngineRuntime("rarext.native-image.elf.v1"), false, "a host ELF launcher is not portable");
  assert.equal(isPortableEngineRuntime("ollama"), false, "a third-party software provider is not an engine artifact");
});

test("a model bundle can commit its engine artifact, so a provider needs no out-of-band engine flag", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    // Shard and upload RAREXT's own GGUF engine first, so its manifest hash can
    // be committed by the model bundle.
    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    const { manifestHash } = await uploadEngineBundle({
      registry: reg.base,
      bundle: engineBundle,
      chunks: engineChunks,
    });

    const bytes = tinyGgufModel();
    const model: ModelRef = {
      id: "tiny-qwen2-committed-engine",
      family: "qwen2",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = {
      kind: "engine",
      engine: "rarext",
      engineModel: null,
      artifact: engineArtifactRef(engineBundle, manifestHash),
    };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    assert.deepEqual(verifyModelBundle(bundle), []);
    assert.equal(bundle.execution.kind, "engine");
    assert.equal(
      bundle.execution.kind === "engine" ? bundle.execution.artifact?.artifactDigest : null,
      engineBundle.artifactDigest,
      "the bundle commits the engine artifact digest",
    );
    await uploadBundle({ registry: reg.base, bundle, chunks });

    // NO engineBundle option: the provider resolves the engine from the bundle.
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "committed-engine"),
      port: 0,
    });
    const health = (await (await fetch(`${provider.url}/health`)).json()) as {
      engineFingerprint: string;
      execution: string;
    };
    assert.equal(health.execution, "engine");
    assert.equal(
      health.engineFingerprint,
      engineDescriptorFingerprint({
        name: "rarext-gguf-engine",
        version: "1",
        digest: engineBundle.artifactDigest,
      }),
      "the committed artifact's digest is the engine fingerprint",
    );

    const answer = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "ab" }],
        max_tokens: 2,
        temperature: 0,
      }),
    });
    assert.equal(answer.status, 200);
    const json = (await answer.json()) as { rarext_trace?: { kind?: string; tokens?: number[] } };
    assert.equal(json.rarext_trace?.kind, "rarext.decode-trace.v1");
    assert.equal(json.rarext_trace?.tokens?.length, 2);

    // A bundle that commits a DIFFERENT artifact digest is refused: the manifest
    // is real, but it is not the engine the model named.
    const tamperedExecution: ExecutionRef = {
      ...execution,
      artifact: { ...engineArtifactRef(engineBundle, manifestHash), artifactDigest: `sha256:${"0".repeat(64)}` },
    };
    const { bundle: tampered, chunks: tamperedChunks } = buildModelBundle({
      bytes,
      model: { ...model, id: "tiny-qwen2-wrong-engine" },
      execution: tamperedExecution,
      chunkBytes: 1024,
    });
    assert.deepEqual(verifyModelBundle(tampered), []);
    await uploadBundle({ registry: reg.base, bundle: tampered, chunks: tamperedChunks });
    await assert.rejects(
      () =>
        startProvider({
          bundle: tampered,
          registry: reg.base,
          stateDir: join(reg.root, "committed-engine-wrong"),
          port: 0,
        }),
      /does not match the engine artifact this bundle commits/,
    );
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("the GGUF engine dequantizes every quantization it advertises", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  assert.ok(engine.dequantTensor !== undefined);
  const dequant = engine.dequantTensor;

  const H1 = 0x3c00;
  const H05 = 0x3800;
  const half = (bits: number): Buffer => {
    const out = Buffer.alloc(2);
    out.writeUInt16LE(bits, 0);
    return out;
  };
  const check = (type: number, dims: number[], data: Buffer, expected: number[]): void => {
    const bytes = singleTensorGguf(type, dims, data);
    const got = Array.from(dequant({ kind: "gguf", bytes }, "t", 0));
    assert.equal(got.length, expected.length, `type ${type} produced ${got.length} values`);
    for (let i = 0; i < expected.length; i += 1) {
      assert.ok(
        Math.abs(got[i]! - expected[i]!) < 1e-4,
        `type ${type}[${i}] = ${got[i]} but expected ${expected[i]}`,
      );
    }
  };
  const repeat = (value: number, count: number): number[] => Array.from({ length: count }, () => value);
  const groups = (values: number[]): number[] => values.flatMap((value) => repeat(value, 32));

  // F32 / F16 / BF16.
  const f32 = Buffer.alloc(32 * 4);
  for (let i = 0; i < 32; i += 1) f32.writeFloatLE(i - 16, i * 4);
  check(0, [32], f32, Array.from({ length: 32 }, (_, i) => i - 16));
  const f16 = Buffer.alloc(32 * 2);
  for (let i = 0; i < 32; i += 1) f16.writeUInt16LE(i === 0 ? H1 : i === 1 ? H05 : 0, i * 2);
  check(1, [32], f16, [1, 0.5, ...repeat(0, 30)]);
  const bf16 = Buffer.alloc(32 * 2);
  const bf16Values = [0x3f80, 0xc000, 0x3f00, 0x0000];
  for (let i = 0; i < 32; i += 1) bf16.writeUInt16LE(bf16Values[i % 4]!, i * 2);
  check(30, [32], bf16, Array.from({ length: 32 }, (_, i) => [1, -2, 0.5, 0][i % 4]!));

  // Q4_0 / Q4_1 / Q5_1 / Q8_0.
  check(2, [32], Buffer.concat([half(H1), Buffer.alloc(16, 0x10)]), [
    ...repeat(-8, 16),
    ...repeat(-7, 16),
  ]);
  const q41 = Buffer.concat([half(H1), half(H05), Buffer.alloc(16, 0x10)]);
  check(3, [32], q41, [...repeat(0.5, 16), ...repeat(1.5, 16)]);
  const q51 = Buffer.concat([half(H1), half(H05), Buffer.alloc(4, 0), Buffer.alloc(16, 0x10)]);
  check(7, [32], q51, [...repeat(0.5, 16), ...repeat(1.5, 16)]);
  const q8 = Buffer.concat([half(H1), Buffer.from(Array.from({ length: 32 }, (_, i) => i))]);
  check(8, [32], q8, Array.from({ length: 32 }, (_, i) => i));

  // Q2_K: scale 1, min 0, qs = 0xE4 (2-bit fields 0,1,2,3).
  check(
    10,
    [256],
    Buffer.concat([Buffer.alloc(16, 0x01), Buffer.alloc(64, 0xe4), half(H1), half(0)]),
    [...groups([0, 1, 2, 3]), ...groups([0, 1, 2, 3])],
  );

  // Q3_K: all scales decode to 33 (dl = 1), hmask all ones, same 2-bit fields.
  check(
    11,
    [256],
    Buffer.concat([
      Buffer.alloc(32, 0xff),
      Buffer.alloc(64, 0xe4),
      Buffer.concat([Buffer.alloc(8, 0x11), Buffer.alloc(4, 0xaa)]),
      half(H1),
    ]),
    [...groups([0, 1, 2, 3]), ...groups([0, 1, 2, 3])],
  );

  // Q4_K: all scales 1, qs 0x10 (low nibble 0, high nibble 1).
  check(
    12,
    [256],
    Buffer.concat([
      half(H1),
      half(0),
      Buffer.from([1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1]),
      Buffer.alloc(128, 0x10),
    ]),
    [0, 0, 0, 0].flatMap(() => [...repeat(0, 32), ...repeat(1, 32)]),
  );

  // Q5_K: all scales 1, qh all ones, ql 0x11 => every weight is 1 + 16.
  check(
    13,
    [256],
    Buffer.concat([
      half(H1),
      half(0),
      Buffer.from([1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1]),
      Buffer.alloc(32, 0xff),
      Buffer.alloc(128, 0x11),
    ]),
    repeat(17, 256),
  );

  // Q6_K: all scales 1, ql/qh 0 => every 6-bit field is -32.
  check(
    14,
    [256],
    Buffer.concat([Buffer.alloc(128, 0), Buffer.alloc(64, 0), Buffer.alloc(16, 1), half(H1)]),
    repeat(-32, 256),
  );

  // Q8_K: float32 delta 1, int8 quants cycling -8..7 (bsums are not used to
  // dequantize). 292 = 4 (f32 d) + 256 (qs) + 32 (bsums).
  const q8k = Buffer.concat([
    (() => {
      const out = Buffer.alloc(4);
      out.writeFloatLE(1, 0);
      return out;
    })(),
    Buffer.from(Array.from({ length: 256 }, (_, i) => (i % 16) - 8)),
    Buffer.alloc(32, 0),
  ]);
  check(15, [256], q8k, Array.from({ length: 256 }, (_, i) => (i % 16) - 8));

  // IQ4_NL: d = 1, qs[i] = i. The low nibble selects IQ4NL[i]; the high nibble
  // of every byte in 0..15 is 0, so the second half is IQ4NL[0] = -127.
  const iq4nlTable = [-127, -104, -83, -65, -49, -35, -22, -10, 1, 13, 25, 38, 53, 69, 89, 113];
  check(
    20,
    [32],
    Buffer.concat([half(H1), Buffer.from(Array.from({ length: 16 }, (_, i) => i))]),
    [...iq4nlTable, ...repeat(-127, 16)],
  );

  // IQ4_XS: d = 1, scales_h = 0, scales_l = 0 => every sub-block scale is
  // (0 - 32); qs all 0 selects IQ4NL[0] = -127 for both nibbles.
  check(
    23,
    [256],
    Buffer.concat([half(H1), Buffer.alloc(2, 0), Buffer.alloc(4, 0), Buffer.alloc(128, 0)]),
    repeat(-32 * -127, 256),
  );
});

test("the GGUF engine decodes every IQ grid quant with the upstream block layout", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const half = (bits: number): Buffer => {
    const out = Buffer.alloc(2);
    out.writeUInt16LE(bits, 0);
    return out;
  };
  // d = 1.0 (0x3c00). All index/scale/sign bits are zero, so every group
  // selects grid row 0. Those rows are known upstream values:
  //   iq2*   grid0 = 0x0808080808080808 -> 8   (db = 0.125)  -> 1.0
  //   iq3xxs grid0 = 0x04040404         -> 4   (db = 0.25)   -> 1.0
  //   iq3s   grid0 = 0x01010101         -> 1   (db = 1)      -> 1.0
  //   iq1s   grid0 = 0xffffffffffffffff -> -1  (dl = 1, delta = +0.125) -> -0.875
  const check = (type: number, size: number, expected: number, head?: Buffer): void => {
    const data = Buffer.alloc(size);
    (head ?? half(0x3c00)).copy(data, 0);
    const bytes = singleTensorGguf(type, [256], data);
    const got = Array.from(engine.dequantTensor!({ kind: "gguf", bytes }, "t", 0));
    assert.equal(got.length, 256, `type ${type} produced 256 values`);
    for (const value of got) {
      assert.ok(Math.abs(value - expected) < 1e-6, `type ${type}: ${value} != ${expected}`);
    }
  };
  check(16, 66, 1.0); // IQ2_XXS
  check(17, 74, 1.0); // IQ2_XS
  check(22, 82, 1.0); // IQ2_S
  check(18, 98, 1.0); // IQ3_XXS
  check(21, 110, 1.0); // IQ3_S
  check(19, 50, -0.875); // IQ1_S
  // IQ1_M packs d into the top nibbles of scales[2] and scales[3]: the f16 bits
  // are (sc2_nibble<<8)|(sc3_nibble<<12) plus lower nibbles, so sc2 = 0xc000 and
  // sc3 = 0x3000 reconstruct 0x3c00 (d = 1) with every 3-bit sub-scale zero,
  // giving -1 + 0.125 = -0.875 across the block.
  const iq1m = Buffer.alloc(56);
  iq1m.writeUInt16LE(0xc000, 4);
  iq1m.writeUInt16LE(0x3000, 6);
  check(29, 56, -0.875, iq1m);
});

test("the GGUF engine serves an IQ2_XXS quantized model through the quant-domain dot path", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const bytes = tinyGgufModel({
    arch: "qwen2",
    tokenizer: "gpt2",
    quant: "IQ2_XXS",
    nEmbd: 256,
    nHead: 4,
    nHeadKv: 2,
    nFfn: 512,
  });
  const model = { kind: "gguf" as const, bytes: new Uint8Array(bytes) };
  const first = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  const second = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  assert.equal(first.tokens.length, 3);
  assert.equal(first.tokens.join(","), second.tokens.join(","), "the IQ2_XXS run is deterministic");
  const row = Array.from(engine.dequantTensor!(model, "blk.0.attn_q.weight", 0));
  assert.ok(
    row.every((value) => Math.abs(value - 1) < 1e-6),
    "all-zero IQ2_XXS blocks with d=1 decode to all-ones weights",
  );
});

/** Minimal safetensors writer for tests: header JSON + raw tensor data. */
function writeSafetensors(
  path: string,
  entries: { name: string; dtype: string; shape: number[]; bytes: Buffer }[],
): void {
  const header: Record<string, { dtype: string; shape: number[]; data_offsets: number[] }> = {};
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    header[entry.name] = {
      dtype: entry.dtype,
      shape: entry.shape,
      data_offsets: [offset, offset + entry.bytes.length],
    };
    chunks.push(entry.bytes);
    offset += entry.bytes.length;
  }
  let json = Buffer.from(JSON.stringify(header), "utf8");
  json = Buffer.concat([json, Buffer.alloc((8 - (json.length % 8)) % 8, 0x20)]);
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(json.length), 0);
  writeFileSync(path, Buffer.concat([prefix, json, ...chunks]));
}

/** The engine's tensor names, mapped back to Hugging Face names for the test. */
const HF_LAYER_NAMES: Record<string, string> = {
  "attn_q.weight": "self_attn.q_proj.weight",
  "attn_k.weight": "self_attn.k_proj.weight",
  "attn_v.weight": "self_attn.v_proj.weight",
  "attn_output.weight": "self_attn.o_proj.weight",
  "attn_q.bias": "self_attn.q_proj.bias",
  "attn_k.bias": "self_attn.k_proj.bias",
  "attn_v.bias": "self_attn.v_proj.bias",
  "attn_norm.weight": "input_layernorm.weight",
  "ffn_norm.weight": "post_attention_layernorm.weight",
  "ffn_gate.weight": "mlp.gate_proj.weight",
  "ffn_up.weight": "mlp.up_proj.weight",
  "ffn_down.weight": "mlp.down_proj.weight",
};
const HF_TOP_NAMES: Record<string, string> = {
  "token_embd.weight": "model.embed_tokens.weight",
  "output_norm.weight": "model.norm.weight",
  "output.weight": "lm_head.weight",
};
function ggufToHfName(name: string): string {
  if (HF_TOP_NAMES[name] !== undefined) return HF_TOP_NAMES[name];
  const match = name.match(/^blk\.(\d+)\.(.+)$/);
  if (match !== null && HF_LAYER_NAMES[match[2]!] !== undefined) {
    return `model.layers.${match[1]}.${HF_LAYER_NAMES[match[2]!]}`;
  }
  throw new Error(`no Hugging Face name for ${name}`);
}

test("a container built from safetensors by RAREXT's own converter decodes exactly like the GGUF", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const ggufBytes = tinyGgufModel({ arch: "qwen2", tokenizer: "gpt2" });
  const ggufModel = { kind: "gguf" as const, bytes: new Uint8Array(ggufBytes) };
  const reference = engine
    .run(ggufModel, { prompt: "a b", steps: 3, temperature: 0 })
    .tokens.join(",");

  // Emit the fixture's exact tensors as Hugging Face safetensors.
  const parsed = engine.parseGguf!(new Uint8Array(ggufBytes));
  const source = new Uint8Array(ggufBytes);
  const entries = Object.values(parsed.tensors).map((tensor) => {
    const length = tensor.rowBytes * tensor.rows;
    return {
      name: ggufToHfName(tensor.name),
      dtype: "F32",
      shape: [tensor.rows, tensor.cols],
      bytes: Buffer.from(source.subarray(parsed.dataStart + tensor.offset, parsed.dataStart + tensor.offset + length)),
    };
  });
  const tokens = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (let i = 0; i < 24; i += 1) tokens.push(`<x${i}>`);
  const dir = mkdtempSync(join(tmpdir(), "rarext-hf-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      model_type: "qwen2",
      hidden_size: 8,
      num_attention_heads: 2,
      num_key_value_heads: 1,
      intermediate_size: 16,
      num_hidden_layers: 1,
      rms_norm_eps: 1e-6,
      rope_theta: 10000,
      max_position_embeddings: 64,
      bos_token_id: 0,
      eos_token_id: 1,
    }),
  );
  writeFileSync(
    join(dir, "tokenizer.json"),
    JSON.stringify({
      model: { type: "BPE", vocab: Object.fromEntries(tokens.map((token, id) => [token, id])), merges: [] },
      added_tokens: [],
    }),
  );
  writeSafetensors(join(dir, "model.safetensors"), entries);

  const container = convertHfDirectory(dir);
  assert.deepEqual(container.ggmlTypes, ["F32"], "the container carries plain F32 weights");
  const hfModel = { kind: "hf" as const, bytes: new Uint8Array(container.bytes) };
  const served = engine.run(hfModel, { prompt: "a b", steps: 3, temperature: 0 }).tokens.join(",");
  assert.equal(served, reference, "the converted container decodes exactly like the GGUF fixture");
});

test("the safetensors converter refuses architectures it does not implement", () => {
  assert.throws(() => hparamsSection({ model_type: "gpt2" }), /only qwen2\/llama/);
});

/** Minimal protobuf writer for a SentencePiece ModelProto (pieces + scores). */
function spmProto(pieces: string[], scores: number[]): Buffer {
  const varint = (value: number): Buffer => {
    const out: number[] = [];
    let v = value;
    for (;;) {
      const byte = v & 0x7f;
      v >>>= 7;
      if (v === 0) {
        out.push(byte);
        return Buffer.from(out);
      }
      out.push(byte | 0x80);
    }
  };
  const parts: Buffer[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const text = Buffer.from(pieces[i]!, "utf8");
    const score = Buffer.alloc(4);
    score.writeFloatLE(scores[i]!, 0);
    const piece = Buffer.concat([
      Buffer.from([0x0a]), varint(text.length), text, // field 1: piece
      Buffer.from([0x15]), score, // field 2: score (fixed32)
      Buffer.from([0x18, 0x01]), // field 3: type = NORMAL
    ]);
    parts.push(Buffer.concat([Buffer.from([0x0a]), varint(piece.length), piece])); // field 1: SentencePiece
  }
  return Buffer.concat(parts);
}

test("SentencePiece tokenizer.model checkpoints are ingested natively and decode like the GGUF", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const ggufBytes = tinyGgufModel({ arch: "llama", tokenizer: "llama" });
  const ggufModel = { kind: "gguf" as const, bytes: new Uint8Array(ggufBytes) };
  const reference = engine
    .run(ggufModel, { prompt: "a b", steps: 3, temperature: 0 })
    .tokens.join(",");

  const parsed = engine.parseGguf!(new Uint8Array(ggufBytes));
  const source = new Uint8Array(ggufBytes);
  const entries = Object.values(parsed.tensors).map((tensor) => {
    const length = tensor.rowBytes * tensor.rows;
    return {
      name: ggufToHfName(tensor.name),
      dtype: "F32",
      shape: [tensor.rows, tensor.cols],
      bytes: Buffer.from(source.subarray(parsed.dataStart + tensor.offset, parsed.dataStart + tensor.offset + length)),
    };
  });
  const tokens = ["\u2581", "a", "b", "c", "d", "e", "f", "g"];
  for (let i = 0; i < 24; i += 1) tokens.push(`<x${i}>`);
  const scores = tokens.map((_, index) => (index === 0 ? 0 : -index * 0.1));
  const dir = mkdtempSync(join(tmpdir(), "rarext-spm-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      model_type: "llama",
      hidden_size: 8,
      num_attention_heads: 2,
      num_key_value_heads: 1,
      intermediate_size: 16,
      num_hidden_layers: 1,
      rms_norm_eps: 1e-6,
      rope_theta: 10000,
      max_position_embeddings: 64,
      bos_token_id: 0,
      eos_token_id: 1,
    }),
  );
  writeFileSync(join(dir, "tokenizer.model"), spmProto(tokens, scores));
  writeFileSync(join(dir, "tokenizer_config.json"), JSON.stringify({ add_bos_token: false }));
  writeSafetensors(join(dir, "model.safetensors"), entries);

  const proto = parseSentencePieceModel(readFileSync(join(dir, "tokenizer.model")));
  assert.equal(proto.pieces.join(","), tokens.join(","), "the proto parser recovered the pieces");
  assert.ok(Math.abs(proto.scores[3]! + 0.3) < 1e-6, "the proto parser recovered the scores");

  const container = convertHfDirectory(dir);
  const hfModel = { kind: "hf" as const, bytes: new Uint8Array(container.bytes) };
  const served = engine.run(hfModel, { prompt: "a b", steps: 3, temperature: 0 }).tokens.join(",");
  assert.equal(served, reference, "the SentencePiece container decodes exactly like the GGUF fixture");
});

/** Emit a GGUF fixture's exact tensors as Hugging Face safetensors entries. */
function hfEntriesFromGguf(
  engine: ReturnType<typeof loadEngine>,
  ggufBytes: Buffer,
): { name: string; dtype: string; shape: number[]; bytes: Buffer }[] {
  const parsed = engine.parseGguf!(new Uint8Array(ggufBytes));
  const source = new Uint8Array(ggufBytes);
  return Object.values(parsed.tensors).map((tensor) => {
    const length = tensor.rowBytes * tensor.rows;
    return {
      name: ggufToHfName(tensor.name),
      dtype: "F32",
      // 1-D tensors (norms, biases) stay 1-D so the ingest leaves them F32.
      shape: tensor.rows === 1 ? [tensor.cols] : [tensor.rows, tensor.cols],
      bytes: Buffer.from(
        source.subarray(parsed.dataStart + tensor.offset, parsed.dataStart + tensor.offset + length),
      ),
    };
  });
}

test("the ingest quantizes weights to the engine's own block formats", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const constant = (quant: string, value: number): number => {
    const result = quantizeTensor(quant, Float32Array.from({ length: 32 }, () => value), 32, 1);
    const container = buildContainer({}, [
      { name: "t", type: result.type, dims: [32, 1], bytes: result.bytes },
    ]);
    const row = engine.dequantTensor!({ kind: "hf", bytes: new Uint8Array(container) }, "t", 0);
    return row[0]!;
  };
  assert.ok(Math.abs(constant("Q8_0", 0.5) - 0.5) < 1e-4, "Q8_0 round-trips a constant block");
  assert.ok(Math.abs(constant("Q4_0", 0.5) - 0.5) < 1e-4, "Q4_0 round-trips a constant block");
  const iq4 = constant("IQ4_NL", 0.5);
  assert.ok(Math.abs(iq4 - 0.5) < 0.06, `IQ4_NL stays within its table step; got ${iq4}`);
  assert.throws(() => quantizeTensor("Q9_9", new Float32Array(32), 32, 1), /unknown quantization/);
});

test("a Q8_0-quantized container decodes within the quantization bound and runs deterministically", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const ggufBytes = tinyGgufModel({
    arch: "qwen2",
    tokenizer: "gpt2",
    nEmbd: 32,
    nHead: 2,
    nHeadKv: 2,
    nFfn: 64,
  });
  const tokens = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (let i = 0; i < 24; i += 1) tokens.push(`<x${i}>`);
  const dir = mkdtempSync(join(tmpdir(), "rarext-quant-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      model_type: "qwen2",
      hidden_size: 32,
      num_attention_heads: 2,
      num_key_value_heads: 2,
      intermediate_size: 64,
      num_hidden_layers: 1,
      rms_norm_eps: 1e-6,
      rope_theta: 10000,
      max_position_embeddings: 64,
      bos_token_id: 0,
      eos_token_id: 1,
    }),
  );
  writeFileSync(
    join(dir, "tokenizer.json"),
    JSON.stringify({
      model: { type: "BPE", vocab: Object.fromEntries(tokens.map((token, id) => [token, id])), merges: [] },
      added_tokens: [],
    }),
  );
  writeSafetensors(join(dir, "model.safetensors"), hfEntriesFromGguf(engine, ggufBytes));

  const container = convertHfDirectory(dir, { quant: "Q8_0" });
  assert.ok(container.ggmlTypes.includes("Q8_0"), "2D weights are Q8_0");
  assert.ok(container.ggmlTypes.includes("F32"), "norms stay F32");
  const model = { kind: "hf" as const, bytes: new Uint8Array(container.bytes) };

  const original = Array.from(
    engine.dequantTensor!({ kind: "gguf", bytes: new Uint8Array(ggufBytes) }, "blk.0.attn_q.weight", 0),
  );
  const quantized = Array.from(engine.dequantTensor!(model, "blk.0.attn_q.weight", 0));
  const bound = Math.max(...original.map(Math.abs)) / 127 + 1e-5;
  for (let i = 0; i < original.length; i += 1) {
    assert.ok(
      Math.abs(quantized[i]! - original[i]!) <= bound,
      `Q8_0 error within bound at ${i}: ${quantized[i]} vs ${original[i]} (bound ${bound})`);
  }

  const first = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  assert.ok(first.tokens.length >= 1, "the quantized container generates tokens");
  const second = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  assert.equal(first.tokens.join(","), second.tokens.join(","), "the quantized container is deterministic");
});

test("a Unigram/SentencePiece vocab inside tokenizer.json is ingested and decodes like the GGUF", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const ggufBytes = tinyGgufModel({ arch: "llama", tokenizer: "llama" });
  const ggufModel = { kind: "gguf" as const, bytes: new Uint8Array(ggufBytes) };
  const reference = engine
    .run(ggufModel, { prompt: "a b", steps: 3, temperature: 0 })
    .tokens.join(",");

  const tokens = ["\u2581", "a", "b", "c", "d", "e", "f", "g"];
  for (let i = 0; i < 24; i += 1) tokens.push(`<x${i}>`);
  const scores = tokens.map((_, index) => (index === 0 ? 0 : -index * 0.1));
  const dir = mkdtempSync(join(tmpdir(), "rarext-unigram-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      model_type: "llama",
      hidden_size: 8,
      num_attention_heads: 2,
      num_key_value_heads: 1,
      intermediate_size: 16,
      num_hidden_layers: 1,
      rms_norm_eps: 1e-6,
      rope_theta: 10000,
      max_position_embeddings: 64,
      bos_token_id: 0,
      eos_token_id: 1,
    }),
  );
  writeFileSync(
    join(dir, "tokenizer.json"),
    JSON.stringify({
      model: {
        type: "Unigram",
        unk_id: 0,
        vocab: tokens.map((token, index) => [token, scores[index]]),
      },
      added_tokens: [],
    }),
  );
  writeFileSync(join(dir, "tokenizer_config.json"), JSON.stringify({ add_bos_token: false }));
  writeSafetensors(join(dir, "model.safetensors"), hfEntriesFromGguf(engine, ggufBytes));

  const container = convertHfDirectory(dir);
  const hfModel = { kind: "hf" as const, bytes: new Uint8Array(container.bytes) };
  const served = engine.run(hfModel, { prompt: "a b", steps: 3, temperature: 0 }).tokens.join(",");
  assert.equal(served, reference, "the Unigram container decodes exactly like the GGUF fixture");
});

test("the ingest refuses a tokenizer.json model type it does not implement", () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-wordpiece-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ model_type: "llama" }));
  writeFileSync(
    join(dir, "tokenizer.json"),
    JSON.stringify({ model: { type: "WordPiece", vocab: {} } }),
  );
  assert.throws(() => tokenizeSection(dir, { model_type: "llama" }), /only BPE\/Unigram/);
});

test("Q4_K quantizes a super-block on the grid and decodes within one step", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  // 256 values on a 0.1 grid spanning [-0.8, 0.7]: a per-32 sub-block step of
  // exactly 0.1, so the reconstruction must land within half a step.
  const values = Float32Array.from({ length: 256 }, (_, i) => ((i % 16) - 8) * 0.1);
  const result = quantizeTensor("Q4_K", values, 256, 1);
  assert.equal(result.type, 12, "Q4_K is ggml type 12");
  const container = buildContainer({}, [
    { name: "t", type: result.type, dims: [256, 1], bytes: result.bytes },
  ]);
  const row = engine.dequantTensor!({ kind: "hf", bytes: new Uint8Array(container) }, "t", 0);
  assert.equal(row.length, 256);
  for (let i = 0; i < 256; i += 1) {
    assert.ok(
      Math.abs(row[i]! - values[i]!) <= 0.05 + 1e-4,
      `Q4_K[${i}] = ${row[i]} vs ${values[i]}`,
    );
  }
});

test("a Q4_K container decodes within the sub-block step and runs deterministically", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const ggufBytes = tinyGgufModel({
    arch: "qwen2",
    tokenizer: "gpt2",
    nEmbd: 256,
    nHead: 4,
    nHeadKv: 4,
    nFfn: 512,
  });
  const tokens = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (let i = 0; i < 24; i += 1) tokens.push(`<x${i}>`);
  const dir = mkdtempSync(join(tmpdir(), "rarext-q4k-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      model_type: "qwen2",
      hidden_size: 256,
      num_attention_heads: 4,
      num_key_value_heads: 4,
      intermediate_size: 512,
      num_hidden_layers: 1,
      rms_norm_eps: 1e-6,
      rope_theta: 10000,
      max_position_embeddings: 64,
      bos_token_id: 0,
      eos_token_id: 1,
    }),
  );
  writeFileSync(
    join(dir, "tokenizer.json"),
    JSON.stringify({
      model: { type: "BPE", vocab: Object.fromEntries(tokens.map((token, id) => [token, id])), merges: [] },
      added_tokens: [],
    }),
  );
  writeSafetensors(join(dir, "model.safetensors"), hfEntriesFromGguf(engine, ggufBytes));

  const container = convertHfDirectory(dir, { quant: "Q4_K" });
  assert.ok(container.ggmlTypes.includes("Q4_K"), "2D weights are Q4_K");
  assert.ok(container.ggmlTypes.includes("F32"), "norms stay F32");
  const model = { kind: "hf" as const, bytes: new Uint8Array(container.bytes) };

  const original = Array.from(
    engine.dequantTensor!({ kind: "gguf", bytes: new Uint8Array(ggufBytes) }, "blk.0.attn_q.weight", 0),
  );
  const quantized = Array.from(engine.dequantTensor!(model, "blk.0.attn_q.weight", 0));
  const span = Math.max(...original) - Math.min(...original);
  const bound = span / 15 / 2 + 1e-3;
  for (let i = 0; i < original.length; i += 1) {
    assert.ok(
      Math.abs(quantized[i]! - original[i]!) <= bound,
      `Q4_K error within a step at ${i}: ${quantized[i]} vs ${original[i]} (bound ${bound})`,
    );
  }

  const first = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  assert.ok(first.tokens.length >= 1);
  const second = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  assert.equal(first.tokens.join(","), second.tokens.join(","), "the Q4_K container is deterministic");
});

test("a Llama-family GGUF is served by the same RAREXT engine (standard RoPE + SentencePiece)", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = tinyGgufModel({ arch: "llama", tokenizer: "llama" });
    const model: ModelRef = {
      id: "tiny-llama",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "own-llama-engine"),
      port: 0,
      engineBundle,
    });
    const ask = async (): Promise<Response> =>
      fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "a b" }],
          max_tokens: 2,
          temperature: 0,
          seed: 3,
        }),
      });
    const first = await ask();
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as { rarext_trace?: { tokens?: number[] } };
    assert.equal(firstJson.rarext_trace?.tokens?.length, 2);
    const secondJson = (await (await ask()).json()) as { rarext_trace?: { tokens?: number[] } };
    assert.deepEqual(secondJson.rarext_trace?.tokens, firstJson.rarext_trace?.tokens);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});


test("RAREXT's own engine serves a Gemma GGUF (GeGLU, norm+1, sqrt(n_embd) embedding scale)", async () => {
  const serve = async (arch: "gemma", tokenizer: "llama"): Promise<void> => {
    const reg = await registry();
    let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
    try {
      const bytes = tinyGgufModel({ arch, tokenizer });
      const model: ModelRef = {
        id: `tiny-${arch}`,
        family: arch,
        parameters: "tiny",
        quantization: "F32",
        format: "gguf",
        sizeBytes: null,
        weightsDigest: null,
        contextLength: 64,
      };
      const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
      const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
      await uploadBundle({ registry: reg.base, bundle, chunks });
      const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
        source: readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
        name: "rarext-gguf-engine",
        engineVersion: "1",
        runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
        chunkBytes: 4096,
      });
      await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });
      provider = await startProvider({
        bundle,
        registry: reg.base,
        stateDir: join(reg.root, `own-${arch}-engine`),
        port: 0,
        engineBundle,
      });
      const ask = async (): Promise<Response> =>
        fetch(`${provider!.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: bundle.model.id,
            messages: [{ role: "user", content: "a b" }],
            max_tokens: 2,
            temperature: 0,
            seed: 5,
          }),
        });
      const first = await ask();
      assert.equal(first.status, 200, "the gemma model is served by RAREXT's own engine");
      const firstJson = (await first.json()) as { rarext_trace?: { tokens?: number[] } };
      assert.equal(firstJson.rarext_trace?.tokens?.length, 2);
      const secondJson = (await (await ask()).json()) as { rarext_trace?: { tokens?: number[] } };
      assert.deepEqual(secondJson.rarext_trace?.tokens, firstJson.rarext_trace?.tokens);
    } finally {
      if (provider !== null) await provider.close();
      await reg.close();
    }
  };
  await serve("gemma", "llama");
});

test("RAREXT's own engine routes a Mixtral GGUF through its expert bank", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = tinyGgufModel({ arch: "mixtral", tokenizer: "llama" });
    const model: ModelRef = {
      id: "tiny-mixtral",
      family: "mixtral",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source: readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "own-mixtral-engine"),
      port: 0,
      engineBundle,
    });
    const ask = async (): Promise<Response> =>
      fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "a b" }],
          max_tokens: 2,
          temperature: 0,
          seed: 5,
        }),
      });
    const first = await ask();
    assert.equal(first.status, 200, "the mixtral MoE model is served by RAREXT's own engine");
    const firstJson = (await first.json()) as { rarext_trace?: { tokens?: number[] } };
    assert.equal(firstJson.rarext_trace?.tokens?.length, 2);
    const secondJson = (await (await ask()).json()) as { rarext_trace?: { tokens?: number[] } };
    assert.deepEqual(secondJson.rarext_trace?.tokens, firstJson.rarext_trace?.tokens);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("the architecture branch is real: Gemma applies norm+1 where Llama applies norm", () => {
  // With all norm weights forced to 0, a plain RMSNorm zeroes the residual
  // stream, so Llama's logits are all zero and it always picks token 0. Gemma's
  // RMSNorm uses (w + 1), so the same committed tensors produce a real decode.
  // If the +1 branch were not applied, both would collapse to token 0.
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  const run = (arch: "llama" | "gemma"): number[] => {
    const bytes = tinyGgufModel({ arch, tokenizer: "llama", normValue: 0 });
    return engine.run(
      { kind: "gguf", bytes: new Uint8Array(bytes) },
      { prompt: "a b", steps: 3, temperature: 0 },
    ).tokens;
  };
  const llamaTokens = run("llama");
  const gemmaTokens = run("gemma");
  // The engine runs in a `node:vm` context, so its arrays carry that realm's
  // Array prototype; compare by value, not by prototype identity.
  assert.equal(llamaTokens.join(","), "0,0,0", "zero norms zero the Llama residual stream");
  assert.equal(gemmaTokens.length, 3);
  assert.ok(
    gemmaTokens.some((token) => token !== 0),
    `Gemma's norm+1 kept the residual stream alive; got ${JSON.stringify(gemmaTokens)}`,
  );
});

test("an unsupported architecture is refused instead of being silently mis-served", () => {
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  // A valid Llama layout relabeled as an architecture the engine does not know.
  const bytes = tinyGgufModel({ arch: "llama", tokenizer: "llama", archOverride: "phi" });
  assert.throws(
    () =>
      engine.run(
        { kind: "gguf", bytes: new Uint8Array(bytes) },
        { prompt: "a b", steps: 1, temperature: 0 },
      ),
    /qwen2\/llama\/mistral\/mixtral\/gemma\/phi3\/phi2 GGUF; got phi/,
  );
});

test("RAREXT's own engine serves an IQ4_NL-quantized GGUF through the quant-domain dot path", () => {
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  // nEmbd = 32 and MHA make every weight row a whole 32-value IQ4_NL block, so
  // the serving path exercises the non-linear 4-bit dot, not a float fallback.
  const bytes = tinyGgufModel({ arch: "qwen2", quant: "IQ4_NL", nEmbd: 32, nHead: 2, nHeadKv: 2 });
  const model = { kind: "gguf" as const, bytes: new Uint8Array(bytes) };
  const first = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  const second = engine.run(model, { prompt: "a b", steps: 3, temperature: 0 });
  assert.equal(first.tokens.length, 3);
  assert.equal(first.tokens.join(","), second.tokens.join(","), "the IQ4_NL run is deterministic");

  // The committed tensor really is IQ4_NL: every dequantized value is the block
  // scale (2^-4) times a table entry, not the original float.
  const iq4 = [-127, -104, -83, -65, -49, -35, -22, -10, 1, 13, 25, 38, 53, 69, 89, 113];
  const row = engine.dequantTensor!(model, "blk.0.attn_q.weight", 0);
  for (const value of Array.from(row)) {
    const entry = value / 0.0625;
    assert.ok(
      iq4.some((candidate) => Math.abs(candidate - entry) < 1e-9),
      `${value} is 2^-4 times an IQ4_NL table entry`,
    );
  }
});

test("RAREXT's own engine serves a Phi-3 GGUF (partial NeoX RoPE, fused QKV, fused gate/up)", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = tinyGgufModel({ arch: "phi3", tokenizer: "llama" });
    const model: ModelRef = {
      id: "tiny-phi3",
      family: "phi3",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source: readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "own-phi3-engine"),
      port: 0,
      engineBundle,
    });
    const ask = async (): Promise<Response> =>
      fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "a b" }],
          max_tokens: 2,
          temperature: 0,
          seed: 5,
        }),
      });
    const first = await ask();
    assert.equal(first.status, 200, "the phi3 model is served by RAREXT's own engine");
    const firstJson = (await first.json()) as { rarext_trace?: { tokens?: number[] } };
    assert.equal(firstJson.rarext_trace?.tokens?.length, 2);
    const secondJson = (await (await ask()).json()) as { rarext_trace?: { tokens?: number[] } };
    assert.deepEqual(secondJson.rarext_trace?.tokens, firstJson.rarext_trace?.tokens);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("Phi-3's fused QKV and gate/up tensors decode exactly like the equivalent separate ones", () => {
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  const run = (phi3Layout: "fused" | "separate"): string => {
    const bytes = tinyGgufModel({ arch: "phi3", tokenizer: "llama", phi3Layout });
    return engine
      .run(
        { kind: "gguf", bytes: new Uint8Array(bytes) },
        { prompt: "a b", steps: 3, temperature: 0 },
      )
      .tokens.join(",");
  };
  // The fixture's PRNG is seeded, and the fused rows are the same value
  // sequence as Q,K,V (or gate,up). A wrong split, order, or bias would show.
  assert.equal(run("fused"), run("separate"));
});

test("Phi-3 applies RoPE to only the declared rotary dimensions", () => {
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  // Head layout [d0 d1 d2 d3]; NeoX pairs (i, i + nRot/2) inside the head.
  const rotated = (nRot: number): number[] => {
    const vector = Float32Array.from([1, 0, 0, 0]);
    engine.rope!(vector, 1, 4, nRot, 1, 10000, true);
    return Array.from(vector);
  };
  const half = rotated(2);
  assert.ok(Math.abs(half[0]! - Math.cos(1)) < 1e-6, "d0 rotates");
  assert.ok(Math.abs(half[1]! - Math.sin(1)) < 1e-6, "d1 rotates");
  assert.equal(half[2], 0, "d2 is outside the 2 rotary dims and is untouched");
  assert.equal(half[3], 0, "d3 is outside the 2 rotary dims and is untouched");

  const full = rotated(4);
  assert.ok(Math.abs(full[0]! - Math.cos(1)) < 1e-6, "d0 rotates");
  assert.ok(Math.abs(full[2]! - Math.sin(1)) < 1e-6, "d2 is now inside the rotary span and rotates");
  assert.equal(full[1], 0, "d1 has no source value to rotate");
  assert.equal(full[3], 0, "d3 has no source value to rotate");
});

test("Phi LongRoPE divides each pair's angle by its factor and scales by attn_factor", () => {
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  const rotated = (factors: Float32Array | null, attn: number): number[] => {
    const vector = Float32Array.from([1, 0, 0, 0]);
    engine.rope!(vector, 1, 4, 4, 1, 10000, true, factors, attn, 1);
    return Array.from(vector);
  };
  const plain = rotated(null, 1);
  assert.ok(Math.abs(plain[0]! - Math.cos(1)) < 1e-6, "unscaled rope uses theta = position");
  const factored = rotated(Float32Array.from([2, 2]), 1);
  assert.ok(Math.abs(factored[0]! - Math.cos(0.5)) < 1e-6, "a factor of 2 halves the angle");
  const magnified = rotated(null, 2);
  assert.ok(Math.abs(magnified[0]! - 2 * Math.cos(1)) < 1e-6, "attn_factor scales cos/sin");
});

test("Phi LongRoPE picks the short factor set in-context and the long set past it", () => {
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  const model = (ropeOrigCtx: number) => ({
    kind: "gguf" as const,
    bytes: new Uint8Array(
      tinyGgufModel({
        arch: "phi3",
        tokenizer: "llama",
        longRope: true,
        nEmbd: 32,
        nHead: 2,
        nHeadKv: 2,
        nFfn: 64,
        ropeShortFactor: 1,
        ropeLongFactor: 8,
        ropeOrigCtx,
      }),
    ),
  });
  const inCtx = engine.ropeFactors!(model(4096), { prompt: "a b", steps: 3 });
  assert.equal(inCtx?.set, "short", "a run inside the original context uses the short set");
  assert.ok(inCtx!.values.every((value) => Math.abs(value - 1) < 1e-6), "short factors come from the short tensor");
  const past = engine.ropeFactors!(model(2), { prompt: "a b", steps: 3 });
  assert.equal(past?.set, "long", "a run past the original context uses the long set");
  assert.ok(past!.values.every((value) => Math.abs(value - 8) < 1e-6), "long factors come from the long tensor");
  // A model without LongRoPE factors reports none.
  const plain = { kind: "gguf" as const, bytes: new Uint8Array(tinyGgufModel({ arch: "qwen2" })) };
  assert.equal(engine.ropeFactors!(plain, { prompt: "a b", steps: 3 }), null);
});

test("RAREXT's own engine serves a Phi-2 GGUF (LayerNorm, GELU, parallel FFN residual)", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = tinyGgufModel({ arch: "phi2", tokenizer: "llama" });
    const model: ModelRef = {
      id: "tiny-phi2",
      family: "phi2",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source: readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "own-phi2-engine"),
      port: 0,
      engineBundle,
    });
    const ask = async (): Promise<Response> =>
      fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "a b" }],
          max_tokens: 2,
          temperature: 0,
          seed: 5,
        }),
      });
    const first = await ask();
    assert.equal(first.status, 200, "the phi2 model is served by RAREXT's own engine");
    const firstJson = (await first.json()) as { rarext_trace?: { tokens?: number[] } };
    assert.equal(firstJson.rarext_trace?.tokens?.length, 2);
    const secondJson = (await (await ask()).json()) as { rarext_trace?: { tokens?: number[] } };
    assert.equal(secondJson.rarext_trace?.tokens?.length, 2);
    assert.deepEqual(secondJson.rarext_trace?.tokens, firstJson.rarext_trace?.tokens);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("Phi-2's LayerNorm subtracts the mean where RMSNorm cannot", () => {
  const engine = loadEngine(
    readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)),
  );
  const x = Float32Array.from([1, 2, 3, 4]);
  const weight = Float32Array.from([1, 1, 1, 1]);
  const out = engine.layerNorm!(new Float32Array(4), x, weight, undefined, 0);
  const mean = Array.from(out).reduce((total, value) => total + value, 0) / out.length;
  const variance =
    Array.from(out).reduce((total, value) => total + (value - mean) * (value - mean), 0) / out.length;
  assert.ok(Math.abs(mean) < 1e-5, "LayerNorm output has zero mean");
  assert.ok(Math.abs(variance - 1) < 1e-4, "LayerNorm output has unit variance");
  // Every input is positive, so a negative output can only come from the mean
  // subtraction that RMSNorm does not perform.
  assert.ok(out[0]! < 0, `expected a mean-shifted negative value, got ${out[0]}`);
});

test("two providers agreeing on an answer agree even when their envelopes were minted a second apart", () => {
  // A completion carries per-request metadata: `id` includes a wall clock and
  // `created` is a timestamp. Two providers that said exactly the same thing can
  // finish in different seconds, so comparing the RAW envelope reports a false
  // disagreement. The protocol compares (and receipts sign) the comparable part.
  const base = {
    object: "chat.completion",
    model: "qwen2.5:0.5b",
    choices: [{ index: 0, message: { role: "assistant", content: "I am a computer." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    rarext_trace: { kind: "rarext.decode-trace.v1", tokens: [198, 40, 1079, 264], digest: "abc" },
  };
  const first = { ...base, id: "chatcmpl-aaa", created: 1_700_000_000 };
  const second = { ...base, id: "chatcmpl-bbb", created: 1_700_000_001 };
  assert.notEqual(canonicalDigest(first), canonicalDigest(second), "the raw envelopes differ");
  assert.equal(
    canonicalDigest(comparableCompletion(first)),
    canonicalDigest(comparableCompletion(second)),
    "the answers compare equal",
  );
  // The volatile fields are exactly the ones stripped; the trace is retained, so
  // a divergence in the decode is still caught.
  assert.equal(
    "rarext_trace" in comparableCompletion(first),
    true,
    "the comparable form keeps the decode trace",
  );
  const diverged = { ...second, rarext_trace: { ...base.rarext_trace, tokens: [1, 2, 3] } };
  assert.notEqual(
    canonicalDigest(comparableCompletion(first)),
    canonicalDigest(comparableCompletion(diverged)),
    "a different decode is still a disagreement",
  );
});

test("the engine itself is a RAREXT artifact a provider fetches, verifies, and runs", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const { bundle } = await publishNative({ base: reg.base });

    // A tiny engine module: deterministic, and its output is NOT the built-in
    // engine's, so the test can tell which engine actually ran.
    const source = Buffer.from(
      [
        "module.exports.run = function (model, input) {",
        "  var seed = (input.seed == null ? 7 : input.seed) >>> 0;",
        "  var steps = Math.max(1, Math.min(input.steps || 4, 4));",
        "  var tokens = [];",
        "  for (var i = 0; i < steps; i++) { seed = (seed * 1103515245 + 12345) >>> 0; tokens.push(seed % model.vocab.length); }",
        "  return { text: tokens.map(function (t) { return model.vocab[t]; }).join(''), seed: seed, steps: steps, tokens: tokens };",
        "};",
      ].join("\n"),
    );
    const { bundle: engineBundle, chunks } = buildEngineBundle({
      source,
      name: "rarext-test-engine",
      engineVersion: "1",
      chunkBytes: 24,
    });
    assert.deepEqual(verifyEngineBundle(engineBundle), []);
    assert.ok(engineBundle.shards.length > 1, "the engine artifact is sharded");
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks });

    // The provider fetches every engine shard from RAREXT, verifies the digest,
    // and runs the FETCHED engine.
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "provider"),
      port: 0,
      engineBundle,
    });
    const health = (await (await fetch(`${provider.url}/health`)).json()) as {
      engineFingerprint: string;
    };
    assert.equal(
      health.engineFingerprint,
      engineDescriptorFingerprint({
        name: "rarext-test-engine",
        version: "1",
        digest: engineBundle.artifactDigest,
      }),
      "the engine-bundle digest is folded into the engine fingerprint",
    );

    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "engine from RAREXT" }],
        max_tokens: 4,
        temperature: 0,
        seed: 5,
      }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { rarext_trace?: { tokens: number[] } };
    // Recompute the FETCHED engine's tokens for seed 5 independently; the
    // built-in engine would give a different sequence.
    const vocab = (JSON.parse(NATIVE_BYTES.toString("utf8")) as { vocab: string[] }).vocab;
    const expected: number[] = [];
    let seed = 5 >>> 0;
    for (let index = 0; index < 4; index += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      expected.push(seed % vocab.length);
    }
    assert.deepEqual(json.rarext_trace?.tokens, expected, "the served trace is the fetched engine's");

    // A tampered engine artifact — a committed digest that does not match the
    // reassembled bytes — is refused before the provider can serve it.
    const tampered = { ...engineBundle, artifactDigest: `sha256:${"0".repeat(64)}` };
    const { digest: _digest, ...covered } = tampered;
    const reDigested = { ...tampered, digest: canonicalDigest(covered) };
    await assert.rejects(
      () => fetchEngineArtifact({ registries: [reg.base], bundle: reDigested }),
      /engine artifact digest .* does not match the committed/,
    );
    // A module that is not an engine is refused by the loader.
    assert.throws(() => loadEngine(Buffer.from("module.exports = {};")), /exports no run/);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("OpenAI decoding fields are parsed with defaults, clamps, and stop truncation", () => {
  assert.deepEqual(decodingParams({}), {
    temperature: 0,
    topK: 0,
    topP: 1,
    minP: 0,
    typicalP: 1,
    logitBias: [],
    repetitionPenalty: 1,
    presencePenalty: 0,
    frequencyPenalty: 0,
    stop: [],
    logprobs: false,
    topLogprobs: 0,
  });

  const parsed = decodingParams({
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    repetition_penalty: 1.2,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    stop: ["</s>", "\n\n"],
  });
  assert.equal(parsed.temperature, 0.7);
  assert.equal(parsed.topK, 40);
  assert.equal(parsed.topP, 0.9);
  assert.equal(parsed.repetitionPenalty, 1.2);
  assert.equal(parsed.presencePenalty, 0.1);
  assert.equal(parsed.frequencyPenalty, 0.2);
  assert.deepEqual(parsed.stop, ["</s>", "\n\n"]);
  assert.equal(parsed.logprobs, false);

  // Both OpenAI shapes are accepted: boolean + top_logprobs (chat) and an
  // integer (legacy completions). Out-of-range counts clamp.
  assert.deepEqual(
    [decodingParams({ logprobs: true }).logprobs, decodingParams({ logprobs: true }).topLogprobs],
    [true, 0],
  );
  assert.deepEqual(
    [decodingParams({ logprobs: true, top_logprobs: 3 }).topLogprobs, decodingParams({ logprobs: 5 }).topLogprobs],
    [3, 5],
  );
  assert.equal(decodingParams({ logprobs: true, top_logprobs: 99 }).topLogprobs, 20);

  // logit_bias: OpenAI's string-keyed map, clamped and filtered.
  assert.deepEqual(
    decodingParams({ logit_bias: { "3": 100, "-1": 5, x: 2, "4": "no" } }).logitBias,
    [[3, 100]],
    "only non-negative integer ids with numeric values are honoured",
  );
  assert.deepEqual(decodingParams({ logit_bias: { "0": 1000, "1": -1000 } }).logitBias, [
    [0, 100],
    [1, -100],
  ]);
  assert.equal(decodingParams({ min_p: -1 }).minP, 0);
  assert.equal(decodingParams({ min_p: 2 }).minP, 1);
  assert.equal(decodingParams({ typical_p: 0.5 }).typicalP, 0.5);

  // A hostile or sloppy client cannot make a run unbounded or non-finite.
  assert.equal(decodingParams({ temperature: -5 }).temperature, 0);
  assert.equal(decodingParams({ temperature: Number.NaN }).temperature, 0);
  assert.equal(decodingParams({ top_p: 7 }).topP, 1);
  assert.equal(decodingParams({ top_p: Number.POSITIVE_INFINITY }).topP, 1);
  assert.equal(decodingParams({ top_k: 1e9 }).topK, 4096);
  assert.equal(decodingParams({ repetition_penalty: 0 }).repetitionPenalty, 0.01);
  assert.deepEqual(decodingParams({ stop: "END" }).stop, ["END"]);
  assert.equal(decodingParams({ stop: Array.from({ length: 20 }, () => "x") }).stop.length, 8);

  assert.deepEqual(applyStop("abcSTOPdef", ["STOP"]), { text: "abc", stopped: true });
  assert.deepEqual(applyStop("abcSTOPdef", ["zzz", "STOP"]), { text: "abc", stopped: true });
  assert.deepEqual(applyStop("abc", ["STOP"]), { text: "abc", stopped: false });
});

test("decoding controls: top-k and top-p restrict the sampler; greedy stays greedy", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const model = { kind: "gguf" as const, bytes: new Uint8Array(tinyGgufModel()) };

  const greedy = engine.run(model, { prompt: "ab", steps: 6, temperature: 0, seed: 3 });
  assert.ok(greedy.tokens.length > 0, "the fixture produces tokens");

  // top_k=1 leaves exactly one candidate, so a sampled run must equal greedy.
  const topOne = engine.run(model, { prompt: "ab", steps: 6, temperature: 0.9, seed: 3, topK: 1 });
  assert.deepEqual(topOne.tokens, greedy.tokens, "top_k=1 is greedy");

  // A nucleus below the top token's mass also leaves exactly one candidate.
  const nucleus = engine.run(model, { prompt: "ab", steps: 6, temperature: 0.9, seed: 3, topP: 1e-9 });
  assert.deepEqual(nucleus.tokens, greedy.tokens, "top_p below the top mass is greedy");

  // Unrestricted sampling is still reproducible from the seed.
  const a = engine.run(model, { prompt: "ab", steps: 6, temperature: 0.9, seed: 3 });
  const b = engine.run(model, { prompt: "ab", steps: 6, temperature: 0.9, seed: 3 });
  assert.deepEqual(a.tokens, b.tokens, "a sampled run is seed-deterministic");
  assert.deepEqual(a.text, b.text, "and so is its text");
});

test("decoding controls: penalties reduce repetition and stop ends the run", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const model = { kind: "gguf" as const, bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama" })) };

  const repeats = (tokens: number[]): number => new Set(tokens).size === tokens.length
    ? 0
    : tokens.length - new Set(tokens).size;

  const base = engine.run(model, { prompt: "ab", steps: 16, temperature: 0, seed: 0 });
  assert.ok(
    repeats(base.tokens) > 0,
    `the greedy fixture repeats a token, so the penalty is testable (got ${base.tokens.join(",")})`,
  );

  const penalized = engine.run(model, {
    prompt: "ab",
    steps: 16,
    temperature: 0,
    seed: 0,
    repetitionPenalty: 8,
  });
  assert.ok(
    repeats(penalized.tokens) < repeats(base.tokens),
    `repetition_penalty reduces repeats: ${repeats(base.tokens)} -> ${repeats(penalized.tokens)}`,
  );

  // The run ends AT the stop sequence, and the sequence is not returned.
  const decodeOne = (ids: number[]): string =>
    (engine as unknown as { decode(model: unknown, ids: number[]): string }).decode(model, ids);
  const decoded = base.tokens.map((token) => decodeOne([token]));
  assert.ok(
    decoded.some((text) => text.length > 0),
    `the greedy run decodes some text to test stop (tokens=${base.tokens.join(",")} decoded=${JSON.stringify(decoded)})`,
  );
  const stop = decoded.find((text) => text.length > 0)!;
  assert.ok(base.text.includes(stop), `the decoded text carries the stop (${JSON.stringify({ stop, text: base.text })})`);
  const at = base.text.indexOf(stop);
  const stopped = engine.run(model, {
    prompt: "ab",
    steps: 16,
    temperature: 0,
    seed: 0,
    stop: [stop],
  });
  assert.equal(stopped.finishReason, "stop");
  assert.equal(stopped.text, base.text.slice(0, at));
  assert.equal(stopped.text.includes(stop), false, "the stop text is not returned");

  // A run that reaches its step budget without a stop reports "length", and a
  // 64-step request against a 64-token context is capped so it cannot overrun.
  const budget = engine.run(model, { prompt: "ab", steps: 64, temperature: 0, seed: 0 });
  const budgetSteps = budget.contextLength! - budget.promptTokens! + 1;
  assert.ok(
    (budget.promptTokens ?? 0) + Math.max(0, budget.tokens.length - 1) <= budget.contextLength!,
    "the 64-step run stayed inside the 64-token context",
  );
  assert.equal(budget.finishReason, budget.tokens.length >= budgetSteps ? "length" : "stop");
});

test("a prompt longer than the declared context truncates to the tail and bounds the run", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const contextLength = 12;
  const model = {
    kind: "gguf" as const,
    bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama", contextLength })),
  };
  const encode = (text: string): number[] => engine.encode!(model, text);

  // Every character here is in the SPM fixture's vocabulary, so the prompt
  // tokenizes to a known length rather than falling back to BOS alone.
  const prompt = "abcdefg".repeat(8);
  const full = encode(prompt);
  assert.ok(
    full.length > contextLength,
    `the fixture prompt is longer than the declared context (${full.length} > ${contextLength})`,
  );

  // A 256-step request against a 12-token context must not run 256 positions.
  const run = engine.run(model, { prompt, steps: 256, temperature: 0, seed: 0 });
  assert.equal(run.contextLength, contextLength);
  assert.equal(run.promptTruncated, true);
  assert.equal(run.promptTokens, contextLength);
  assert.equal(run.promptIds?.length, contextLength);
  assert.equal(run.promptIds?.[0], 0, "the truncation keeps BOS at the front");
  assert.deepEqual(
    run.promptIds,
    (() => {
      const tail = full.slice(full.length - contextLength);
      if (tail[0] !== 0) tail[0] = 0;
      return tail;
    })(),
    "the truncation keeps the most recent tokens, not the oldest",
  );

  // Positions = prompt + (generated - 1); the first generated token comes out
  // of the last prompt position. It can never exceed the declared context.
  const positions = (result: { promptTokens?: number; tokens: number[] }): number =>
    (result.promptTokens ?? 0) + Math.max(0, result.tokens.length - 1);
  assert.ok(
    positions(run) <= contextLength,
    `the run stayed inside the context (${positions(run)} <= ${contextLength})`,
  );
  assert.ok(run.tokens.length <= 1, `the step budget was capped to the left-over context (${run.tokens.length})`);
  assert.equal(run.finishReason, run.tokens.length === 0 ? "stop" : "length");

  // Deterministic: the same oversized request truncates the same way.
  const again = engine.run(model, { prompt, steps: 256, temperature: 0, seed: 0 });
  assert.deepEqual(again.promptIds, run.promptIds);
  assert.deepEqual(again.tokens, run.tokens);
  assert.equal(again.finishReason, run.finishReason);
});

test("a prompt that fits the context is untouched, and the step budget is only cut when needed", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const contextLength = 16;
  const model = {
    kind: "gguf" as const,
    bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama", contextLength })),
  };
  const prompt = "abcdefg";
  const full = engine.encode!(model, prompt);
  assert.ok(full.length > 0 && full.length < contextLength);

  const run = engine.run(model, { prompt, steps: 256, temperature: 0, seed: 0 });
  assert.equal(run.promptTruncated, false);
  assert.deepEqual(run.promptIds, full, "a fitting prompt is evaluated verbatim");
  assert.equal(run.contextLength, contextLength);

  // The run can use contextLength - prompt + 1 steps at most.
  const budget = contextLength - full.length + 1;
  assert.ok(
    run.tokens.length <= budget,
    `steps were capped to the context (${run.tokens.length} <= ${budget})`,
  );
  assert.equal(run.finishReason, run.tokens.length >= budget ? "length" : "stop");

  // A call that fits both prompt and steps is not shortened.
  const small = engine.run(model, { prompt, steps: 3, temperature: 0, seed: 0 });
  assert.equal(small.promptTruncated, false);
  assert.ok(small.tokens.length <= 3);
});

test("the engine reports its own logprobs, aligned with the tokens it emitted", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const model = { kind: "gguf" as const, bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama" })) };

  // Off by default: a caller that does not ask pays no vocabulary-wide exp().
  const plain = engine.run(model, { prompt: "ab", steps: 6, temperature: 0, seed: 0 });
  assert.equal("logprobs" in plain, false);

  const run = engine.run(model, {
    prompt: "ab",
    steps: 6,
    temperature: 0,
    seed: 0,
    logprobs: true,
    topLogprobs: 4,
  });
  assert.ok(run.logprobs !== undefined, "logprobs were requested and returned");
  assert.equal(run.logprobs!.length, run.tokens.length, "one entry per generated token");
  for (const [i, entry] of run.logprobs!.entries()) {
    assert.equal(entry.token, run.tokens[i], "entries are aligned with tokens");
    assert.ok(
      Number.isFinite(entry.logprob) && entry.logprob <= 0,
      `logprob ${entry.logprob} is a natural log of a probability`,
    );
    assert.equal(entry.top.length, 4);
    // Greedy picks the argmax, so the chosen token heads its own top list.
    assert.equal(entry.top[0]!.token, entry.token);
    assert.equal(entry.top[0]!.logprob, entry.logprob);
    for (let k = 1; k < entry.top.length; k += 1) {
      assert.ok(entry.top[k - 1]!.logprob >= entry.top[k]!.logprob, "alternatives descend");
    }
    assert.ok(entry.top.every((alt) => Number.isFinite(alt.logprob) && alt.logprob <= 0));
  }

  // Sampling can pick a token that is not the most likely one; the reported
  // confidence is still the model's, not a re-scored sampler artifact.
  const sampled = engine.run(model, {
    prompt: "ab",
    steps: 8,
    temperature: 0.9,
    seed: 3,
    topK: 2,
    logprobs: true,
    topLogprobs: 1,
  });
  assert.equal(sampled.logprobs!.length, sampled.tokens.length);
  for (const entry of sampled.logprobs!) {
    assert.ok(
      entry.logprob <= entry.top[0]!.logprob + 1e-9,
      `the sampled token cannot beat the best token (${entry.logprob} <= ${entry.top[0]!.logprob})`,
    );
  }

  // A stop sequence removes the token that carried it, so ids, logprobs, and
  // text stay aligned rather than reporting confidence for text not returned.
  const stopped = engine.run(model, {
    prompt: "ab",
    steps: 8,
    temperature: 0,
    seed: 0,
    logprobs: true,
    topLogprobs: 2,
    stop: [run.text.slice(0, 1)],
  });
  assert.equal(stopped.finishReason, "stop");
  assert.equal(stopped.logprobs!.length, stopped.tokens.length);
  assert.ok(stopped.text.length < run.text.length, "the stop shortened the answer");
  assert.equal(
    stopped.tokens.map((token) => engine.decode!(model, [token])).join(""),
    stopped.text,
    "the remaining token texts reconstruct the returned text",
  );

  // Confidence is deterministic along with the tokens.
  const again = engine.run(model, {
    prompt: "ab",
    steps: 6,
    temperature: 0,
    seed: 0,
    logprobs: true,
    topLogprobs: 4,
  });
  assert.deepEqual(again.logprobs, run.logprobs);
});

test("decoding controls: logit bias, min-p, and typical-p all shape the sampler", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const model = { kind: "gguf" as const, bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama" })) };

  // logit_bias: a large boost makes a token certain, and the reported logprob
  // agrees because the bias is applied to the logits the sampler used.
  const forced = engine.run(model, {
    prompt: "ab",
    steps: 1,
    temperature: 0,
    seed: 0,
    logitBias: [[3, 1000]],
    logprobs: true,
    topLogprobs: 1,
  });
  assert.equal(forced.tokens[0], 3);
  assert.ok(
    forced.logprobs![0]!.logprob > -1e-9,
    `the biased token is near-certain (${forced.logprobs![0]!.logprob})`,
  );
  const removed = engine.run(model, { prompt: "ab", steps: 1, temperature: 0, seed: 0, logitBias: [[3, -1000]] });
  assert.notEqual(removed.tokens[0], 3, "a large negative bias removes the token");
  // An out-of-vocabulary id is ignored, not fatal.
  const ignored = engine.run(model, { prompt: "ab", steps: 3, temperature: 0, seed: 0, logitBias: [[999999, 5]] });
  assert.deepEqual(ignored.tokens, engine.run(model, { prompt: "ab", steps: 3, temperature: 0, seed: 0 }).tokens);

  // min-p is an invariant of the draw: every chosen token keeps at least `minP`
  // of the best token's probability.
  const minP = 0.5;
  const sampled = engine.run(model, {
    prompt: "ab",
    steps: 12,
    temperature: 1,
    seed: 9,
    minP,
    logprobs: true,
    topLogprobs: 1,
  });
  assert.equal(sampled.logprobs!.length, sampled.tokens.length);
  for (const entry of sampled.logprobs!) {
    const ratio = Math.exp(entry.logprob - entry.top[0]!.logprob);
    assert.ok(ratio >= minP - 1e-9, `min-p kept a token below the floor (${ratio} < ${minP})`);
  }

  // typical-p restricts the draw and stays seed-deterministic.
  const plain = engine.run(model, { prompt: "ab", steps: 12, temperature: 1, seed: 9 });
  const typical = engine.run(model, { prompt: "ab", steps: 12, temperature: 1, seed: 9, typicalP: 0.4 });
  assert.notDeepEqual(typical.tokens, plain.tokens, "typical-p changed the sampled sequence");
  const typicalAgain = engine.run(model, { prompt: "ab", steps: 12, temperature: 1, seed: 9, typicalP: 0.4 });
  assert.deepEqual(typicalAgain.tokens, typical.tokens, "typical-p is seed-deterministic");
});

test("the embeddings endpoint returns deterministic, normalized vectors from the verified weights", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = tinyGgufModel({ tokenizer: "llama" });
    const model: ModelRef = {
      id: "tiny-embed",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "embeddings"),
      port: 0,
      engineBundle,
    });

    type EmbeddingResponse = {
      object: string;
      data: Array<{ object: string; index: number; embedding: number[] | string }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    const embed = async (input: unknown, extra: Record<string, unknown> = {}): Promise<EmbeddingResponse> => {
      const response = await fetch(`${provider!.url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: bundle.model.id, input, ...extra }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as EmbeddingResponse;
    };

    const one = await embed("ab");
    assert.equal(one.object, "list");
    assert.equal(one.data.length, 1);
    assert.equal(one.data[0]!.object, "embedding");
    assert.equal(one.data[0]!.index, 0);
    assert.equal(one.model, bundle.model.id);
    assert.ok(one.usage.prompt_tokens > 0 && one.usage.total_tokens === one.usage.prompt_tokens);
    const vector = one.data[0]!.embedding as number[];
    assert.equal(vector.length, 8, "the dimension is the model's n_embd");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 1e-5, `the vector is L2-normalized (norm=${norm})`);

    // Deterministic across requests and across processes: no RNG is involved.
    const again = await embed("ab");
    assert.deepEqual(again.data[0]!.embedding, vector, "the same input gives the same vector");

    // The vector is exactly the normalized mean of the token embedding rows,
    // recomputed independently through the engine's own dequantizer.
    const engine = loadEngine(source);
    const engineModel = { kind: "gguf" as const, bytes: new Uint8Array(bytes) };
    const ids = engine.encode!(engineModel, "ab");
    const rows = ids.map((id) =>
      Array.from(engine.dequantTensor!(engineModel, "token_embd.weight", id)),
    );
    const mean = rows[0]!.map(
      (_, column) => rows.reduce((sum, row) => sum + row[column]!, 0) / rows.length,
    );
    const meanNorm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0));
    vector.forEach((value, column) => {
      assert.ok(
        Math.abs(value - mean[column]! / meanNorm) < 1e-6,
        `dimension ${column} is the normalized mean of the token rows`,
      );
    });

    // An array input yields one vector per entry, indexed in order, and
    // different text gives a different vector.
    const many = await embed(["a", "b"]);
    assert.equal(many.data.length, 2);
    assert.deepEqual(many.data.map((entry) => entry.index), [0, 1]);
    const single = await embed("a");
    assert.equal(
      many.usage.prompt_tokens,
      2 * single.usage.prompt_tokens,
      "usage sums the tokens of every input",
    );
    assert.notDeepEqual(many.data[0]!.embedding, many.data[1]!.embedding);

    // Token ids are accepted and agree with the text form.
    const byIds = await embed(ids);
    assert.deepEqual(byIds.data[0]!.embedding, vector);

    // base64 encoding_format decodes to the same floats.
    const base64 = await embed("ab", { encoding_format: "base64" });
    const raw = Buffer.from(base64.data[0]!.embedding as string, "base64");
    const decoded = Array.from(
      new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)),
    );
    decoded.forEach((value, column) => {
      assert.ok(Math.abs(value - vector[column]!) < 1e-9, `base64 dimension ${column}`);
    });

    // Malformed input is refused, not silently embedded.
    const bad = await fetch(`${provider.url}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bundle.model.id, input: { not: "a string" } }),
    });
    assert.equal(bad.status, 400);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("tool calls are rendered, parsed into the OpenAI shape, and replayable", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    // Byte-fallback tokens so JSON punctuation round-trips through the fixture.
    const bytes = tinyGgufModel({ tokenizer: "llama", byteTokens: true, contextLength: 512 });
    const model: ModelRef = {
      id: "tiny-tools",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 512,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "tools"),
      port: 0,
      engineBundle,
    });

    // Parser unit checks: only declared functions are accepted, and prose with
    // no JSON yields no call.
    const declared = parseTools([
      { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
      { type: "function", function: { name: "get_time" } },
      { type: "not-function", function: { name: "nope" } },
      { type: "function", function: { name: "bad name!" } },
    ]);
    assert.deepEqual(declared.map((tool) => tool.name), ["get_weather", "get_time"]);
    assert.equal(extractToolCalls("no json here", declared, parseToolChoice(undefined)).length, 0);
    assert.equal(
      extractToolCalls('{"name":"get_moon","arguments":{}}', declared, parseToolChoice(undefined)).length,
      0,
      "an undeclared tool is refused",
    );
    assert.equal(
      extractToolCalls(
        'sure! {"name":"get_time","arguments":{"zone":"UTC"}} done',
        declared,
        parseToolChoice(undefined),
      ).length,
      1,
      "a tool call is found inside surrounding prose",
    );
    assert.equal(
      extractToolCalls('{"name":"get_weather","arguments":{}}', declared, parseToolChoice("none")).length,
      0,
    );
    assert.deepEqual(jsonObjects('a {"x":{"y":1}} b {"z":2}').length, 2);

    // The exact tool-call JSON the constrained decode will emit.
    const engine = loadEngine(source);
    const engineModel = { kind: "gguf" as const, bytes: new Uint8Array(bytes) };
    const callJson = '{"name":"get_weather","arguments":{"city":"Paris"}}';
    // Array.from: the engine returns a cross-realm array from the vm sandbox.
    const pinned = Array.from(engine.encode!(engineModel, callJson));
    assert.equal(engine.decode!(engineModel, pinned), callJson, "the fixture round-trips the tool JSON");

    type ToolResponse = {
      choices: Array<{
        index: number;
        message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
      rarext_trace?: { kind?: string; tokens?: number[] };
      usage: { total_tokens: number };
    };
    const askTool = async (extra: Record<string, unknown>) => {
      const response = await fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "What is the weather in Paris?" }],
          tools: [
            {
              type: "function",
              function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
            },
          ],
          max_completion_tokens: pinned.length + 8,
          ...extra,
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as ToolResponse;
    };

    const called = await askTool({ pinned_tokens: pinned });
    assert.equal(called.choices[0]!.finish_reason, "tool_calls");
    assert.equal(called.choices[0]!.message.content, null);
    const call = called.choices[0]!.message.tool_calls![0]!;
    assert.equal(call.type, "function");
    assert.equal(call.function.name, "get_weather");
    assert.deepEqual(JSON.parse(call.function.arguments), { city: "Paris" });
    assert.match(call.id, /^call_[0-9a-f]{24}$/);
    assert.equal(called.rarext_trace?.kind, "rarext.decode-trace.v1");
    assert.deepEqual(called.rarext_trace?.tokens, pinned, "the trace records the emitted tool-call tokens");

    // Reproducible: the same request returns the same call and the same trace.
    const again = await askTool({ pinned_tokens: pinned });
    assert.deepEqual(again.choices[0]!.message.tool_calls, called.choices[0]!.message.tool_calls);
    assert.deepEqual(again.rarext_trace?.tokens, called.rarext_trace?.tokens);

    // tool_choice "none" disables tools: the same pinned text is not parsed.
    const disabled = await askTool({ pinned_tokens: pinned, tool_choice: "none" });
    assert.equal(disabled.choices[0]!.message.tool_calls, undefined);
    assert.notEqual(disabled.choices[0]!.finish_reason, "tool_calls");

    // An undeclared tool in the output is not returned as a call.
    const foreign = '{"name":"get_moon","arguments":{"moon":"full"}}';
    const foreignPinned = Array.from(engine.encode!(engineModel, foreign));
    const refused = await askTool({ pinned_tokens: foreignPinned });
    assert.equal(refused.choices[0]!.message.tool_calls, undefined);
    assert.notEqual(refused.choices[0]!.finish_reason, "tool_calls");

    // Streaming carries the tool call as a delta and finishes with tool_calls.
    const streamed = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: bundle.model.id,
        messages: [{ role: "user", content: "What is the weather in Paris?" }],
        tools: [
          { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
        ],
        max_completion_tokens: pinned.length + 8,
        pinned_tokens: pinned,
        stream: true,
      }),
    });
    const raw = await streamed.text();
    const frames = raw
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: ") && !frame.includes("[DONE]"))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as {
        choices: Array<{ delta?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string | null }>;
      });
    const delta = frames.find((frame) => frame.choices[0]?.delta?.tool_calls !== undefined);
    assert.ok(delta !== undefined, "a tool_calls delta was streamed");
    assert.equal(delta!.choices[0]!.delta!.tool_calls![0]!.function.name, "get_weather");
    assert.equal(frames.at(-1)!.choices[0]!.finish_reason, "tool_calls");
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a JSON schema compiles to a byte DFA that decides the language exactly", () => {
  const anyJson = jsonObjectDfa();
  for (const text of ["{}", "[]", '{"a":1}', "[1,2,3]", '"hi"', '{"a":{"b":[null]}}', "12.5e-3", "false"]) {
    assert.ok(dfaAccepts(anyJson, text), `json_object accepts ${text}`);
  }
  for (const text of ["", "{", "tru", "1.", '{"a":1,}', "[1,]", "nul"]) {
    assert.equal(dfaAccepts(anyJson, text), false, `json_object rejects ${JSON.stringify(text)}`);
  }

  const schema = {
    type: "object",
    properties: { kind: { enum: ["hot", "cold"] }, ok: { type: "boolean" } },
    required: ["kind", "ok"],
    additionalProperties: false,
  };
  const dfa = schemaDfa(schema);
  for (const text of ['{"kind":"hot","ok":true}', '{"kind":"cold","ok":false}']) {
    assert.ok(dfaAccepts(dfa, text), `schema accepts ${text}`);
  }
  for (const text of [
    '{"ok":true}',
    '{"kind":"warm","ok":true}',
    '{"kind":"hot","ok":true,"x":1}',
    '{"kind":"hot"}',
    '{"kind":"hot","ok":true',
  ]) {
    assert.equal(dfaAccepts(dfa, text), false, `schema rejects ${JSON.stringify(text)}`);
  }
  // Every prefix of a legal document stays live; a dead byte is refused early.
  assert.ok(dfaLivePrefix(dfa, '{"kind":"ho'));
  assert.equal(dfaLivePrefix(dfa, '{"kind":"wa'), false);

  // Unsupported schemas are refused, not silently ignored.
  assert.throws(() => schemaDfa({ type: "object", properties: { a: { type: "string" } }, additionalProperties: true }));
  assert.throws(() => schemaDfa({ type: "object", properties: { a: { type: "frobnicate" } }, additionalProperties: false }));
  assert.throws(() => responseFormatDfa({ type: "json_schema", json_schema: { strict: false, schema: {} } }));
  assert.throws(() => responseFormatDfa({ type: "json_schema", json_schema: { strict: true, schema: { type: "frobnicate" } } }));
  assert.equal(responseFormatDfa({ type: "json_object" }) !== null, true);
});

test("constrained decoding only emits tokens the grammar allows", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const model = {
    kind: "gguf" as const,
    bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama", byteTokens: true, contextLength: 512 })),
  };
  const dfa = schemaDfa({
    type: "object",
    properties: { kind: { enum: ["hot", "cold"] }, ok: { type: "boolean" } },
    required: ["kind", "ok"],
    additionalProperties: false,
  });
  const run = engine.run(model, {
    prompt: "ab",
    steps: 64,
    temperature: 0,
    seed: 0,
    logprobs: true,
    topLogprobs: 1,
    grammarDfa: { accept: dfa.accept, table: dfa.table },
  });
  assert.equal(run.finishReason, "stop", "the run ends when the document is complete");
  assert.ok(dfaAccepts(dfa, run.text), `the output is inside the language: ${JSON.stringify(run.text)}`);
  const parsed = JSON.parse(run.text) as { kind: string; ok: boolean };
  assert.ok(["hot", "cold"].includes(parsed.kind));
  assert.equal(typeof parsed.ok, "boolean");
  // Every prefix the engine emitted stayed live, so no token ever left the
  // language and was then abandoned.
  const prefixes = Array.from(engine.decodePrefixes!(model, run.tokens));
  for (const prefix of prefixes) assert.ok(dfaLivePrefix(dfa, prefix), `live prefix ${JSON.stringify(prefix)}`);
  assert.equal(run.logprobs?.length, run.tokens.length, "constrained tokens still carry logprobs");

  const again = engine.run(model, {
    prompt: "ab",
    steps: 64,
    temperature: 0,
    seed: 0,
    grammarDfa: { accept: dfa.accept, table: dfa.table },
  });
  assert.equal(again.text, run.text);
  assert.deepEqual(Array.from(again.tokens), Array.from(run.tokens));
});

test("response_format constrains the chat decode to the declared language", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const bytes = tinyGgufModel({ tokenizer: "llama", byteTokens: true, contextLength: 512 });
    const model: ModelRef = {
      id: "tiny-format",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 512,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "format"),
      port: 0,
      engineBundle,
    });

    const chat = async (responseFormat: unknown) => {
      const response = await fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages: [{ role: "user", content: "give me a JSON object" }],
          max_completion_tokens: 64,
          response_format: responseFormat,
        }),
      });
      return response;
    };
    type FormatResponse = {
      choices: Array<{ message: { content: string | null }; finish_reason: string }>;
      rarext_trace?: { kind?: string; tokens?: number[] };
    };

    const schemaFormat = {
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { kind: { enum: ["hot", "cold"] }, ok: { type: "boolean" } },
          required: ["kind", "ok"],
          additionalProperties: false,
        },
      },
    };
    const first = await chat(schemaFormat);
    assert.equal(first.status, 200);
    const body = (await first.json()) as FormatResponse;
    const content = body.choices[0]!.message.content!;
    assert.equal(body.choices[0]!.finish_reason, "stop");
    assert.equal(body.rarext_trace?.kind, "rarext.decode-trace.v1");
    assert.ok((body.rarext_trace?.tokens?.length ?? 0) > 0);
    const parsed = JSON.parse(content) as { kind: string; ok: boolean };
    assert.ok(["hot", "cold"].includes(parsed.kind), `kind came from the enum: ${content}`);
    assert.equal(typeof parsed.ok, "boolean");
    assert.deepEqual(Object.keys(parsed).sort(), ["kind", "ok"], "no property outside the schema");

    // Reproducible: same request, same constrained document, same trace.
    const second = (await (await chat(schemaFormat)).json()) as FormatResponse;
    assert.equal(second.choices[0]!.message.content, content);
    assert.deepEqual(second.rarext_trace?.tokens, body.rarext_trace?.tokens);

    // json_object: whatever the model says stays a live JSON prefix.
    const loose = await chat({ type: "json_object" });
    assert.equal(loose.status, 200);
    const looseBody = (await loose.json()) as FormatResponse;
    const looseText = looseBody.choices[0]!.message.content ?? "";
    assert.ok(looseText.length > 0);
    assert.ok(
      dfaLivePrefix(jsonObjectDfa(), looseText),
      `the output is a live JSON prefix: ${JSON.stringify(looseText)}`,
    );
    if (looseBody.choices[0]!.finish_reason === "stop") {
      JSON.parse(looseText);
    }

    // A schema that cannot be constrained is refused, not ignored.
    const looseSchema = await chat({
      type: "json_schema",
      json_schema: { name: "x", strict: true, schema: { type: "object", properties: {}, additionalProperties: true } },
    });
    assert.equal(looseSchema.status, 400);
    const nonStrict = await chat({
      type: "json_schema",
      json_schema: { name: "x", strict: false, schema: { type: "object", properties: {}, additionalProperties: false } },
    });
    assert.equal(nonStrict.status, 400);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("a model's own chat template renders messages, tools, and special tokens", () => {
  const chatml =
    "{% for message in messages %}<|im_start|>{{ message['role'] }}\n{{ message['content'] }}<|im_end|>\n" +
    "{% if message['tool_calls'] %}<|calls|>{{ message['tool_calls'] | tojson }}<|end|>\n{% endif %}{% endfor %}" +
    "{% if tools %}<|tools|>{{ tools | tojson }}<|end|>\n{% endif %}" +
    "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}";
  const info = { template: chatml, bos: "<s>", eos: "</s>", addBos: true };

  const rendered = chatPromptFromTemplate(
    info,
    [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "42", tool_call_id: "call_1" },
    ],
    [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
  );
  assert.equal(
    rendered,
    "<|im_start|>system\nbe brief<|im_end|>\n" +
      "<|im_start|>user\nhi<|im_end|>\n" +
      "<|im_start|>assistant\n<|im_end|>\n" +
      "<|calls|>[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"f\",\"arguments\":\"{}\"}}]<|end|>\n" +
      "<|im_start|>tool\n42<|im_end|>\n" +
      "<|tools|>[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"parameters\":{\"type\":\"object\"}}}]<|end|>\n" +
      "<|im_start|>assistant\n",
  );

  // Whitespace control, filters, loop metadata, `is defined`, and `else`.
  const complex =
    "{%- for m in messages -%}{{ m.content | trim | upper }}{% if not loop.last %},{% endif %}{% else %}none{% endfor -%}" +
    "{%- if missing is not defined -%}|?{%- endif -%}{%- set x = 2 * 3 -%}{{ x }}";
  assert.equal(renderChatTemplate(complex, { messages: [] }), "none|?6");
  assert.equal(renderChatTemplate(complex, { messages: [{ content: " a " }, { content: "b" }] }), "A,B|?6");

  // A template the interpreter cannot handle throws, so the caller can fall back
  // rather than execute something arbitrary.
  assert.throws(() => renderChatTemplate("{% import \"x\" as y %}", {}));
  assert.throws(() => renderChatTemplate("{{ ", {}));
  assert.throws(() => renderChatTemplate("{% for m in %}", {}));
});

test("the engine exposes a container's chat template, and null when absent", () => {
  const engine = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const template = "{% for m in messages %}{{ m.role }}:{{ m.content }};{% endfor %}{% if add_generation_prompt %}>{% endif %}";
  const withTemplate = loadEngine(readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url)));
  const modelWith = { kind: "gguf" as const, bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama", chatTemplate: template })) };
  const info = withTemplate.chatTemplate!(modelWith);
  assert.ok(info !== null);
  assert.equal(info!.template, template);
  assert.equal(typeof info!.bos, "string");
  assert.equal(typeof info!.eos, "string");

  const without = { kind: "gguf" as const, bytes: new Uint8Array(tinyGgufModel({ tokenizer: "llama" })) };
  assert.equal(engine.chatTemplate!(without), null, "a container without a template says so");
});

test("a chat request renders through the container's own template, and the decode follows it", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const template =
      "{% for m in messages %}<|{{ m.role }}|>{{ m.content }}<|end|>{% endfor %}" +
      "{% if tools %}<|tools|>{{ tools | tojson }}<|end|>{% endif %}" +
      "{% if add_generation_prompt %}<|assistant|>{% endif %}";
    const bytes = tinyGgufModel({
      tokenizer: "llama",
      byteTokens: true,
      contextLength: 512,
      chatTemplate: template,
    });
    const model: ModelRef = {
      id: "tiny-templated",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 512,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });

    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });

    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "template"),
      port: 0,
      engineBundle,
    });

    const engine = loadEngine(source);
    const engineModel = { kind: "gguf" as const, bytes: new Uint8Array(bytes) };
    const info = engine.chatTemplate!(engineModel)!;
    assert.ok(info !== null, "the fixture declares a template");

    const messages = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ];
    const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }];
    const expectedPrompt = chatPromptFromTemplate(info, messages, tools, { addGenerationPrompt: true });
    assert.ok(expectedPrompt.includes("<|assistant|>"), "the template's generation prompt is present");
    assert.ok(expectedPrompt.includes("<|tools|>"), "the template sees the declared tools");

    // The engine run on that exact prompt is what the provider must produce.
    const manual = engine.run(engineModel, { prompt: expectedPrompt, steps: 6, temperature: 0, seed: 0 });
    const fallbackPrompt = engine.run(engineModel, { prompt: "hi", steps: 6, temperature: 0, seed: 0 });
    assert.notDeepEqual(
      Array.from(manual.tokens),
      Array.from(fallbackPrompt.tokens),
      "the templated prompt changes the decode versus the bare user turn",
    );

    const ask = async () => {
      const response = await fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: bundle.model.id,
          messages,
          tools,
          max_completion_tokens: 6,
          seed: 0,
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { rarext_trace?: { tokens?: number[] }; choices: Array<{ message: { content: string | null } }> };
    };

    const templated = await ask();
    assert.deepEqual(
      templated.rarext_trace?.tokens,
      Array.from(manual.tokens),
      "the provider prompted with the container's own template",
    );
    assert.notDeepEqual(
      templated.rarext_trace?.tokens,
      Array.from(fallbackPrompt.tokens),
      "and not with the bare user turn",
    );
    const again = await ask();
    assert.deepEqual(again.rarext_trace?.tokens, templated.rarext_trace?.tokens, "templating is deterministic");
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("the template interpreter handles macros, namespace, and the common filters", () => {
  // A macro with a default argument, called with and without it.
  const macro =
    "{% macro line(t, sep=\";\") %}{{ t.function.name }}{{ sep }}{% endmacro %}" +
    "{% for x in tools %}{{ line(x) }}{% endfor %}|{{ line(tools[0], \"!\") }}";
  assert.equal(
    renderChatTemplate(macro, { tools: [{ function: { name: "a" } }, { function: { name: "b" } }] }),
    "a;b;|a!",
  );

  // namespace() accumulates across loop iterations, the pattern real templates
  // use to collect tool names or flags.
  const namespace =
    "{% set ns = namespace(users=0, names=[]) %}" +
    "{% for m in messages %}{% if m.role == \"user\" %}" +
    "{% set ns.users = ns.users + 1 %}{% set ns.names = ns.names + [m.name] %}{% endif %}{% endfor %}" +
    "{{ ns.users }}:{{ ns.names | join(\",\") }}";
  assert.equal(
    renderChatTemplate(namespace, {
      messages: [{ role: "user", name: "a" }, { role: "assistant" }, { role: "user", name: "b" }],
    }),
    "2:a,b",
  );

  const scope = {
    tools: [{ function: { name: "get_weather" } }, { function: { name: "get_time" } }],
    d: { b: 2, a: 1 },
    v: 0,
  };
  assert.equal(
    renderChatTemplate("{{ tools | map(attribute=\"function.name\") | join(\"+\") }}", scope),
    "get_weather+get_time",
  );
  assert.equal(
    renderChatTemplate("{{ tools | selectattr(\"function.name\",\"equalto\",\"get_time\") | map(attribute=\"function.name\") | join(\",\") }}", scope),
    "get_time",
  );
  assert.equal(
    renderChatTemplate("{{ tools | rejectattr(\"function.name\",\"equalto\",\"get_time\") | length }}", scope),
    "1",
  );
  assert.equal(renderChatTemplate("{{ d | items | first | tojson }}", scope), '["b",2]');
  assert.equal(renderChatTemplate("{{ d | keys | sort | join(\",\") }}", scope), "a,b");
  assert.equal(renderChatTemplate("{{ 'a-b-c' | replace('-', '_') }}", scope), "a_b_c");
  assert.equal(renderChatTemplate("{{ [3,1,2] | sort | join('') }}|{{ [3,1,2] | sort(reverse=true) | join('') }}", scope), "123|321");
  assert.equal(renderChatTemplate("{{ v | default('fallback', boolean=true) }}", scope), "fallback");
  assert.equal(renderChatTemplate("{{ [1,1,2] | unique | length }}|{{ 'x' ~ '!' }}", scope), "2|x!");
  assert.equal(renderChatTemplate("{{ tools | list | count }}|{{ (tools | last).function.name }}", scope), "2|get_time");

  // Still no arbitrary execution: unknown statements and filters are refused.
  assert.throws(() => renderChatTemplate("{% include \"x\" %}", {}));
  assert.throws(() => renderChatTemplate("{{ 1 | frobnicate }}", {}));
  assert.throws(() => renderChatTemplate("{{ [1] | select('nosuchtest', 1) | join(',') }}", {}));
});

test("a macro-and-namespace chat template drives the decode end to end", async () => {
  const reg = await registry();
  let provider: Awaited<ReturnType<typeof startProvider>> | null = null;
  try {
    const template =
      "{% macro tool_line(t) %}{{ t.function.name }}{% endmacro %}" +
      "{% set ns = namespace(names=[]) %}" +
      "{% for t in tools %}{% set ns.names = ns.names + [tool_line(t)] %}{% endfor %}" +
      "{% if ns.names | length > 0 %}<|tools|>{{ ns.names | join(',') }}<|end|>{% endif %}" +
      "{% for m in messages %}<|{{ m.role }}|>{{ m.content }}<|end|>{% endfor %}" +
      "{% if add_generation_prompt %}<|assistant|>{% endif %}";
    const bytes = tinyGgufModel({
      tokenizer: "llama",
      byteTokens: true,
      contextLength: 512,
      chatTemplate: template,
    });
    const model: ModelRef = {
      id: "tiny-macro-template",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 512,
    };
    const execution: ExecutionRef = { kind: "engine", engine: "rarext", engineModel: null };
    const { bundle, chunks } = buildModelBundle({ bytes, model, execution, chunkBytes: 1024 });
    await uploadBundle({ registry: reg.base, bundle, chunks });
    const source = readFileSync(new URL("../engines/rarext-gguf-engine.js", import.meta.url));
    const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
      source,
      name: "rarext-gguf-engine",
      engineVersion: "1",
      runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
      chunkBytes: 4096,
    });
    await uploadEngineBundle({ registry: reg.base, bundle: engineBundle, chunks: engineChunks });
    provider = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "macro-template"),
      port: 0,
      engineBundle,
    });

    const engine = loadEngine(source);
    const engineModel = { kind: "gguf" as const, bytes: new Uint8Array(bytes) };
    const info = engine.chatTemplate!(engineModel)!;
    const messages = [{ role: "user", content: "hi" }];
    const tools = [
      { type: "function", function: { name: "get_weather" } },
      { type: "function", function: { name: "get_time" } },
    ];
    const expectedPrompt = chatPromptFromTemplate(info, messages, tools, { addGenerationPrompt: true });
    // The macro and the namespace both contributed.
    assert.ok(expectedPrompt.includes("<|tools|>get_weather,get_time<|end|>"), expectedPrompt);
    assert.ok(expectedPrompt.endsWith("<|assistant|>"), expectedPrompt);

    const manual = engine.run(engineModel, { prompt: expectedPrompt, steps: 6, temperature: 0, seed: 0 });
    const fallback = engine.run(engineModel, { prompt: "hi", steps: 6, temperature: 0, seed: 0 });
    assert.notDeepEqual(Array.from(manual.tokens), Array.from(fallback.tokens));

    const ask = async () => {
      const response = await fetch(`${provider!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: bundle.model.id, messages, tools, max_completion_tokens: 6, seed: 0 }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { rarext_trace?: { tokens?: number[] } };
    };
    const first = await ask();
    assert.deepEqual(first.rarext_trace?.tokens, Array.from(manual.tokens));
    assert.deepEqual((await ask()).rarext_trace?.tokens, first.rarext_trace?.tokens);
  } finally {
    if (provider !== null) await provider.close();
    await reg.close();
  }
});

test("the provider refuses a model the host cannot hold, unless overridden", async () => {
  const reg = await registry();
  const GIB = 1024 ** 3;
  try {
    const bytes = tinyGgufModel();
    const model: ModelRef = {
      id: "tiny-oversize",
      family: "llama",
      parameters: "tiny",
      quantization: "F32",
      format: "gguf",
      sizeBytes: null,
      weightsDigest: null,
      contextLength: 64,
    };
    const { bundle: real, chunks } = buildModelBundle({
      bytes,
      model,
      execution: NATIVE_EXECUTION,
      chunkBytes: 1024,
    });
    await uploadBundle({ registry: reg.base, bundle: real, chunks });
    // The committed size this deployment declares is the 6/7/8 GB class it
    // names; the container bytes here are small so the test stays fast.
    const bundle = { ...real, model: { ...real.model, sizeBytes: 9 * GIB } };

    // The host-capability commitment: refused before the container is read.
    await assert.rejects(
      () =>
        startProvider({
          bundle,
          registry: reg.base,
          stateDir: join(reg.root, "oversize"),
          port: 0,
          hostMemoryBytes: 8 * GIB,
        }),
      /exceed this host's memory/,
    );

    // The explicit override (what a streaming engine would set) starts.
    const overridden = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "oversize-ok"),
      port: 0,
      hostMemoryBytes: 8 * GIB,
      allowOversizeModel: true,
    });
    await overridden.close();

    // A host that can hold it needs no override.
    const large = await startProvider({
      bundle,
      registry: reg.base,
      stateDir: join(reg.root, "large-host"),
      port: 0,
      hostMemoryBytes: 64 * GIB,
    });
    await large.close();
  } finally {
    await reg.close();
  }
});
