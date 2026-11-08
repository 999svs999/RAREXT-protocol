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
wire. Whether it hides them from the **operator** depends on where the key lives:

- With `--seal-key-file`, the operator's provider holds the key and opens the
  weights to run them (and for an engine briefly places them on the OS temp
  filesystem). The operator sees the weights, and prompts.
- With an **enclave**, the operator's serving process never holds the key.

### The enclave path

`bundle --seal --seal-to <enclave-public-key>` seals the model and **wraps the
data key to the enclave's RSA public key** (`sealing.wrap`), writing no plaintext
key file. Now the blobs *and* the manifest are useless to anyone but the enclave:
the manifest carries a wrapped key that only the enclave's private key opens.

A provider started with `--enclave-endpoint <url>` is a **forwarding provider**:
it verifies the committed CIPHERTEXT (`fetchBundleCiphertext`) and proxies
inference to the enclave, holding ciphertext and no key — `/health` reports
`holdsKey: false`. The enclave is a provider started with `--enclave-key-file`,
which unwraps the data key with its private key, decrypts in its own process, and
answers. The forwarder's card carries the **enclave's** attestation (quote and
chain), so the trust machinery pins the enclave's anchor, not the forwarder's.

This is a **software enclave**: a separate trust domain in a separate process, not
a hardware TEE. The protocol shape is real — the process on the wire holds no key,
the weights are encrypted to the enclave, and only an enclave whose attestation
chains to the pinned anchor is trusted — but an operator with root on the enclave's
host can still read its memory. A hardware TEE (SGX/SEV-SNP) is what makes the
enclave itself private; the `scheme` field and the attestation chain are shaped
for it, but no hardware root is wired in.

### Confidential prompts

The same idea hides the prompt. A caller seals its request to the enclave's public
key (`GET /v1/attestation` returns `enclavePublicKey`): a random data key is
wrapped to the enclave, and the request is AES-256-GCM under it. The body posted to
the forwarding provider is

```json
{ "model": "…", "confidential": { "wrappedKey": "…", "nonce": "…", "ciphertext": "…" } }
```

The forwarder relays it verbatim — it never sees the prompt. The enclave unwraps the
data key, opens the request, runs it, and seals the response under the same key,
which the caller kept. So the prompt and the answer are ciphertext everywhere
except inside the enclave, and the forwarder's logs, a gateway, or a relay see only
sealed bytes. A provider with no enclave key refuses a confidential request by name.

This protects prompts from the *relaying* process and from the operator of the
path. It does not protect them from an operator with root on the enclave's own host
— the same software-enclave caveat as above; a hardware TEE closes it.

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

### Signed machine quotes

An allowlist checks the VALUE; a signed, chained quote checks the CLAIM. A
provider signs its machine attestation with a **leaf key**, and the leaf is
certified by a **trust anchor** the deployment pins. A quote whose chain does
not terminate at the pinned anchor is refused:

```json
"independence": {
  "kind": "rarext.provider-machine.v1", "scheme": "tee",
  "machine": "…", "measurement": "…", "issuedAt": "…",
  "quote": {
    "signature": "…", "publicKey": { "kty": "EC", … }, "suite": "ecdsa-p256",
    "chain": [ { "subject": { …leaf… }, "issuer": { …anchor… },
                 "signature": "…", "suite": "ecdsa-p256" } ]
  }
}
```

The quote signature covers the attestation fields (not the quote itself); each
certificate is signed by its issuer over `{subject, issuer}`, so the chain binds
the leaf up to the anchor. A provider supplies its leaf key and chain with
`--tee-key-file` and `--tee-cert-file`. A deployment pins the **anchor** by key
id:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --tee-vendor <anchor-key-id> \
  --registry https://registry.example
```

`deploy --tee-vendor` commits `labels.teeVendor`, and it REFUSES a pin that any
adopted provider's chain does not terminate at. The challenge commits
`spec.teeVendor`; the gateway refuses a run in which any agreeing provider's
chain does not reach the pinned anchor; and the verifier recomputes every quote
and certificate from the run's recorded attestations, so a gateway cannot
substitute one. A forged quote (fields changed, signature stale), a broken
certificate (signature not matching its issuer), or a chain rooted somewhere else
is refused by name. The verifier's check is `verifyProviderChain` — the same
function the provider's own card validation uses — and it returns the chain's
ROOT key id, which must equal the pin.

The honest boundary: this proves the quote chains to the pinned anchor without
the operator holding the anchor's key, so a provider cannot mint its own trust.

### Hardware root of trust

A deployment can go further and require the chain to terminate at the **vendor's
hardware root**, not an anchor it chose. The protocol ships a simulated root of
trust (`hardware-root.ts`) — the silicon vendor's key, fixed the way a chip's root
key is fused into the die — and a depth-two chain: the leaf is certified by a
**platform** key, and the platform key by the vendor root.

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --tee-vendor <vendor-root-key-id> --tee-chain-depth 2 \
  --registry https://registry.example
```

`deploy --tee-chain-depth 2` commits `labels.teeChainDepth` and REFUSES unless every
adopted provider's chain reaches the pinned vendor root at that depth. The challenge
commits `spec.teeChainDepth`; the gateway refuses a run whose agreeing providers'
chains are shorter or root elsewhere, and the verifier recomputes the same rule. A
bare leaf key (depth zero) is valid attestation but **not hardware-rooted**, and is
refused by name.

### Measured boot

Depth alone is not enough: a chain can reach the vendor root without measuring
what booted. The vendor root can instead certify a **measured-boot chain** —
firmware, then the OS, then the app (the enclave's leaf key) — where each link
names its stage (`"firmware"`, `"os"`, `"app"`). A deployment requires the stages
it trusts:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --tee-vendor <vendor-root-key-id> \
  --tee-chain-depth 3 --tee-boot-stages firmware,os,app \
  --registry https://registry.example
```

`deploy --tee-boot-stages` commits `labels.teeBootStages` and REFUSES unless every
adopted provider's chain names the stages it requires. The challenge commits
`spec.teeBootStages`; the gateway refuses a run whose agreeing providers' chains
omit any required stage, and the verifier recomputes it. So a leaf signed outside
the measured boot — even one chained to the vendor root — cannot count: the chain
must extend through firmware and the OS the deployment trusts.

The honest boundary: the root is a fixed key shipped with the protocol, so this is
the *shape* of a hardware root — a deployment pins a vendor root it did not choose,
a chain must extend through the stages it trusts, and a leaf cannot stand in for
either — but the root is still a file, not a fuse, and the stage names are claims
the chain carries, not values a silicon fuses. A real TEE (SGX/SEV-SNP) records the
measurements in hardware and holds the root in silicon; the chain, the stages, and
the `scheme` field are built for it, but no hardware root is wired in.

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

- **A quorum can require signed operators, distinct machines, allowlisted
  measurements, and machine quotes chained from the VENDOR hardware root through a
  measured boot — but the shipped root is a file, not a fuse, and the stage names
  are claims, not fuses.** The card names a key id, machine, and measurement under
  the operator's signature, plus a leaf-signed quote chained up through firmware and
  the OS to the vendor root the protocol ships (`hardware-root.ts`); the deployment
  commits the operators, operator-aligned machines, a measurement allowlist, and
  (with `--tee-vendor` + `--tee-chain-depth` + `--tee-boot-stages`) the vendor root,
  minimum depth, and required boot stages. A quorum then needs that many distinct
  keys and machines, every agreeing provider on the approved list, and every
  agreeing quote's chain reaching the pinned vendor root at that depth AND naming
  every required stage — enforced by the gateway and recomputed by the verifier. The
  operator supplies only a LEAF key and cannot mint its own trust: a bare leaf
  (depth zero), a chain ending at an operator anchor, a chain rooted elsewhere, or a
  chain that reaches the root without measuring the boot is refused by name. What it
  still does not prove is that the machine ids name physically separate boxes, that
  the stage names reflect a real boot, or that the vendor root is real silicon: the
  root is a fixed key the protocol ships and the stages are claims the chain carries,
  so it is hardware-*shaped* but a file. A TEE that records the measurements in
  hardware and fuses the root into the chip is what closes that last gap; the
  `scheme` field, the chain, and the stages are built for it, but no hardware root is
  wired in. The bundled demo's two providers are co-located, which is why a
  machine-independent quorum refuses them.
- **Sealed weights hide the model from the store and the wire, and — through an
  enclave — from the serving process; only a hardware TEE hides them from the
  operator's host.** A sealed bundle's shards are AES-256-GCM ciphertext, so the
  RAREXT node, a mirror, and anyone reading the blobs hold only ciphertext. With
  `--seal-key-file` the operator's provider holds the key and sees the weights as
  it runs them (an engine provider opens them into a short-lived temp file). With
  `--seal-to` + `--enclave-endpoint`, the data key is wrapped to an enclave's
  public key, the forwarding provider holds ciphertext and no key (`holdsKey:
  false`), and only the enclave process opens the model. A confidential request
  (`{ confidential: { wrappedKey, nonce, ciphertext } }`) is sealed to the enclave
  too, so the prompt and the answer are ciphertext everywhere but inside the
  enclave — the forwarder, a gateway, or a relay never sees them. But a software
  enclave is not silicon: an operator with root on the enclave's host can read its
  memory and, with it, the prompt. A hardware-rooted TEE (SGX/SEV-SNP) is what
  closes that; the attestation chain and `scheme` field are shaped for it, but no
  hardware root is wired in.
- **Inference is not cryptographically proven.** The run transcript proves the
  bytes exchanged; a deterministic native model can be replayed from the bundle.
  An arbitrary GGUF is still not reproduced bit-for-bit by the protocol alone —
  the weights do not determine the engine's arithmetic. What the protocol does is
  pin the engine (`engine.fingerprint`), record it in the run, and refuse a replay
  whose provider runs a different engine, so a replay is a checked re-execution
  under a named engine rather than a claim.
- **Credits move on the ledger, and can leave it against an external
  reference — but the protocol does not move real value.** A committed bounty is
  recorded and settled in RAREXT's credit ledger; the run commits who was paid, the
  verifier recomputes it, and an operator proves its receipt against the ledger
  root. A key can move credits to another key with a signed transfer
  (`/v1/work/transfer`, a zero-sum pair) or take them out with a signed redemption
  (`/v1/work/redeem`, a debit with no credit that lowers the ledger supply),
  refused if it would overdraw the payer and proved against the same whole-ledger
  root. What no protocol can do is hand over cash: the redemption commits an
  external reference and a bounty is only as good as the accounts behind it.
- **The engine is the provider's.** With `execution.kind: "engine"` the provider
  must have Ollama (today) and reproduces the model locally from the verified
  file. The weights still come from RAREXT; the compute is the provider's.
