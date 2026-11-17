// Run prompts through RAREXT's engine on a committed GGUF and print the answers.
//
// This is the integration proof: the model is trained elsewhere, but it is
// SERVED by the engine that ships in this repo, so the decode it produces must be
// the decode the trainer reported — same tokens, same text, same trace.
//
//   node engine_check.mjs <model.gguf> <prompts.json>
//
// prompts.json is [{ "prompt": "...", "want": "..." }, ...]
import { readFileSync } from "node:fs";
import vm from "node:vm";

const [modelPath, promptsPath] = process.argv.slice(2);
if (!modelPath || !promptsPath) {
  console.error("usage: node engine_check.mjs <model.gguf> <prompts.json>");
  process.exit(2);
}

const source = readFileSync(new URL("../../apps/runtime/engines/rarext-gguf-engine.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} }, exports: {}, TextEncoder, TextDecoder, console, Math, JSON };
vm.runInNewContext(source, sandbox, { filename: "rarext-gguf-engine.js" });
const engine = sandbox.module.exports;

const bytes = readFileSync(modelPath);
const model = { kind: "gguf", bytes };
const prompts = JSON.parse(readFileSync(promptsPath, "utf8"));

const parsed = engine.parseGguf(bytes);
console.log(
  `model ${modelPath}\n  arch ${parsed.kv["general.architecture"]} · ` +
    `vocab ${parsed.kv["tokenizer.ggml.tokens"].length} · ` +
    `${parsed.kv["qwen2.block_count"]} layers · d=${parsed.kv["qwen2.embedding_length"]} · ` +
    `ctx ${parsed.kv["qwen2.context_length"]} · ${bytes.length} bytes\n`,
);

let exact = 0;
const started = Date.now();
for (const { prompt, want } of prompts) {
  const t0 = Date.now();
  const out = engine.run(model, { prompt, steps: 48, temperature: 0 });
  const got = out.text;
  const ok = want === undefined ? null : got === want;
  if (ok) exact += 1;
  console.log(`${ok === null ? "    " : ok ? "ok  " : "MISS"} ${JSON.stringify(prompt)}`);
  console.log(`      got  ${JSON.stringify(got)}   (${Date.now() - t0} ms, ${out.tokens.length} tok, finish=${out.finishReason})`);
  if (ok === false) console.log(`      want ${JSON.stringify(want)}`);
}
const scored = prompts.filter((p) => p.want !== undefined).length;
if (scored > 0) console.log(`\nexact match: ${exact}/${scored} (${((100 * exact) / scored).toFixed(1)}%)`);
console.log(`total ${((Date.now() - started) / 1000).toFixed(2)} s`);
