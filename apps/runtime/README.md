# @rarext/runtime

Deploy a large model — on hardware you own, at a remote provider, or as
content-addressed RAREXT artifacts — then publish every inference as a
RAREXT-verifiable exact transcript.

The runtime is a control plane, not another inference kernel. It wraps an
OpenAI-compatible engine ([Ollama](https://ollama.com),
[Strata](https://github.com/Niko1221/Strata),
[FreeToken](https://github.com/FlashML-org/FreeToken), or anything else) or
forwards to a remote OpenAI/Anthropic-compatible endpoint. It adds a deployment
commitment, an attested gateway, a hash-chained local ledger, and a registry
verifier. In a remote deployment it holds no weights, downloads no model files,
and runs no inference. In a **storage-native** (`web4`) deployment the weights
**and the engine** are sharded RAREXT blobs: a provider fetches, verifies, and
runs both, and the asking machine runs nothing.

Full guides: [`docs/MODEL-RUNTIME.md`](../../docs/MODEL-RUNTIME.md),
[`docs/WEB4-MODEL.md`](../../docs/WEB4-MODEL.md), and
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

Storage-native: the weights and the engine are RAREXT artifacts, and a provider
fetches and verifies both before serving. A GGUF or RAREXT-native `RXHF`
container defaults to RAREXT's own engine and commits it into the bundle.

```bash
# shard the weights + engine into RAREXT and commit execution.artifact
node apps/runtime/src/cli.ts bundle --file model.gguf --model qwen2.5:0.5b \
  --registry http://127.0.0.1:8787 --out model-bundle.json

# a provider with no host engine: it fetches the bundle, verifies every shard and
# the engine artifact, then runs the committed engine over the committed weights
node apps/runtime/src/cli.ts provider --bundle model-bundle.json --registry http://127.0.0.1:8787
```

A deployment can declare the generation it serves under — a declared rung of
`rarext.generations.v1` that is folded into the manifest digest, so a run records
it and a reader recomputes it (see [`docs/GENERATIONS.md`](../../docs/GENERATIONS.md)):

```bash
node apps/runtime/src/cli.ts deploy --endpoint http://127.0.0.1:11434 \
  --model qwen2.5:0.5b --generation network=5G,model=1G,web=web4,protocol=gen-4
```

An undeclared id is refused (`parseGenerationSpec` / `validateDeployment`), so a
typo cannot be folded silently into a digest.

The end-to-end local proof is `npm run demo:model-runtime`, the cloud proof is
`npm run demo:cloud-runtime`, the storage-native proof is
`npm run demo:web4-model` (and `npm run demo:ai-on-rarext` for a portable engine
with no host engine at all), and the tests are `npm run test:runtime`.

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
