#!/usr/bin/env node
/**
 * decoding-proof.mjs — the decoding controls, demonstrated on real weights.
 *
 * The engine used to expose only `temperature`. A run could not be capped with
 * top-k / top-p, could not be discouraged from looping with a repetition
 * penalty, and could not be ended at a delimiter with `stop`. All four are now
 * honoured, on committed weights, with a seeded RNG that keeps a sampled run
 * replayable.
 *
 * This runs the REAL RAREXT GGUF engine over a committed container and shows,
 * on the same prompt and seed:
 *
 *   1. greedy (temperature 0)                      — the baseline, often looping
 *   2. repetition_penalty                          — the same run, fewer repeats
 *   3. top_k + top_p + temperature                 — restricted sampling
 *   4. the same sampled request twice              — byte-identical (replayable)
 *   5. stop                                        — the run ends, and the
 *                                                    stop text is not returned
 *
 *   RAREXT_WEB4_GGUF=/tmp/model.rarext npm run demo:decoding
 *
 * Exit is non-zero if any control fails to do what it claims.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const { loadEngine } = await import(root + "apps/runtime/src/engine-bundle.ts");
const { schemaDfa, dfaAccepts } = await import(root + "apps/runtime/src/grammar.ts");

const path = process.env.RAREXT_WEB4_GGUF ?? "/tmp/tinyllama-q8.rarext";
if (!existsSync(path)) {
  console.error(`no committed container at ${path}; set RAREXT_WEB4_GGUF`);
  process.exit(1);
}

const engine = loadEngine(readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js"));
const bytes = new Uint8Array(readFileSync(path));
const magic = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
const model = { kind: magic === "RXHF" ? "hf" : "gguf", bytes };

const prompt = process.env.RAREXT_WEB4_PROMPT ?? "aaaa";
const steps = Number(process.env.RAREXT_WEB4_STEPS ?? 64) || 64;

const repeats = (tokens) => tokens.length - new Set(tokens).size;
const show = (label, result) =>
  console.log(
    `  ${label.padEnd(18)} ${JSON.stringify(result.text)}\n` +
      `  ${"".padEnd(18)} tokens=${result.tokens.length} repeats=${repeats(result.tokens)} finish=${result.finishReason}`,
  );

console.log(`RAREXT decoding controls — real weights ${path}`);
console.log(`prompt ${JSON.stringify(prompt)} · ${steps} steps · ${model.kind}\n`);

let failed = 0;
const check = (ok, message) => {
  if (ok) return;
  failed += 1;
  console.error(`  [FAIL] ${message}`);
};

// 1. Greedy baseline.
const greedy = engine.run(model, { prompt, steps, temperature: 0, seed: 0 });
show("greedy", greedy);

// 2. Repetition penalty: same prompt/seed/temperature, fewer repeated tokens.
const penalized = engine.run(model, {
  prompt,
  steps,
  temperature: 0,
  seed: 0,
  repetitionPenalty: 2,
});
show("repetition x2", penalized);
const before = repeats(greedy.tokens);
const after = repeats(penalized.tokens);
check(
  before === 0 ? after === 0 : after < before,
  `repetition penalty did not reduce repeats (${before} -> ${after})`,
);
console.log(`  ${"".padEnd(18)} repeats ${before} -> ${after}\n`);

// 3. top_k + top_p + temperature: a restricted sample.
const sampled = engine.run(model, {
  prompt,
  steps,
  temperature: 0.8,
  seed: 7,
  topK: 4,
  topP: 0.9,
});
show("top_k 4 / top_p .9", sampled);

// top_k=1 is a probability mass of one, so a sampled run must equal greedy.
const topOne = engine.run(model, { prompt, steps, temperature: 0.9, seed: 7, topK: 1 });
check(
  topOne.tokens.join(",") === greedy.tokens.join(","),
  "top_k=1 did not reproduce the greedy run",
);

// 4. The same sampled request reproduces exactly — replay needs this.
const again = engine.run(model, {
  prompt,
  steps,
  temperature: 0.8,
  seed: 7,
  topK: 4,
  topP: 0.9,
});
check(
  again.tokens.join(",") === sampled.tokens.join(","),
  "a sampled run was not reproducible from the seed",
);

// 5. Stop: end at the first occurrence, and do not return the stop text.
const stopAt = greedy.text.length >= 2 ? greedy.text.slice(0, 2) : null;
if (stopAt !== null) {
  const stopped = engine.run(model, { prompt, steps, temperature: 0, seed: 0, stop: [stopAt] });
  show("stop " + JSON.stringify(stopAt), stopped);
  const index = greedy.text.indexOf(stopAt);
  check(stopped.finishReason === "stop", `stop did not end the run (finish=${stopped.finishReason})`);
  check(!stopped.text.includes(stopAt), "the stop text was returned");
  check(stopped.text === greedy.text.slice(0, index), "the stopped text is not the prefix of the greedy text");
} else {
  console.log("  [--] stop             skipped: the greedy run produced no text to stop on");
}

// 6. Context: an oversized prompt cannot overrun the declared context.
const parsed = engine.parseContainer(bytes);
const arch = parsed.kv["general.architecture"];
const declaredCtx = Number(parsed.kv[`${arch}.context_length`]);
if (Number.isFinite(declaredCtx) && declaredCtx > 0) {
  const longPrompt = "the quick brown fox jumps over the lazy dog. ".repeat(2000);
  const longRun = engine.run(model, { prompt: longPrompt, steps: 8, temperature: 0, seed: 0 });
  const positions = (longRun.promptTokens ?? 0) + Math.max(0, longRun.tokens.length - 1);
  console.log(
    `  ${"context".padEnd(18)} declared ${declaredCtx} · prompt ${longRun.promptTokens} tokens` +
      ` · truncated ${longRun.promptTruncated} · positions ${positions}\n`,
  );
  check(longRun.contextLength === declaredCtx, `contextLength ${longRun.contextLength} != declared ${declaredCtx}`);
  check(longRun.promptTruncated === true, "a prompt far longer than the context was not truncated");
  check(
    longRun.promptTokens <= declaredCtx,
    `the prompt was not bounded by the context (${longRun.promptTokens} > ${declaredCtx})`,
  );
  check(
    positions <= declaredCtx,
    `the run exceeded the declared context (${positions} > ${declaredCtx})`,
  );
} else {
  console.log("  [--] context          skipped: the container declares no context length");
}

// 7. logprobs: the model's own confidence, one entry per token.
const scored = engine.run(model, {
  prompt,
  steps: 8,
  temperature: 0,
  seed: 0,
  logprobs: true,
  topLogprobs: 2,
});
const entries = scored.logprobs ?? [];
console.log(
  `  ${"logprobs".padEnd(18)} ${entries.map((entry) => entry.logprob.toFixed(3)).join(" ")}` +
    `  (top 2 per token)\n`,
);
check(entries.length === scored.tokens.length, `logprobs ${entries.length} != tokens ${scored.tokens.length}`);
check(
  entries.every((entry) => Number.isFinite(entry.logprob) && entry.logprob <= 0),
  "a logprob was not a log-probability",
);
check(
  entries.every((entry) => entry.top.length === 2 && entry.top[0].logprob >= entry.top[1].logprob),
  "top_logprobs was not two descending alternatives",
);
check(
  entries.every((entry) => entry.top[0].token === entry.token),
  "a greedy token did not head its own top list",
);

// 8. Embeddings: a deterministic, normalized vector from the same weights.
const first = engine.embed(model, { text: "hello" });
const repeat = engine.embed(model, { text: "hello" });
const other = engine.embed(model, { text: "goodbye" });
const norm = Math.sqrt(first.embedding.reduce((sum, value) => sum + value * value, 0));
console.log(
  `  ${"embeddings".padEnd(18)} dims ${first.dimensions} · tokens ${first.tokens} · L2 norm ${norm.toFixed(6)}\n`,
);
check(
  first.embedding.length === first.dimensions && first.dimensions > 0,
  "the vector length is not the model's embedding dimension",
);
check(Math.abs(norm - 1) < 1e-5, `the embedding is not L2-normalized (${norm})`);
check(
  JSON.stringify(first.embedding) === JSON.stringify(repeat.embedding),
  "embedding the same text twice gave different vectors",
);
check(
  JSON.stringify(first.embedding) !== JSON.stringify(other.embedding),
  "two different texts embedded to the same vector",
);

// 9. Structured output: the constrained decode tool calls are built on. Pinning
//    ids still runs a forward pass per token, so the trace and logprobs are real.
const target = '{"name":"get_weather","arguments":{"city":"Paris"}}';
const targetIds = Array.from(engine.encode(model, target));
const pinnedRun = engine.run(model, {
  prompt,
  steps: targetIds.length + 4,
  temperature: 0,
  seed: 0,
  pinnedTokens: targetIds,
  logprobs: true,
  topLogprobs: 1,
});
const pinnedAgain = engine.run(model, {
  prompt,
  steps: targetIds.length + 4,
  temperature: 0,
  seed: 0,
  pinnedTokens: targetIds,
});
console.log(
  `  ${"structured".padEnd(18)} ${targetIds.length} pinned tokens → ${JSON.stringify(pinnedRun.text)}\n`,
);
check(pinnedRun.text === target, `pinned decode emitted ${JSON.stringify(pinnedRun.text)}`);
check(
  pinnedRun.tokens.join(",") === targetIds.join(","),
  "the trace is exactly the pinned ids",
);
check(pinnedRun.finishReason === "stop", "a finished structured output reports stop");
check(
  (pinnedRun.logprobs ?? []).length === targetIds.length,
  "every pinned token still carries a real logprob",
);
check(pinnedAgain.text === pinnedRun.text, "pinned decoding is deterministic");

// 10. response_format: compile a schema to a byte DFA and let the engine only
//     emit tokens inside it. The document is valid by construction.
const boundedSchema = {
  type: "object",
  properties: {
    sentiment: { enum: ["positive", "negative"] },
    confident: { type: "boolean" },
  },
  required: ["sentiment", "confident"],
  additionalProperties: false,
};
const schemaDfaRun = schemaDfa(boundedSchema);
const constrained = engine.run(model, {
  prompt,
  steps: 128,
  temperature: 0,
  seed: 0,
  grammarDfa: { accept: schemaDfaRun.accept, table: schemaDfaRun.table },
});
const constrainedAgain = engine.run(model, {
  prompt,
  steps: 128,
  temperature: 0,
  seed: 0,
  grammarDfa: { accept: schemaDfaRun.accept, table: schemaDfaRun.table },
});
console.log(`  ${"response_format".padEnd(18)} ${JSON.stringify(constrained.text)}\n`);
check(
  dfaAccepts(schemaDfaRun, constrained.text),
  `the constrained output is not in the schema's language: ${JSON.stringify(constrained.text)}`,
);
check(constrained.finishReason === "stop", "a completed document reports stop");
check(
  constrainedAgain.text === constrained.text,
  "constrained decoding is deterministic",
);

// A digest over the poised run, so two machines can compare the control surface.
const digest = createHash("sha256")
  .update(
    JSON.stringify([
      greedy.tokens,
      penalized.tokens,
      sampled.tokens,
      topOne.tokens,
      entries.map((entry) => [entry.token, Number(entry.logprob.toFixed(6))]),
    ]),
  )
  .digest("hex");

console.log(`\ncontrols digest sha256:${digest}`);
if (failed > 0) {
  console.error(`\n${failed} decoding control(s) FAILED`);
  process.exit(1);
}
console.log(
  "All decoding controls behaved as declared: greedy, penalty, top-k/top-p, replay, stop, context, logprobs, embeddings, structured output, response_format.",
);
