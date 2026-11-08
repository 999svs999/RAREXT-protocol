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
3. reassemble the file and check it against `model.weightsDigest` — or, for a
   sealed bundle, open each shard in memory with the key and check the plaintext
   against the same digest;
4. only then load the model — parse the committed native model, or write the
   verified file and ask the provider's Ollama to create it;
5. serve an OpenAI-compatible `/v1/chat/completions` and `/v1/models`;
6. publish a provider card at `/v1/provider-card` naming the bundle, the shard
   commitment, the manifest address, the model, and the execution class.

If one byte of one shard is wrong, the provider refuses to start. There is no
"best effort" load.

### Sealed weights

A bundle can be **sealed**. `bundle --seal` shards the model, encrypts each shard
with AES-256-GCM under a fresh 32-byte key, and stores the ciphertext; the
manifest commits the ciphertext's `shardsRoot` and `totalBytes` alongside the
plaintext's `weightsDigest` and `sizeBytes`, plus `sealing.keyCommitment` — the
sha256 of the key, never the key.

The consequence is that RAREXT holds ciphertext. The store operator, a mirror,
or anyone reading the blobs gets bytes that hash to the committed shards and
open to nothing without the key. A provider is given the key out of band
(`--seal-key-file`); it checks the key against `keyCommitment`, opens the shards
in memory, verifies the plaintext against `weightsDigest`, and serves. It never
writes plaintext weights to disk.

Sealing works for both execution classes. A `native` provider parses the opened
bytes in memory and never touches disk. An `engine` provider has to hand its
engine a file, so it opens the sealed bytes into a mode-0600 file under the OS
temp directory — never the provider's state dir, never a cached artifact — lets
the engine load it, and removes the directory the moment the engine returns. The
provider's state directory therefore never holds the model, which the demo checks
for a sealed GGUF.

Sealing hides the weights from the RAREXT store, from mirrors, and from the
wire; it does **not** hide them from the provider: the provider holds the key,
opens the weights to run them, and for an engine briefly places them on the OS
temp filesystem to load. Prompts remain visible to the provider. Hiding the
weights from the operator needs a TEE or MPC, which is not implemented.

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

### Machine independence

Distinct keys are not necessarily distinct machines. Each provider card also
attests the **machine** it runs on (`independence`: a machine id and a
measurement), and the card signature is the operator's own key — so the machine
claim is bound to the key that makes it. A provider defaults to a host
fingerprint, so two co-located providers attest the same machine:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --independence machine \
  --registry https://registry.example
```

`deploy` commits the operator-aligned machine ids as `labels.machines`, and the
challenge commits them alongside `operators` and `independence: "machine"`. The
gateway then counts the quorum over **distinct machines** as well as distinct
operators, refusing a run whose agreeing providers sit on one box; and the
verifier checks each agreeing provider's `(operator, machine)` pair against the
committed list, so a gateway cannot invent a machine to pass the rule. A
deployment whose committed machines cannot meet the quorum is invalid before any
run happens.

The machine id is only as trustworthy as the operator's key: this proves the
operators CLAIM distinct machines, not that the boxes are physically separate. A
TEE deployment would put an enclave measurement in `independence.measurement`;
today it is a hash of the declared id.

### Measurement allowlist: checking the claim

Recording a machine is not checking it. A deployment can also commit a
**measurement allowlist** — the software/image digests it approves:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --measure <approved-measurement> \
  --registry https://registry.example
```

`deploy --measure` commits `labels.measurements`, and it REFUSES an allowlist
that does not include every provider it is adopting — so a deployment cannot name
an approved image its own providers do not run. The challenge commits the list as
`spec.measurements`; the gateway refuses a run in which any agreeing provider
presents a measurement off the list, and the verifier recomputes the same rule
from the run, so a gateway cannot quietly count an unapproved provider. Each
provider attests a `measurement` (with a `scheme` naming what produced it —
`software-image` today, an enclave kind for a real TEE), and a provider sets it
with `--measurement`.

This is what turns the machine claim from a self-declaration into something the
deployment enforces: the provider still produces the value, but a value the
deployment did not approve does not count.

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

### The engine pin

What the protocol CAN pin is the engine. Each provider reports the engine it
serves with — name, version, and (when the operator knows it) the image digest —
and folds them into one `engine.fingerprint`. A web4 `deploy` reads every
provider's `/health`, and when they all report the same engine it commits that
fingerprint as `labels.engineFingerprint`; the challenge commits it as
`spec.engineFingerprint`, and every run records it. A heterogeneous fleet is left
unpinned rather than pinned to one member.

`rarext-runtime replay` then checks the pin **before generating anything**: it
reads the target provider's present `/health.engineFingerprint` and refuses a
provider running a different engine build — so "I replayed it" cannot mean "I ran
it on some other engine and called it a match." Only a matching engine is
re-issued, and its output is compared to the committed output. The verifier
recomputes the same rule, refusing a run whose `engine.fingerprint` is not the
one the challenge pinned.

```bash
# replay refuses a provider whose engine differs from the pinned one
node apps/runtime/src/cli.ts replay --transcript run.json --endpoint https://other.example
# engine differs — <pinned> vs <present>
```

This does not make an arbitrary GGUF bit-for-bit reproducible; it makes a replay
of one *checkable*: same weights, same engine, and the output compared — or the
replay is refused by name.

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

- **A quorum is over signed operators, distinct machines, and allowlisted
  measurements — but the measurement is only as strong as what produced it.** A
  signed provider card names a key id, a machine, and a measurement, all covered
  by the card's own signature; the deployment and challenge commit the operators,
  the operator-aligned machines, and a measurement allowlist. A quorum then needs
  that many distinct keys, that many distinct machines, and every agreeing
  provider on the approved list — enforced by the gateway and recomputed by the
  verifier. What it still does not prove is that the machine ids name physically
  separate boxes or that the measurements come from real hardware: the provider
  produces its own measurement, and `scheme: "software-image"` is a digest of a
  declared image. Only a TEE that signs its own measurement (`scheme: "sgx"`,
  `"sev-snp"`, …) makes the value unforgeable; the field is shaped for it, but no
  TEE is wired in. The bundled demo's two providers are co-located, which is why
  a machine-independent quorum refuses them.
- **Sealed weights hide the model from the store and the wire, not the operator.**
  A sealed bundle's shards are AES-256-GCM ciphertext, so the RAREXT node, a
  mirror, and anyone reading the blobs hold only ciphertext. A native provider
  opens them in memory; an engine provider opens them into a short-lived mode-0600
  temp file outside its state dir and removes it after the engine loads — the
  provider's state never holds the model. But the provider holds the key and sees
  the weights as it runs them, and prompts are still visible to it. Privacy from
  the operator needs a TEE or MPC, which is not implemented.
- **Inference is not cryptographically proven.** The run transcript proves the
  bytes exchanged; a deterministic native model can be replayed from the bundle.
  An arbitrary GGUF is still not reproduced bit-for-bit by the protocol alone —
  the weights do not determine the engine's arithmetic. What the protocol does is
  pin the engine (`engine.fingerprint`), record it in the run, and refuse a replay
  whose provider runs a different engine, so a replay is a checked re-execution
  under a named engine rather than a claim.
- **Credits move on the ledger, not off it.** A committed bounty is recorded and
  settled in RAREXT's credit ledger; the run commits who was paid, the verifier
  recomputes it, and an operator proves its receipt against the ledger root. A key
  can then move credits it holds to another key with a signed transfer
  (`/v1/work/transfer`): a zero-sum debit/credit pair, refused if it would overdraw
  the payer, proved against the same whole-ledger root. There is still no cash-out —
  no bank to withdraw from — and a bounty is only as good as the accounts behind it.
- **The engine is the provider's.** With `execution.kind: "engine"` the provider
  must have Ollama (today) and reproduces the model locally from the verified
  file. The weights still come from RAREXT; the compute is the provider's.
