/**
 * An independent forward pass, written separately from the engine.
 *
 * The benchmark needs a yardstick that is not the engine grading itself. This
 * module re-implements the transformer in the open — embedding lookup, RMSNorm,
 * RoPE, causal attention with a KV cache, a SwiGLU/GeGLU gated FFN, and the
 * output projection — in plain TypeScript, reading the SAME committed weights
 * through the engine's own `dequantRows` (so no third-party code touches the
 * bytes, and no weight is re-derived by a second implementation).
 *
 * The point is agreement first, speed second: if its argmax for the last prompt
 * position is not the engine's first generated token, the benchmark says so
 * rather than reporting a ratio.
 */

import type { NativeEngine } from "./engine-bundle.ts";

interface Tensor {
  values: Float32Array;
  rows: number;
  cols: number;
}

export interface ReferencePassResult {
  /** The reference's argmax over the vocabulary at the last prompt position. */
  argmax: number;
  /** The two highest logits, so a near-tie is visible rather than hidden. */
  top: Array<{ token: number; logit: number }>;
  promptTokens: number;
  positions: number;
  layers: number;
  nEmbd: number;
  vocab: number;
  /** Wall time of the whole reference pass, milliseconds. */
  ms: number;
}

function rmsNorm(out: Float32Array, x: Float32Array, weight: Float32Array, eps: number): void {
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += x[i]! * x[i]!;
  const scale = 1 / Math.sqrt(sum / x.length + eps);
  for (let i = 0; i < x.length; i += 1) out[i] = x[i]! * scale * weight[i]!;
}

/** RoPE, with the adjacent-pair (llama/mistral) and half-split (NeoX) layouts. */
function rope(vector: Float32Array, heads: number, headDim: number, position: number, base: number, neox: boolean): void {
  const half = headDim / 2;
  for (let head = 0; head < heads; head += 1) {
    const off = head * headDim;
    for (let i = 0; i < half; i += 1) {
      const theta = position * Math.pow(base, (-2 * i) / headDim);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const a = neox ? off + i : off + 2 * i;
      const b = neox ? off + i + half : off + 2 * i + 1;
      const x0 = vector[a]!;
      const x1 = vector[b]!;
      vector[a] = x0 * cos - x1 * sin;
      vector[b] = x0 * sin + x1 * cos;
    }
  }
}

function matVec(weight: Tensor, x: Float32Array, out: Float32Array): void {
  for (let row = 0; row < weight.rows; row += 1) {
    let total = 0;
    const at = row * weight.cols;
    for (let col = 0; col < weight.cols; col += 1) total += weight.values[at + col]! * x[col]!;
    out[row] = total;
  }
}

const silu = (x: number): number => x / (1 + Math.exp(-x));
const geluTanh = (x: number): number =>
  0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x * x * x)));

/**
 * Run the reference pass over `prompt`. Only the architectures the engine
 * supports are claimed; anything else throws rather than guessing.
 */
export function referenceForward(
  engine: NativeEngine,
  model: { kind: "gguf" | "hf"; bytes: Uint8Array },
  options: { prompt: string },
): ReferencePassResult {
  const started = performance.now();
  const parsed = (model.kind === "hf" ? engine.parseContainer!(model.bytes) : engine.parseGguf!(model.bytes)) as unknown as {
    kv: Record<string, unknown>;
    tensors: Record<string, { name: string; rows: number; cols: number }>;
  };
  const kv = parsed.kv;
  const arch = String(kv["general.architecture"] ?? "");
  const supported = new Set(["llama", "mistral", "qwen2", "gemma", "phi2", "phi3", "mixtral"]);
  if (!supported.has(arch)) throw new Error(`the reference pass does not implement ${arch}`);
  if (arch === "mixtral") throw new Error("the reference pass does not implement mixtral's MoE FFN");
  const neox = arch === "qwen2" || arch === "gemma" || arch === "phi3" || arch === "phi2";
  const gemma = arch === "gemma";
  const phi2 = arch === "phi2";

  const nEmbd = Number(kv[`${arch}.embedding_length`]);
  const nHead = Number(kv[`${arch}.attention.head_count`]);
  const nHeadKv = Number(kv[`${arch}.attention.head_count_kv`] ?? nHead);
  const nFfn = Number(kv[`${arch}.feed_forward_length`]);
  const nLayer = Number(kv[`${arch}.block_count`]);
  const eps = Number(kv[`${arch}.attention.layer_norm_rms_epsilon`] ?? kv[`${arch}.attention.layer_norm_epsilon`] ?? 1e-5);
  const base = Number(kv[`${arch}.rope.freq_base`] ?? 10000);
  if (![nEmbd, nHead, nFfn, nLayer].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("the reference pass needs embedding_length, attention.head_count, feed_forward_length and block_count");
  }
  const headDim = nEmbd / nHead;
  const kvDim = nHeadKv * headDim;
  const group = nHead / nHeadKv;
  const tensor = (name: string): Tensor => {
    if (parsed.tensors[name] === undefined) throw new Error(`the reference pass needs ${name}`);
    return engine.dequantRows!(model, name) as unknown as Tensor;
  };

  const embed = tensor("token_embd.weight");
  const output = parsed.tensors["output.weight"] === undefined ? embed : tensor("output.weight");
  const outputNorm = tensor("output_norm.weight");
  const layers = Array.from({ length: nLayer }, (_, index) => {
    const prefix = `blk.${index}.`;
    return {
      attnNorm: tensor(`${prefix}attn_norm.weight`),
      attnQ: tensor(`${prefix}attn_q.weight`),
      attnK: tensor(`${prefix}attn_k.weight`),
      attnV: tensor(`${prefix}attn_v.weight`),
      attnOutput: tensor(`${prefix}attn_output.weight`),
      ffnNorm: phi2 ? null : tensor(`${prefix}ffn_norm.weight`),
      ffnGate: phi2 ? null : tensor(`${prefix}ffn_gate.weight`),
      ffnUp: tensor(`${prefix}ffn_up.weight`),
      ffnDown: tensor(`${prefix}ffn_down.weight`),
    };
  });

  const ids = engine.encode!(model, options.prompt);
  if (ids.length === 0) {
    const bos = Number(kv["tokenizer.ggml.bos_token_id"] ?? 0);
    ids.push(bos);
  }

  const x = new Float32Array(nEmbd);
  const norm = new Float32Array(nEmbd);
  const q = new Float32Array(nEmbd);
  const k = new Float32Array(kvDim);
  const v = new Float32Array(kvDim);
  const attn = new Float32Array(nEmbd);
  const hidden = new Float32Array(nEmbd);
  const gate = new Float32Array(nFfn);
  const up = new Float32Array(nFfn);
  const cacheK: Float32Array[][] = layers.map(() => []);
  const cacheV: Float32Array[][] = layers.map(() => []);
  const scores = new Float32Array(ids.length);

  let logits = new Float32Array(output.rows);
  for (let position = 0; position < ids.length; position += 1) {
    const token = ids[position]!;
    for (let i = 0; i < nEmbd; i += 1) x[i] = embed.values[token * embed.cols + i]!;
    if (gemma) {
      const scale = Math.sqrt(nEmbd);
      for (let i = 0; i < nEmbd; i += 1) x[i] = x[i]! * scale;
    }

    for (let layer = 0; layer < layers.length; layer += 1) {
      const weights = layers[layer]!;
      const attnNorm = weights.attnNorm.values;
      if (phi2) {
        // Phi-2 uses LayerNorm (mean-subtracted) and a parallel residual.
        let mean = 0;
        for (let i = 0; i < nEmbd; i += 1) mean += x[i]!;
        mean /= nEmbd;
        let variance = 0;
        for (let i = 0; i < nEmbd; i += 1) variance += (x[i]! - mean) ** 2;
        variance /= nEmbd;
        for (let i = 0; i < nEmbd; i += 1) norm[i] = ((x[i]! - mean) / Math.sqrt(variance + eps)) * attnNorm[i]!;
      } else {
        rmsNorm(norm, x, attnNorm, eps);
      }
      matVec(weights.attnQ, norm, q);
      matVec(weights.attnK, norm, k);
      matVec(weights.attnV, norm, v);
      rope(q, nHead, headDim, position, base, neox);
      rope(k, nHeadKv, headDim, position, base, neox);
      cacheK[layer]!.push(q.constructor === Float32Array ? k.slice() : k.slice());
      cacheV[layer]!.push(v.slice());

      const scale = 1 / Math.sqrt(headDim);
      for (let head = 0; head < nHead; head += 1) {
        const kvHead = Math.floor(head / group);
        const qBase = head * headDim;
        const count = cacheK[layer]!.length;
        let maxScore = -Infinity;
        for (let p = 0; p < count; p += 1) {
          const keys = cacheK[layer]![p]!;
          let score = 0;
          for (let d = 0; d < headDim; d += 1) score += q[qBase + d]! * keys[kvHead * headDim + d]!;
          score *= scale;
          scores[p] = score;
          if (score > maxScore) maxScore = score;
        }
        let denom = 0;
        for (let p = 0; p < count; p += 1) {
          const e = Math.exp(scores[p]! - maxScore);
          scores[p] = e;
          denom += e;
        }
        for (let d = 0; d < headDim; d += 1) {
          let weighted = 0;
          for (let p = 0; p < count; p += 1) {
            weighted += (scores[p]! / denom) * cacheV[layer]![p]![kvHead * headDim + d]!;
          }
          attn[qBase + d] = weighted;
        }
      }
      matVec(weights.attnOutput, attn, hidden);
      for (let i = 0; i < nEmbd; i += 1) x[i] = x[i]! + hidden[i]!;

      if (phi2) {
        // Sequential GELU up/down on the same normalized attention input.
        matVec(weights.ffnUp, norm, up);
        for (let i = 0; i < nFfn; i += 1) up[i] = geluTanh(up[i]!);
        matVec(weights.ffnDown, up, hidden);
        for (let i = 0; i < nEmbd; i += 1) x[i] = x[i]! + hidden[i]!;
      } else {
        rmsNorm(norm, x, weights.ffnNorm!.values, eps);
        matVec(weights.ffnGate!, norm, gate);
        matVec(weights.ffnUp, norm, up);
        for (let i = 0; i < nFfn; i += 1) gate[i] = (gemma ? geluTanh(gate[i]!) : silu(gate[i]!)) * up[i]!;
        matVec(weights.ffnDown, gate, hidden);
        for (let i = 0; i < nEmbd; i += 1) x[i] = x[i]! + hidden[i]!;
      }
    }

    if (position === ids.length - 1) {
      rmsNorm(norm, x, outputNorm.values, eps);
      const next = new Float32Array(output.rows);
      matVec(output, norm, next);
      logits = next;
    }
  }

  let argmax = 0;
  for (let i = 1; i < logits.length; i += 1) if (logits[i]! > logits[argmax]!) argmax = i;
  const top = [
    { token: argmax, logit: logits[argmax]! },
    ...(() => {
      let second = -1;
      for (let i = 0; i < logits.length; i += 1) if (i !== argmax && (second < 0 || logits[i]! > logits[second]!)) second = i;
      return second < 0 ? [] : [{ token: second, logit: logits[second]! }];
    })(),
  ];
  return {
    argmax,
    top,
    promptTokens: ids.length,
    positions: ids.length,
    layers: nLayer,
    nEmbd,
    vocab: output.rows,
    ms: performance.now() - started,
  };
}
