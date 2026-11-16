#!/usr/bin/env node
/**
 * measure-ppl.mjs — score a fixed passage token by token with RAREXT.
 *
 * Perplexity is the model-level check that a forward pass is right: it does not
 * care which token wins one prompt, only whether the probability assigned to
 * real text matches another implementation of the same weights. The tokens are
 * pinned, so every position is a real forward pass and the logprob reported is
 * for the token that actually comes next.
 *
 *   npm run measure:ppl -- <model.gguf> [llama-per-token.json]
 *
 * The optional second file is `{ "ids": [...], "lp": [...] }` measured from
 * llama.cpp (one /completion per prefix, n_predict 1, n_probs large enough to
 * contain the true next token). When given, the two are compared position by
 * position and both are written to bench/quality-ppl.json.
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const { loadEngine } = await import(root + "apps/runtime/src/engine-bundle.ts");

const modelPath = process.argv[2];
const llamaPath = process.argv[3];
if (!modelPath) {
  console.error("usage: npm run measure:ppl -- <model.gguf> [llama-per-token.json]");
  process.exit(1);
}

const PASSAGE =
  "Paris is the capital and largest city of France. It is situated on the river Seine, in the north of the country, at the heart of the Ile-de-France region. The city is a major European centre for finance, commerce, fashion, science and the arts. The Paris region had a gross domestic product of about one trillion dollars in recent years, which makes it one of the largest metropolitan economies in Europe. Paris is especially known for its museums and architectural landmarks. The Louvre is the most visited art museum in the world. The Eiffel Tower is a global icon of France and one of the most recognisable structures on Earth. The city hosts many international organisations and sporting events, and it is served by one of the busiest metro systems in Europe.";

const engine = loadEngine(readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js"));
const bytes = new Uint8Array(readFileSync(modelPath));
const model = { kind: "gguf", bytes };
const ids = engine.encode(model, PASSAGE);

const run = engine.run(model, {
  prompt: engine.decode(model, ids.slice(0, 1)),
  steps: ids.length - 1,
  pinnedTokens: ids.slice(1),
  logprobs: true,
});
const lp = (run.logprobs ?? []).map((entry) => entry.logprob);
const mean = -lp.reduce((a, b) => a + b, 0) / lp.length;
const result = {
  kind: "rarext.quality-ppl.v1",
  passage: PASSAGE,
  tokens: ids.length,
  scored: lp.length,
  rarext: {
    meanNll: Number(mean.toFixed(4)),
    ppl: Number(Math.exp(mean).toFixed(4)),
    engineSha256: JSON.parse(readFileSync(`${root}bench/sota-comparison.json`, "utf8")).rarext.receipt.engineSha256,
  },
};

if (llamaPath) {
  const llama = JSON.parse(readFileSync(llamaPath, "utf8"));
  if (llama.ids.join(",") !== ids.join(",")) {
    console.error("llama.cpp scored a different token sequence — comparison refused");
    process.exit(1);
  }
  const ok = llama.lp.filter((v) => typeof v === "number");
  const lMean = -ok.reduce((a, b) => a + b, 0) / ok.length;
  const diffs = lp.map((v, i) => v - llama.lp[i]).filter((v) => Number.isFinite(v));
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  result.llamaCpp = {
    meanNll: Number(lMean.toFixed(4)),
    ppl: Number(Math.exp(lMean).toFixed(4)),
    method:
      "llama-server b12428 /completion per prefix with raw token ids, n_predict 1, n_probs, cache_prompt; logprob of the true next token",
    meanLogprobGap: Number(meanDiff.toFixed(4)),
  };
  result.tokensMatch = true;
}

writeFileSync(`${root}bench/quality-ppl.json`, `${JSON.stringify(result, null, 2)}\n`);

console.log(`tokens ${result.tokens}, scored ${result.scored}`);
console.log(`RAREXT    mean NLL ${result.rarext.meanNll}  PPL ${result.rarext.ppl}`);
if (result.llamaCpp) {
  console.log(`llama.cpp mean NLL ${result.llamaCpp.meanNll}  PPL ${result.llamaCpp.ppl}`);
  console.log(`mean logprob gap (RAREXT - llama.cpp) ${result.llamaCpp.meanLogprobGap}`);
}
console.log("wrote bench/quality-ppl.json");
