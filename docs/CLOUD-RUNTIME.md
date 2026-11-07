# AI lives in the cloud on RAREXT

The model runtime has two placements. `local` probes an engine on the machine
that runs the gateway. `remote` commits an OpenAI- or Anthropic-compatible
endpoint somewhere else and forwards every request to it. In a remote
deployment the runtime holds **no weights**, downloads **no model files**, and
runs **no inference**; it is the control plane that records and publishes what
the cloud engine said.

The deployment identity does not change between placements. It is still
`sha256(canonicalize(manifest))`, and the challenge still commits the deployment
digest, model id, weight digest (when the provider reports one), and engine. A
run made against a cloud deployment verifies with the same verifier, over the
same bytes, as a run made against a local one.

```bash
npm run demo:cloud-runtime
```

runs the whole path with no Ollama and no local model file:
`target -> plan -> deploy -> verifier -> registry -> card -> serve -> infer ->
publish -> weights -> anchor -> discover -> catalog -> adopt -> recompute ->
ledger`. Without a provider it uses a deterministic remote *fixture* on loopback
and says so; set the variables below to run the same commands against a real
provider.

## What is local, and what is not

| Piece | Local deployment | Remote deployment |
| --- | --- | --- |
| Weights | on this host | at the provider; never downloaded here |
| Inference | this host's engine | the provider's server |
| Gateway / control plane | this host | this host or a cloud container |
| Manifest memory field | host memory | `null` — the local host is irrelevant |
| `plan` | fits / tight / too-large against host memory | lists remote models; makes no host-memory claim |
| `--pull` | Ollama only | refused |
| Ledger, signing key, verifier | this host | this host or the cloud container |

`placement: "remote"` is part of the signed manifest, so a reader can see the
claim. The verifier checks it: a remote card must name `hardware.backend:
"cloud"` and `hardware.memoryBytes: null`, so a manifest cannot say "remote"
while recording a local fit it did not perform.

## Deploy against a provider

The provider must expose an OpenAI-compatible `/v1/models` and
`/v1/chat/completions`, or an Anthropic-compatible `/v1/models` and
`/v1/messages`. Keys stay in the environment; they are never written into the
manifest or the transcript.

```bash
export RAREXT_UPSTREAM_API_KEY='...'

node apps/runtime/src/cli.ts deploy \
  --remote \
  --endpoint https://api.provider.example \
  --engine openai-compatible \
  --upstream-api openai \
  --model <provider-model-id> \
  --out .rarext-runtime
```

Anthropic-compatible provider:

```bash
export RAREXT_UPSTREAM_API_KEY='...'

node apps/runtime/src/cli.ts deploy \
  --remote \
  --endpoint https://api.anthropic.example \
  --engine anthropic \
  --upstream-api anthropic \
  --upstream-auth x-api-key \
  --model <provider-model-id> \
  --out .rarext-runtime
```

The CLI refuses `--pull` in remote mode. It also refuses a loopback endpoint
unless `--allow-loopback` is passed, so a local engine cannot be published as a
cloud deployment by accident; the flag exists for test fixtures. A loopback
deployment is labeled `fixture: "loopback"`, and the verifier accepts a remote
card with a loopback endpoint only when that label is present — a real cloud
card cannot quietly point at the publisher's own machine.

What the command writes:

```json
{
  "kind": "rarext.model-deployment.v1",
  "id": "<model>-openai-compatible",
  "placement": "remote",
  "engine": { "name": "openai-compatible", "version": "2026-11", "endpoint": "https://api.provider.example" },
  "model": {
    "id": "<provider-model-id>",
    "quantization": null,
    "weightsDigest": null,
    "sizeBytes": null
  },
  "hardware": { "backend": "cloud", "device": "api.provider.example", "memoryBytes": null, "os": "remote", "arch": "remote" },
  "apis": ["openai", "anthropic"],
  "createdAt": "...",
  "digest": "<sha256 over the canonical manifest>"
}
```

`weightsDigest` is whatever the provider reports through its model listing; it
is `null` when the provider exposes none. That is an honest absence, not a
fabricated hash. The digest is still the identity of the deployment: the
endpoint, model id, and any provider-reported weight digest are all committed.

`plan --remote` lists the models without comparing them to this host's memory:

```bash
node apps/runtime/src/cli.ts plan --remote --endpoint https://api.provider.example --model <id>
```

## Serve from the cloud

The gateway is a normal Node process and can run in a container, a VM, or a
serverless host. Bind it to the interface the platform routes to, and tell it
the public URL clients should use:

```bash
export RAREXT_UPSTREAM_API_KEY='...'
export RAREXT_GATEWAY_TOKEN='...'       # clients send Authorization: Bearer ...

node apps/runtime/src/cli.ts serve \
  --manifest .rarext-runtime/deployment.json \
  --host 0.0.0.0 \
  --port 8790 \
  --public-url https://ai.example.com \
  --publish \
  --registry https://registry.example.com
```

- `RAREXT_GATEWAY_TOKEN` protects inference and the local run ledger. `/health`,
  `/v1/deployment`, and `/v1/models` stay readable so a deployment can be
  discovered like a model card.
- `RAREXT_UPSTREAM_API_KEY` is sent to the provider. The client's bearer token
  is never forwarded upstream.
- The upstream shape is committed in the manifest as `labels.upstreamApi` and
  `labels.upstreamAuth`, so `serve` forwards the same way `deploy` probed
  without repeating `--upstream-api` or `--upstream-auth`. Only the auth mode is
  recorded; the key still comes from the environment. An explicit flag still
  wins if an operator needs to override it.
- Before binding, `serve` recomputes the manifest with the same verifier used
  for published cards. A stale digest, a remote manifest with local memory, or
  a remote manifest pointing at loopback without the `fixture: "loopback"` label
  is refused instead of served.
- `--public-url` is what the gateway prints and returns; without it, a bind to
  `0.0.0.0` would advertise an address nobody can dial.
- TLS belongs at the edge. Terminate HTTPS in a reverse proxy (Caddy, nginx, a
  cloud load balancer) and forward to the gateway on the private network. The
  gateway itself speaks HTTP and records the exact bytes it received from the
  provider, not the proxy's framing.

A minimal Caddy front door:

```caddyfile
ai.example.com {
  reverse_proxy 127.0.0.1:8790
}
```

The runtime's default bind stays `127.0.0.1`; publishing a port is an explicit
operator choice, not a default.

## Publish and discover

The deployment card and its runs are published to a RAREXT registry exactly as
in a local deployment:

```bash
# publish the card and anchor it in one step
node apps/runtime/src/cli.ts publish-deployment \
  --manifest .rarext-runtime/deployment.json \
  --registry https://registry.example.com \
  --anchor

# serve with --publish, then anchor the runs and build a mirror
node apps/runtime/src/cli.ts anchor --registry https://registry.example.com
npm run mirror:build
```

The registry must know the challenge before it can attest. `deploy` writes
`challenges.json`; point the registry's `RAREXT_CHALLENGES` at that file, or
sponsor the challenge through the registry's own process. This is the one piece
the runtime cannot upload for you.

A reader who does not trust the registry verifies the same evidence offline:

```bash
# read the latest anchored bundle from a registry
node apps/runtime/src/cli.ts discover --registry https://registry.example.com

# or verify a bundle someone handed you, with no server at all
node apps/runtime/src/cli.ts discover --bundle .ai-proof/cloud-runtime/bundle.json
```

`discover` recomputes every `ai.model-deployment` card and every `ai.model-run`
transcript against the challenge carried in the same bundle. It reports the
bundle root and leaf version, prints a `remote` placement for cloud cards, and
exits non-zero if a single byte was edited after publication. A card's own
attestation is shown, but never trusted: the recomputation is the verdict.

## Find a cloud model on RAREXT

`plan` can read its catalog from RAREXT instead of probing a provider:

```bash
node apps/runtime/src/cli.ts plan --registry https://registry.example.com
node apps/runtime/src/cli.ts plan --bundle bundle.json --json
```

It lists each verified remote card's deployment id, digest, model, engine, and
endpoint. It makes no host-memory claim and contacts no engine; the endpoint is
the one the card commits.

## Serve from a verified card

A second control plane does not need to re-deploy. Point it at the registry's
anchored bundle, or at a bundle file, and name the deployment:

```bash
node apps/runtime/src/cli.ts serve \
  --registry https://registry.example.com \
  --deployment <deployment-digest-or-id> \
  --host 0.0.0.0 \
  --public-url https://ai.example.com \
  --publish

# offline, from a bundle someone handed you
node apps/runtime/src/cli.ts serve \
  --bundle .ai-proof/cloud-runtime/bundle.json \
  --deployment <deployment-digest>
```

`serve` fetches the latest anchored bundle, recomputes the model card with the
same `discoverBundle` rule, and refuses one that does not verify or does not
commit `placement: "remote"`. It then forwards to the endpoint the card
commits, using the upstream shape recorded in the card's labels and the key in
the environment. No `deployment.json`, no weights, and no model server are
needed on this host.

The endpoint is part of what the card commits. Choose a card from a registry
you trust before pointing your provider key at it; passing the deployment
digest pins the exact manifest you verified.

`examples/model-runtime/cloud/compose.adopt.yml` is the container form of this:
it runs only the control plane, takes `RAREXT_DEPLOYMENT` and
`RAREXT_REGISTRY_URL`, and has no deploy service or local `deployment.json`.

## The Web4 path

The remote runtime does not need a new network primitive; it uses the one
RAREXT already has:

1. **Identity** — the runtime's ECDSA-P256 key signs the card and the runs.
2. **Write** — the card and runs go to any registry that accepts signed
   publications. The registry is an index, not the model.
3. **Anchor** — `POST /v1/anchors` freezes the pending publications into a
   Merkle root. The root is the receipt a client can carry.
4. **Mirror** — `npm run mirror:build` writes the anchored bundle, the seed, and
   browser-verifiable pages. A mirror serves the evidence after the registry is
   gone; `npm run test:takedown` is the acceptance test.
5. **Discover** — a client reads a seed, verifies the bundle against the pinned
   root, and runs `discoverBundle` (or the SDK's `findVerifiedBundle` and
   `replayBundleAi`) with no registry and no model server.
6. **Verify** — the card and run carry the exact bytes, digests, deployment
   challenge, and, when the caller asked for deterministic decoding, a replay
   envelope. A holder of the same remote model can replay it; a reader without
   the weights still recomputes every digest.
7. **Adopt** — another control plane serves the verified card straight from the
   bundle (`serve --deployment … --registry …`), so the model's location comes
   from RAREXT rather than from a fresh local deployment.

The only thing the cloud adds is that the compute sits behind step 1's
endpoint instead of on the reader's machine. The evidence path is unchanged.

## What the demo proves, and what it does not

With a real `RAREXT_CLOUD_ENDPOINT`, the demo proves:

- the CLI probed the remote endpoint and committed `placement: "remote"`;
- the gateway forwarded the request with the operator's key and a client token
  of its own;
- the registry attested the card and the run as `exact`;
- the anchored bundle carries both, and `discover` recomputes them offline;
- `plan --registry` lists the card and the endpoint it commits, with no
  provider probe and no host-memory claim;
- the CLI adopts the verified card from the bundle alone and forwards a
  completion, with no local `deployment.json`;
- no `.gguf`, `.safetensors`, `.bin`, `.pt`, `.pth`, or `.onnx` file exists in
  the runtime state.

It does not prove the provider ran the model it claims, that the weights match
a public digest when the provider reports none, or that the model is correct.
Those are provider-trust questions; the runtime records what it can check and
says `null` where it cannot.

## Limits

- The OpenAI-shaped client surface requires an OpenAI-compatible upstream. An
  Anthropic-native upstream serves `/v1/messages`; an OpenAI request to it is
  refused with `501` rather than translated silently.
- Anthropic streaming is still not attested; OpenAI SSE is.
- Replay is available only when the client asks for deterministic decoding
  (`temperature: 0` plus a seed). Anthropic Messages has no seed field, so an
  Anthropic-native run is exact and hash-linked but not replayable.
- A remote provider may change the model behind a stable id. The manifest
  commits the id and whatever weight digest the provider reports; a provider
  that reports neither can be recorded but not pinned to bytes.
- The gateway token is optional. A public deployment should set it, and should
  put TLS in front of the gateway.

## Tests

```bash
npm run test:runtime       # manifest, transcript, gateway, cloud, discovery
npm run demo:cloud-runtime # remote fixture, no local engine
npm run demo:model-runtime # local Ollama path, still supported
```

The cloud tests cover remote placement validation, auth-header forwarding,
OpenAI and Anthropic probing, the client-token gate, public-URL binding, native
Anthropic forwarding, and offline discovery of an edited run.
