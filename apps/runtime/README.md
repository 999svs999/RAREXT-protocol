# @rarext/runtime

Deploy a large model on hardware you own, then publish every inference as a
RAREXT-verifiable exact transcript.

The runtime is a control plane, not another inference kernel. It wraps an
OpenAI-compatible local engine — [Ollama](https://ollama.com),
[Strata](https://github.com/Niko1221/Strata),
[FreeToken](https://github.com/FlashML-org/FreeToken), or anything else — and
adds a deployment commitment, an attested gateway, a hash-chained local ledger,
and a registry verifier.

Full guide: [`docs/MODEL-RUNTIME.md`](../../docs/MODEL-RUNTIME.md).

```bash
# 1. probe the engine and write deployment.json / challenges.json / verifiers.json
node apps/runtime/src/cli.ts deploy --endpoint http://127.0.0.1:11434 --model qwen2.5:0.5b

# 2. run the verifier and a registry that loads the challenge
node apps/runtime/src/cli.ts verifier --port 8788
RAREXT_CHALLENGES=.rarext-runtime/challenges.json \
RAREXT_VERIFIERS=.rarext-runtime/verifiers.json \
node apps/api/src/server.ts

# 3. serve and publish
node apps/runtime/src/cli.ts serve --manifest .rarext-runtime/deployment.json --publish

# 4. verify and replay offline
node apps/runtime/src/cli.ts verify --transcript .rarext-runtime/runs.jsonl --challenge .rarext-runtime/challenges.json
node apps/runtime/src/cli.ts replay --transcript .rarext-runtime/runs.jsonl --endpoint http://127.0.0.1:11434
```

The end-to-end proof is `npm run demo:model-runtime`; the tests are
`npm run test:runtime`.

## Endpoints

| Route | What it does |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat completions, including SSE streaming |
| `POST /v1/messages` | Anthropic Messages (translated; `stream:false` only) |
| `GET /v1/models` | the committed model |
| `GET /v1/deployment` | the deployment commitment |
| `GET /v1/rarext/runs` | summaries of the local ledger |
| `GET /v1/rarext/runs/:digest` | one full run record |
| `GET /v1/rarext/ledger` | recompute the chain |
| `GET /health` | gateway, deployment, ledger head |
