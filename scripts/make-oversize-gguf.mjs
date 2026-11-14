#!/usr/bin/env node
/**
 * make-oversize-gguf.mjs — write a genuinely large GGUF container.
 *
 * The bytes are real: a valid `GGUF` header, a real KV block, a real tensor
 * table, and real tensor data, written in bounded chunks so the generator never
 * holds the container. The declared architecture is deliberately small and
 * fully specified (llama, 2 layers, embd 512) — the bulk lives in one extra
 * tensor, `blk.9.pad.weight`, which the declared layer count does not reference.
 *
 * That makes the file an honest test of the LOADER and PROVIDER at 6-7 GB
 * (verify-to-disk, bounded resident, streamed serve) without pretending that a
 * 6.5 GB *model* runs: those weights do not exist here, and this tool says so.
 *
 *   node scripts/make-oversize-gguf.mjs --out /tmp/oversize-6g.gguf --target-gib 6.5
 *   node scripts/make-oversize-gguf.mjs --out /tmp/oversize-control.gguf --pad false
 *
 * Exported as `writeOversizeGguf(path, options)` for the demo to reuse.
 */
import { closeSync, existsSync, fstatSync, openSync, writeSync } from "node:fs";

const GIB = 1024 ** 3;
const N_EMBD = 512;
const N_HEAD = 4;
const N_HEAD_KV = 1;
const N_FFN = 1024;
const N_LAYER = 2;
const VOCAB = 32;
const CTX = 256;
const KV_DIM = N_HEAD_KV * (N_EMBD / N_HEAD);

function tokens() {
  const list = ["\u2581", "a", "b", "c", "d", "e", "f", "g"];
  while (list.length < VOCAB) list.push(`<x${list.length}>`);
  return list;
}

const u32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
};
const u64 = (value) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value), 0);
  return out;
};
const f32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeFloatLE(value, 0);
  return out;
};
const str = (value) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
};
const kv = (key, type, value) => Buffer.concat([str(key), u32(type), value]);
const arr = (elementType, values) => Buffer.concat([u32(elementType), u64(values.length), ...values]);

/** The tensor table: the small declared model, plus an optional bulk tensor. */
function tensorSpecs(padRows) {
  const specs = [
    { name: "token_embd.weight", dims: [N_EMBD, VOCAB] },
    { name: "output_norm.weight", dims: [N_EMBD] },
  ];
  for (let layer = 0; layer < N_LAYER; layer += 1) {
    const p = `blk.${layer}.`;
    specs.push(
      { name: `${p}attn_norm.weight`, dims: [N_EMBD] },
      { name: `${p}attn_q.weight`, dims: [N_EMBD, N_EMBD] },
      { name: `${p}attn_k.weight`, dims: [N_EMBD, KV_DIM] },
      { name: `${p}attn_v.weight`, dims: [N_EMBD, KV_DIM] },
      { name: `${p}attn_output.weight`, dims: [N_EMBD, N_EMBD] },
      { name: `${p}ffn_norm.weight`, dims: [N_EMBD] },
      { name: `${p}ffn_gate.weight`, dims: [N_FFN, N_EMBD] },
      { name: `${p}ffn_up.weight`, dims: [N_FFN, N_EMBD] },
      { name: `${p}ffn_down.weight`, dims: [N_EMBD, N_FFN] },
    );
  }
  if (padRows > 0) specs.push({ name: "blk.9.pad.weight", dims: [N_EMBD, padRows] });
  return specs;
}

function headerFor(specs) {
  const list = tokens();
  const kvs = [
    kv("general.architecture", 8, str("llama")),
    kv("general.file_type", 4, u32(0)),
    kv("llama.block_count", 4, u32(N_LAYER)),
    kv("llama.context_length", 4, u32(CTX)),
    kv("llama.embedding_length", 4, u32(N_EMBD)),
    kv("llama.feed_forward_length", 4, u32(N_FFN)),
    kv("llama.attention.head_count", 4, u32(N_HEAD)),
    kv("llama.attention.head_count_kv", 4, u32(N_HEAD_KV)),
    kv("llama.attention.layer_norm_rms_epsilon", 6, f32(1e-6)),
    kv("llama.rope.freq_base", 6, f32(10000)),
    kv("tokenizer.ggml.model", 8, str("llama")),
    kv("tokenizer.ggml.pre", 8, str("default")),
    kv("tokenizer.ggml.tokens", 9, arr(8, list.map(str))),
    kv("tokenizer.ggml.token_type", 9, arr(5, list.map(() => u32(1)))),
    kv("tokenizer.ggml.merges", 9, arr(8, [])),
    kv("tokenizer.ggml.bos_token_id", 4, u32(0)),
    kv("tokenizer.ggml.eos_token_id", 4, u32(1)),
    kv("tokenizer.ggml.scores", 9, arr(6, list.map((_, index) => f32(index === 0 ? 0 : -index * 0.1)))),
    kv("tokenizer.ggml.add_bos_token", 7, Buffer.from([0])),
  ];

  // Lay the data out first (offsets are relative to the data section).
  let offset = 0;
  const infos = [];
  const layout = [];
  for (const spec of specs) {
    const cols = spec.dims[0];
    const rows = spec.dims.slice(1).reduce((total, value) => total * value, 1) || 1;
    const rowBytes = cols * 4; // F32 throughout
    const start = Math.ceil(offset / 32) * 32;
    layout.push({ name: spec.name, start, rows, cols, rowBytes });
    infos.push(
      Buffer.concat([
        str(spec.name),
        u32(spec.dims.length),
        ...spec.dims.map(u64),
        u32(0), // GGML_TYPE_F32
        u64(start),
      ]),
    );
    offset = start + rowBytes * rows;
  }

  const header = Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    u32(3),
    u64(specs.length),
    u64(kvs.length),
    ...kvs,
    ...infos,
  ]);
  const dataStart = Math.ceil(header.length / 32) * 32;
  return { header, dataStart, layout, dataBytes: offset };
}

/**
 * Write the container. `padRows` inflates it; the rest is a fixed small model,
 * so the same prompt decodes identically with and without the pad tensor.
 */
export function writeOversizeGguf(path, options = {}) {
  const targetBytes = options.targetBytes ?? 6.5 * GIB;
  const withPad = options.pad !== false;
  const probe = headerFor(tensorSpecs(0));
  let padRows = 0;
  if (withPad) {
    const wanted = Math.max(0, targetBytes - probe.dataStart - probe.dataBytes);
    padRows = Math.ceil(wanted / (N_EMBD * 4));
  }
  const { header, dataStart, layout, dataBytes } = headerFor(tensorSpecs(padRows));

  const fd = openSync(path, "w");
  try {
    // Header first, then zero padding up to the aligned data section.
    writeSync(fd, header, 0, header.length, 0);
    const pad = Buffer.alloc(Math.min(1 << 20, dataStart - header.length));
    let at = header.length;
    while (at < dataStart) {
      const size = Math.min(pad.length, dataStart - at);
      writeSync(fd, pad, 0, size, at);
      at += size;
    }

    // Tensor data, written one bounded chunk at a time: a deterministic pattern
    // (an LCG) so the bytes are real and reproducible, not zeros.
    const chunkBytes = 8 * 1024 * 1024;
    const chunk = Buffer.alloc(chunkBytes);
    let state = 0x12345678;
    const fill = (bytes, offsetInFile) => {
      for (let i = 0; i < bytes; i += 1) {
        state = (state * 1664525 + 1013904223) >>> 0;
        // A small, well-conditioned weight-like value.
        chunk[i] = ((state >>> 23) & 0x7f) - 64;
      }
    };
    for (const tensor of layout) {
      let remaining = tensor.rowBytes * tensor.rows;
      let writeAt = dataStart + tensor.start;
      while (remaining > 0) {
        const size = Math.min(chunk.length, remaining);
        fill(size, writeAt);
        writeSync(fd, chunk, 0, size, writeAt);
        writeAt += size;
        remaining -= size;
      }
    }
    const total = dataStart + dataBytes;
    const stats = fstatSync(fd);
    return {
      path,
      bytes: stats.size,
      declaredBytes: total,
      padRows,
      tensors: layout.length - (withPad ? 1 : 0),
    };
  } finally {
    closeSync(fd);
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
  };
  const out = get("out", "/tmp/oversize-6g.gguf");
  const targetGib = Number(get("target-gib", "6.5"));
  const pad = get("pad", "true") !== "false";
  if (existsSync(out) && get("force", "false") !== "true") {
    console.log(`exists: ${out} (use --force to rewrite)`);
  } else {
    const written = writeOversizeGguf(out, { targetBytes: targetGib * GIB, pad });
    console.log(
      `wrote ${out}: ${written.bytes} bytes ` +
        `(${(written.bytes / GIB).toFixed(2)} GiB, ${written.tensors} declared tensors, pad rows ${written.padRows})`,
    );
  }
}
