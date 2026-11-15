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

## The open question, stated precisely

Getting this wrong twice is part of the record, so the record says so.

**First claim (withdrawn):** "the forward pass diverges from llama.cpp on 2/7
probes, so the engine is not yet correct." Too strong. It attributed to the engine
what was partly a property of the measuring instrument.

**Second claim (also withdrawn):** "the forward pass does *not* diverge — it was
only ollama's sampler." Also too strong. The sampler is real and is worth knowing,
but fixing it does not make the disagreement go away.

**What is actually true, and reproducible:**

1. **ollama's defaults are not greedy — on some versions.** `temperature: 0` is
   not greediness on its own: a server may still apply `repeat_penalty: 1.1`,
   which suppresses tokens already present in the prompt, and that is exactly what
   turns an echoing completion into a fluent one. Measured on the **0.23.2**
   command-line server against the 34-token template:

   | ollama sampler settings (0.23.2) | first tokens |
   | --- | --- |
   | defaults (`repeat_penalty` 1.1) | `"Paris."` |
   | every sampler disabled | `"The capital of"` |

   **This does not reproduce on 0.40.14**, the version the desktop app runs: there,
   defaults and samplers-off both return `"The capital of"`. So the sampler was a
   version-specific hazard, not the explanation for the remaining disagreement —
   recorded because it was reported here as the explanation and that was wrong.
   Both scripts still disable every sampler explicitly, because a comparison that
   does not is measuring the server's defaults whenever they happen to apply.

2. **RAREXT's dequantization is bit-exact against an independent implementation.**
   `npm run oracle:dequant` reimplements Q4_0/Q5_0/Q8_0/Q4_K/Q6_K/F32 from the
   ggml block layouts and compares row by row:
   `max|engine − numpy| = 0.000000e+00` on every type this model uses.

3. **RAREXT's forward pass matches a clean-room NumPy implementation** — its own
   RMSNorm, RoPE, GQA, causal softmax and SwiGLU — on the first generated token of
   a 13-, 30- and 34-token chat template (ids 785, 40, 9707). `npm run oracle:forward`.

4. **The tokenizers agree on 7/7 probes**, and the control-token fix made that
   possible: `<|im_start|>` is now the single id 151644 rather than six ordinary
   tokens.

5. **llama.cpp still disagrees on templated prompts, stably.** With samplers off,
   asked twice in both orders, and re-confirmed against a second server started
   with an empty cache, it returns `"Paris"` for the 13-token prompt and
   `"The capital of"` for the 30- and 34-token ones, where RAREXT returns
   `"The capital of"`, `"I'm sorry"`, `"Hello! I"`.

Versions matter, and both are recorded: the disagreement above is measured
against **0.40.14**, with the same prompts re-run against a second server holding
an empty cache, in both orders, and with every sampler disabled. An earlier pass
of this work also used a **0.23.2** copy, whose sampler defaults produced the
`"Paris."` in the table above; that path is why both scripts now disable samplers
explicitly.

**So the honest state is:** RAREXT is verified against an implementation written
from the architecture and the ggml formats, and it is *not* verified against
llama.cpp on templated prompts. `"Paris"` is the better answer, and that is a real
reason to suspect that RAREXT and the NumPy oracle share a misreading of some
Qwen2 detail — an independent *implementation* is not an independent
*interpretation*, and the oracle was written by the same hand in the same session.

**What would settle it, and why it is not settled here.** The arbiter is
llama.cpp's own prompt token ids and logits. Ollama's HTTP API exposes neither,
and ollama 0.23.2 does not log per-request prompt tokens at any debug level
(checked: a second server on a spare port with `OLLAMA_DEBUG=1` prints batch
sizes, not `task.n_tokens`). The instrument that would answer it is
`llama-cli --verbose-prompt`, which requires building llama.cpp:
`brew install llama.cpp` did not finish in fifteen minutes on this Intel host and
was stopped. That build is the next step, and it is the only thing standing
between "verified against one clean-room implementation" and "verified against
the reference everyone uses".

**The lesson worth keeping:** both wrong claims came from trusting a convenient
oracle — first a sampler, then an agreement between two implementations by one
author. The fix in both cases was to write the arithmetic out where it could be
read.

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
