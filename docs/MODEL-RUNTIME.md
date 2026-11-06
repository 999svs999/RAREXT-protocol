# AI lives on RAREXT: deploying a model and proving what it said

RAREXT verifies builds by recomputation. The AI verification layer already
covers three representation kinds — `exact` bytes, `generative` replay from a
committed model and seed, and `bounded` reconstructions against a committed
reference ([AI-VERIFICATION.md](AI-VERIFICATION.md)). What was missing was the
other half of "AI lives on RAREXT": **the model actually running somewhere, and
its output arriving as a record rather than a screenshot.**

This document describes `apps/runtime`, the deployment and attestation control
plane. It does not ship another inference kernel. It treats an existing local
engine as the kernel and adds:

1. a **deployment commitment** — engine, model, quantization, weight digest,
   hardware, and the challenge that names them;
2. an **attested gateway** — OpenAI- and Anthropic-compatible endpoints that
   forward inference and record the exact request/response transcript;
3. an **append-only ledger** — each run links to the previous one by digest, so
   a removed or reordered record is visible offline;
4. a **registry verifier** — recomputes every digest in the transcript and
   checks it against the deployment the challenge committed;
5. a **replay check** — when the caller asked for deterministic decoding, a
   holder of the same weights re-runs the request and compares the output.

The one-command proof is:

```bash
npm run demo:model-runtime
```

## Why these two engines are the reference

[Strata](https://github.com/Niko1221/Strata) and
[FreeToken](https://github.com/FlashML-org/FreeToken) solve the part RAREXT
should not re-solve: getting frontier open-weight models onto consumer hardware
and exposing a local API.

| | Strata | FreeToken | What RAREXT adds |
| --- | --- | --- | --- |
| Job | One-click local inference engine | Edge-native MoE serving engine | Deployment commitment + verifiable output |
| Surface | OpenAI and Anthropic APIs on localhost | OpenAI and Anthropic-compatible APIs | The same surface, plus transcript headers and a run ledger |
| Models | Qwen3.8-Flash-Next, Qwen3.6-35B-A3B, DeepSeekV4.1-Flash | DeepSeek-V4-Flash, Qwen3.6-35B-A3B, GLM-5.2 and other MoE models | An engine-agnostic manifest that names whichever model you run |
| Hardware | RTX 20/30/40/50, Radeon, Intel Arc, Apple Silicon, Strix Halo, DGX Spark | RTX 30/40/50, laptops and workstations | Hardware recorded in the manifest; no GPU claim invented by the protocol |
| Formats | GGUF-family quantizations | MXFP4, NVFP4, FP8, BF16, GGUF | The engine's own digest/quantization labels, or an honest `null` |
| Install | Desktop, terminal `strata launch`, Docker | Desktop, `uv pip install "freetoken[accel]"` | `rarext-runtime deploy` + `serve` |

Both projects are engines. RAREXT is the record. A user can keep using either
engine's desktop app or CLI; `rarext-runtime` points at its endpoint and wraps
it.

## Architecture

```
              client (OpenCode, Claude Code, curl, an agent)
                                  |
                    OpenAI /v1/chat/completions
                    Anthropic /v1/messages
                                  |
                    +-------------v--------------+
                    |   rarext-runtime gateway   |
                    |  forward + record + sign   |
                    +------+--------------+------+
                           |              |
             exact bytes   |              |  signed publication
                           v              v
                 +---------+----+   +-----+-------------+
                 | local ledger |   |  RAREXT registry  |
                 |  runs.jsonl  |   | challenge + HTTP  |
                 | hash-chained |   | verifier + anchor |
                 +--------------+   +-------------------+
                           |
                           | replay (temperature 0 + seed)
                           v
                    +------+-------+
                    |    engine    |
                    | Ollama/Strata|
                    |  /FreeToken  |
                    +--------------+
```

The gateway is in the request path but not in the model's way: if publishing
fails, the completion still returns, the local ledger still has the record, and
the response headers say what happened.

## The deployment commitment

`rarext-runtime deploy` probes the engine and writes three files:

- `deployment.json` — the manifest plus its `digest`;
- `challenges.json` — one challenge whose spec commits that digest and the
  model's weight digest;
- `verifiers.json` — the external-verifier config a registry loads.

A manifest looks like this (abridged from the demo):

```json
{
  "kind": "rarext.model-deployment.v1",
  "id": "qwen2-5-0-5b-ollama",
  "engine": { "name": "ollama", "version": "0.23.2", "endpoint": "http://127.0.0.1:11434" },
  "model": {
    "id": "qwen2.5:0.5b",
    "family": "qwen2",
    "parameters": "494.03M",
    "quantization": "Q4_K_M",
    "format": "gguf",
    "sizeBytes": 397821319,
    "weightsDigest": "sha256:a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67",
    "contextLength": null
  },
  "hardware": { "backend": "cpu", "device": "host CPU", "memoryBytes": 17179869184, "os": "darwin 24.6.0", "arch": "x64" },
  "apis": ["openai", "anthropic"],
  "createdAt": "2026-11-06T00:00:00.000Z",
  "digest": "<sha256 over the canonical manifest>"
}
```

`digest` is `sha256(canonicalize(manifest))`. Two operators who run the same
engine, model, quantization, and weight digest get the same commitment; a
different weight digest is a different deployment, by construction. If an engine
does not expose a weight digest, the field is `null` — never a fabricated hash.

The manifest is also published as an `ai.model-deployment` artifact — a model
card on RAREXT. It shares the run challenge, so the verifier recomputes the
deployment digest and checks the model, weights, engine, and hardware against the
same commitment every run cites. `rarext-runtime publish-deployment` publishes
it; the demo publishes the card before serving.

The challenge spec is what binds publications to the deployment:

```json
{
  "deploymentDigest": "<manifest digest>",
  "modelId": "qwen2.5:0.5b",
  "weightsDigest": "sha256:a8b0...c67",
  "engine": "ollama"
}
```

## The run transcript

Every completion becomes a `rarext.model-run.v1` body:

```json
{
  "kind": "rarext.model-run.v1",
  "deployment": { "id": "qwen2-5-0-5b-ollama", "digest": "<deployment digest>" },
  "model": { "id": "qwen2.5:0.5b", "weightsDigest": "sha256:a8b0...c67" },
  "engine": { "name": "ollama", "version": "0.23.2" },
  "request": { "body": { "...": "the exact upstream request" }, "digest": "<sha256>", "bytes": 123 },
  "response": { "body": { "...": "the exact upstream response" }, "digest": "<sha256>", "bytes": 306, "text": "...", "textDigest": "<sha256>" },
  "sampling": { "temperature": 0, "topP": null, "seed": 42, "maxTokens": 32, "stream": false },
  "usage": { "promptTokens": 38, "completionTokens": 7, "totalTokens": 45 },
  "startedAt": "...",
  "completedAt": "...",
  "previous": "<digest of the previous run record, or null>",
  "replay": { "api": "openai", "endpoint": "http://127.0.0.1:11434", "request": { "...": "..." }, "params": { "...": "..." } }
}
```

The record digest is `sha256(canonicalize(body))`. The registry verifier
recomputes:

- the request digest and byte length from the request body;
- the response digest and byte length from the response body;
- the assistant text and its digest from the response body;
- the deployment, model, weight, and engine identity against the challenge;
- timestamps, sampling ranges, usage counts, and the shape of the `previous` link;
- that the replay envelope, when present, names a usable endpoint and request;
- the throughput implied by the committed interval and completion count, so the
  number is derived from the record rather than trusted from a log line.

It does **not** re-run a 290B model on the registry, and the attestation does not
pretend it did. What it attests is the representation kind `exact`: these bytes,
this deployment, this chain. The `replay` phase is the separate, local check a
holder of the weights performs.

## Quickstart

### 1. Plan what fits

Before pulling weights or committing a deployment, ask the engine and the host
what they can hold:

```bash
node apps/runtime/src/cli.ts plan --endpoint http://127.0.0.1:11434
```

`plan` lists every model the engine advertises, its quantization and weight
size, and a `fits` / `tight` / `too-large` / `unknown` verdict against host
memory. The reserve defaults to the larger of 1 GiB and 15% of memory. This is a
host-memory claim, not a VRAM claim: a discrete GPU may hold another copy, and an
engine such as Strata can stream weights from disk when they do not fit, so the
verdict is advisory. `unknown` is what it prints when the engine or the host
reports no size — it never guesses.

### 2. Deploy (probe a running engine)

```bash
# Ollama (what the demo uses). --pull fetches the model if the engine does
# not already advertise it, then commits the digest the engine reports.
node apps/runtime/src/cli.ts deploy \
  --endpoint http://127.0.0.1:11434 \
  --model qwen2.5:0.5b \
  --pull \
  --backend cpu \
  --out .rarext-runtime

# Strata (point at the localhost port it prints)
node apps/runtime/src/cli.ts deploy --engine strata --endpoint http://127.0.0.1:8000 --model <model-id> --backend cuda

# FreeToken (same OpenAI surface)
node apps/runtime/src/cli.ts deploy --engine freetoken --endpoint http://127.0.0.1:30000 --model <model-id> --backend cuda
```

`--engine` is a label, not a protocol switch: Strata, FreeToken, Ollama, and any
other OpenAI-compatible server are probed through `/v1/models` (Ollama also
through `/api/tags`). If you omit `--model` and the engine advertises more than
one model, the command refuses and lists them rather than guessing.

### Getting the weights

`deploy --pull` closes the gap between "an engine is running" and "the model is
here": it speaks Ollama's streaming `/api/pull`, prints the engine's own progress
lines, and then re-probes `/api/tags` so the manifest records the digest of the
bytes now on disk — never a digest inferred from download events. If the model
is already advertised, the pull is skipped.

Strata and FreeToken ship their own installers and downloaders (`strata launch`,
the FreeToken desktop app or CLI). Let them put the weights on the machine,
start their OpenAI-compatible server, and run `deploy` without `--pull`; the
runtime does not invent a download endpoint for an engine that already has one.

### 3. Start the verifier and a registry

```bash
node apps/runtime/src/cli.ts verifier --port 8788

RAREXT_CHALLENGES=.rarext-runtime/challenges.json \
RAREXT_VERIFIERS=.rarext-runtime/verifiers.json \
node apps/api/src/server.ts
```

### 4. Serve the attested gateway

```bash
node apps/runtime/src/cli.ts serve \
  --manifest .rarext-runtime/deployment.json \
  --state .rarext-runtime \
  --publish \
  --registry http://127.0.0.1:8787
```

The gateway listens on `127.0.0.1:8790` by default:

- `POST /v1/chat/completions` — OpenAI, including streaming (SSE is teed to the
  client and recorded);
- `POST /v1/messages` — Anthropic Messages, translated to the OpenAI surface
  (non-streaming; streaming Anthropic is refused before inference);
- `GET /v1/models`, `GET /v1/deployment`, `GET /health`;
- `GET /v1/rarext/runs`, `GET /v1/rarext/runs/:digest`,
  `GET /v1/rarext/ledger`.

Point OpenCode, Claude Code, or any OpenAI client at
`http://127.0.0.1:8790/v1`. Every response carries:

```
x-rarext-deployment: <manifest digest>
x-rarext-run:        <run record digest>
x-rarext-publication:<publication id, when --publish is on>
x-rarext-attested:   true|false
```

### 5. Publish the deployment card

```bash
node apps/runtime/src/cli.ts publish-deployment \
  --manifest .rarext-runtime/deployment.json \
  --state .rarext-runtime \
  --registry http://127.0.0.1:8787
```

This publishes the manifest under the same challenge as its runs. The card
names the engine, model, quantization, weight digest, and hardware; the
registry's verifier recomputes the digest and refuses a card that does not match
the challenge. It is optional — a deployment can serve and publish runs without
a card — but a reader then has the runs' deployment digest without the manifest
that explains it.

### 6. Verify and replay without the server

```bash
node apps/runtime/src/cli.ts verify \
  --transcript .rarext-runtime/runs.jsonl \
  --challenge .rarext-runtime/challenges.json

node apps/runtime/src/cli.ts replay \
  --transcript .rarext-runtime/runs.jsonl \
  --endpoint http://127.0.0.1:11434

node apps/runtime/src/cli.ts ledger \
  --state .rarext-runtime \
  --challenge .rarext-runtime/challenges.json
```

`verify` recomputes the transcript offline. `replay` re-sends the committed
request to the live engine and compares the output byte for byte; it only exists
when the run was made with `temperature: 0` **and** an explicit `seed`. `ledger`
recomputes the chain; with `--challenge` it also verifies every run against the
deployment, so a ledger that mixes two models fails even when its chain is
intact.

## What the demo proves

The demo was run on a Mac with Ollama `0.23.2` and `qwen2.5:0.5b` (Q4_K_M,
`sha256:a8b0…c67`):

```
[PASS] plan — qwen2.5:0.5b (Q4_K_M): fits — weights leave 6.4 GiB after a 1.2 GiB reserve
[PASS] probe — ollama 0.23.2 serving qwen2.5:0.5b (Q4_K_M), deployment b03dbe76ee0aca2a…
[PASS] verifier — refuses a bodyless artifact and names representation exact
[PASS] registry — loaded model-run-b03dbe76ee0aca2a (app ai-model-run)
[PASS] infer — qwen2.5:0.5b answered in 775ms: "AI lives on RAREXT" (run d105c21041bc…)
[PASS] publish — publication 20b2b60b… attested exact; body hashes to d105c21041bc…
[PASS] deployment — manifest b03dbe76ee0a… published as 13d37bf4… and attested exact
[PASS] anchor — bundle leafVersion 4; root ab8c31a2151c10ef… covers 20b2b60b… and 13d37bf4…; run body re-hashes to d105c21041bc…
[PASS] recompute — 16 checks pass; transcript d105c21041bc…; 9.2 tok/s over 764 ms
[PASS] replay — output reproduced byte for byte (18 chars)
[PASS] ledger — 1 record(s), head d105c21041bc6ab7…

DEMO PASSED: plan -> probe -> verifier -> registry -> deployment -> infer -> publish -> anchor -> recompute -> replay -> ledger, 11/11 phases verified. AI lives on RAREXT.
```

It writes `deployment.json`, `challenge.json`, `run.json`, `bundle.json`, and
`verification.json` to `.ai-proof/model-runtime/` (gitignored) with a README
that names the run and the command to re-check it offline.

## Deploying for real

The runtime is a normal Node process with no native dependencies. Run it under
the supervisor you already use:

- **macOS** — `examples/model-runtime/launchd/com.rarext.runtime.plist.template`
- **Linux** — `examples/model-runtime/systemd/rarext-runtime.service`
- **Docker** — `examples/model-runtime/docker-compose.yml` (Ollama + runtime)

Keep the engine and the runtime on the same host: the endpoint is a loopback
address, and the ledger is local by design.

## Privacy and safety

- Publishing is **opt-in** (`--publish`). Without it, transcripts stay in the
  local ledger.
- A published transcript includes the prompt and the response. Do not publish
  runs that contain secrets, private code, or personal data; use the local
  ledger for those.
- The runtime's signing key is created once at
  `<state>/runtime-identity.json` with mode `0600`. It is the runtime's identity,
  not the model's.
- A weight digest is only as trustworthy as the engine that reports it. RAREXT
  records `null` when the engine has none, rather than implying a check it did
  not perform.
- Exact transcripts prove integrity and provenance of the record. They do not
  prove the model is correct, safe, or unbiased. Replay proves reproducibility
  only under the same weights and deterministic settings.

## Limits in this version

- Anthropic streaming is refused (`stream:false` required); OpenAI streaming is
  supported and recorded as an SSE transcript.
- `--pull` is Ollama-only. Strata, FreeToken, and other engines keep their own
  installers; the runtime commits the model they serve rather than reimplementing
  their downloaders.
- Replay covers the OpenAI surface. An engine that changes its sampler between
  versions can fail a replay even with the same weights; the transcript records
  the engine version so the failure is explainable.
- One deployment per manifest. A multi-model engine gets one manifest and one
  challenge per model, which is the intended shape: the weights, not the
  process, are the subject.
- The registry's verifier checks the transcript, not the tensor math. Full
  generative replay for large models is the next representation class — the
  transcript is the commitment it will build on.

## Tests

```bash
npm run test:runtime      # 31 unit/integration tests, no model needed
npm run demo:model-runtime
```

The unit tests use mock engine streams and cover: manifest digest stability,
field validation, endpoint normalisation, transcript verification, every
tamperable field, cross-deployment refusal, ledger chaining and tamper
detection, ledger auditing against a challenge, deployment-card verification
and challenge mismatch, OpenAI and Anthropic surfaces, streaming teeing,
model-mismatch refusal, the refusal of unattested Anthropic streaming,
memory-fit planning, derived throughput, and Ollama's streaming pull (progress,
error events, non-2xx answers, and the re-probe that supplies the digest).
