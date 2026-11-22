# Live forwarding to real brand endpoints — measured

This directory is the evidence that RAREXT's remote placement forwards to
**real live endpoints** and that the runs RAREXT records about them verify:

1. **Google** — Gemini's OpenAI-compatible API: a text run ("Paris") and a live
   image pass-through (a teal PNG answered "Teal"), both verified against the
   deployment challenge (20 checks each).
2. **NVIDIA hub** (the operator's configured `NVIDIA_BASE_URL`, an
   OpenAI-compatible hub serving `agnes-*` models) — and, through it, **live
   image generation**: `POST /v1/images/generations` through RAREXT's gateway
   returned a generated 1024×1024 PNG (`generated-teal-square.png`,
   628,770 bytes), which the hub's own vision model then described back as
   *"A solid teal-green square is centered on a plain white background."*
   Generate through RAREXT, verify through RAREXT.

Nothing here holds a key: upstream credentials came from the operator's
environment (`RAREXT_UPSTREAM_API_KEY`), and the committed deployments carry
only the auth MODE (`labels.upstreamAuth: "bearer"`), never the secret.

Nothing here holds a key: the upstream credential came from the operator's
environment (`RAREXT_UPSTREAM_API_KEY`), and the committed deployment carries
only the auth MODE (`labels.upstreamAuth: "bearer"`), never the secret.

## What was run (2026-11-22)

```bash
export RAREXT_UPSTREAM_API_KEY=…            # operator's key, never committed

node apps/runtime/src/cli.ts deploy \
  --remote \
  --endpoint https://generativelanguage.googleapis.com/v1beta/openai \
  --engine openai-compatible \
  --upstream-api openai --upstream-auth bearer --upstream-key-env GOOGLE_API_KEY \
  --model models/gemini-3-flash-preview \
  --label "input.modalities=text,image" \
  --out <state> --json

RAREXT_GATEWAY_TOKEN=… node apps/runtime/src/cli.ts serve \
  --manifest <state>/deployment.json --state <state> --port 0
```

`serve` refuses a deployment that does not verify against its own challenge, so
the gateway only ever ran the committed bytes.

## Results

### 1. Text run through the gateway

`POST /v1/chat/completions` → HTTP 200 in 1.44 s, content `"Paris"`,
usage `{completion_tokens: 1, prompt_tokens: 10, total_tokens: 72}`.

Run headers (the gateway cannot fabricate these; they bind the run to the
committed deployment):

```
x-rarext-deployment: 3a261bd966e492151ea112de4bba21d4b34f2a39ca6069321eb64573d4db381e
x-rarext-model:      models/gemini-3-flash-preview
x-rarext-placement:  remote
x-rarext-run:        2d60a3fd0af2ec161175315ffe5df585adedc9644904c8529748d428515e31d2
```

### 2. Image pass-through (the vision path, live)

A 32×32 teal PNG, base64, sent as an OpenAI `image_url` part **through the
gateway**. The deployment's committed labels declare `input.modalities=text,image`,
so the gateway forwards the part instead of refusing it (the refusal is
reserved for weight-backed deployments with no vision tower).

→ HTTP 200 in 2.96 s, content **`"Teal"`**, run
`be9a9bd334a132b3454c479d32763881329e8d68227318bbef704e041649c948`.
The model read the actual image bytes — the upstream answered about the image,
not the text around it.

### 3. Independent verification

Both recorded transcripts verify against the deployment's challenge with the
runtime's own checker:

```console
$ node apps/runtime/src/cli.ts verify --transcript run-1.json --challenge challenge.json
PASS — 20 checks, transcript 2d60a3fd0af2ec16…
$ node apps/runtime/src/cli.ts verify --transcript run-2.json --challenge challenge.json
PASS — 20 checks, transcript be9a9bd334a132b3…
```

## Files

| file | what it is |
|---|---|
| `deployment.json` | the committed remote Google deployment (endpoint, model, `input.modalities` label, digest) |
| `challenge.json` | the deployment's model challenge |
| `run-1.json` | the recorded text run (exact request, response, provider receipt side) |
| `run-2.json` | the recorded image pass-through run |
| `deployment-nvidia-images.json` | the committed NVIDIA-hub deployment for `agnes-image-2.5-flash` |
| `images-generations-response.json` | the gateway-relayed images API response (the generated URL) |
| `generated-teal-square.png` | the image the upstream generated, fetched through that URL (1024×1024 PNG) |

## Reproduce

Any OpenAI-compatible brand endpoint works the same way (xAI, DeepSeek,
Mistral, NVIDIA NIM, Google's compat surface). Deploy, serve, ask; the run
digest in the response headers is the one to verify. A key is required and is
the caller's own.

## Honest scope

- This proves the FORWARDING path and the verification of its records against
  a live brand endpoint. It does not make RAREXT's engine multimodal: the
  image was read by the UPSTREAM, exactly as the capabilities string states.
- Gemini-3 "thinking" consumed a 60-token budget before emitting visible text
  (an empty `content` with `finish_reason: length`); the probe raises the
  budget. Recorded here because it is the kind of upstream behavior a
  forwarding gateway surfaces honestly instead of papering over.
- Gemini-2.5-flash is retired for new Google users; the deployment pins
  `models/gemini-3-flash-preview`, and a retired model is refused by the
  upstream with its own error (observed live before the re-pin).
