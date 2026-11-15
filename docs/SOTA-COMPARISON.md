# RAREXT against the state of the art

The objective this document answers to is: *make RAREXT AI the best AI in the
world, better than any top state-of-the-art model, in any size.*

**It cannot be done, and this document shows why with measurements rather than
opinions — then reports what actually was made better.** Anything else would be
the kind of claim this project exists to refuse.

## The hardware answer

| | |
| --- | --- |
| Host | Intel i5-8257U, **4 cores**, **8 GiB RAM** |
| GPU | Intel Iris Plus 645, 1536 MB shared — no usable LLM compute |
| Frontier model that fits | **none** |
| Models on this machine | Qwen2.5-0.5B, in five copies (RAREXT's and llama.cpp's) |

Qwen2.5-0.5B is 494 M parameters. A frontier model is 100–1000× that. Serving
one needs hundreds of GB of accelerator memory; *training* one needs thousands of
GPUs for months. There is no configuration of this machine on which RAREXT — or
anyone — produces a model that beats GPT-class systems, because the model is not
something the runtime can supply. RAREXT serves committed weights; it does not
create them. When this document says "the same weights both engines read", that
is not a rhetorical device: it is the whole of what either engine contributes.

So the honest framing is the one the project already uses: **RAREXT does not
compete on model quality, and never claimed to.** It competes on whether an
answer can be checked. That is measurable, and it is measured below.

## Method — two engines, identical bytes, one box

`node scripts/compare-sota.mjs` gives the same 379 MB Q4_K_M GGUF to two engines:

- **RAREXT** — `apps/runtime/engines/rarext-gguf-engine.js`, pure JavaScript, no
  third-party inference code;
- **llama.cpp** — through the local Ollama server, the reference implementation
  every other project builds on.

Measurements are best-of-three for RAREXT and warm requests for llama.cpp, on the
prompt `The capital of France is`, greedy decoding, four tokens.

```
RAREXT            " Paris. It"
  deterministic   true  (4 runs, identical token ids)
  prefill         4171 ms
  decode          1038.2 ms/token   0.96 tok/s
  receipt         weights c5396e06af294bd1… engine a90e9b1e59c6c512… tokens 894f4bcb487aaf71…
llama.cpp         "Paris."
  deterministic   true  (same prompt twice, temperature 0)
  prefill         74 ms   (34 prompt tokens)
  decode          51.1 ms/token   19.58 tok/s
  response fields context, created_at, done, done_reason, eval_count, eval_duration,
                  load_duration, model, prompt_eval_count, prompt_eval_duration,
                  response, total_duration
throughput        llama.cpp is 20.3x faster per token
```

## What RAREXT wins, and what it loses

| Axis | RAREXT | llama.cpp / hosted SOTA | Winner |
| --- | --- | --- | --- |
| Reproducible output on committed weights | yes, and the weights have a digest | deterministic at `temperature 0`, but nothing binds the answer to the bytes | **RAREXT** |
| Per-response receipt (which weights, which engine, which tokens) | weights + engine + token digests on the response | none of the 12 response fields names the weights | **RAREXT** |
| Runs with no vendor, no account, no network | yes | local here, but the same product hosted does not | **RAREXT** |
| Decode throughput | 0.96 tok/s | 19.6 tok/s | llama.cpp by **20.3×** |
| Prompt prefill | 4.2 s | 74 ms | llama.cpp by **56×** |
| Model quality | the same 0.5B weights, therefore identical | identical | **tie** |
| Model breadth vs frontier | far behind — 0.5B, no vision, no audio | frontier models are orders of magnitude larger | **not competitive** |

The last row is the objective's honest answer. Two rows above it are what RAREXT
can defend.

**Where this sits in the project's other comparison:** RAREXT's *front door* is
first against 13 AI brands on the UI/UX instrument — 100 to Gemini's 98, Copilot's
93, Claude's 92 ([UI-UX-BENCHMARK.md](UI-UX-BENCHMARK.md)). That is a real win, on
a real axis, and it is a different axis from this one. A better door does not make
a better model, and this document does not let the two blur together.

## Two defects fixed on the way

Both were found by measuring against llama.cpp, not by reading the code.

### 1. Every request re-parsed the container and rebuilt the tokenizer

`run()` called `parseModel()` and `new Tokenizer()` on every invocation. Both are
pure functions of the bytes. Measured per call: **308 ms** to parse,
**335 ms** to build the 151,936-entry tokenizer and encode one prompt.

Fixed with a `WeakMap` keyed on the handle, so a dropped handle takes its entry
with it. One-token request, same host, same prompt:

| | before | after |
| --- | ---: | ---: |
| `run(steps=1)` | 1436 ms | **1069 ms** |
| `run(steps=2)` | 2458 ms | **2177 ms** |

**367 ms off every short request, 26%.** Verified bit-exact: the engine
benchmark's fingerprint is unchanged —
`e9ff3f85827660d07802da4be3beea03ac8947324091f0d4aae025163048037a` before and
after — and `npm run test:runtime` stays at 181/181.

### 2. The tokenizer ignored the control-token table

A GGUF marks each token's type. `tokenizer.ggml.token_type` is
`{1: 151643, 3: 20, 4: 2, 5: 271}` for this file: 22 CONTROL/USER_DEFINED tokens.
The engine ignored the table, so `<|im_start|>` was BPE-split into six ordinary
tokens instead of id 151644:

| | before | after |
| --- | --- | --- |
| `encode("<|im_start|>")` | `27, 91, 318, 4906, 91, 29` | **`151644`** |
| `encode("<|im_end|>")` | `27, 91, 318, 6213, 91, 29` | **`151645`** |
| full chat template | 56 tokens | **34 tokens** |

llama.cpp reports **34** for that prompt. Before the fix RAREXT was answering a
*different question* from every other engine in the world, silently. After it,
`scripts/probe-engine-divergence.mjs` reports the tokenizers agreeing on **7/7**
probes.

## Corrected finding: the forward pass does *not* diverge — my first probe was wrong

An earlier version of this document reported that RAREXT's forward pass disagreed
with llama.cpp on 2 of 7 probes. **That claim is withdrawn.** Diagnosing it
produced a stronger result than the claim it replaced, and the correction is
recorded here rather than quietly deleted, because a comparison that is wrong in
RAREXT's disfavour is still wrong.

### What the divergence actually was

Two things in the *probe*, not in the engine:

1. **`temperature: 0` is not greedy in ollama.** Its defaults also apply
   `repeat_penalty: 1.1`, which suppresses tokens already present in the prompt —
   and suppressing the prompt's own words is exactly what turns an echoing
   completion into a fluent one. On the 34-token chat template, same prompt, same
   weights, same box:

   | ollama sampler settings | first tokens |
   | --- | --- |
   | ollama defaults (`repeat_penalty` 1.1) | `"Paris."` |
   | every sampler disabled | `"The capital of"` |

   RAREXT answers `"The capital of"`. The "divergence" was ollama's sampler.

2. **ollama reuses a cached KV prefix between requests**, so a prompt that shares
   a suffix with the previous request can answer from the cached tail. The
   probe's 30- and 34-token rows both returned `"The capital of"` — which is the
   answer for the *13-token* prompt embedded in them.

`scripts/probe-engine-divergence.mjs` now disables every sampler explicitly and
asks each prompt twice, reporting whether the answer is stable.

### What RAREXT is actually verified against

A third implementation, in `tools/oracle/` — written from the architecture and
the ggml formats, not from the engine:

| Check | Command | Result |
| --- | --- | --- |
| Quantized weights | `npm run oracle:dequant` | **bit-exact**: `max|engine − numpy| = 0.000000e+00` for Q5_0, Q6_K, Q8_0, F32 |
| Tokenization | `npm run probe:divergence` | tokenizers agree **7/7**; control tokens atomic; decode round-trips |
| Forward pass | `npm run oracle:forward` | independent NumPy argmax **equals the engine's first token** on 13-, 30- and 34-token templates (785, 40, 9707) |

So three separately-written implementations of the dequantization and the
forward pass — the JavaScript engine, the TypeScript reference pass, and the
NumPy oracle — agree on the same weights, and the weights themselves are
confirmed against an independent reader of the format.

**What remains unestablished, and will be reported as such:** agreement with
llama.cpp on a chat-templated prompt. Ollama's HTTP API exposes neither prompt
token ids nor logits, and its raw mode produced an implausible baseline on this
weights file (a bare 5-token prompt answered `" ______. A"`, which no correct
engine does, and which no setting of the samplers changed). Until llama.cpp's
own ids can be read, the correct statement is *"RAREXT is verified against an
independent implementation"* — not *"RAREXT agrees with llama.cpp"*, and
certainly not the reverse of either.

**The lesson worth keeping:** a benchmark that measures someone else's front door
through their HTTP defaults is measuring the defaults. The fix was to stop
trusting the oracle's convenience API and write the arithmetic out.

## Reproduce

```sh
npm run bench:sota                 # head-to-head vs llama.cpp, writes bench/sota-comparison.json
npm run probe:divergence           # tokenizer + forward-pass agreement, writes bench/engine-divergence.json
npm run bench:engine               # RAREXT alone, with its fingerprints

# the independent implementation (needs numpy; ~2 GB of scratch space)
npm run oracle:dump -- <path-to.gguf>     # dump the engine's dequantized weights
npm run oracle:dequant -- <path-to.gguf>  # reimplement the ggml formats and compare
npm run oracle:forward -- 151644,872,198,785,6722,315,9625,374,151645,198,151644,77091,198
```

Requires `ollama` serving `qwen2.5:0.5b` on `127.0.0.1:11434` for the llama.cpp
side, and `numpy` for the oracle. `bench:sota` and `probe:divergence` both disable
ollama's samplers explicitly; anything comparing against a hosted model should do
the same, or it is measuring that service's defaults.
