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
RAREXT            " Paris. It is"
  deterministic   true  (4 runs, identical token ids)
  prefill         4255 ms
  decode          1054.6 ms/token   0.95 tok/s
  receipt         weights c5396e06af294bd1… engine d077e9d894314a38… tokens 894f4bcb487aaf71…
llama.cpp         "The capital of France"
  deterministic   true  (same prompt twice, temperature 0)
  prefill         22 ms   (34 prompt tokens)
  decode          15.2 ms/token   65.92 tok/s
  response fields context, created_at, done, done_reason, eval_count, eval_duration,
                  load_duration, model, prompt_eval_cached_count, prompt_eval_count,
                  prompt_eval_duration, response, total_duration
throughput        llama.cpp is 69.5x faster per token (65.9 against 0.95 tok/s)
```

**Correction to an earlier number.** This document previously reported llama.cpp
at **19.58 tok/s** and a 20.3× gap. That measurement was taken while other
CPU-heavy probes were running on the same four cores. Re-measured on an idle
box, twice, llama.cpp is **63.2 and 65.9 tok/s** (15.2–15.8 ms/token). The
honest gap is **~66–69×**, not 20×. RAREXT's own number is stable (0.95–0.96
tok/s), so the earlier understatement was entirely on the arbiter's side.

The two `textA` strings above are **not** comparable as quality: RAREXT is handed
the bare prompt, while ollama renders the model's chat template before answering.
`bench:sota` therefore also runs the fair row — the model's own 34-token template,
rendered identically for both — where the prompt token counts match (34/34) and
the text matches (`"The capital of France"`). The model-level comparison that
does not depend on prompt formatting is the PPL row below.

## What RAREXT wins, and what it loses

| Axis | RAREXT | llama.cpp / hosted SOTA | Winner |
| --- | --- | --- | --- |
| Reproducible output on committed weights | yes, and the weights have a digest | deterministic at `temperature 0`, but nothing binds the answer to the bytes | **RAREXT** |
| Per-response receipt (which weights, which engine, which tokens) | weights + engine + token digests on the response | none of the 12 response fields names the weights | **RAREXT** |
| Runs with no vendor, no account, no network | yes | local here, but the same product hosted does not | **RAREXT** |
| Decode throughput | 0.95 tok/s | 65.9 tok/s | llama.cpp by **69×** |
| Prompt prefill | 4.3 s | 22 ms | llama.cpp by **193×** |
| Model quality | the same 0.5B weights, therefore identical | identical | **tie** |
| Measured text quality (PPL, same 155 tokens) | **5.912** | 5.940 | **tie** (within numeric noise) |
| Model breadth vs frontier | far behind — 0.5B, no vision, no audio | frontier models are orders of magnitude larger | **not competitive** |

The last row is the objective's honest answer. Two rows above it are what RAREXT
can defend.

**Where this sits in the project's other comparison:** RAREXT's *front door* is
first against 13 AI brands on the UI/UX instrument — 100 to Gemini's 98, Copilot's
93, Claude's 92 ([UI-UX-BENCHMARK.md](UI-UX-BENCHMARK.md)). That is a real win, on
a real axis, and it is a different axis from this one. A better door does not make
a better model, and this document does not let the two blur together.

## Three defects fixed on the way

All three were found by measuring against llama.cpp, not by reading the code.

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
`scripts/probe-engine-divergence.mjs` reports the tokenizers agreeing **id for id
on 7/7** probes — which is what makes the forward-pass comparison meaningful at
all: two engines that tokenize differently are answering different questions.

### 3. Every Q6_K tensor was dequantized with the wrong stride

Found last, and the largest of the three. It is described in full in
[The output divergence, resolved](#the-output-divergence-resolved) below, because
the search for it is the story of that section: twelve `ffn_down` tensors decoded
from the wrong bytes, and a NumPy oracle that shared the same mis-index so it
could not see it.

## The output divergence, resolved

This section replaces an earlier one that said the question was open. The record
of the wrong answers stays, because the way they were wrong is the useful part.

**First claim (withdrawn):** "the forward pass diverges from llama.cpp on 2/7
probes, so the engine is not yet correct." Too strong, and it blamed the engine
for what was partly the measuring instrument.

**Second claim (also withdrawn):** "the forward pass does *not* diverge — it was
only ollama's sampler." Also too strong. The sampler is real, but fixing it did
not make the disagreement go away.

**Third claim (withdrawn as stated):** "RAREXT's dequantization is bit-exact
against an independent implementation." True as written, and misleading. The
"independent" implementation shared the engine's misreading, so the two agreed on
the same wrong bytes. Bit-exactness against a shared interpretation says nothing
about the model.

### What the arbiter showed

llama.cpp **b12428** was obtained as a prebuilt macOS x64 binary — no build
required — and used four ways:

| instrument | result |
| --- | --- |
| `llama-tokenize` | ids **identical** to RAREXT on every probe; tokenization eliminated as a cause |
| `llama-server /completion` | `"Paris"` for the 13-token template, with `tokens_evaluated = 13` |
| per-token logprobs | mean NLL **1.7818** over the same 155 tokens; RAREXT was **2.2466** |
| `llama-quantize --allow-requantize … F32` | llama.cpp's **own dequantizer**, for every tensor |

The last one localized it. Comparing llama.cpp's F32 output against the engine's
dump, tensor by tensor:

| tensor | type | before | after fix |
| --- | --- | ---: | ---: |
| `token_embd.weight` | Q8_0 | 0.000e+00 | 0.000e+00 |
| `blk.0.attn_q.weight` | Q5_0 | 0.000e+00 | 0.000e+00 |
| `blk.2.ffn_down.weight` | Q4_K | 0.000e+00 | 0.000e+00 |
| `blk.0.ffn_down.weight` | **Q6_K** | **1.465e-01** | **0.000e+00** |
| `blk.1.ffn_down.weight` | **Q6_K** | **1.572e-01** | **0.000e+00** |

### The defect

A Q6_K super-block holds 256 values as two halves. Each half consumes **64 `ql`
bytes and 32 `qh` bytes**. The engine used one index, `half * 32 + i`, for both —
correct for `qh`, wrong for `ql`: the second half re-read `ql[32..95]` instead of
`ql[64..127]`. All **12 Q6_K tensors** in the model (`ffn_down` in layers 0, 1, 3,
6, 7, 8, 9, 10, 13, 16, 19, 21) were corrupted in the second half of every
super-block. The fused `dotRow` path and the row `dequantRow` path had the same
bug, so every consumer agreed with every other consumer.

Why the oracle missed it: `tools/oracle/dequant-check.py` implemented the same
mis-index. It was independent code, not an independent interpretation. The fix is
one stride (`half * 64 + i` for `ql`, `half * 32 + i` for `qh`), a regression test
that fails on the old code (`type 14[128] = -32 but expected -31`), and the same
correction in the oracle.

### After the fix

Measured by `npm run measure:ppl` and written to `bench/quality-ppl.json`; the
same 155 tokens, the same weights, the same box.

| measurement | RAREXT | llama.cpp |
| --- | ---: | ---: |
| PPL, 155 tokens of the same passage | **5.912** | **5.940** |
| mean NLL, same tokens | 1.7770 | 1.7818 |
| 13-token template, greedy | **59604 `"Paris"`** | **59604 `"Paris"`** |
| 30- and 34-token templates | 785 `"The"` | 785 `"The"` |
| text agreement, 7 probes | **6/7** (was 2/7) | — |
| token ids, 7 probes | **7/7** | — |

The remaining disagreement is probe 5, a bare non-templated prompt, where both
engines are splitting near-ties: llama.cpp's top is `" ______"` (−1.49) with
`" Paris"` second (−1.75); RAREXT prefers `" Paris"` (−1.54). That is recorded
rather than smoothed over. It is not a quality difference; it is two
implementations splitting a 0.25-nat gap on an input the chat model was not
trained to see raw.

**The lesson, revised:** an independent implementation is not an independent
*interpretation*. Agreement between two programs written by one author in one
session is weak evidence, however clean the code is. The fix was to get an
arbiter from a different lineage — llama.cpp's own dequantizer — and let it name
the tensor.

## Reproduce

```sh
npm run bench:sota                 # head-to-head vs llama.cpp, writes bench/sota-comparison.json
npm run probe:divergence           # tokenizer + forward-pass agreement, writes bench/engine-divergence.json
npm run bench:engine               # RAREXT alone, with its fingerprints (needs a .rarext container)
npm run measure:ppl -- <model.gguf> [llama-per-token.json]
                                   # per-token NLL / PPL, writes bench/quality-ppl.json

# the independent implementation (needs numpy; ~2 GB of scratch space).
# On a host where only python3.11 carries numpy: PYTHON=python3.11 npm run …
npm run oracle:dump -- <path-to.gguf>     # dump the engine's dequantized weights
npm run oracle:dequant -- <path-to.gguf>  # reimplement the ggml formats and compare
npm run oracle:forward -- 151644,872,198,785,6722,315,9625,374,151645,198,151644,77091,198
```

**The arbiter that found the Q6_K defect** is llama.cpp's own dequantizer, not
ollama. With a prebuilt `llama-quantize` next to the model:

```sh
llama-quantize --allow-requantize <model.gguf> /tmp/model-f32.gguf F32
# then compare /tmp/model-f32.gguf, tensor by tensor, against the oracle dump:
# every type in this model now reports max|llama.cpp − RAREXT| = 0.000e+00.
```

Requires `ollama` serving `qwen2.5:0.5b` on `127.0.0.1:11434` for the llama.cpp
side, and `numpy` for the oracle. `bench:sota` and `probe:divergence` both disable
ollama's samplers explicitly; anything comparing against a hosted model should do
the same, or it is measuring that service's defaults.
