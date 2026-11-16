# Can RAREXT AI do everything other AI can do — and do it better?

Date: 2026-11-15. Scope: the AI runtime, the engine, the provider surface, and
the verification path, exercised against a real 0.5B instruct container. Every
number below is a command you can re-run; the output is quoted, not summarised
into a slogan. The short answer is two answers, because the question hides two
different ones.

## Verdict

**Capability breadth: no.** RAREXT AI cannot do everything a frontier hosted
model does. It has no vision, audio, image, speech, or video path; the only
model-size class it ships is **1G**; the 6/7/8 GB classes are declared
`shipped: false`; tool calling is implemented but a 0.5B model missed the live
prompt; and on this host the engine decodes at **0.50 tok/s** against
**15.2 tok/s** for llama.cpp on the same 0.5B model — roughly **30× slower**
(llama.cpp at Q4_K_M, RAREXT at Q8_0; not quantisation-matched, so read it as an
order-of-magnitude gap, not a precise ratio).

**Verifiability and independence: yes, and better than the alternatives.** On the
same run, a stranger can name the exact weight bytes, the exact engine bytes, the
decode trace, and a signed receipt; a corrupted shard is refused before serving;
a seeded run replays byte-for-byte; two nodes agree on a canonical trace (on the
same host in this run — the demo separately proves a machine-distinct quorum is
refused when both are one box); and perturbing the committed weights changes the answer. Hosted APIs
publish a model *name*, not a weight digest; local runtimes run weights but do
not commit the *engine* as a content-addressed artifact and verify it before
serving. That is the axis RAREXT wins on, and it is the axis the protocol exists
for.

The question "can it do everything other AI can do and even better" conflates
those two axes. On capability, the honest answer is no; claiming otherwise would
be exactly the unverifiable assertion this project refuses. On verification, the
honest answer is yes, and the evidence is below.

One distinction matters throughout: **RAREXT AI is a runtime and a protocol, not
a model.** Its capability ceiling is the model an operator commits. The audited
container is Qwen2.5-0.5B-Instruct (Q8); the repo's default demo model is a
deterministic fixture. The same engine accepts llama, mistral, mixtral, qwen2,
gemma, phi2, and phi3 containers. The runtime can host a larger model; the
host cannot hold one, and the ladder says so instead of pretending.

## What was measured

Host: 8.0 GiB RAM, Intel Core i5-8257U, macOS, Node v24.15.0.

Container: `/tmp/qwen05-q8.rarext`, RXHF, `qwen2`, **528,950,400 bytes**,
declared context **32,768**, weights
`sha256:829e6e3234673d69d0265186ca5635310f626fd6e88ca265b219bd98e93b9f34`.
Engine: `sha256:1846522dd074c8f41239e5502d72375cf2470a8d4d7b930574ba3bcf4f1038d0`.

The audit stands up a real RAREXT node, shards the container into **64**
content-addressed blobs, starts a provider that fetches and verifies every shard,
serves the *engine* as a RAREXT artifact too, and probes the OpenAI-compatible
surface over HTTP:

```console
$ npm run audit:ai
RAREXT AI capability audit
  model   /tmp/qwen05-q8.rarext
          qwen2 · 528,950,400 bytes · context 32768
  weights sha256:829e6e3234673d69d02…
  engine  sha256:1846522dd074c8f4123… (content-addressed, served by the provider)
  node    http://127.0.0.1:58640

  provider fetched and verified 64 shards / 528,950,400 bytes
  serving http://127.0.0.1:58667

  [ok  ] GET /v1/models advertises capabilities {"chat":true,"completions":true,"streaming":true,"embeddings":true,"tools":true,"logprobs":true,"grammar":true,"multimodal":false}
  [ok  ] text completion · factual prompt       " Paris. It is the largest city in"
  [ok  ] SSE stream · one chunk per decoded token 24 chunks vs 24 trace tokens · concat equal · finish=length
  [ok  ] seeded sample replays byte-for-byte    same seed, identical text
  [ok  ] temperature/top-k/top-p/penalties applied different seed, different text
  [ok  ] stop sequence ends the run             finish=stop · " Paris"
  [ok  ] per-token logprobs + alternatives      6 scored tokens vs 6 trace tokens · first=-2.464
  [ok  ] JSON-schema constrained output         {"name":":","age":36}
  [gap ] tool call (name + JSON arguments)      no call; model said " The answer will be in the format: {\"city\": \"Paris\", \"countr"
  [ok  ] embeddings from the same weights       2 vectors · 896 dims
  [ok  ] vision/audio refused by name           HTTP 400 · unsupported_content_part
  [ok  ] declared context window is served      declared 32768 · prompt_tokens 96
  [ok  ] engine throughput on this host         0.50 tok/s · 2020 ms/token · 8 tokens
  [ok  ] same 0.5B model via llama.cpp (qwen2.5:0.5b, Q4_K_M) 15.2 tok/s · 66 ms/token · 16 tokens
  [ok  ] health names bundle + engine fingerprint bundle 3c2781399f54420081… · engine b138f4203eefd085de…

14/15 probes passed · 0 critical failure(s)
wrote bench/ai-capability.json
```

The JSON-schema probe is worth reading precisely: the grammar **did** constrain
the decode — the output is valid against the schema — but the model chose `":"`
for a name. Structured output guarantees shape, not truth. That is a property of
constrained decoding everywhere, not a RAREXT defect, and the audit reports the
value rather than calling it a pass on semantics.

## Capability matrix

| Capability | RAREXT AI today | Evidence |
| --- | --- | --- |
| Text completion | **yes** | `" Paris. It is the largest city in"` on a factual prompt |
| Chat | **yes** | OpenAI `/v1/chat/completions`; note below on templates |
| Streaming | **yes**, per token | 24 chunks = 24 decode-trace tokens; concatenation equals the non-stream text; `finish_reason` on the final chunk |
| Sampling controls | **yes** | temperature, top-k, top-p, min-p, typical-p, repetition/presence/frequency penalties, `logit_bias`, seeded RNG |
| Stop sequences | **yes** | `finish=stop`, stop text not returned (`" Paris"`) |
| Logprobs | **yes** | 6 scored tokens = 6 trace tokens; negatives; alternatives |
| JSON-schema output | **yes** (shape) | `{"name":":","age":36}` valid against the schema |
| Tool calls | **protocol yes**, model **weak** | runtime parses calls; the 0.5B emitted prose on the live prompt |
| Embeddings | **yes**, same weights | 2 × 896-dim vectors from the committed container |
| Vision / audio | **no**, refused by name | HTTP 400 `unsupported_content_part` |
| Image / speech / video generation | **no** | no such route or tower |
| Long context | **declared 32,768**, not performance-tested | this host would take hours to prefill 32k; truncation is covered on a small container |
| Model classes | **1G shipped**; 6/7/8G `shipped: false` | `packages/core/src/generations.ts`; host has 8 GiB |
| Fine-tuning | **no** | no trainer path |
| Throughput | **0.50 tok/s** on 0.5B Q8_0 | 2020 ms/token on this host |
| No third-party AI dependency | **yes** | weights and engine are RAREXT artifacts; no Ollama/llama.cpp/GPU/container on the path |
| Content-addressed weights | **yes** | 64 shards verified against one digest before serving |
| Content-addressed engine | **yes** | engine served as a RAREXT artifact; fingerprint folded into the provider's health/receipt |
| Tamper refusal | **yes** | a corrupted shard stops the provider (`demo:web4-model` — `tamper` phase) |
| Seeded replay | **yes** | same seed, identical text; a second node reproduces the same trace |
| Signed receipt | **yes** | provider signs request/response/attestation/engine/bundle |
| Multi-provider quorum | **yes** | 2 providers, same canonical trace; machine-distinct quorum enforced |
| Hardware TEE | **no** (software enclave only) | the trust anchor is a shipped key, not fused silicon — documented limit |

Rows that are not a single live probe are covered by the **181-test** runtime
suite (`npm run test:runtime`): `logit_bias`, `n > 1`, `parallel_tool_calls`,
grammar and tool-call parsing, prompt truncation, sealed prompts, replay
envelopes, receipts, and tamper refusal. The harness above is the live
cross-check, not the only test; where the two disagree, the live probe wins.

## Against the other three kinds of "AI"

| | RAREXT AI | Frontier hosted API | Local runtime (Ollama/llama.cpp) |
| --- | --- | --- | --- |
| Model quality ceiling | the model you commit (0.5B here) | frontier scale | the model you download |
| Modalities | text + embeddings | text, vision, audio, image, often more | model-dependent; usually text, some vision |
| Throughput on this host | 0.50 tok/s (Q8_0) | vendor datacenter; network-bound | 15.2 tok/s (same 0.5B, Q4_K_M) |
| Weights you can name | **yes, by digest** | no (a model name) | yes, a local file; not a served, verified artifact |
| Engine you can name | **yes, by digest** | no | the binary you installed; not pinned per run |
| Tamper refusal before serving | **yes** | n/a | no (a corrupted file fails at load, not by commitment) |
| Replay a sampled run | **yes, byte-for-byte** | no | only with the same binary/flags, not a committed promise |
| Signed, provider-side receipt | **yes** | vendor logs, not a portable receipt | no |
| Independent-provider quorum | **yes** | no | no |
| Works with no third-party AI provider | **yes** | no | yes, but with a third-party engine |
| Zero install / no GPU | **yes** | client only | needs the runtime installed |

RAREXT is not trying to win the first two rows. It is trying to make the last
seven true at the same time, and on this evidence it does.

## What the audit found and fixed

An audit that only confirms is not an audit. Three real defects surfaced, and all
were fixed with tests.

### 1. The "independent" forward pass was wrong on Qwen2

`npm run bench:engine` compares the engine against a separately written
reference pass on the same bytes. On Qwen2 it reported a mismatch:

```console
argmax 115878 vs engine first token 576  → agrees false (MISMATCH)
[FAIL] the independent forward pass disagreed
```

Cause: Qwen2 carries additive biases on `attn_q`/`attn_k`/`attn_v` (and some
checkpoints on the output projection). The engine applied them; the reference
pass did not. The engine was right and the yardstick was wrong. After adding
bias support to `apps/runtime/src/reference-forward.ts`:

```console
argmax 576 vs engine first token 576  → agrees true
fingerprint 48db0de40f5271844c8545b6e2d986bfd060d366fa1a745eb7f1f0542b22e161
Benchmark ok: engine, streamed, and reference all measured on the same weights.
```

This matters more than a benchmark number: the claim "the engine computes the
same function as a straightforward implementation" now holds on the architecture
this deployment actually runs. A regression test now builds a Qwen2 container with
non-zero Q/K/V biases; it **fails** with the bias lines removed and **passes**
with them, so the yardstick cannot silently drift again.

### 2. The HF converter dropped the chat template

`scripts/convert-hf-safetensors.mjs` read `tokenizer_config.json` for special
tokens but not for `chat_template`. A converted instruct checkpoint kept its
weights and lost its chat format, so the provider fell back to a plain
`user: … assistant:` prompt. Fixed: the template is carried into the container's
KV, with a test that asserts it survives conversion. The existing
`/tmp/qwen05-q8.rarext` predates the fix, which is why the live tool-call probe
ran on the fallback prompt; that is one reason the 0.5B missed the call, and it
is stated rather than hidden.

### 3. Every Q6_K tensor was dequantized with the wrong stride

Q6_K super-blocks hold 256 values as two halves, each consuming **64 `ql` bytes
and 32 `qh` bytes**. The engine used one index (`half * 32 + i`) for both, so the
second half re-read `ql[32..95]` instead of `ql[64..127]`. The 12 Q6_K tensors
(`ffn_down` in layers 0, 1, 3, 6, 7, 8, 9, 10, 13, 16, 19, 21) were corrupted,
and both the fused `dotRow` and the row `dequantRow` carried the bug.

What makes this an audit finding rather than a bug report: the NumPy oracle had
the **same** mis-index and consumed the engine's dump, so it reported
`0.000000e+00` and the "independent" verification was agreeing with itself. It
was caught only by an arbiter from a different lineage — llama.cpp b12428's own
`llama-quantize --allow-requantize … F32` — which differed by up to `1.57e-01` on
Q6_K and by `0.000e+00` on Q5_0/Q8_0/Q4_K/F32. After the one-stride fix, PPL on
the same 155 tokens fell from **9.4560 to 5.912**, against llama.cpp's **5.940**;
the 13-token template answers `"Paris"` like llama.cpp instead of `"The"`; and
text agreement went from **2/7 to 6/7**. The lesson is now enforced by a
regression test that fails on the old code (`type 14[128] = -32 but expected
-31`), and [SOTA-COMPARISON.md](SOTA-COMPARISON.md) records the full search.

### Still open (not defects, limits)

- **Tool-call reliability at 0.5B.** The runtime's parser and OpenAI shape are
  tested; the model did not emit a call on the live prompt. A larger instruct
  model, or the recovered chat template, is the fix.
- **Throughput.** 0.50 tok/s is a JavaScript engine on a 2018 ultrabook CPU.
  It is not competitive with llama.cpp and is not claimed to be; the measured
  baseline is Q4_K_M, so the 30× figure overstates a like-for-like gap, but the
  order of magnitude does not change.
- **Modalities.** Vision/audio are refused by name; image/speech/video
  generation does not exist.
- **Model scale.** 6/7/8 GB classes remain `shipped: false`. Serving a real
  model of that size needs a host that can hold it — well beyond this 8 GiB box —
  or the streaming path with real weights.
- **Hardware isolation.** The enclave is software; `host-root-excluded` is
  refused unless a vendor-signed image certifies it. That is the documented
  hardware-TEE gap.

## Verification is not a slogan

The end-to-end demo exercises the properties the matrix claims, including the
adversarial ones:

```console
$ npm run demo:web4-model
...
[PASS] determinism — a sampled request was refused (422); the accepted run carried an
       independent witness whose decode trace (8 token ids) matched the run token-for-token;
       stripping the witness, reusing the run's own provider as witness, and diverging the
       witness trace were all refused
[PASS] engine — the engine is a RAREXT artifact: 11 shard(s) under sha256:7fff6daea4f…;
       the provider fetched and verified it, its digest is folded into the engine fingerprint,
       it served the FETCHED engine, and a tampered artifact was refused
[PASS] isolation — the deployment demanded vendor-certified memory isolation;
       the gateway refused the run (503) rather than treat a host-readable box as confidential
[PASS] tamper — a provider starting after shard 9a8971001842… was corrupted refused to serve it
[PASS] verify — deployment c2936dd26a01… and bundle a2bce7dfac7e… recomputed with no provider
34/34 phases passed
```

And two-node inference over the real 0.5B container:

```console
$ RAREXT_WEB4_GGUF=/tmp/qwen05-q8.rarext RAREXT_WEB4_PROMPT="The capital of France is" \
    npm run demo:ai-on-rarext
  [OK] commit — weights sha256:829e6e32346… and engine sha256:1846522dd07… are RAREXT shards
  [OK] nodes — 2 node(s) fetched and verified the shards from RAREXT and serve ai-on-rarext
  [OK] infer — both nodes answered " Paris. It is the largest city in" from the committed weights
  [OK] agree — the same canonical trace 6ea29f5d699d794d7f… on every node
  [OK] replay — a re-run on node A reproduced trace 6ea29f5d699d794d7f…
  [OK] weights — perturbing 32543195 committed weight bytes changed the run
                  (6ea29f5d699d… -> 202b22a6c587…)
```

The answer changes when the weights change. That is the property a hosted model
name cannot give you.

## Quality is the model's, not the runtime's

Same prompts, greedy, RAREXT versus llama.cpp on the same base model — RAREXT at
Q8_0, llama.cpp at Q4_K_M, so this is a fidelity check, not a quant-matched bake-off:

```console
"The capital of France is"
  RAREXT: " Paris. It is the largest city in Europe and the third largest in the world. It is located"
  llama : " ______. A. Paris B. London C. Moscow D. Berlin\nAnswer:\n\nA\n\nIn"

"def add(a, b):"
  RAREXT: " \n    return a + b \n\ndef subtract(a, b): \n    return a - b \n\n"
  llama : " \n    return a + b\n\ndef subtract(a, b):\n    return a - b\n\ndef"

"Q: If a train travels 60 km/h for 2.5 hours, how far does it go?\nA:"
  RAREXT: " 15\nExplanation for A: The train travels 60 km/h * 2."
  llama : " 15\nThe answer is 15\nIs the following statement correct expressed in logical form"
```

The outputs are of comparable quality — including the same wrong answer to the
train problem (15 instead of 150). That is the honest picture: the runtime
is faithful; a 0.5B model is a 0.5B model. RAREXT does not make a small model
into a frontier one, and does not claim to.

## Reproduce

```bash
# the container audited here (any supported GGUF/RXHF works; this is how it was built)
node scripts/convert-hf-safetensors.mjs /path/to/Qwen2.5-0.5B-Instruct \
  /tmp/qwen05-q8.rarext Q8_0

npx tsc --noEmit                                   # exit 0
npm run test:runtime                               # 181/181
npm run audit:ai                                   # 14/15 probes, 0 critical
RAREXT_BENCH_MODEL=/tmp/qwen05-q8.rarext npm run bench:engine
npm run demo:web4-model                            # 34/34 phases
RAREXT_WEB4_GGUF=/tmp/qwen05-q8.rarext \
  RAREXT_WEB4_PROMPT="The capital of France is" npm run demo:ai-on-rarext
npm run claim:check                                # 9 (documented pre-existing drift)
```

`bench/ai-capability.json` records the probe results, digests, and host. The
audit is a harness, not a one-off transcript: it exits non-zero if a critical
probe fails, so a regression in streaming, logprobs, stop, structured output,
embeddings, refusal, or receipt binding is caught rather than narrated.

## Bottom line

- **Everything other AI can do?** No. Text, chat, streaming, sampling, stop,
  logprobs, structured output, embeddings, and a tool-call protocol: yes.
  Vision, audio, image/speech/video generation, fine-tuning, frontier-scale
  reasoning, and reliable tool use at 0.5B: no.
- **Even better?** On verifiability, replay, tamper refusal, engine pinning,
  signed receipts, multi-provider quorum, and independence from third-party AI
  providers: yes, and measurably. On capability and speed: no, and the ladder
  and the benchmark say so in public.
- **What would close the gap?** Larger committed models on a host that can hold
  them, an optimized/GPU engine backend, multimodal towers, and a trainer. None
  of those is claimed today.

The value is not that RAREXT out-reasons a frontier model. It is that when
RAREXT answers, you can check *which* weights, *which* engine, *which* run, and
*who* signed it — and no one else in this comparison gives you all four.
