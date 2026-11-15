// Dump the engine's OWN dequantized weights as raw float32, so an independent
// implementation can run the same math without re-deriving dequantization.
// Any disagreement then has one possible cause: the algorithm.
import { mkdirSync, openSync, readFileSync, writeSync, closeSync, writeFileSync } from "node:fs";

const root = `${process.env.HOME}/rarext-protocol/`;
const OUT = "/tmp/npw";
const { loadEngine } = await import(root + "apps/runtime/src/engine-bundle.ts");
const engine = loadEngine(readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js"));
const bytes = new Uint8Array(readFileSync(process.argv[2]));
const model = { kind: "gguf", bytes };
const parsed = engine.parseGguf(bytes);

mkdirSync(OUT, { recursive: true });
const names = Object.keys(parsed.tensors);
const CHUNK = 4096;
const index = {};
let total = 0;

for (const name of names) {
  const t = parsed.tensors[name];
  const fd = openSync(`${OUT}/${name}.f32`, "w");
  for (let start = 0; start < t.rows; start += CHUNK) {
    const count = Math.min(CHUNK, t.rows - start);
    const part = engine.dequantRows(model, name, start, count);
    const view = new Float32Array(part.values.buffer, part.values.byteOffset, part.values.length);
    writeSync(fd, Buffer.from(view.buffer, view.byteOffset, view.byteLength));
    total += view.length * 4;
  }
  closeSync(fd);
  index[name] = { rows: t.rows, cols: t.cols, type: t.type };
}

writeFileSync(`${OUT}/index.json`, JSON.stringify({ tensors: index, kv: {
  arch: parsed.kv["general.architecture"],
  block_count: parsed.kv["qwen2.block_count"],
  embedding_length: parsed.kv["qwen2.embedding_length"],
  head_count: parsed.kv["qwen2.attention.head_count"],
  head_count_kv: parsed.kv["qwen2.attention.head_count_kv"],
  ffn_length: parsed.kv["qwen2.feed_forward_length"],
  eps: parsed.kv["qwen2.attention.layer_norm_rms_epsilon"],
  rope_base: parsed.kv["qwen2.rope.freq_base"],
  context_length: parsed.kv["qwen2.context_length"],
  eos: parsed.kv["tokenizer.ggml.eos_token_id"],
} }, null, 2));
console.log(`dumped ${names.length} tensors, ${(total / 1e9).toFixed(2)} GB -> ${OUT}`);
