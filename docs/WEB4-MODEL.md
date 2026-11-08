# The whole model lives on RAREXT

The earlier model runtime could run a model locally or forward to somebody
else's cloud. `placement: "web4"` is the third path: the weights are RAREXT
storage blobs, a **provider node** fetches every shard and verifies the committed
digest before it loads anything, and the runtime commits the bundle so a reader
can check the model bytes instead of trusting a provider name.

There is no OpenAI, no Anthropic, and no model file on the machine asking the
question. The provider is a network participant; the model is content-addressed
data.

```bash
npm run demo:web4-model
```

runs the whole path with a deterministic native model in seconds:
`storage -> 2 providers -> deploy -> registry -> card -> announce -> serve ->
infer -> publish -> compare -> weights -> replay -> anchor -> discover-deploy ->
discover -> tamper -> verify`.

To put a real GGUF through the same path:

```bash
RAREXT_WEB4_GGUF=/path/to/model.gguf \
RAREXT_WEB4_MODEL=qwen2.5:0.5b \
RAREXT_WEB4_ENGINE_MODEL=rarext-web4-qwen \
RAREXT_WEB4_QUANT=Q4_K_M \
RAREXT_WEB4_FAMILY=qwen2 \
npm run demo:web4-model
```

The demo shards the GGUF into RAREXT blobs, starts a provider that fetches and
reassembles them, asks the provider's own Ollama to load the verified file, and
serves real completions. The caller still holds no weights and runs no model.
The reference run stored a 397,807,936-byte `qwen2.5:0.5b` GGUF as 48 blobs and
passed all 13 phases for a real model; the native multi-provider demo passes
16/16.

## What is committed

A model is a **bundle**, not a vendor id:

```json
{
  "kind": "rarext.model-bundle.v1",
  "version": 1,
  "id": "qwen2-5-0-5b",
  "model": {
    "id": "qwen2.5:0.5b",
    "format": "gguf",
    "quantization": "Q4_K_M",
    "sizeBytes": 397807936,
    "weightsDigest": "sha256:c5396e06…"
  },
  "execution": { "kind": "engine", "engine": "ollama", "engineModel": "rarext-web4-qwen" },
  "shards": [{ "index": 0, "hash": "<sha256>", "size": 8388608 }, "…"],
  "totalBytes": 397807936,
  "shardsRoot": "<sha256 over the shard list>",
  "createdAt": "2026-11-07T00:00:00.000Z",
  "digest": "<sha256 over the canonical bundle>"
}
```

Every shard is a normal RAREXT blob (`POST /v1/blobs/raw`), addressed by the
sha256 of its own bytes. The bundle manifest is a blob too, so a reader fetches
the shard list from storage by `manifestHash` rather than trusting the copy a
provider serves. `model.weightsDigest` is the sha256 of the **reassembled file**;
`shardsRoot` commits the shard list; `digest` commits the whole bundle.

The bundle is built from the file's bytes, not from flags. `buildModelBundle`
recomputes both `sizeBytes` and `weightsDigest` and refuses a caller that names
different ones.

## The provider

`rarext-runtime provider` is the network compute side:

1. fetch the bundle manifest by content address and verify its digest;
2. fetch every shard, checking each shard's length and sha256;
3. reassemble the file and check it against `model.weightsDigest`;
4. only then load the model — parse the committed native model, or write the
   verified file and ask the provider's Ollama to create it;
5. serve an OpenAI-compatible `/v1/chat/completions` and `/v1/models`;
6. publish a provider card at `/v1/provider-card` naming the bundle, the shard
   commitment, the manifest address, the model, and the execution class.

If one byte of one shard is wrong, the provider refuses to start. There is no
"best effort" load.

A provider keeps its own key at `<state-dir>/provider-identity.json` (kind
`rarext.provider-identity.v1`). The card it serves is signed with that key, and
`provider.keyId` is the key id derived from the public key: the operator identity
is a content address, not a label the provider asked to be called. Restarting
with the same state directory reuses the identity; a fresh directory is a new
operator. A reader verifies the signature over the canonical card bytes, so a
card cannot be re-signed by a publisher claiming someone else's key.

The card is still not a trust anchor. Its digest is recomputed by the runtime, and
the bundle manifest is fetched independently from RAREXT and cross-checked against
the card. A card can be re-digested over a lie (dropping the signature, which no
longer covers the changed bytes); the independent manifest still catches it.

## The deployment

```bash
node apps/runtime/src/cli.ts deploy \
  --web4 \
  --provider https://provider.example \
  --registry https://registry.example \
  --verify-shards \
  --out .rarext-runtime
```

`--verify-shards` downloads and hashes every shard at deploy time. Without it the
runtime still fetches the manifest from RAREXT and verifies the provider card
against it; the provider has already verified the shards it serves.

The manifest records:

- `placement: "web4"`;
- `hardware.backend: "network"` and `hardware.memoryBytes: null` — the provider
  is neither this host nor a cloud vendor, and this process cannot see its memory;
- `labels.execution: "web4"`;
- `labels.bundle`, `labels.shardsRoot`, `labels.manifestHash`;
- `labels.provider` and `labels.providerCard`.

The challenge commits `bundleDigest`, `shardsRoot`, and `manifestHash` alongside
the deployment digest, model id, weight digest, and engine. A run that does not
name the same bundle fails, so weights cannot be swapped between a verified card
and an unrelated transcript.

## Several providers, one bundle

A bundle is bytes, so more than one provider can serve it. `--provider` is
repeatable, and the deployment commits the whole set:

```bash
node apps/runtime/src/cli.ts deploy \
  --web4 \
  --provider https://alice.example \
  --provider https://bob.example \
  --quorum 2 \
  --registry https://registry.example
```

`labels.providers` is the committed endpoint list and `labels.quorum` is how many
must return the same response before a run is recorded. The challenge commits the
same `quorum`, so removing the evidence or lowering the count fails verification.

A provider can publish its own card as a normal signed artifact under the model
challenge. Deploy can then find it without being told a URL:

```bash
node apps/runtime/src/cli.ts announce --endpoint https://bob.example \
  --manifest .rarext-runtime/deployment.json \
  --registry https://registry.example

node apps/runtime/src/cli.ts deploy --web4 --discover \
  --bundle-digest <bundle-digest> --registry https://registry.example
```

`announce` recomputes the card, fetches the bundle manifest independently, and
refuses a card that names different bytes before signing it. `--discover` reads
the anchored `ai.model-provider` publications, verifies each against the
challenge, and cross-checks each card against the manifest it will serve. It
searches every anchored batch, not only the newest: an anchor covers the
publications that were pending when it was made, so a provider card and a later
run can legitimately live in different batches.

The same view is available offline:

```bash
node apps/runtime/src/cli.ts discover --registry https://registry.example --all-anchors
```

That recomputes every card, provider, and run across the registry's anchors and
reports one verdict.

Discovery does not have to depend on one registry. `--mirror-registry` is
repeatable on `announce`, `deploy --discover`, `compare --discover`, and
`discover --all-anchors`: the same signed card is published to every named
registry, and discovery unions the results by card digest. An unreachable mirror
is reported and skipped, not fatal, so no single registry is the gatekeeper for
who can serve a model.

```bash
node apps/runtime/src/cli.ts announce --endpoint https://bob.example \
  --manifest .rarext-runtime/deployment.json \
  --registry https://registry-a.example \
  --mirror-registry https://registry-b.example

node apps/runtime/src/cli.ts deploy --web4 --discover \
  --bundle-digest <bundle-digest> \
  --registry https://registry-a.example \
  --mirror-registry https://registry-b.example
```

The gateway queries every committed provider, groups responses by canonical
digest, and records the evidence in the run:

```json
"quorum": {
  "required": 2,
  "responded": 3,
  "agreed": 2,
  "providers": [
    { "endpoint": "https://alice.example", "operator": "did:rarext:alice", "responseDigest": "…" },
    { "endpoint": "https://bob.example", "operator": "did:rarext:bob", "responseDigest": "…" },
    { "endpoint": "https://carol.example", "operator": "did:rarext:carol", "responseDigest": "…" }
  ]
}
```

Every provider that answered is recorded, including a dissenter: the transcript is
evidence, not a tally. The verifier recomputes `agreed` as the number of recorded
providers whose digest equals the response the run carries, so a gateway cannot
claim agreement it did not get, and a repeated endpoint cannot count twice.

Every signed provider card names the operator that runs it: `provider.keyId` is
the key id of the provider's own signing key, and `provider.publicKey` is the key
itself. `deploy` commits those identities as `labels.operators` (falling back to
`provider.handle` only for an unsigned card), and the challenge commits them too.
Agreement is then counted over **distinct operators**, not endpoints: two endpoints
run by one operator are one voice, and a gateway configured that way refuses the
run instead of writing it. A deployment whose quorum exceeds its distinct operator
count is invalid.

```bash
# The operator identity is derived from the provider's persisted key; --handle is
# only a human-readable label.
node apps/runtime/src/cli.ts provider --bundle model-bundle.json \
  --registry https://registry.example --handle provider-a
```

The digest is over the comparable completion: `id`, `created`, and
`system_fingerprint` are transport metadata and are removed before comparison.
If two providers disagree, or fewer than `required` answer, the gateway returns
`503` with both answers and does not write a run. A disagreement is never
averaged into a transcript.

Streaming still works under a quorum. The gateway asks every provider for a
complete response, compares them, records the run, and then re-emits the agreed
answer as SSE (`x-rarext-stream: quorum-agreed`) with the same run digest and
quorum headers. It is a view of the attested answer, never a pass-through of one
provider's live stream, so nothing unverified reaches the caller.

`compare` is the independent version of the same check:

```bash
node apps/runtime/src/cli.ts compare \
  --provider https://alice.example --provider https://bob.example \
  --registry https://registry.example --prompt "Where do weights live?"
```

It verifies every card against the bundle, asks every provider the same question,
and prints the canonical response digests and their agreement.

## Payment

A web4 deployment can commit a bounty (`labels.bounty`), and the challenge commits
it too. When a quorum run completes, the gateway pays each **distinct agreeing
operator** that amount and records the payment in the run:

```json
"credits": { "action": "infer", "bounty": 12, "paid": 2, "ledgerRoot": "…" }
```

Each operator's receipt is a RAREXT credit record — `keyId`, `action` (`infer`),
`bounty`, `challengeId` (the deployment), `artifactHash` (the agreed answer), and
`at` (when the run completed) — and `ledgerRoot` is the commitment over them.
Nothing is taken on faith: `verify` recomputes the records from the quorum evidence
and the committed bounty, so paying a dissenter, changing the amount, or editing
the root makes the run fail. A dissent is evidence, not a payee, and a provider
with no operator key cannot be paid.

The gateway exposes the ledger as a view of its runs, with Merkle inclusion proofs:

```bash
curl http://gateway/v1/rarext/credits
curl http://gateway/v1/rarext/credits/<operator-key-id>
```

And the node settles it in RAREXT's own credit ledger. A provider submits a signed
`rarext.inference-work.v1` claim naming the run; the node — which attested and
anchored that run — recomputes the payment from the run's own evidence (never from
the claim) and records the operator's receipt, with an inclusion proof against the
whole-ledger root:

```bash
curl -X POST https://registry.example/v1/work/inference \
  -d '{"kind":"rarext.inference-work.v1","operator":"…","runDigest":"…","signature":"…"}'
```

`deploy --bounty <n>` commits the amount. The node's action board prices the same
act (`infer`) at its own base; the run pays the amount the buyer committed.

## The verification chain

```
storage blob hash  ->  shard bytes
shard list         ->  shardsRoot
reassembled file   ->  weightsDigest
all of the above   ->  bundle.digest
bundle.digest      ->  challenge.spec.bundleDigest
deployment         ->  challenge.spec.deploymentDigest
run request/response bytes -> transcript digests
run.bundle         ->  the same digest, shardsRoot, manifestHash, weightsDigest
```

Each arrow is recomputed by whoever holds the bytes. Nothing in the chain asks a
provider whether it is telling the truth about the model.

`serve` forwards to the provider exactly as the `remote` placement does, and the
gateway records the exact request and response. The run body carries the bundle
reference, so `verify` checks the model identity as well as the transcript bytes.

## Replay

For the native execution class, replay is real: the demo deletes the source model
file before the provider starts, then regenerates the committed output from the
bundle bytes and the request seed and compares it to the recorded text.

For a GGUF, exact token replay depends on the engine, hardware, and decoding
state. RAREXT does not pretend otherwise: the run is an exact transcript, and a
provider holding the same `weightsDigest` is what makes a replay meaningful.
`representation: "generative"` remains the right claim for a model class with a
deterministic replay function; the runtime's `exact` verifier does not invent one
for an arbitrary engine.

## Commands

```bash
# shard a model into RAREXT and write model-bundle.json
node apps/runtime/src/cli.ts bundle --file model.gguf --model qwen2.5:0.5b \
  --engine ollama --engine-model rarext-web4-qwen --format gguf \
  --registry http://127.0.0.1:8787 --out .rarext-runtime

# a deterministic native model, generated from a vocabulary
node apps/runtime/src/cli.ts bundle --native --model native-proof \
  --vocab RAREXT,is,a,network --steps 24 \
  --registry http://127.0.0.1:8787 --out .rarext-runtime

# provider node: fetch, verify, serve
node apps/runtime/src/cli.ts provider --bundle .rarext-runtime/model-bundle.json \
  --registry http://127.0.0.1:8787 --port 8791

# deploy against it (repeat --provider for a quorum)
node apps/runtime/src/cli.ts deploy --web4 --provider http://127.0.0.1:8791 \
  --registry http://127.0.0.1:8787 --allow-loopback --out .rarext-runtime

# publish a provider card under the deployment's challenge
node apps/runtime/src/cli.ts announce --endpoint http://127.0.0.1:8791 \
  --manifest .rarext-runtime/deployment.json --registry http://127.0.0.1:8787

# compare providers and their answers
node apps/runtime/src/cli.ts compare --provider http://127.0.0.1:8791 \
  --provider http://127.0.0.1:8792 --registry http://127.0.0.1:8787 \
  --prompt "Where do weights live?"

# serve the attested gateway
node apps/runtime/src/cli.ts serve --manifest .rarext-runtime/deployment.json --publish
```

`--allow-loopback` is required for a loopback provider and marks the manifest
`fixture: "loopback"`, exactly as the remote placement does. A web4 card cannot
quietly run on the publisher's machine.

## Storage transport

Model weights do not fit in the JSON blob route. `POST /v1/blobs/raw` accepts the
exact bytes with `content-type: application/octet-stream` and an optional
`x-rarext-hash`; the node hashes the body and returns `409` when the claimed
content address is wrong. The store's 32 MiB per-blob cap still applies, which is
why a large file is sharded rather than sent as one object.

## Honest limits

- **A quorum is over signed operators, not proven machines.** A signed provider
  card names a key id anyone can verify, and the deployment and challenge commit
  those identities, so a quorum requires that many *distinct* signing keys; a
  gateway configured to collapse two endpoints onto one operator refuses the run.
  What the protocol still cannot prove is that two keys are held by independent
  people or run on unrelated hardware or upstream engines — one party can hold
  many keys. The bundled demo's two operators are separate processes, and keys,
  on one machine.
- **The provider sees the weights and the prompts.** Encryption at rest is the
  sealed storage tier; inference over sealed weights is not implemented.
- **Inference is not cryptographically proven.** The run transcript proves the
  bytes exchanged; a deterministic native model can be replayed from the bundle;
  an arbitrary GGUF cannot be reproduced bit-for-bit by the protocol alone.
- **Payment is per run, not a currency.** A committed bounty is recorded and
  settled in RAREXT's credit ledger: the run commits who was paid, the verifier
  recomputes it, and an operator proves its receipt against the ledger root. What
  is not implemented is moving value off the ledger — there is no cash-out, and a
  bounty is only as good as the accounts behind it.
- **The engine is the provider's.** With `execution.kind: "engine"` the provider
  must have Ollama (today) and reproduces the model locally from the verified
  file. The weights still come from RAREXT; the compute is the provider's.
