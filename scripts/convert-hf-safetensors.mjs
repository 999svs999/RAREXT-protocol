#!/usr/bin/env node
/**
 * Convert a Hugging Face checkpoint (config.json + tokenizer.json + *.safetensors)
 * into a RAREXT-native container ("RXHF") that RAREXT's own engine serves
 * directly. No llama.cpp, no gguf-py, no third-party converter.
 *
 *   node --experimental-strip-types scripts/convert-hf-safetensors.mjs <hf-dir> <out.rarext> [F32|Q4_0|Q8_0|IQ4_NL|Q4_K]
 *
 * Supported: qwen2 and llama architectures, with a byte-level BPE tokenizer
 * (tokenizer.json), a Unigram/SentencePiece tokenizer (either tokenizer.model,
 * parsed straight from the protobuf, or a Unigram vocab inside tokenizer.json).
 * Weights can be quantized to Q4_0/Q8_0/IQ4_NL/Q4_K with RAREXT's own encoders.
 * Other layouts are refused, not guessed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DTYPE = { F32: 0, F16: 1, Q4_0: 2, Q8_0: 8, Q4_K: 12, IQ4_NL: 20, BF16: 30 };
const GGML_TYPE_NAME = { 0: "F32", 1: "F16", 2: "Q4_0", 8: "Q8_0", 12: "Q4_K", 20: "IQ4_NL", 30: "BF16" };

// ── float <-> half ───────────────────────────────────────────────────────────
function f16ToF32(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** Round a float to its half-precision bit pattern (round to nearest). */
function f32ToF16(value) {
  const scratch = new Float32Array(1);
  const view = new Uint32Array(scratch.buffer);
  scratch[0] = value;
  const bits = view[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  const mant = bits & 0x7fffff;
  if (exp === 255) return (sign | 0x7c00 | (mant ? 0x200 : 0)) & 0xffff;
  let half = exp - 127 + 15;
  if (half >= 31) return (sign | 0x7c00) & 0xffff;
  if (half <= 0) {
    if (half < -10) return sign & 0xffff;
    const m = mant | 0x800000;
    const shift = 14 - half;
    let rounded = m >>> shift;
    if ((m >>> (shift - 1)) & 1) rounded += 1;
    return (sign | rounded) & 0xffff;
  }
  let rounded = sign | (half << 10) | (mant >>> 13);
  const remainder = mant & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && ((mant >>> 13) & 1) === 1)) rounded += 1;
  return rounded & 0xffff;
}

/** Decode a safetensors tensor to Float32 for (re-)quantization. */
function toFloat32(dtype, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dtype === "F32") {
    const out = new Float32Array(bytes.byteLength / 4);
    for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  if (dtype === "F16") {
    const out = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = f16ToF32(view.getUint16(i * 2, true));
    return out;
  }
  if (dtype === "BF16") {
    const out = new Float32Array(bytes.byteLength / 2);
    const scratch = new Float32Array(1);
    const u32 = new Uint32Array(scratch.buffer);
    for (let i = 0; i < out.length; i += 1) {
      u32[0] = view.getUint16(i * 2, true) << 16;
      out[i] = scratch[0];
    }
    return out;
  }
  throw new Error(`cannot read dtype ${dtype}; only F32/F16/BF16`);
}

/** Nearest index into ggml's kvalues_iq4nl, by midpoint. */
const IQ4NL = [-127, -104, -83, -65, -49, -35, -22, -10, 1, 13, 25, 38, 53, 69, 89, 113];
function nearestIq4(value) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < 16; i += 1) {
    const distance = Math.abs(IQ4NL[i] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Quantize a [cols, rows] float matrix into the engine's block layout. Matches
 * the block formats the engine decodes (Q4_0/Q8_0/IQ4_NL, 32 weights per block).
 */
export function quantizeTensor(type, values, cols, rows) {
  if (cols % 32 !== 0) throw new Error(`cannot quantize ${cols} columns; not a multiple of 32`);
  const blocks = rows * (cols / 32);
  if (type === "Q8_0") {
    const out = Buffer.alloc(blocks * 34);
    let w = 0;
    for (let b = 0; b < blocks; b += 1) {
      const base = b * 32;
      let amax = 0;
      for (let i = 0; i < 32; i += 1) amax = Math.max(amax, Math.abs(values[base + i]));
      const d = amax / 127;
      const id = d === 0 ? 0 : 1 / d;
      out.writeUInt16LE(f32ToF16(d), w);
      for (let i = 0; i < 32; i += 1) {
        let q = Math.round(values[base + i] * id);
        if (q > 127) q = 127;
        if (q < -127) q = -127;
        out.writeInt8(q, w + 2 + i);
      }
      w += 34;
    }
    return { type: 8, bytes: out };
  }
  if (type === "Q4_0") {
    const out = Buffer.alloc(blocks * 18);
    let w = 0;
    for (let b = 0; b < blocks; b += 1) {
      const base = b * 32;
      let amax = 0;
      for (let i = 0; i < 32; i += 1) amax = Math.max(amax, Math.abs(values[base + i]));
      const d = -amax / 8;
      const id = d === 0 ? 0 : 1 / d;
      out.writeUInt16LE(f32ToF16(d), w);
      for (let i = 0; i < 16; i += 1) {
        let low = Math.round(values[base + i] * id) + 8;
        let high = Math.round(values[base + i + 16] * id) + 8;
        if (low < 0) low = 0;
        if (low > 15) low = 15;
        if (high < 0) high = 0;
        if (high > 15) high = 15;
        out.writeUInt8((high << 4) | low, w + 2 + i);
      }
      w += 18;
    }
    return { type: 2, bytes: out };
  }
  if (type === "IQ4_NL") {
    const out = Buffer.alloc(blocks * 18);
    let w = 0;
    for (let b = 0; b < blocks; b += 1) {
      const base = b * 32;
      let amax = 0;
      for (let i = 0; i < 32; i += 1) amax = Math.max(amax, Math.abs(values[base + i]));
      const d = amax / 127;
      const id = d === 0 ? 0 : 1 / d;
      out.writeUInt16LE(f32ToF16(d), w);
      for (let i = 0; i < 16; i += 1) {
        const low = nearestIq4(values[base + i] * id);
        const high = nearestIq4(values[base + i + 16] * id);
        out.writeUInt8((high << 4) | low, w + 2 + i);
      }
      w += 18;
    }
    return { type: 20, bytes: out };
  }
  if (type === "Q4_K") {
    if (cols % 256 !== 0) throw new Error(`cannot Q4_K quantize ${cols} columns; not a multiple of 256`);
    const superBlocks = (rows * cols) / 256;
    const out = Buffer.alloc(superBlocks * 144);
    let w = 0;
    for (let sb = 0; sb < superBlocks; sb += 1) {
      const base = sb * 256;
      const scales = new Array(8);
      const mins = new Array(8);
      let maxScale = 0;
      let maxMin = 0;
      for (let j = 0; j < 8; j += 1) {
        let minx = Infinity;
        let maxx = -Infinity;
        for (let l = 0; l < 32; l += 1) {
          const v = values[base + j * 32 + l];
          if (v < minx) minx = v;
          if (v > maxx) maxx = v;
        }
        const scale = (maxx - minx) / 15;
        const min = Math.max(0, -minx);
        scales[j] = scale;
        mins[j] = min;
        if (scale > maxScale) maxScale = scale;
        if (min > maxMin) maxMin = min;
      }
      const d = maxScale / 63;
      const dmin = maxMin / 63;
      const invScale = maxScale > 0 ? 63 / maxScale : 0;
      const invMin = maxMin > 0 ? 63 / maxMin : 0;
      const packed = new Uint8Array(12);
      const ls6 = new Array(8);
      const lm6 = new Array(8);
      for (let j = 0; j < 8; j += 1) {
        const ls = Math.min(63, Math.round(invScale * scales[j]));
        const lm = Math.min(63, Math.round(invMin * mins[j]));
        ls6[j] = ls;
        lm6[j] = lm;
        if (j < 4) {
          packed[j] = ls;
          packed[j + 4] = lm;
        } else {
          // 6-bit scales/mins packed the way ggml's get_scale_min_k4 reads them.
          packed[j + 4] = (ls & 0xf) | ((lm & 0xf) << 4);
          packed[j - 4] |= (ls >> 4) << 6;
          packed[j] |= (lm >> 4) << 6;
        }
      }
      const dBits = f32ToF16(d);
      const dminBits = f32ToF16(dmin);
      out.writeUInt16LE(dBits, w);
      out.writeUInt16LE(dminBits, w + 2);
      Buffer.from(packed).copy(out, w + 4);
      const qsOff = w + 16;
      const dEff = f16ToF32(dBits);
      const dminEff = f16ToF32(dminBits);
      for (let g = 0; g < 4; g += 1) {
        const lowScale = dEff * ls6[2 * g];
        const lowMin = dminEff * lm6[2 * g];
        const highScale = dEff * ls6[2 * g + 1];
        const highMin = dminEff * lm6[2 * g + 1];
        for (let i = 0; i < 32; i += 1) {
          let low = lowScale ? Math.round((values[base + g * 64 + i] + lowMin) / lowScale) : 0;
          let high = highScale ? Math.round((values[base + g * 64 + 32 + i] + highMin) / highScale) : 0;
          low = Math.max(0, Math.min(15, low));
          high = Math.max(0, Math.min(15, high));
          out.writeUInt8((high << 4) | low, qsOff + g * 32 + i);
        }
      }
      w += 144;
    }
    return { type: 12, bytes: out };
  }
  throw new Error(`unknown quantization ${type}; only Q4_0/Q8_0/IQ4_NL/Q4_K`);
}

/** Rank suffix per HF parameter name, for the GGUF-style naming the engine uses. */
const LAYER_TENSORS = {
  "self_attn.q_proj.weight": "attn_q.weight",
  "self_attn.k_proj.weight": "attn_k.weight",
  "self_attn.v_proj.weight": "attn_v.weight",
  "self_attn.o_proj.weight": "attn_output.weight",
  "self_attn.q_proj.bias": "attn_q.bias",
  "self_attn.k_proj.bias": "attn_k.bias",
  "self_attn.v_proj.bias": "attn_v.bias",
  "input_layernorm.weight": "attn_norm.weight",
  "post_attention_layernorm.weight": "ffn_norm.weight",
  "mlp.gate_proj.weight": "ffn_gate.weight",
  "mlp.up_proj.weight": "ffn_up.weight",
  "mlp.down_proj.weight": "ffn_down.weight",
};
const TOP_TENSORS = {
  "model.embed_tokens.weight": "token_embd.weight",
  "model.norm.weight": "output_norm.weight",
  "lm_head.weight": "output.weight",
};

/** Map one HF tensor name to the engine's name, or null to skip it. */
export function mapTensorName(name) {
  if (TOP_TENSORS[name] !== undefined) return TOP_TENSORS[name];
  const match = name.match(/^model\.layers\.(\d+)\.(.+)$/);
  if (match !== null && LAYER_TENSORS[match[2]] !== undefined) {
    return `blk.${match[1]}.${LAYER_TENSORS[match[2]]}`;
  }
  if (name.endsWith("rotary_emb.inv_freq")) return null; // recomputed by the engine
  throw new Error(`unsupported tensor ${name}`);
}

/** Read every tensor out of a set of .safetensors files. */
export function readSafetensors(files) {
  const tensors = new Map();
  for (const file of files) {
    const buf = readFileSync(file);
    const headerLen = Number(buf.readBigUInt64LE(0));
    const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString("utf8"));
    const dataStart = 8 + headerLen;
    for (const [name, info] of Object.entries(header)) {
      if (name === "__metadata__") continue;
      const [begin, end] = info.data_offsets;
      tensors.set(name, {
        dtype: info.dtype,
        shape: info.shape,
        bytes: buf.subarray(dataStart + begin, dataStart + end),
      });
    }
  }
  return tensors;
}

function safetensorsFiles(dir) {
  const names = readdirSync(dir);
  const single = names.find((n) => n === "model.safetensors");
  if (single !== undefined) return [join(dir, single)];
  const shards = names.filter((n) => n.endsWith(".safetensors")).sort();
  if (shards.length === 0) throw new Error(`no .safetensors files in ${dir}`);
  return shards.map((n) => join(dir, n));
}

/** Read one protobuf varint; the wire format SentencePiece's tokenizer.model uses. */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let at = pos;
  for (;;) {
    const byte = buf[at++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, pos: at };
}

/**
 * Parse a SentencePiece ModelProto (tokenizer.model). Only the fields the engine
 * needs are read: each `SentencePiece`'s piece (1), score (2) and type (3). No
 * protobuf library, no sentencepiece dependency.
 */
export function parseSentencePieceModel(buffer) {
  const pieces = [];
  const scores = [];
  const types = [];
  let pos = 0;
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos);
    pos = tag.pos;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 2) {
      const len = readVarint(buffer, pos);
      pos = len.pos;
      const end = pos + len.value;
      if (field === 1) {
        let piece = "";
        let score = 0;
        let type = 1;
        let at = pos;
        while (at < end) {
          const sub = readVarint(buffer, at);
          at = sub.pos;
          const subField = sub.value >>> 3;
          const subWire = sub.value & 7;
          if (subWire === 2) {
            const l = readVarint(buffer, at);
            at = l.pos;
            if (subField === 1) piece = buffer.subarray(at, at + l.value).toString("utf8");
            at += l.value;
          } else if (subWire === 5) {
            if (subField === 2) score = buffer.readFloatLE(at);
            at += 4;
          } else if (subWire === 0) {
            const v = readVarint(buffer, at);
            at = v.pos;
            if (subField === 3) type = v.value;
          } else if (subWire === 1) {
            at += 8;
          } else {
            throw new Error(`unsupported SentencePiece wire type ${subWire}`);
          }
        }
        pieces.push(piece);
        scores.push(score);
        types.push(type);
      }
      pos = end;
    } else if (wire === 0) {
      pos = readVarint(buffer, pos).pos;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return { pieces, scores, types };
}

/** Build the tokenizer KV entries from a tokenizer.json (BPE) or tokenizer.model (SPM). */
export function tokenizeSection(dir, config) {
  const tokenizerConfigPath = join(dir, "tokenizer_config.json");
  const tokenizerConfig = existsSync(tokenizerConfigPath)
    ? JSON.parse(readFileSync(tokenizerConfigPath, "utf8"))
    : {};
  const spmPath = join(dir, "tokenizer.model");
  if (!existsSync(join(dir, "tokenizer.json")) && existsSync(spmPath)) {
    const { pieces, scores, types } = parseSentencePieceModel(readFileSync(spmPath));
    return {
      "tokenizer.ggml.model": "llama",
      "tokenizer.ggml.tokens": pieces,
      "tokenizer.ggml.scores": scores,
      "tokenizer.ggml.token_type": types,
      "tokenizer.ggml.add_bos_token":
        tokenizerConfig.add_bos_token === undefined ? true : tokenizerConfig.add_bos_token,
      ...(config.bos_token_id !== undefined ? { "tokenizer.ggml.bos_token_id": config.bos_token_id } : {}),
      ...(config.eos_token_id !== undefined ? { "tokenizer.ggml.eos_token_id": config.eos_token_id } : {}),
    };
  }
  const tokenizerPath = join(dir, "tokenizer.json");
  const tokenizer = JSON.parse(readFileSync(tokenizerPath, "utf8"));
  const model = tokenizer.model ?? {};
  if (model.type === "Unigram" || model.type === "SPM" || model.type === "SentencePiece") {
    // SentencePiece carried inside tokenizer.json: vocab is [piece, score] pairs.
    const tokens = [];
    const scores = [];
    for (const entry of model.vocab ?? []) {
      const [piece, score] = Array.isArray(entry) ? entry : [entry, 0];
      tokens.push(piece);
      scores.push(score);
    }
    let maxId = tokens.length - 1;
    for (const token of tokenizer.added_tokens ?? []) if (token.id > maxId) maxId = token.id;
    while (tokens.length <= maxId) {
      tokens.push("");
      scores.push(0);
    }
    for (const token of tokenizer.added_tokens ?? []) {
      tokens[token.id] = token.content;
      scores[token.id] = 0;
    }
    return {
      "tokenizer.ggml.model": "llama",
      "tokenizer.ggml.tokens": tokens,
      "tokenizer.ggml.scores": scores,
      "tokenizer.ggml.add_bos_token":
        tokenizerConfig.add_bos_token === undefined ? true : tokenizerConfig.add_bos_token,
      ...(config.bos_token_id !== undefined ? { "tokenizer.ggml.bos_token_id": config.bos_token_id } : {}),
      ...(config.eos_token_id !== undefined ? { "tokenizer.ggml.eos_token_id": config.eos_token_id } : {}),
    };
  }
  if (model.type !== "BPE") {
    throw new Error(`unsupported tokenizer.json model type ${model.type}; only BPE/Unigram`);
  }
  const vocab = model.vocab ?? {};
  let maxId = 0;
  for (const id of Object.values(vocab)) if (id > maxId) maxId = id;
  for (const token of tokenizer.added_tokens ?? []) if (token.id > maxId) maxId = token.id;
  const tokens = new Array(maxId + 1).fill("");
  for (const [text, id] of Object.entries(vocab)) tokens[id] = text;
  for (const token of tokenizer.added_tokens ?? []) tokens[token.id] = token.content;
  const merges = (model.merges ?? []).map((merge) =>
    Array.isArray(merge) ? merge.join(" ") : merge,
  );
  return {
    "tokenizer.ggml.model": "gpt2",
    "tokenizer.ggml.tokens": tokens,
    "tokenizer.ggml.merges": merges,
    ...(config.bos_token_id !== undefined ? { "tokenizer.ggml.bos_token_id": config.bos_token_id } : {}),
    ...(config.eos_token_id !== undefined ? { "tokenizer.ggml.eos_token_id": config.eos_token_id } : {}),
  };
}

/** Build the GGUF-style KV map from a Hugging Face config.json. */
export function hparamsSection(config) {
  const arch = config.model_type;
  if (arch !== "qwen2" && arch !== "llama") {
    throw new Error(`only qwen2/llama safetensors are supported; got ${arch}`);
  }
  const kv = { "general.architecture": arch, "general.file_type": 0 };
  kv[`${arch}.block_count`] = config.num_hidden_layers;
  kv[`${arch}.embedding_length`] = config.hidden_size;
  kv[`${arch}.feed_forward_length`] = config.intermediate_size;
  kv[`${arch}.attention.head_count`] = config.num_attention_heads;
  kv[`${arch}.attention.head_count_kv`] = config.num_key_value_heads ?? config.num_attention_heads;
  kv[`${arch}.attention.layer_norm_rms_epsilon`] = config.rms_norm_eps ?? 1e-6;
  kv[`${arch}.rope.freq_base`] = config.rope_theta ?? 10000;
  if (config.max_position_embeddings !== undefined) {
    kv[`${arch}.context_length`] = config.max_position_embeddings;
  }
  return kv;
}

/**
 * Serialize a container: "RXHF" + version + u64 header length + JSON header +
 * 32-byte-aligned raw tensor data. `dims` are in the engine's [cols, ...rows]
 * order (i.e. the reverse of the Hugging Face shape).
 */
export function buildContainer(kv, tensors) {
  const header = { format: "rarext.hf-container.v1", kv, tensors: [] };
  const chunks = [];
  let offset = 0;
  for (const tensor of tensors) {
    const aligned = Math.ceil(offset / 32) * 32;
    if (aligned > offset) chunks.push(Buffer.alloc(aligned - offset));
    offset = aligned;
    header.tensors.push({
      name: tensor.name,
      type: tensor.type,
      dims: tensor.dims,
      offset,
      length: tensor.bytes.length,
    });
    chunks.push(Buffer.from(tensor.bytes));
    offset += tensor.bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(16);
  prefix.write("RXHF", 0, "ascii");
  prefix.writeUInt32LE(1, 4);
  prefix.writeBigUInt64LE(BigInt(json.length), 8);
  const body = Buffer.concat([prefix, json]);
  const pad = (32 - (body.length % 32)) % 32;
  return Buffer.concat([body, Buffer.alloc(pad), ...chunks]);
}

/**
 * Convert a Hugging Face directory into container bytes. `options.quant` names a
 * weight quantization (F32/Q4_0/Q8_0/IQ4_NL); 2D weight matrices whose columns
 * are whole 32-value blocks are quantized, norms/biases and anything else stay
 * F32 so the engine can always decode the container.
 */
export function convertHfDirectory(dir, options = {}) {
  const quant = options.quant ?? "F32";
  if (quant !== "F32" && DTYPE[quant] === undefined) {
    throw new Error(`unknown quantization ${quant}; only F32/Q4_0/Q8_0/IQ4_NL/Q4_K`);
  }
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const kv = { ...hparamsSection(config), ...tokenizeSection(dir, config) };
  const raw = readSafetensors(safetensorsFiles(dir));
  const tensors = [];
  for (const [hfName, info] of raw) {
    const name = mapTensorName(hfName);
    if (name === null) continue;
    // Hugging Face shape is [rows, cols]; the engine wants [cols, rows].
    const dims = [info.shape[info.shape.length - 1], ...info.shape.slice(0, -1).reverse()];
    const cols = dims[0];
    const rows = dims.slice(1).reduce((total, dim) => total * dim, 1);
    const blockWeights = quant === "Q4_K" ? 256 : 32;
    const is2d = info.shape.length === 2;
    // Q4_K needs 256-wide super-blocks; a narrower weight row falls back to Q8_0
    // (32-wide) rather than staying in a slow 16-bit path, like a GGUF "K_M" mix.
    const chosenQuant =
      quant !== "F32" && is2d && cols % blockWeights === 0
        ? quant
        : quant === "Q4_K" && is2d && cols % 32 === 0
          ? "Q8_0"
          : null;
    if (chosenQuant !== null) {
      const result = quantizeTensor(chosenQuant, toFloat32(info.dtype, info.bytes), cols, rows);
      tensors.push({ name, type: result.type, dims, bytes: result.bytes });
    } else {
      // Keep the checkpoint's own float dtype rather than upcasting to F32.
      const type = DTYPE[info.dtype];
      if (type === undefined || (type !== 0 && type !== 1 && type !== 30)) {
        throw new Error(`unsupported dtype ${info.dtype} for ${hfName}`);
      }
      tensors.push({ name, type, dims, bytes: info.bytes });
    }
  }
  return {
    bytes: buildContainer(kv, tensors),
    tensorCount: tensors.length,
    ggmlTypes: [...new Set(tensors.map((t) => GGML_TYPE_NAME[t.type]))],
  };
}

const isCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isCli && process.argv.length >= 4) {
  const dir = process.argv[2];
  const out = process.argv[3];
  const quant = process.argv[4] ?? "F32";
  const result = convertHfDirectory(dir, { quant });
  writeFileSync(out, result.bytes);
  console.log(
    `wrote ${out}: ${result.tensorCount} tensors, ${quant} weights, types ${result.ggmlTypes.join(", ")}`,
  );
}
