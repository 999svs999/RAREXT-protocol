# Can RAREXT AI do what the top 10 AI brands do?

Date: 2026-11-22. Companion to [AI-CAPABILITY-AUDIT.md](AI-CAPABILITY-AUDIT.md)
and [holographic-encoding.md](holographic-encoding.md) (the measured
memory-axis research: capacity scaling in the holographic dimension D).
This page maps that
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

**The new scorecard: [TOP-100.md](TOP-100.md).** The objective "best among the
current top 100 AI" is answered there axis by axis against the live 100-model
registry: **8 axes won, 1 tied, 3 lost**. RAREXT is #1 on exactness (1000/1000
held-out vs the neural model's 48%), determinism, integrity, offline operation,
privacy, cost, latency and footprint; it loses on context (192 tokens),
multimodal input and open-ended reasoning, and says so on the same page. The
published receipt is `/mirror/rank.json`, gated by `tools/rank/verify.mjs`.

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
| Vision input on forwarded models | **yes, on both wire shapes, gated by the committed card — and exercised live** | OpenAI surface: parts forward verbatim (`gateway.test.ts` — "a forwarded deployment passes multimodal parts through"); Anthropic surface: `image` blocks map to the OpenAI `image_url` shape **when the deployment's labels declare `input.modalities=text,image`**, and are refused by name otherwise (`gateway.test.ts` — "a card that declares image input…"); `document`/`audio` stay refused everywhere. **Live 2026-11-22**: a real teal PNG through the gateway to `models/gemini-3-flash-preview` answered `"Teal"`, run verified — `tools/brand-live/` |
| Prompt caching | **yes — real KV-prefix reuse, measured** | the engine stores bounded KV prefixes per model and resumes prefill from a matching prefix (`rarext-gguf-engine.js`; LRU, 192 MiB budget, pure-prefill runs only — no pinned/grammar). A cache-disabled engine decodes **token-identically** to a cached one (`web4.test.ts` — "reuses a cached KV prompt prefix and stays token-identical"). Measured through the web4 provider: on Qwen2.5-0.5B-Instruct a second question over a shared 233-token prefix answered in **7.9 s vs 94.9 s cold (12.1×)** with identical answers; usage reports `prompt_tokens_details.cached_tokens` (OpenAI shape) and the Anthropic surface maps it to `cache_read_input_tokens`. Limits stated: automatic only (no user-controlled breakpoints — `cache_control` fields are accepted and ignored on RAREXT's own engine), per-process (cold after a provider restart), bounded |
| Batch API | **yes — OpenAI shape, provider + gateway** | `POST /v1/files` accepts a validated JSONL of requests (`custom_id` + `url` ∈ {`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`} + `body`; anything else is named in the refusal, never dropped); `POST /v1/batches` runs the queue one request per event-loop turn so `/health` and status polls keep answering; `GET /v1/batches/{id}` carries `request_counts` and `output_file_id`; `GET /v1/batches/{id}/output` serves the results JSONL in the OpenAI result shape. Embeddings run through the SAME `embedFor()` the interactive route uses — one implementation, not two that can drift — and a per-request failure becomes that line's `error`, never a batch abort. The gateway proxies the whole surface to the provider behind it (`gateway.ts` — a pure proxy that adds no run records). State persists under the provider's state dir and rehydrates after a restart (output verified byte-identical). Tests: `web4.test.ts` — "the provider runs an OpenAI-shaped batch" (chat + completions + embeddings lines) and "the gateway proxies the batch surface to the provider behind it" (a real provider behind a real gateway). Limit: batch requests run the same engine path as interactive ones — same result body, no separate fast lane |

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

**Live, not just mock: 2026-11-22.** The forwarding path was exercised against
a real brand endpoint — Google's Gemini OpenAI-compatible API
(`models/gemini-3-flash-preview`, key from the operator's environment, never
committed). A text run answered `"Paris"` (HTTP 200, 1.44 s) and a 32×32 teal
PNG sent as an `image_url` part **through the gateway** was answered
`"Teal"` (HTTP 200, 2.96 s) by the upstream — the card-gated vision pass-through
working live, not against a mock. Both recorded runs verify against the
deployment's challenge with the runtime's own checker (20 checks each):
`tools/brand-live/` holds the deployment, the challenge, both transcripts, and
the reproduction commands.

**Ops: RAREXT AI runs all the projects.** The runtime is now an operations
layer, not just a model host: `tools/ops/run-projects.mjs` (`npm run ops:all`)
executes every project's declared gates — rarext-protocol (runtime suite +
claim gate), RAREXT (test + typecheck), BAPECLUB (typecheck + build),
FUTURISTIC (site build), shipflow and stockflow (build + lint) — probes the
five live services (provider, edge-direct, tunnel, the mirror page, the
in-browser weights), and writes a **receipt per gate**: sha256 over the exact
output, duration, exit code. Status publishes to the mirror
(`/mirror/projects.html`), where the page serves the receipts themselves.
Latest measured run: **6/6 projects PASS, 5/5 services PASS** (`all ok: true`).
The ops layer also caught and drove two real fixes: an IPv6 renumber that took
the direct edge down (DNS re-pointed, edge back to 200) and 75 lines of lint
debt across shipflow/stockflow (cleared).

**And the stronger answer to the underlying goal: no third party at all.**
The rebuilt model now runs **in a web page with no server and no API provider**:
`/mirror/entangled.html` (published from `apps/web/public/entangled.html`)
fetches RAREXT's own engine (verbatim, 213 KB) and the χ=48 MPO-factored
weights (4,673,760 bytes) from the same static origin, verifies both sha256
digests in-browser with `crypto.subtle` — pinned: weights
`da1a69cb…cf779`, engine `83b666cf…33b15` — and refuses to run on any mismatch,
then decodes entirely in the tab (the engine's self-registered `RAREXT_GGUF`
api; no eval, CSP-clean: `script-src 'self' 'unsafe-inline'`). The embedded
**14-prompt skill self-test spans all seven deployed skills** — price lookup
(S0) and the full comparison-reasoning suite: cheapest/priciest of two and
three rows, over mixed digit lengths (S1/S2/S1m/S2m/S1t/S2t) — and scores
**14/14 exact in-page** against computed gold (prompts from the task's own
generators, seeds 20261122 and 777). A **holographic memory** panel encodes a
50-pair table into one 32 KiB phasor vector and reads it back 50/50, in the
same tab, with the D-scaling law shown live (200 pairs: D=4096 → 200/200 at
32 KiB, D=16384 → 200/200 at 128 KiB). The same load path is proven under Node
with browser-equivalent APIs only (`crypto.subtle`, `TextEncoder`,
`performance`), digest-mismatch refusal included. Live at
`https://999svs999.github.io/RAREXT-protocol/mirror/entangled.html` (gh-pages
projection of `site/registry/mirror/`); the served bytes' digests were fetched
and compared to the pins — byte-identical.

**Refinement, attempted and gated honestly.** A new skill the base model never
had — price-difference arithmetic (`"A costs $X more than B."`) — was taught to
the χ=48 weights with the projected refine loop (3,000 unique computed-gold
examples, 3,000 supervised steps, SVD projection to χ=48 after every step,
40% replay of the old skills). Measured (`tools/entangle/teach-difference.json`):
the loss fell 7.31 → 0.18 and the response template fully formed
(`"shark costs $25 more than cap classic."`), all seven old skills were
preserved at 1.00/1.00 (worst regression 0.000, several improved), but
**exact new-skill accuracy stayed 0/40 — the gate refused promotion**. The
finding: inside the χ=48 manifold, response templates transfer quickly but
learned arithmetic does not emerge in 3k steps; exact tabular knowledge is the
holographic memory's job (shipped), and new *reasoning* skills need either a
higher-χ refinement or a digit-decomposed curriculum. That is what an honest
gate is for.

**The combined system closed the gap the same day.** Rather than waiting for
gradient descent to re-learn subtraction, the live page pairs the two measured
axes: the trained model keeps language and comparison; a **holographic
difference memory** carries the arithmetic as exact lookup — one binding per
ordered (item, item) pair into a single 32 KiB vector, learned **instantly**
(one binding, no gradient step, even for a pair added after encoding). In-page
measured: **40/40 difference pairs read back exactly**, plus a brand-new pair
learned after encoding and answered correctly (`hrrDifferenceSelfTest` in
`entangled.js`, live on the page's "Difference questions" panel).

The wider-manifold retry was also run and **refused by the same gate**: χ=96,
no-carry digit-decomposed curriculum (every digit of the min price ≥ the
corresponding digit — subtraction without borrowing as the learnable base
case), two held-out seeds — 3,000 steps, loss 7.03 → 0.23, four-digit
difference shapes in the samples (`"$2117 more"`), all seven old skills at
1.00/1.00, worst regression 0.000, and **0/80 on the new skill across both
seeds** (`tools/entangle/teach-difference.json`, χ=96). Twice measured, twice
refused: within this manifold and step budget, arithmetic is not acquired by
gradient descent even when the template is — and the gate says so instead of
promoting a fluent-but-wrong model. Acquiring it honestly needs either a
digit-by-digit decoding curriculum at much longer horizon, or the memory axis
— which is shipped.

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
| **Google — live** | Gemini OpenAI-compatible API, vision | **exercised live 2026-11-22**: text + image pass-through through the gateway, both runs verified against the deployment challenge | `tools/brand-live/` |

And the part none of the ten offers, which is the point of the protocol: on
every RAREXT run a stranger can name the exact weight bytes and engine bytes by
digest, check a signed provider receipt, replay a seeded run byte-for-byte, and
refuse a tampered shard before serving. The brands publish a model *name*.

## 3. What RAREXT itself does not ship

Stated plainly, with the honest reason:

| absent feature | why | current route |
| --- | --- | --- |
| Image **generation** on RAREXT's own engine | no image tower in the weights — the provider names the refusal (`unsupported_operation`, "no image tower") | **forwarded, live**: the gateway proxies `POST /v1/images/generations` to a cloud upstream — exercised 2026-11-22 against the operator's NVIDIA hub: a generated 1024×1024 PNG came back through the gateway and was described correctly by the same hub's vision model (`tools/brand-live/`) |
| Video **generation** | no tower; the hub's `/v1/videos` route requires an upstream-specific `mode` field (probed live: `text-to-video`, `t2v`, `i2v` all refused as "invalid mode" — the contract is undocumented) | the gateway's generation proxy already forwards `/v1/videos` (`gateway.test.ts` — the video line reaches the upstream untouched); a live run needs the upstream's field contract |
| Audio/document **input** | no mapping and no upstream contract for them yet — refused by name on every surface, even on a vision card | — |
| Server-side web search / code interpreter | not built | caller-side tools over the tool-calling surface |
| Realtime voice API | no audio path | — |
| `/v1/fine_tuning/jobs`-style API | RAREXT *trains its own models* (native path, self-evolution, the entanglement rebuild) but does not expose a hosted fine-tuning API; a trained artifact becomes a new content-addressed model | train offline, commit, serve |

## 4. Verdict

- **The API contract the top 10 are written against: covered** — 14/15 live
  probes, both wire shapes, tools, structured output, logprobs, embeddings,
  prompt caching (12.1× on a repeated 233-token prefix, token-identical
  output), and an OpenAI-shaped batch API (provider + gateway proxy) — plus
  image input forwarded on both wire shapes when the committed card declares it
  (`deploy --label input.modalities=text,image`; the claim lives in the signed
  manifest, not in a serve-time flag).
- **Access to all ten brands' models: covered** — natively for the open-weight
  families (llama, mistral, mixtral, gemma, phi, qwen2 containers), verified
  forwarding for the closed ones.
- **Literal product-feature parity: not met, and not hidden** — the table
  above is the list. Where the objective can be met by routing, the route
  exists; where it needs a tower RAREXT does not have, the surface refuses by
  name, which is the behaviour the protocol exists to guarantee.
- **What RAREXT adds that none of the ten offer**: digests on the run, tamper
  refusal before serving, byte-for-byte replay as a deployment requirement,
  signed receipts, machine-distinct quorum — and the endpoint none of them
  ship at all: **the model itself running in the reader's browser tab**, on the
  reader's CPU, with the weights verified against a pinned digest before a
  single token is decoded. That is the axis the project wins, now measured
  against the brand surface specifically.
