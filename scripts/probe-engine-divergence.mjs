#!/usr/bin/env node
/**
 * Where RAREXT and llama.cpp stop agreeing.
 *
 * Two engines reading the same weights and fed the same tokens must produce the
 * same greedy token. This probe walks from a prompt where they agree to one
 * where they do not, so the divergence is a reproducible measurement with a
 * location rather than a claim that one of them is wrong.
 *
 * Every row reports the token count EACH side saw. A row where the counts differ
 * is a tokenizer disagreement; a row where they match and the text differs is a
 * forward-pass disagreement, and those are the rows that matter.
 *
 *   node scripts/probe-engine-divergence.mjs            # RAREXT + llama.cpp
 *   node scripts/probe-engine-divergence.mjs --json
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:0.5b";
const CONTAINER = process.env.RAREXT_SOTA_MODEL
  ?? `${process.env.HOME}/.ollama/models/blobs/sha256-c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515`;
const STEPS = Number(process.env.RAREXT_SOTA_STEPS ?? 3) || 3;

const { loadEngine } = await import(root + "apps/runtime/src/engine-bundle.ts");
const engine = loadEngine(readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js"));
const bytes = new Uint8Array(readFileSync(CONTAINER));
const model = { kind: "gguf", bytes };

const SYSTEM = "You are Qwen, created by Alibaba Cloud. You are a helpful assistant.";
const PROBES = [
  ["5 · bare words", "The capital of France is"],
  ["6 · one control token first", "<|im_end|>The capital of France is"],
  ["6 · other control token first", "<|im_start|>The capital of France is"],
  ["6 · a newline first", "\nThe capital of France is"],
  ["13 · user + assistant", `<|im_start|>user\nThe capital of France is<|im_end|>\n<|im_start|>assistant\n`],
  ["30 · system + user + assistant", `<|im_start|>system\n${SYSTEM}<|im_start|>user\nThe capital of France is<|im_start|>assistant\n`],
  ["34 · full chat template", `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\nThe capital of France is<|im_end|>\n<|im_start|>assistant\n`],
];

// Every sampler is switched OFF. `temperature: 0` alone is not greedy in
// ollama: its defaults also apply `repeat_penalty: 1.1`, which suppresses tokens
// that already appear in the prompt — and that single default is what made
// llama.cpp answer "Paris." where a truly greedy decode answers "The capital
// of". Comparing against a sampler and calling the difference an engine bug is
// the mistake this script exists to avoid repeating.
const GREEDY = {
  num_predict: STEPS,
  temperature: 0,
  seed: 0,
  repeat_penalty: 1.0,
  repeat_last_n: 0,
  presence_penalty: 0,
  frequency_penalty: 0,
  top_k: 0,
  top_p: 1.0,
  min_p: 0.0,
  typical_p: 1.0,
  tfs_z: 1.0,
};

const llama = async (prompt) => {
  const response = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, raw: true, options: GREEDY }),
  });
  if (!response.ok) throw new Error(`ollama ${response.status}`);
  return response.json();
};

const rows = [];
for (const [label, prompt] of PROBES) {
  const ids = engine.encode(model, prompt);
  const run = engine.run(model, { prompt, steps: STEPS });
  const rarextText = engine.decode(model, run.tokens);
  // Twice, in the same order: ollama reuses a KV prefix between requests, so a
  // prompt that is a suffix of the previous one can answer from the cached tail.
  // A row that changes between the two calls is reporting that reuse, not a
  // forward pass.
  let other = null;
  let second = null;
  try {
    const reply = await llama(prompt);
    other = { tokens: reply.prompt_eval_count, text: reply.response };
    const again = await llama(prompt);
    second = again.response;
  } catch (error) {
    other = { error: String(error) };
  }
  rows.push({
    probe: label,
    rarextTokens: ids.length,
    rarextFirstIds: ids.slice(0, 4),
    rarextText,
    llamaCppTokens: other?.tokens ?? null,
    llamaCppText: other?.text ?? null,
    llamaCppSecondText: second,
    llamaCppStable: second === null || second === other?.text,
    tokensAgree: other?.tokens === ids.length,
    textAgrees: other?.text !== null && other !== undefined && other.text === rarextText,
  });
}

const width = Math.max(...rows.map((r) => r.probe.length));
console.log("llama.cpp is asked with every sampler disabled: temperature 0, repeat_penalty 1.0, top_k 0.");
console.log(`${"probe".padEnd(width)}  tok  RAREXT          llama.cpp       tokens  text    stable`);
for (const r of rows) {
  console.log(
    `${r.probe.padEnd(width)}  ${String(r.rarextTokens).padStart(3)}  ${JSON.stringify(r.rarextText).padEnd(14)} ` +
      `${JSON.stringify(r.llamaCppText).padEnd(14)}  ${r.tokensAgree ? "  same" : " DIFFER"}  ` +
      `${r.textAgrees ? "same" : "DIFFER"}  ${r.llamaCppStable ? "yes" : "NO"}`,
  );
}

// Ask the same prompts again, in reverse order. A stateless engine answers the
// same way; a server that reuses a KV prefix moves, and a moved answer is
// evidence about the server, not about the weights.
const reversed = [];
for (const row of [...rows].reverse()) {
  const prompt = PROBES.find(([label]) => label === row.probe)[1];
  try {
    const reply = await llama(prompt);
    reversed.push({ probe: row.probe, text: reply.response, sameAsForward: reply.response === row.llamaCppText });
  } catch (error) {
    reversed.push({ probe: row.probe, error: String(error) });
  }
}
const unstable = reversed.filter((r) => r.sameAsForward === false);
console.log("");
console.log(`llama.cpp, same prompts in reverse order: ${unstable.length}/${reversed.length} answers changed`);
for (const r of unstable) {
  console.log(`  ${r.probe}: "${rows.find((x) => x.probe === r.probe).llamaCppText}" -> "${r.text}"`);
}

const matchedTokens = rows.filter((r) => r.tokensAgree);
const agreed = matchedTokens.filter((r) => r.textAgrees);
const shortRows = matchedTokens.filter((r) => r.rarextTokens <= 6);
const longRows = matchedTokens.filter((r) => r.rarextTokens > 6);
console.log("");
console.log(`tokenizers agree on ${matchedTokens.length}/${rows.length} probes  (this is the engine's side, and it is exact)`);
console.log(`text agrees with llama.cpp on ${agreed.length}/${matchedTokens.length} of those`);
if (unstable.length > 0) {
  console.log("");
  console.log("Read that second number carefully: llama.cpp's own answers depend on the");
  console.log("order the prompts are asked in, so its HTTP path is not a token-level");
  console.log("oracle for this engine. RAREXT's forward pass is verified instead against");
  console.log("the independent implementation in tools/oracle/ (see docs/SOTA-COMPARISON.md).");
}

const result = {
  kind: "rarext.engine-divergence.v1",
  model: CONTAINER.split("/").pop(),
  steps: STEPS,
  llamaCppOptions: GREEDY,
  rows,
  summary: {
    probes: rows.length,
    tokenizersAgree: matchedTokens.length,
    forwardPassAgrees: agreed.length,
    llamaCppOrderSensitive: `${unstable.length}/${reversed.length}`,
    reversedPass: reversed,
  },
};

if (process.argv.includes("--json")) {
  writeFileSync(root + "bench/engine-divergence.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log("\nwrote bench/engine-divergence.json");
}
