# @rarext/runtime

Deploy a large model — on hardware you own or at a remote provider — then
publish every inference as a RAREXT-verifiable exact transcript.

The runtime is a control plane, not another inference kernel. It wraps an
OpenAI-compatible engine ([Ollama](https://ollama.com),
[Strata](https://github.com/Niko1221/Strata),
[FreeToken](https://github.com/FlashML-org/FreeToken), or anything else) or
forwards to a remote OpenAI/Anthropic-compatible endpoint. It adds a deployment
commitment, an attested gateway, a hash-chained local ledger, and a registry
verifier. In a remote deployment it holds no weights, downloads no model files,
and runs no inference.

Full guides: [`docs/MODEL-RUNTIME.md`](../../docs/MODEL-RUNTIME.md) and
[`docs/CLOUD-RUNTIME.md`](../../docs/CLOUD-RUNTIME.md).

```bash
# 0. see which models the engine has and whether they fit this host's memory
node apps/runtime/src/cli.ts plan --endpoint http://127.0.0.1:11434

# 1. probe the engine and write deployment.json / challenges.json / verifiers.json
#    (--pull fetches a missing Ollama model first, then commits its digest)
node apps/runtime/src/cli.ts deploy --endpoint http://127.0.0.1:11434 --model qwen2.5:0.5b --pull

# 2. run the verifier and a registry that loads the challenge
node apps/runtime/src/cli.ts verifier --port 8788
RAREXT_CHALLENGES=.rarext-runtime/challenges.json \
RAREXT_VERIFIERS=.rarext-runtime/verifiers.json \
node apps/api/src/server.ts

# 3. publish the deployment commitment as a model card, then anchor it
node apps/runtime/src/cli.ts publish-deployment \
  --manifest .rarext-runtime/deployment.json \
  --registry http://127.0.0.1:8787 \
  --anchor

# 4. serve and publish runs
node apps/runtime/src/cli.ts serve --manifest .rarext-runtime/deployment.json --publish

# 5. verify, audit, and replay offline
node apps/runtime/src/cli.ts verify --transcript .rarext-runtime/runs.jsonl --challenge .rarext-runtime/challenges.json
node apps/runtime/src/cli.ts ledger --state .rarext-runtime --challenge .rarext-runtime/challenges.json
node apps/runtime/src/cli.ts replay --transcript .rarext-runtime/runs.jsonl --endpoint http://127.0.0.1:11434
```

Cloud-only, no local weights or inference:

```bash
# commit a remote endpoint; --pull is refused and loopback needs --allow-loopback
node apps/runtime/src/cli.ts deploy --remote \
  --endpoint https://api.provider.example \
  --engine openai-compatible \
  --upstream-api openai \
  --model <provider-model-id>

# or serve a card already published to RAREXT, with no local deployment file
node apps/runtime/src/cli.ts serve \
  --registry https://registry.example.com \
  --deployment <verified-deployment-digest> \
  --host 0.0.0.0 \
  --public-url https://ai.example.com \
  --publish

# anchor pending publications
node apps/runtime/src/cli.ts anchor --registry https://registry.example.com
```

The end-to-end local proof is `npm run demo:model-runtime`, the cloud proof is
`npm run demo:cloud-runtime`, and the tests are `npm run test:runtime`.

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
