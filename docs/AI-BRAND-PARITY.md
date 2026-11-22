# Can RAREXT AI do what the top 10 AI brands do?

Date: 2026-11-22. Companion to [AI-CAPABILITY-AUDIT.md](AI-CAPABILITY-AUDIT.md),
which measures the capability surface probe by probe. This page maps that
surface onto the brands people actually mean. The top-10 list below is the
2026 consensus across published rankings (OpenAI, Anthropic, Google DeepMind,
Microsoft, NVIDIA, Amazon, Meta, xAI, DeepSeek, Mistral); the *capabilities*
are theirs, the *numbers* are all re-runnable commands from this repo.

The question hides three different questions, and they have three different
answers:

1. **As a serving surface** — does RAREXT speak the same API contract the
   brands' clients are written against? **Yes for the core text-AI classes**,
   measured live: 14/15 probes, 0 critical failures, including tool calling.
2. **As model access** — can a RAREXT deployment reach each brand's models?
   **Yes, all ten** — six by serving their open-weight containers natively,
   all ten through verified forwarding.
3. **As literal feature parity** — does RAREXT itself ship every product
   feature the brands ship (image/video/speech generation, batch, prompt
   caching, fine-tuning API, realtime voice)? **No**, and this page names each
   absence instead of hiding it behind a router.

## 1. The serving surface, measured live

`npm run audit:ai` with a real instruct container (Qwen2.5-0.5B-Instruct,
Q8_0, 675,710,816 bytes, `sha256:ca59ca7f…`), sharded into content-addressed
blobs, served by the provider with the engine also a RAREXT artifact:

```console
$ RAREXT_AUDIT_MODEL=/tmp/qwen25-05b-instruct-q8.gguf npm run audit:ai
  [ok  ] GET /v1/models advertises capabilities {"chat":true,"completions":true,"streaming":true,"embeddings":true,"tools":true,"logprobs":true,"grammar":true,"multimodal":false}
  [ok  ] text completion · factual prompt       " Paris. It is the largest city in"
  [ok  ] SSE stream · one chunk per decoded token 24 chunks vs 24 trace tokens · concat equal · finish=length
  [ok  ] seeded sample replays byte-for-byte    same seed, identical text
  [ok  ] temperature/top-k/top-p/penalties applied different seed, different text
  [ok  ] stop sequence ends the run             finish=stop · " Paris"
  [ok  ] per-token logprobs + alternatives      6 scored tokens vs 6 trace tokens · first=-2.416
  [ok  ] JSON-schema constrained output         {"name":":","age":36}
  [ok  ] tool call (name + JSON arguments)      get_weather({"city":"Paris"})
  [ok  ] embeddings from the same weights       2 vectors · 896 dims
  [ok  ] vision/audio refused by name           HTTP 400 · unsupported_content_part
  [ok  ] declared context window is served      declared 32768 · prompt_tokens 96
  [ok  ] engine throughput on this host         0.68 tok/s · 1472 ms/token · 8 tokens
  [gap ] same model via llama.cpp (ollama)      not running
  [ok  ] health names bundle + engine fingerprint bundle 7a5040e04030ab6cd1… · engine 314380d6f86ecd1218…

14/15 probes passed · 0 critical failure(s)
```

The one gap is the comparative llama.cpp row (Ollama is not running on this
host) — comparative context, not a RAREXT capability. Note the tool-call probe:
the 2026-11-15 audit scored it a model-side gap; with the current container the
runtime parses and returns a real call. That is the audit's own point: the
runtime is not the model, and now both halves of that sentence have live
evidence.

What the brands' clients rely on, beyond the audit, is covered by the runtime
suite (190/190) and named here so it is checkable:

| surface class | RAREXT | evidence |
| --- | --- | --- |
| OpenAI wire (`/v1/chat/completions`) | **yes** | gateway route; audit above |
| Anthropic wire (`/v1/messages`) for RAREXT's own models | **yes, both directions** | `gateway.test.ts`: two-way translation, tool_use block streaming, tool_choice translation, parallel tool use, per-token Anthropic stream, multimodal refusal by name |
| Tool calling incl. parallel + `tool_choice` | **yes** | audit probe + the four gateway tests above |
| Structured output (`response_format`) | **yes** (grammar-constrained) | audit probe; shape guaranteed, truth is the model's |
| Logprobs + alternatives, token-level SSE | **yes** | audit probe; 6 scored = 6 trace tokens |
| Embeddings | **yes**, same committed weights | audit probe; 896-dim from the container |
| Seeded deterministic replay | **yes**, byte-for-byte | audit probe; also a *deployment requirement* (`deterministic-replay`), which no brand API offers |
| Signed receipts, quorum, tamper refusal | **yes** | `demo:web4-model` 34/34; not offered by any brand API |
| Vision/audio input on native models | **no — refused by name** | HTTP 400 `unsupported_content_part` (no vision/audio tower in the engine); measured by the audit |
| Vision input on forwarded models | **yes, on both wire shapes, gated by the committed card** | OpenAI surface: parts forward verbatim (`gateway.test.ts` — "a forwarded deployment passes multimodal parts through"); Anthropic surface: `image` blocks map to the OpenAI `image_url` shape **when the deployment's labels declare `input.modalities=text,image`**, and are refused by name otherwise (`gateway.test.ts` — "a card that declares image input…"); `document`/`audio` stay refused everywhere |

## 2. Reaching each brand's models

Two paths, both in code today:

- **Open-weight containers, served natively.** The engine parses `qwen2`,
  `llama`, `mistral`, `mixtral`, `gemma`, `phi3`, `phi2`
  (`apps/runtime/engines/rarext-gguf-engine.js`, `ARCHS`). A container is
  sharded into RAREXT blobs, verified, and served with digests, receipts and
  replay — including the MPO-factored rebuild
  (`docs/quantum-entanglement-rebuild.md`).
- **Verified forwarding.** A `rarext.cloud-model.v1` card declares a model by
  *capability* (`chat, streaming, tools, parallel_tool_calls, response_format,
  logprobs, embeddings, context_length, input_modalities, output_modalities`)
  with protocol `rarext-cloud`, `openai` or `anthropic`
  (`apps/runtime/src/cloud-model.ts`). The gateway forwards to the upstream and
  still records the run: exact transcript, provider receipt, quorum.

| brand | flagship surface | RAREXT path today | evidence |
| --- | --- | --- | --- |
| OpenAI | GPT chat, tools, structured output, vision, images, voice | forwarded via `openai`-protocol card; core text surface also served natively | `cloud-model.ts` protocols; gateway forward |
| Anthropic | Claude Messages API, tool use, vision | forwarded via `anthropic`-protocol card; the same wire is also served **natively** for RAREXT models | `gateway.test.ts` `/v1/messages` suite |
| Google DeepMind | Gemini multimodal, long context | forwarded via an OpenAI-compatible card (Gemini's compat endpoint) or `rarext-cloud`; Gemma open weights served natively | `ARCHS` includes `gemma` |
| Microsoft | Azure Foundry (hosts many models), Phi | Phi containers served natively; Foundry-hosted models via `openai`-protocol cards | `ARCHS` includes `phi2`, `phi3` |
| NVIDIA | NIM/inference microservices | any NIM OpenAI-compatible endpoint via `openai`-protocol card; RAREXT's own engine is the native alternative | cloud card protocols |
| Amazon | Bedrock (hosted Anthropic/Meta/Mistral/Nova) | Bedrock's OpenAI-compatible gateways via `openai` cards; Llama/Mistral weights natively | `ARCHS` includes `llama`, `mistral`, `mixtral` |
| Meta | Llama open weights, Llama API | **served natively** (llama containers); Llama API via OpenAI-compatible card | `ARCHS` includes `llama` |
| xAI | Grok API (OpenAI/Anthropic-compatible) | forwarded via either protocol card | `cloud-model.ts` |
| DeepSeek | OpenAI-compatible API, open weights | forwarded via `openai` card; open-weight checkpoints are containerised and served natively | protocols + `ARCHS` |
| Mistral | Le Chat + API, open weights | **served natively** (mistral/mixtral); API via OpenAI-compatible card | `ARCHS` includes `mistral`, `mixtral` |

And the part none of the ten offers, which is the point of the protocol: on
every RAREXT run a stranger can name the exact weight bytes and engine bytes by
digest, check a signed provider receipt, replay a seeded run byte-for-byte, and
refuse a tampered shard before serving. The brands publish a model *name*.

## 3. What RAREXT itself does not ship

Stated plainly, with the honest reason:

| absent feature | why | current route |
| --- | --- | --- |
| Image / video / speech **generation** | no such tower in RAREXT's engine; the runtime refuses what it cannot do rather than faking it | forward to a generation endpoint; the gateway records the run |
| Audio/document **input** | no mapping and no upstream contract for them yet — refused by name on every surface, even on a vision card | — |
| Batch API (24-hour jobs) | not built; runs are synchronous with receipts | run N requests through the gateway (quorum/receipts still apply) |
| Prompt caching | the engine re-reads committed rows; KV/prefix caching is not implemented | — |
| Server-side web search / code interpreter | not built | caller-side tools over the tool-calling surface |
| Realtime voice API | no audio path | — |
| `/v1/fine_tuning/jobs`-style API | RAREXT *trains its own models* (native path, self-evolution, the entanglement rebuild) but does not expose a hosted fine-tuning API; a trained artifact becomes a new content-addressed model | train offline, commit, serve |

## 4. Verdict

- **The API contract the top 10 are written against: covered** — 14/15 live
  probes, both wire shapes, tools, structured output, logprobs, embeddings —
  and image input forwarded on both wire shapes when the committed card
  declares it (`deploy --label input.modalities=text,image`; the claim lives in
  the signed manifest, not in a serve-time flag).
- **Access to all ten brands' models: covered** — natively for the open-weight
  families (llama, mistral, mixtral, gemma, phi, qwen2 containers), verified
  forwarding for the closed ones.
- **Literal product-feature parity: not met, and not hidden** — the table
  above is the list. Where the objective can be met by routing, the route
  exists; where it needs a tower RAREXT does not have, the surface refuses by
  name, which is the behaviour the protocol exists to guarantee.
- **What RAREXT adds that none of the ten offer**: digests on the run, tamper
  refusal before serving, byte-for-byte replay as a deployment requirement,
  signed receipts, machine-distinct quorum. That is the axis the project wins,
  and it is now measured against the brand surface specifically.
