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
`storage -> provider -> deploy -> registry -> card -> serve -> infer -> publish ->
weights -> replay -> discover -> tamper -> verify`.

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
passed all 13 phases.

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

The card is not a trust anchor. Its digest is recomputed by the runtime, and the
bundle manifest is fetched independently from RAREXT and cross-checked against
the card. A card can be re-signed over a lie; the independent manifest still
catches it.

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

# deploy against it
node apps/runtime/src/cli.ts deploy --web4 --provider http://127.0.0.1:8791 \
  --registry http://127.0.0.1:8787 --allow-loopback --out .rarext-runtime

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

- **One provider is one machine.** The bundle can be fetched by any provider, but
  this demo runs one. Provider discovery across independent operators is the next
  step, not something the card alone supplies.
- **The provider sees the weights and the prompts.** Encryption at rest is the
  sealed storage tier; inference over sealed weights is not implemented.
- **Inference is not cryptographically proven.** The run transcript proves the
  bytes exchanged; a deterministic native model can be replayed from the bundle;
  an arbitrary GGUF cannot be reproduced bit-for-bit by the protocol alone.
- **Payment is not wired.** A provider serves because an operator runs it, not
  because the protocol pays for the work yet.
- **The engine is the provider's.** With `execution.kind: "engine"` the provider
  must have Ollama (today) and reproduces the model locally from the verified
  file. The weights still come from RAREXT; the compute is the provider's.
