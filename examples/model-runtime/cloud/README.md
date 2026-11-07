# Cloud-only model runtime

This recipe runs the RAREXT model runtime as a cloud control plane. The model
and inference live at a provider endpoint; no service in this directory
downloads weights, starts a local engine, or executes a forward pass.

```
client ──TLS──> Caddy ──> runtime (attested gateway) ──> provider /v1/chat/completions
                              │
                              ├──> RAREXT registry  (publish card + runs)
                              ├──> RAREXT verifier  (recompute transcripts)
                              └──> local append-only ledger + signing key
```

The runtime commits `placement: "remote"` and `hardware.memoryBytes: null`, so
the manifest cannot claim a local fit it did not perform. `deploy` refuses
`--pull` and refuses a loopback endpoint unless the deliberate test-only
`--allow-loopback` flag is set.

## Run it

```bash
cp .env.example .env
# set RAREXT_CLOUD_ENDPOINT, RAREXT_CLOUD_MODEL, RAREXT_UPSTREAM_API_KEY,
# RAREXT_REGISTRY_URL, RAREXT_VERIFIER_URL, RAREXT_PUBLIC_URL, RAREXT_GATEWAY_TOKEN

docker compose -f examples/model-runtime/cloud/compose.yml up --build
```

The `deploy` service writes `/state/deployment.json` and the challenge; the
`runtime` service serves on `0.0.0.0:8790`, publishes the model card and runs,
and prints the public URL. The manifest records the upstream API shape and auth
mode as labels, so the `runtime` service does not repeat them; the key still
comes from `RAREXT_UPSTREAM_API_KEY` in the environment.

The registry must know the challenge before it can attest. Give it the
`/state/challenges.json` that `deploy` wrote (for a RAREXT node, point its
`RAREXT_CHALLENGES` at that file), or sponsor the challenge through the
registry's own process. The runtime cannot upload a challenge for you. Put TLS in front with the optional profile:

```bash
docker compose -f examples/model-runtime/cloud/compose.yml --profile tls up --build
```

`RAREXT_PUBLIC_HOST` must resolve to this host for Caddy to obtain a
certificate. Without the profile, terminate TLS at your cloud load balancer and
forward to `127.0.0.1:8790`.

## Adopt a published card instead of deploying

Once a card is anchored, a second control plane can start from RAREXT evidence
alone. There is no deploy service and no local `deployment.json`:

```bash
# RAREXT_DEPLOYMENT is a verified deployment digest or id
RAREXT_DEPLOYMENT=<digest> \
  docker compose -f examples/model-runtime/cloud/compose.adopt.yml up --build
```

`serve` fetches the latest anchored bundle from `RAREXT_REGISTRY_URL`, recomputes
the card, refuses anything that is not a verified remote deployment, and
forwards to the endpoint the card commits. The provider key and gateway token
still come from the environment.

## Prove the path

From any machine with the bundle:

```bash
node apps/runtime/src/cli.ts discover --registry "$RAREXT_REGISTRY_URL"
node apps/runtime/src/cli.ts discover --bundle bundle.json

# list verified cloud models from the network, without probing a provider
node apps/runtime/src/cli.ts plan --registry "$RAREXT_REGISTRY_URL"
```

`discover` recomputes the model card and every run from the bundle alone. It does
not contact the gateway or the provider, and it exits non-zero if a byte was
edited after publication. `plan --registry` lists the verified remote cards and
the endpoints they commit.

A second control plane can serve the card that bundle proved, with no local
deployment file:

```bash
node apps/runtime/src/cli.ts serve \
  --registry "$RAREXT_REGISTRY_URL" \
  --deployment <deployment-digest-or-id> \
  --host 0.0.0.0 \
  --public-url "$RAREXT_PUBLIC_URL" \
  --publish
```

`serve` fetches the latest anchored bundle, recomputes the card, refuses one
that does not verify or does not commit `placement: "remote"`, and forwards to
the endpoint the card commits. The upstream key still comes from the
environment.

The same path, end to end, without a provider account:

```bash
npm run demo:cloud-runtime
```

The demo uses a deterministic remote fixture when
`RAREXT_CLOUD_ENDPOINT` is unset, states that the fixture is a stand-in, and
still proves there is no local engine and no model file.

## What this does not claim

- The provider's hardware, weights, and model are the provider's claim. The
  manifest records the endpoint, model id, and any weight digest the provider
  reports; `null` is an honest absence.
- TLS and the gateway token protect access to your deployment. They are not a
  proof of the provider's behavior.
- Exact transcripts prove the bytes and the deployment identity. Replay proves
  reproducibility only when the upstream supports `temperature: 0` with a seed
  and the same weights.
