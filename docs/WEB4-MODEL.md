# The whole model lives on RAREXT

The earlier model runtime could run a model locally or forward to somebody
else's cloud. `placement: "web4"` is the third path: the weights are RAREXT
storage blobs, a **provider node** fetches every shard and verifies the committed
digest before it loads anything, and the runtime commits the bundle so a reader
can check the model bytes instead of trusting a provider name.

There is no OpenAI, no Anthropic, and no model file on the machine asking the
question. The provider is a network participant; the model is content-addressed
data.

### Where the AI actually runs

`placement: "web4"` means the asking machine runs **no model and no inference**. The
demo proves it: `storage` shards the weights into RAREXT blobs, the source file is
deleted, a provider fetches and verifies every shard from RAREXT, and the `weights`
phase asserts the caller's state contains no model file. The caller's deployment
records `hardware.backend: "network"` and `memoryBytes: null` — it names compute it
does not own.

The **engine** (the process that turns tokens) also runs on the RAREXT provider node,
not on the caller — and the engine itself is a RAREXT artifact. It is sharded into
RAREXT like the weights, under one committed digest (`rarext.engine-bundle.v1`), and
a provider **fetches and verifies it before it will serve**: a shard that does not
hash to the commitment, a reassembled artifact whose digest does not match, or a
module that exposes no engine is refused before any inference. The provider runs the
engine it fetched, not one the box already has, and the artifact digest is folded
into the `engineFingerprint` the deployment commits, every run records, and a replay
checks. The demo's `engine` phase serves with a fetched engine (and shows the served
trace is the fetched engine's, not the built-in one) and refuses a tampered artifact.

`bundle --engine-module <file> --engine-runtime native|gguf|wasm|worker --engine-name <n>`
shards the engine and **commits it into the model bundle** (`execution.artifact`:
name, version, runtime, artifact digest, and the manifest hash). The engine is
therefore part of the model's content identity: a provider fetches the exact
engine the bundle names, verifies it against that digest, and needs no
out-of-band `--engine-bundle` flag. A bundle that names a different artifact is a
different bundle and is refused. `provider --engine-bundle <manifest>` remains
available to pin an engine explicitly. A JavaScript engine artifact is evaluated
in a `node:vm` context with no `require` and no filesystem; a WebAssembly engine
artifact is instantiated with an empty import object.

Four runtimes ship in this repository:

- `rarext.worker-engine.node-cjs.v1` runs a **non-RAREXT native engine program**
  (a self-contained JS module) on a dedicated **worker thread** inside a
  `node:vm` context with no `require`, no `process`, no filesystem and no
  network — the host path for a foreign engine binary without a container. The
  engine is digest-pinned in the bundle and in the engine fingerprint, and its
  output trace makes the run replayable like any other.
- `rarext.wasm-engine.wasm.v1` instantiates a **third-party engine shipped as a
  WebAssembly binary** inside the provider process with an *empty import object* —
  no OS process, no syscall surface, no container runtime. The module exports
  `memory` and `run(promptPtr, len, steps, seed) -> i32` (a NUL-terminated UTF-8
  result), plus optional `alloc`/`dealloc`/`load` so the committed model bytes can
  be handed in; `scripts/make-wasm-engine.mjs` emits a working example. The same
  artifact digest and engine fingerprint pin it, so a foreign binary is committed,
  fetched, verified and replayed like any other engine.
- `rarext.native-engine.node-cjs.v1` runs the committed xorshift32 model.
- `rarext.gguf-engine.node-cjs.v1` is **RAREXT's own GGUF transformer**
  (`apps/runtime/engines/rarext-gguf-engine.js`). It parses the GGUF header, KV,
  and tensor table, dequantizes the committed weights (F32/F16/BF16/Q4_0/Q4_1/
  Q5_0/Q5_1/Q8_0/Q2_K/Q3_K/Q4_K/Q5_K/Q6_K/Q8_K, the non-linear 4-bit IQ4_NL and
  IQ4_XS, and the **grid quants IQ2_XXS/IQ2_XS/IQ2_S/IQ3_XXS/IQ3_S/IQ1_S/IQ1_M**
  from ggml's own grid tables), and runs the transformer inside the
  provider: qwen2, llama/mistral, **mixtral** (top-k MoE routing), **gemma**
  (GeGLU, norm+1, `sqrt(n_embd)` embedding scale), **phi3** (optional partial
  NeoX rotary, fused QKV, fused gate/up, LongRoPE long/short factors with the
  `attn_factor` magnitude) and **phi2** (LayerNorm with bias, GELU sequential
  FFN, parallel FFN residual, output bias) — RMSNorm/LayerNorm, GQA attention,
  NeoX or adjacent-pair RoPE, SwiGLU/GeGLU/GELU, optional output matrix. Both GPT-2
  byte-level BPE and SentencePiece tokenizers are implemented, so the engine
  covers the common GGUF families rather than one. A GGUF `bundle` therefore
  defaults to this engine and commits it into the model bundle; Ollama is only
  used when `--engine ollama` is passed explicitly as interop. A GGUF execution
  named
  `engine: "rarext"` therefore needs **no Ollama, no llama.cpp, no native addon,
  and no container runtime**, and no engine endpoint at all: both the weights and
  the engine are fetched from RAREXT and verified before serving. The generated
  token ids are recorded as a `rarext.decode-trace.v1`, so a replay re-runs the
  same fetched engine and compares token-for-token.

The same engine also serves a **RAREXT-native container** (`rarext.hf-container.v1`,
magic `RXHF`) produced by RAREXT's own ingest
(`scripts/convert-hf-safetensors.mjs`) straight from a Hugging Face checkpoint —
`config.json`, `*.safetensors`, and a `tokenizer.json` (BPE) or `tokenizer.model`
(SentencePiece) — with **no llama.cpp, no gguf-py and no third-party converter**. The converter maps the HF parameter names
and config into the GGUF-style KV/tensor table the engine already consumes, so
one engine runs both containers. `bundle --file model.rarext` detects the magic,
defaults to RAREXT's engine and commits it, exactly like a GGUF. Weight
quantization is RAREXT's own (`Q8_0`/`Q4_0`/`IQ4_NL`/`Q4_K`), not a llama.cpp pass.

### The AI lives on RAREXT, purely — no host capability required

The point is not *which* box ran it. Both the **weights** and the **engine** are
content-addressed RAREXT artifacts; a node fetches, verifies and runs them, and
the run is replayable from the committed artifacts alone. Nothing about the host
is a prerequisite:

- **no third-party software** — not Ollama, not llama.cpp, not gguf-py, not a
  converter. The engine is either RAREXT's own transformer or a **portable engine
  artifact** the network carries (`rarext.worker-engine.node-cjs.v1`,
  `rarext.wasm-engine.wasm.v1`). The portable engine *reads the committed
  weights*: it parses the `RXHF` container out of the model bytes and computes
  the transformer itself — the run is driven by the network's artifacts, and a
  perturbed copy of the same weights produces a different run, which
  `demo:ai-on-rarext` shows explicitly;
- **no container runtime / OS sandbox** — a foreign engine is a portable artifact
  (a wasm module, or a native program run on a sandboxed worker thread), so it
  needs no ELF/Mach-O launcher on the host;
- **no GPU, no accelerator** — the compute is just the provider's, whatever it is;
- **no hardware root of trust is *required*** — a TEE/attestation is an optional
  *assurance level* a deployment may demand, not a prerequisite of the network. A
  node with no TEE still participates, serves and replays; a deployment that needs
  a hardware root says so explicitly and refuses nodes without it.

That is the invariant to hold onto: **the AI — weights and engine — lives on the
RAREXT network, and the machine that asks runs nothing.** The engine being a
*portable network artifact* is what removes the hardware and software limits: the
network does not depend on what any particular node happens to have installed.

```bash
npm run demo:web4-model          # 34 phases: weights + RAREXT's own engine on the network
# weights + a PORTABLE engine (RAREXT's own transformer) on a sandboxed worker:
# real inference, two nodes agree and replay, and perturbed weights change the run
RAREXT_WEB4_GGUF=/path/to/model.rarext npm run demo:ai-on-rarext
```

The demo uses a prompt every fixture can tokenize (`abcdefgh`); set
`RAREXT_WEB4_PROMPT` for a model that needs another prompt. It also needs a model
whose greedy decode varies — a degenerate model that emits one repeated token
cannot demonstrate weight-dependence, and the demo says so rather than pretend.

runs the whole path with a deterministic native model in seconds:
`storage -> sealed -> provider -> deploy -> registry -> card -> announce -> serve ->
infer -> publish -> receipt -> attribute -> trace -> deterministic -> determinism ->
pay -> compare -> weights -> replay -> discover-deploy -> discover -> settle ->
redeem -> independence -> engine -> measure -> quote -> isolation -> rotate ->
engine-pin -> enclave -> mirror -> tamper -> verify` — 34 phases.

To put a real GGUF through the same path (by default served by the provider's own
Ollama as interop; see `RAREXT_WEB4_OWN_ENGINE=1` below):

```bash
RAREXT_WEB4_GGUF=/path/to/model.gguf \
RAREXT_WEB4_MODEL=qwen2.5:0.5b \
RAREXT_WEB4_ENGINE_MODEL=rarext-web4-qwen \
RAREXT_WEB4_QUANT=Q4_K_M \
RAREXT_WEB4_FAMILY=qwen2 \
npm run demo:web4-model
```

The demo shards the GGUF into RAREXT blobs, starts a provider that fetches and
reassembles them, and serves real completions. The caller still holds no weights
and runs no model. In the `engine` phase the GGUF is served a second time by
RAREXT's **own** GGUF engine artifact, with **no engine endpoint**: the provider
fetches and verifies both the weights and the engine, runs the transformer
itself, reproduces the same token trace twice, and refuses a tampered engine
artifact. The reference GGUF is 397,807,936 bytes (`qwen2.5:0.5b`, Q4_K_M).

Set `RAREXT_WEB4_OWN_ENGINE=1` to remove Ollama from the **whole** path, not just
the `engine` phase. The main bundle then names `engine: "rarext"` and **commits
the engine artifact itself** (`execution.artifact`): `bundle --engine-module`
shards and uploads RAREXT's GGUF engine before the model bundle is built, so the
engine's digest is part of the model identity. Every provider resolves the engine
from the bundle and verifies it, with no `--engine-bundle` flag and no engine
endpoint. Two providers run the fetched engine independently, so quorum,
determinism, and replay all run on RAREXT's own engine:

```bash
RAREXT_WEB4_GGUF=/path/to/model.gguf \
RAREXT_WEB4_MODEL=qwen2.5:0.5b \
RAREXT_WEB4_OWN_ENGINE=1 \
node scripts/demo-web4-model.mjs
```

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
  "execution": {
    "kind": "engine",
    "engine": "rarext",
    "engineModel": null,
    "artifact": {
      "id": "rarext-gguf-engine@1",
      "name": "rarext-gguf-engine",
      "engineVersion": "1",
      "runtime": "rarext.gguf-engine.node-cjs.v1",
      "artifactDigest": "sha256:…",
      "manifestHash": "<sha256 of the engine-bundle manifest>"
    }
  },
  "shards": [{ "index": 0, "hash": "<sha256>", "size": 8388608 }, "…"],
  "totalBytes": 397807936,
  "shardsRoot": "<sha256 over the shard list>",
  "createdAt": "2026-11-07T00:00:00.000Z",
  "digest": "<sha256 over the canonical bundle>"
}
```

`execution.artifact` is what makes the engine part of the model's identity; the
canonical bundle therefore commits weights **and** engine. A bundle built with
`--engine ollama` names an interop engine instead (`"engine": "ollama"`, no
`artifact`), and the provider then needs an engine endpoint. The portable default
is an engine artifact, so the same bundle works with no engine endpoint at all.

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
4. only then load the model — parse the committed native model, run the fetched
   engine artifact over the verified bytes, or (interop) write the verified file
   and ask the provider's Ollama to create it;
5. serve an OpenAI-compatible `/v1/chat/completions` and `/v1/models`;
6. publish a provider card at `/v1/provider-card` naming the bundle, the shard
   commitment, the manifest address, the model, and the execution class.

If one byte of one shard is wrong, the provider refuses to start. There is no
"best effort" load.

### Registry mirrors: no single registry is a dependency

A bundle is content-addressed, so its manifest and shards are the same bytes
wherever they are mirrored. A provider given more than one registry fetches each
shard from the **first registry that serves bytes matching the commitment**:

```bash
node apps/runtime/src/cli.ts provider --bundle model-bundle.json \
  --registry https://registry-a.example \
  --mirror-registry https://registry-b.example \
  --mirror-registry https://registry-c.example
```

A registry that is down, missing a shard, or serving the wrong bytes is skipped;
the provider fails only when every registry fails, and the error names what each
did. So one registry outage does not stop a provider from serving a model — the
same redundancy the discovery path gets from multiple registries, now on the
compute side.

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
chains to the pinned anchor is trusted — but by default an operator with root on the
enclave's host can still read its memory. A hardware TEE (SGX/SEV-SNP) is what makes
the enclave itself private; the `scheme` field and the attestation chain are shaped
for it, but no hardware root is wired in. A deployment that will not accept a
host-readable box can demand vendor-certified isolation (see *Memory isolation*
below): `--tee-isolation host-root-excluded` refuses any enclave whose signed quote
and vendor-signed image do not certify that the host root is excluded.

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

The key the caller seals to is **bound into the signed attestation**: the enclave
records `independence.enclaveKey` — a digest of its encryption public key — under
its quote, and `GET /v1/attestation` returns both the key and that attestation. A
caller checks the two against each other (`attestationBindsEnclaveKey`) before
encrypting anything, so a man in the middle cannot substitute its own key and
decrypt the prompt — the attestation's signature no longer vouches for it, and the
seal is refused. The same binding rides into the provider's response receipt (its
stable identity includes `enclaveKey`).

This protects prompts from the *relaying* process and from the operator of the
path, and the key binding protects the caller from sealing to the wrong key. It does
not protect them from an operator with root on the enclave's own host — the same
software-enclave caveat as above; a hardware TEE closes it, and a deployment can at
least demand a vendor-certified `host-root-excluded` capability so a host-readable
enclave is refused rather than assumed confidential.

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

### Provider receipts: the gateway is not trusted either

The quorum evidence above is what the GATEWAY recorded. So each provider also
signs a **receipt** over the exact exchange — its operator key over the request
digest, the comparable response digest, its own attestation, the engine it served
with, **and the bundle it served** — and returns it in an `x-rarext-receipt` header:

```json
{ "kind": "rarext.response-receipt.v1",
  "request": "<request digest>", "response": "<comparable response digest>",
  "attestation": "<digest of the machine/code/image identity>",
  "engine": "<the engine fingerprint this provider served with>",
  "bundle": "<the bundle digest this provider served>",
  "signature": "…", "publicKey": { … }, "suite": "ecdsa-p256" }
```

The gateway records each receipt in the run's `quorum.providers`; the verifier
checks that the `request` matches the run's request digest, the `response` matches
that provider's recorded `responseDigest`, the signature verifies, and the signing
key is the operator the run names. A gateway that rewrites a provider's answer — or
fabricates one — cannot produce a matching receipt, so the transcript proves what
each provider said, not just what the gateway claims.

The receipt also binds the provider's **attestation** — its machine, code, and
signed image, minus the volatile parts (the freshness nonce, the timestamp, and the
per-nonce quote). So an answer cannot be paired with a different enclave: if a
gateway records a run whose attestation is not the one the provider signed, the
receipt's `attestation` digest no longer matches what the run holds and the run
fails. The operator signs "this answer came from THIS enclave", and the same
binding holds whether the run recorded the static card or a freshly-challenged
attestation.

The receipt also binds the **engine**: the run's `engine.fingerprint` is the
deployment's committed value, and every agreeing provider's receipt MUST carry that
same fingerprint — the value it *says* it served with. A run that commits an engine
no agreeing provider signed (a provider on another engine, or one whose receipt
omits the engine), fails verification — a verifier catches a changed engine, and a
run cannot claim an engine the providers did not attest, not only at replay.

And it binds the **bundle**: the run's `bundle.digest` is the committed weights,
but the receipt carries the bundle digest the provider *says* it served. A provider
serving other weights signs a different value, so a run attributed to the committed
model but served by another one fails — the answer is tied to the exact weights the
provider signed, not just to the deployment's claim about them.

Presence is part of the rule, not just correctness: **every recorded provider that
answered — whether it agreed or dissented — must present a receipt** once the run
commits evidence: an engine fingerprint, a model bundle, a pinned vendor, or a
recorded attestation. Otherwise a gateway could count a provider that signed
nothing toward the quorum and record the run under a committed engine/bundle/enclave
that no one attested, which is exactly the attribution gap receipts exist to close.
Dissenters are included for the same reason: a gateway must not be able to invent an
unsigned dissenting voice to pad the answered count or the recorded provider set —
a provider entry with no signature is not evidence of anything. A loose run, with no
committed evidence, may still omit them; a run that names evidence may not.

The single-provider path is held to the same rule. A non-quorum run records the
one provider that answered in `provider` — its `endpoint`, the `operator` and
attestation the gateway observed, and the provider's own `receipt`. When the run
commits evidence, that block is required and the receipt must bind the exact
response (and the committed engine/bundle), so a single-provider web4 run cannot
attribute a committed model or enclave to no one. A pass-through stream has no
complete body to sign; it still must name the provider it came from, but cannot
carry a receipt.

A stream carries no receipt (there is no complete body to sign), and an env-var
label operator is not a key, so the binding is enforced whenever the operator is a
key id.

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

The machine is not a label the recorder types: it must be the machine the
provider's **own signed quote** binds. Each agreeing provider's attestation must
carry a `quote` that verifies (`verifyProviderQuote`) and whose covered `machine`
equals the machine the run records; a provider with no valid machine quote has no
machine and cannot count toward a machine-distinct quorum. `deploy
--independence machine` refuses a card with no signed machine quote, and a
gateway that is given no signed attestations refuses the run (`503`). With
`--tee-vendor` pinned the same quote must additionally chain to the vendor root,
so the machine is vendor-rooted rather than self-declared.

The honest boundary that remains: even a vendor-rooted quote proves the machine
id the leaf ATTESTED, not that two leaves are on physically separate boxes — a
vendor that certifies both leaves can be lied to, and `independence.measurement`
is a hash of the declared id (a real TEE would put the enclave measurement
there). The protocol makes the machine claim signed and, when pinned,
vendor-rooted; it cannot make the vendor's certification honest.

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

### Root rotation and revocation

A pinned root is not static forever. The protocol ships an append-only
`rarext.root-rotation.v1` chain: each step retires one root and names its
successor, carries both public keys, a monotonic `epoch`, a digest of the previous
step, an optional `revoke` list, and is **signed by the root being retired**. Authority
therefore flows forward from the shipped anchor; an unrelated key cannot claim the
next root.

```bash
node apps/runtime/src/cli.ts provider --bundle model-bundle.json \
  --tee-key-file leaf.json --tee-cert-file chain.json \
  --tee-root-chain-file root-chain.json

node apps/runtime/src/cli.ts deploy --web4 --provider https://alice.example \
  --quorum 1 --tee-vendor <anchor-key-id> --tee-root-epoch 1 \
  --registry https://registry.example
```

`deploy --tee-root-epoch 1` commits `labels.teeRootEpoch` and REFUSES unless every
adopted provider's root chain starts at the pinned anchor, advances the epoch by
exactly one per step, links each step to the previous digest, presents public keys
whose ids match the roots they name, and terminates at the root that issued the
provider's certificate chain. The challenge commits `spec.teeRootEpoch`; the
gateway and the verifier recompute the same rule.

Three refusals follow. A quote still rooted at the **retired anchor** is stale once
the deployment has learned the rotation. A quote that terminates at a **revoked**
root is refused even if that root is current. A **forged handover** — a rotation
whose successor key does not hash to the key id it claims — breaks the chain.

The honest boundary is unchanged: the anchor is still a key shipped in a file, not
a fused hardware root, so "the vendor rotated its root" is only as trustworthy as
the anchor itself. Rotation removes the *static* limit (a compromised or retired
root could never be replaced), not the *file-versus-fuse* one.

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

Each link also carries a `measurement` (a digest of that stage's image), and a
deployment can pin the values it approves:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --tee-vendor <vendor-root-key-id> --tee-chain-depth 3 \
  --tee-boot-stages firmware,os,app \
  --tee-boot-measurements firmware=<hex>,os=<hex>,app=<hex> \
  --registry https://registry.example
```

`deploy --tee-boot-measurements` commits `labels.teeStageMeasurements` and REFUSES
unless every adopted provider's chain carries exactly those values. The challenge
commits `spec.teeStageMeasurements`; the gateway and the verifier require each
agreeing provider's per-stage measurement to equal the approved one, so the stage
names become checked values — a chain running different firmware is refused even
though it reaches the vendor root and names the stages.

### Freshness

An attestation is only worth as much as it is fresh: a captured quote replayed
later is not proof the machine is running that image NOW. `--tee-freshness
challenge` closes that. Each run, the gateway generates a nonce and asks every
provider for its attestation bound to it:

```
GET /v1/attestation?nonce=<hex>   →   { "attestation": { …, "challenge": "<hex>", "quote": { … } } }
```

The provider re-signs a quote covering the nonce, and the gateway records those
nonce-bound attestations in the run. A provider that answers with a stale
(unchallenged) quote is refused before a run is written, and the verifier requires
every agreeing provider to bind the SAME nonce — one run, one challenge, so a
replayed attestation cannot pass. `deploy --tee-freshness challenge` commits
`labels.teeFreshness`; the challenge commits `spec.teeFreshness`.

### The enclave's own code

A boot chain measures the firmware and OS; the enclave's OWN code is a separate
thing. Each provider measures the code it is running — a digest of the runtime
source on disk — and attests it as `independence.code`. A deployment pins the
code it approves:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --tee-vendor <vendor-root-key-id> --tee-code <code-measurement> \
  --registry https://registry.example
```

`deploy --tee-code` commits `labels.teeCodeMeasurement` and REFUSES unless every
adopted provider attests that digest. The challenge commits
`spec.teeCodeMeasurement`; the gateway refuses a run in which any agreeing
provider attests other code, and the verifier recomputes the rule from the run.
So an enclave running different code is refused by name — the code identity is
pinned, not merely claimed. `provider --code-measurement <hex>` overrides the
measured digest (for a build that measures itself out of band).

#### The image manifest: the digest is vendor-signed

A self-computed digest is only what the running process says. It becomes a
certified value when a **vendor signs an image manifest** for it, and its signer is
bound to a trust ANCHOR by a certificate chain (the same chain shape the machine
quote uses):

```json
{ "kind": "rarext.image-manifest.v1", "image": "<code digest>", "runtime": "…",
  "publishedAt": "…", "signature": "…", "publicKey": { … }, "suite": "ecdsa-p256",
  "chain": [ { "subject": { …signer… }, "issuer": { …anchor… }, "signature": "…" } ] }
```

`provider --image-manifest <file>` makes the provider refuse to run unless the
manifest is valid AND its `image` is the code the process is actually running, then
binds the manifest into its attestation (`independence.image`). A deployment pins
the vendor **root** the manifest's chain must terminate at:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --tee-vendor <vendor-root-key-id> \
  --tee-code <code-digest> --tee-signed-image <vendor-root-key-id> \
  --tee-signed-image-depth 1 \
  --registry https://registry.example
```

`deploy --tee-signed-image` commits `labels.teeSignedImage` and REFUSES unless every
adopted provider presents a manifest whose chain reaches that root and vouches for
the approved code. `--tee-signed-image-depth <n>` additionally commits
`labels.teeSignedImageDepth` and requires a certificate-chain of at least that
depth, so a manifest signed **directly by the anchor with no chain** (depth 0) is
refused: the signer must be *certified* by the root, not merely equal to it —
mirroring `--tee-chain-depth` for the machine quote. The gateway and the verifier
recompute both: the chain's ROOT (not the leaf) must equal the pin, and its depth
must reach the minimum. A manifest signed by a bare, self-rooted operator key, one
signed directly by the root, one signed by another vendor, or one whose measured
image is not the signed one is refused. The code digest is bound to the pinned trust
anchor, not the running source's word.

#### App stage = signed image

The measured boot and the image manifest are two claims about "the code": the boot
chain's final (`app`) stage measurement, and the manifest's `image`. When a
deployment commits `--tee-signed-image`, the two must **agree** — a provider whose
boot chain measures one thing and whose signed image vouches for another is refused,
even though each attestation is individually valid. So `app` is not a free-floating
measurement: it must BE the image the vendor signed. This is checked at the gateway
and recomputed by the verifier alongside the root and depth checks.

The honest boundary: the root is a fixed key shipped with the protocol, so this is
the *shape* of a hardware root — a deployment pins a vendor root it did not choose,
a chain must extend through the stages it trusts, each stage's measurement must be
the approved value, the enclave's own code must be the approved build under the
vendor's signature, and each attestation must be fresh for a nonce the verifier
chose — but the root is still a file, not a fuse, and the measurements are digests
the code and chain carry, not values a silicon records. A real TEE (SGX/SEV-SNP)
records the measurements in hardware, holds the root in silicon, and signs the nonce
with a key that never leaves the chip; the chain, the stages, the measurements, the
code digest, the signed image manifest, the nonce challenge, and the `scheme` field
are built for it, but no hardware root is wired in.

#### Memory isolation: refusing a host-readable enclave

A software-only enclave's own host root can read its memory, so sealing weights and
prompts to it hides them from the wire and the store but not from the operator. The
protocol cannot create memory isolation — only a TEE can — but it can refuse to call
a host-readable process confidential. An image manifest can carry a
**memory-isolation capability**:

```json
{ "kind": "rarext.image-manifest.v1", "image": "<code digest>", "runtime": "…",
  "isolation": "host-root-excluded", "signature": "…", "chain": [ … ] }
```

`isolation` is covered by the vendor signature, so it is a certified capability, not
a running process's word. A provider attests the same capability with
`--isolation host-root-excluded` (covered by its machine quote), and a deployment
demands it with:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --quorum 1 \
  --tee-vendor <root> --tee-signed-image <root> --tee-isolation host-root-excluded \
  --registry https://registry.example
```

`deploy --tee-isolation` commits `labels.teeIsolation` (which requires
`--tee-vendor` and `--tee-signed-image`) and REFUSES unless every adopted provider's
signed quote AND vendor-signed image manifest both certify
`host-root-excluded`. The challenge commits `spec.teeIsolation`; the gateway refuses
a run in which any agreeing provider's quote or vendor-signed manifest does not carry
the capability, and the verifier recomputes the same rule. The enclave's encryption
key is bound into the same signed quote (`enclaveKey`), so the key a caller seals
weights or prompts to is inside the vendor-attested isolation claim — a substituted
key, a quote without the capability, or a signed image without it is refused.

The honest boundary: this makes memory isolation a **checked, vendor-certified
capability** that a host-readable enclave cannot satisfy — but the protocol cannot
manufacture the isolation itself. The vendor that signs `host-root-excluded` is
asserting the image runs in a mode whose memory the host root cannot read, and the
root that certifies it is still a shipped key, not fused silicon. The capability
closes the *policy* gap (a deployment need not trust the operator's box); the
*hardware* gap needs a real enclave.

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

### Off-ledger settlement: the adapter

Removing credits from the ledger (a redemption, above) is the ledger half of a
cash-out; actually moving value out is the outside world's, so the node does it
through a pluggable **settlement adapter**. When a redemption is received, the node
calls `adapter.settle({ keyId, amount, reference, redemptionId })` FIRST:

- **The adapter succeeds** → the node records the credit removal AND a settlement
  receipt bound to the redemption and the external reference (`adapter`,
  `settlementId`, `detail`, `binding`), and returns both in the response.
- **The adapter throws** → the node returns `502` and removes **no** credits: the
  ledger never loses value the outside world did not receive. The refusal is
  atomic — nothing is written.

The receipt is not taken on faith. An adapter can sign the settlement payload
(`rarext.settlement-receipt.v1`: the redemption id, payer, amount, external
reference, settlement id, and detail) with its own key; the node pins that key with
`RAREXT_SETTLEMENT_KEY` (or `AppOptions.settlementKey`) and verifies the signature
against the pinned key id before removing any credits. Every receipt also carries a
`binding` digest over those same facts, recomputed by
`verifySettlementReceipt(receipt, keyId)`, so an edited amount, reference, or
settlement id breaks both the binding and the signature. An unsigned receipt, or
one signed by another key, is refused exactly like a failed adapter: `502`, no
credits removed, no settlement recorded. `RAREXT_SETTLEMENT_KEY_FILE` gives the
echo adapter a signing key so a real chain or escrow can be wired the same way.

### Inclusion in the external ledger's signed state

A signed receipt says WHO claimed the movement; it does not say the external ledger
ever recorded it. So a node can pin the external ledger's key and require an
**inclusion proof**. The adapter returns an `inclusion` alongside its signature: the
settlement's leaf (`settlementLeaf(binding)`) with a Merkle path into a
`rarext.settlement-checkpoint.v1` — the ledger's state root at a height, signed by
the ledger's key. The node:

- recomputes the leaf from the receipt's own `binding`;
- verifies the Merkle path reaches the checkpoint's `root` (`verifyProof`);
- verifies the checkpoint signature and, when pinned, that its signer is the
  external ledger's key (`RAREXT_SETTLEMENT_LEDGER_KEY` / `AppOptions.settlementLedgerKey`);
- refuses a checkpoint **below** `RAREXT_SETTLEMENT_LEDGER_MIN_HEIGHT`, so an old
  but still-valid checkpoint cannot be replayed for a new redemption.

With a ledger key pinned, a settlement the ledger did not record — no inclusion, a
proof for another movement, a forked root, a stale height, or a checkpoint signed
by another key — is refused exactly like a failed adapter: `502`, no credits
removed, nothing recorded. `RAREXT_SETTLEMENT_LEDGER_KEY_FILE`,
`RAREXT_SETTLEMENT_LEDGER`, and `RAREXT_SETTLEMENT_LEDGER_HEIGHT` let the echo
adapter emit a real (single-leaf) checkpoint so a chain or escrow can be wired the
same way.

`GET /v1/work/settlement?keyId=…` lists the settlement receipts the node recorded,
so a redeemer can prove its redemption was settled against the reference it named.
An adapter is visible from the environment (`RAREXT_SETTLEMENT=echo` records the
movement by echoing the reference — a placeholder for a chain or escrow;
`RAREXT_SETTLEMENT=fail` always refuses, for testing the atomic path), or supplied
in code (`AppOptions.settlement`). With no adapter a redemption is ledger-only —
recorded with `settlement: null`.

The honest boundary: the protocol never moves real cash; it calls an adapter once,
atomically, and binds the adapter's answer to the ledger fact. A pinned adapter key
makes the recorded movement attributable, and a pinned ledger key plus an inclusion
proof makes it *recorded in a signed external state* — the movement cannot be
invented by a node that holds neither key, and cannot be replayed from a stale or
forked checkpoint. What it still does not prove is that value actually left the
system, or that the external ledger is honest: the checkpoint signature is the
receipt of a state, and the ledger's key is itself an anchor.

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

For a GGUF served by RAREXT's own engine (`engine: "rarext"`), the transformer is
a fixed, deterministic artifact: the provider fetches the exact engine bytes,
greedy decoding records the generated token ids, and a replay on the same engine
artifact re-runs and compares token-for-token. For a *third-party* engine, exact
token replay still depends on the engine, hardware, and decoding state; RAREXT
does not pretend otherwise. The run remains an exact transcript, and a provider
holding the same `weightsDigest` is what makes a replay meaningful.
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

A verifier also catches a changed engine **without a replay**: each provider's
receipt signs the engine fingerprint it actually served with, and the verifier
requires it to equal the run's committed `engine.fingerprint`. So a gateway cannot
record a run attributed to the pinned engine but served by another one — the
provider's own signature disagrees and the run fails.

```bash
# replay refuses a provider whose engine differs from the pinned one
node apps/runtime/src/cli.ts replay --transcript run.json --endpoint https://other.example
# engine differs — <pinned> vs <present>
```

This does not make an arbitrary GGUF bit-for-bit reproducible; it makes a replay
of one *checkable*: same weights, same engine, and the output compared — or the
replay is refused by name.

### The decode trace

For the deterministic `native` class, a replay is checked at the level of the
DECODE, not just the text. The provider records the token ids it emitted as a
`rarext_trace` in the response:

```json
"rarext_trace": { "kind": "rarext.decode-trace.v1", "tokens": [3, 7, 1, …], "digest": "…" }
```

An engine that exposes no token ids (a **wasm or custom engine that returns only
text**) is not exempt: the provider records a `rarext.output-trace.v1` carrying a
digest of the exact completion text, so every engine commits *something* a replay
can check bit-for-bit:

```json
"rarext_trace": { "kind": "rarext.output-trace.v1", "outputDigest": "…", "digest": "…" }
```

Both kinds are validated by one shared `validDecodeTrace`/`decodeTraceOf`, so a
`--require-trace` deployment, the gateway, and the verifier agree on what a trace
is, and `tracesMatch` compares token ids for a decode trace or the output digest
for an output trace.

The `digest` binds the tokens to the response, so the verifier recomputes it —
editing the tokens is caught in the transcript. A replay re-runs, digests its own
token ids (or output), and **refuses when the trace diverges** from the committed
one, even if
the text happened to match: the point is that the same bytes were decoded, not
that a similar string came out. `replay` reports `traceMatches`, and a divergence
ends the replay by name.

### The engine judgment

An engine run can be checked at the decode level too, when the engine exposes
per-token logprobs. With `provider --engine-logprobs`, the provider asks the engine
for logprobs and records a **judgment** — the token sequence and each token's
logprob — as the run's trace:

```json
"rarext_trace": { "kind": "rarext.judgment.v1",
                  "tokens": ["hello", " world", …],
                  "logprobs": [-0.1, -0.2, …], "digest": "…" }
```

The verifier recomputes the digest the same way (over the trace without the digest
field), so editing a logprob is caught. A replay re-runs on the pinned engine,
records its own judgment, and refuses when the digest diverges — so an arbitrary
GGUF run is checked at the token/logprob level, not only at the text level. An
engine that exposes neither token ids nor logprobs records no trace, honestly;
`--engine-logprobs` is opt-in because not every engine supports it.

### Requiring a trace

The trace is opt-in from the provider's side, so a deployment can make it a
requirement of its own:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --require-trace \
  --registry https://registry.example
```

`deploy --require-trace` commits `labels.trace = "required"`, and the challenge
commits `spec.requireTrace`. Then every run must carry a **valid** decode trace —
the native token ids or an engine judgment — and the verifier adds a
`response.decodeTraceRequired` check, so a run whose response omits the trace fails
even if everything else is consistent. The gateway refuses the run *before* writing
it: a provider (or engine) whose response carries no trace, and a pass-through SSE
stream that has no complete body to commit a trace over, are both refused `503`.
So a deployment can insist on the decode-level evidence rather than trusting that
the provider happens to emit it.

### Requiring a replayable run

A run is only *reproducible* if the caller asked for deterministic decoding — a
temperature of 0 and a seed — which the run records as a replay envelope. A
deployment can make that mandatory:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --provider https://bob.example \
  --quorum 2 --require-replay \
  --registry https://registry.example
```

`deploy --require-replay` commits `labels.replay = "required"`, and the challenge
commits `spec.requireReplay`. The gateway refuses a **sampled** request — one with a
temperature above 0, or no seed — with `422` before it forwards anything, so a
non-reproducible run is never recorded. The verifier adds a `replay.required` check,
so a run that arrives without a valid replay envelope fails, even if every other
digest is consistent. Together with `--require-trace` this is the strongest shape:
every run is deterministic, carries its decode trace, and can be re-derived by any
reader holding the same bundle and engine.

### Determinism class: an independent witness

A trace and a replay envelope still prove less than they appear to. A provider can
run any arithmetic and write any token ids; one run's trace is only that
provider's word, and a reader who merely recomputes the digests is checking that
the provider was *consistent*, not that the engine *reproduces*. The protocol
closes part of that gap with a committed **determinism class**:

```bash
node apps/runtime/src/cli.ts deploy --web4 \
  --provider https://alice.example --quorum 1 \
  --determinism deterministic-replay \
  --registry https://registry.example

node apps/runtime/src/cli.ts serve --manifest .rarext-runtime/deployment.json \
  --witness https://witness.example --publish
```

`deploy --determinism deterministic-replay` commits `labels.determinism` (and, as
a consequence, `trace` and `replay` required); the challenge commits
`spec.determinism`. Every run under the class must then carry a **witness**: a
second, independently recorded run whose decode trace — native token ids, or an
engine token+logprob judgment — matches the run **token-for-token**. The witness
embeds its own response and the provider's own signed receipt over it, so it is
not the recorder's word.

`serve --witness <url>` names one or more providers OUTSIDE the committed provider
set. Before recording, the gateway sends the exact same request to a witness
provider, checks that its trace matches token-for-token, and refuses the run
(`503`) if the engine did not reproduce, if the witness is the run's own provider,
or if no independent witness is configured. The verifier recomputes the same rule:
the shared request, the token-for-token trace, the witness receipt signature (and
the engine and bundle it binds), and independence from every provider that
produced the run. Stripping the witness, reusing a run provider as the witness,
diverging a token, or editing the witness receipt all fail `determinism.replayWitness`.

The honest boundary: a witness raises the cost of a false determinism claim from
one signature to two independent ones, and it makes the claim checkable rather
than asserted — but it still does not prove the engine's arithmetic is
reproducible on any machine. Two co-located providers are two keys, not two
boxes, and a bit-for-bit proof needs hardware plus an engine that exposes its
arithmetic, which the protocol cannot supply.

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
  measurements, machine quotes chained from the VENDOR hardware root through a
  measured boot whose per-stage measurements are allowlisted, and nonce-FRESH
  attestations — but the shipped root is a file, not a fuse, and the measurements
  are digests the chain carries, not values a silicon records.** The card names a key
  id, machine, and measurement under the operator's signature, plus a leaf-signed
  quote chained up through firmware and the OS to the vendor root the protocol ships
  (`hardware-root.ts`); the deployment commits the operators, operator-aligned
  machines, a measurement allowlist, and (with `--tee-vendor` + `--tee-chain-depth` +
  `--tee-boot-stages` + `--tee-boot-measurements` + `--tee-freshness challenge`) the
  vendor root, minimum depth, required boot stages, approved per-stage measurements,
  and freshness. A quorum then needs that many distinct keys and machines, every
  agreeing provider on the approved list, and every agreeing quote's chain reaching
  the pinned vendor root at that depth, naming every required stage, carrying the
  approved measurement per stage, AND bound to one fresh nonce for the run — enforced
  by the gateway and recomputed by the verifier. A machine-independent quorum counts
  SIGNED machines only: each agreeing provider's recorded machine must be the machine
  its own verifying quote binds, so a run cannot pass distinct strings the gateway
  typed, and with a vendor pinned that quote is also chained to the vendor root. A
  deployment can additionally demand vendor-certified memory isolation
  (`--tee-isolation host-root-excluded`): every agreeing provider's signed quote AND
  vendor-signed image must certify that the host root cannot read its memory, so a
  host-readable software enclave is refused — but the protocol cannot manufacture the
  isolation, only refuse to call the absence of it confidential. The operator supplies only a LEAF
  key and cannot mint its own trust: a bare leaf (depth zero), a chain ending at an
  operator anchor, a chain rooted elsewhere, a chain that skips the boot stages, a
  chain running unapproved firmware/OS/app, a REPLAYED (stale) attestation, a quote
  still rooted at a retired anchor, or one terminating at a revoked root is
  refused by name. An append-only, root-signed rotation chain
  (`--tee-root-epoch`) lets the anchor move forward without resetting the pin, so
  a compromised or retired root can be replaced; the anchor is still a shipped key
  file, not a fused root. What it still does not prove is that the machine ids name
  physically separate boxes, that the measurements reflect a real boot, or that the
  vendor root is real silicon: the root is a fixed key the protocol ships and the
  measurements are digests the chain carries, so it is hardware-*shaped* but a file.
  A TEE that records the measurements in hardware, fuses the root into the chip, and
  signs the nonce with a key that never leaves the chip is what closes that last gap;
  the `scheme` field, the chain, the stages, the measurements, and the nonce
  challenge are built for it, but no hardware root is wired in. The bundled demo's two providers are co-located, which is why a
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
  enclave — the forwarder, a gateway, or a relay never sees them. The enclave's own
  code is pinned and the digest is bound to an image manifest whose certificate
  chain must reach the pinned hardware root, at a minimum depth, and the boot chain's
  `app` stage must equal that signed image (`--tee-code` + `--tee-signed-image` +
  `--tee-signed-image-depth`), so an enclave running different code, an image signed
  by another vendor, a manifest signed by a bare self-rooted key, one signed directly
  by the anchor with no chain, or a boot chain whose app stage disagrees with the
  signed image is refused — the code identity is checked and its trust anchor, depth,
  and its own measured stage are pinned, not merely
  claimed. But a software enclave
  is not silicon: an operator with root on the enclave's host can read its memory
  and, with it, the prompt, and the root the manifest chain terminates at is a key
  file shipped with the protocol rather than one a chip holds. A hardware-rooted TEE
  (SGX/SEV-SNP), whose image measurement the silicon takes and whose root key never
  leaves the die, is what closes that; the attestation chain, the certificate chain,
  the code digest, the signed image manifest, and the `scheme` field are shaped for
  it, but no hardware root is wired in.
- **Inference is not cryptographically proven.** The run transcript proves the
  bytes exchanged; a deterministic native model can be replayed from the bundle,
  and for that class the run records its **decode trace** (token ids + digest), so
  a replay is refused when the decode diverges — not just when the text does. An
  engine run can be checked at the same level when the engine exposes per-token
  logprobs: `--engine-logprobs` records a **judgment** (tokens + logprobs + digest),
  and a replay of it is refused when the judgment diverges. A deployment can even
  REQUIRE a trace (`--require-trace`) AND a replay envelope (`--require-replay`):
  then a run whose response carries no trace, or a sampled request with no envelope,
  is refused by the gateway and fails verification. A deployment can go one step
  further and commit a determinism class (`--determinism deterministic-replay`):
  every run must then carry an independently recorded witness — a second run from a
  provider outside the run's own set — whose decode trace matches token-for-token,
  signed by that provider, so the claim rests on a second signature rather than one.
  An engine that exposes neither tokens nor logprobs is not traceable-free: it
  records a `rarext.output-trace.v1` (a digest of the exact completion) by default,
  and a replay whose output diverges is refused bit-for-bit — a text coincidence
  does not pass. What is still not proven is that the engine's arithmetic IS the
  model's: an arbitrary GGUF is not *independently* reproduced by the protocol
  alone, and two co-located witness providers are two keys and not two machines.
  For such an engine the protocol pins the engine (`engine.fingerprint`) and
  refuses a replay whose provider runs a different engine: a checked re-execution
  under a named engine, not an independent proof of determinism.
- **Credits move on the ledger, and can leave it against an external
  reference — but the protocol does not move real value.** A committed bounty is
  recorded and settled in RAREXT's credit ledger; the run commits who was paid, the
  verifier recomputes it, and an operator proves its receipt against the ledger
  root. A key can move credits to another key with a signed transfer
  (`/v1/work/transfer`, a zero-sum pair) or take them out with a signed redemption
  (`/v1/work/redeem`, a debit with no credit that lowers the ledger supply),
  refused if it would overdraw the payer and proved against the same whole-ledger
  root. The settlement half is attributable and recorded: a pinned adapter key
  signs the exact settlement (`rarext.settlement-receipt.v1` over redemption id,
  payer, amount, reference, settlement id, and detail), a pinned external-ledger
  key plus a Merkle inclusion proof binds it into a signed checkpoint at a fresh
  height, the node verifies both before removing credits, and an unsigned,
  mis-signed, unrecorded, stale, or forked receipt is refused atomically. What no
  protocol can do is hand over cash or prove the external ledger is honest: an
  inclusion proof shows the movement is in a signed STATE, and the ledger's key is
  the receipt of that state, not the funds.
- **The engine can be a RAREXT artifact, a third-party WASM binary, a sandboxed
  worker program, or RAREXT's own GGUF/RXHF engine — no container runtime is
  needed for any of them.** The engine
  is sharded into RAREXT (`rarext.engine-bundle.v1`), the provider fetches and
  verifies it, runs the fetched engine, and folds the artifact digest into the
  engine fingerprint — so the engine is a RAREXT artifact, not the box's. A
  foreign engine compiled to WebAssembly runs in-process under the
  `rarext.wasm-engine.wasm.v1` runtime with an empty import object; a JS engine
  module runs in a `node:vm` context with no `require` and no filesystem; and the
  GGUF runtime (`rarext.gguf-engine.node-cjs.v1`) is RAREXT's own transformer. So
  a qwen2 GGUF is served with no Ollama, llama.cpp, native addon, or container,
  and no engine endpoint: weights and engine both come from RAREXT. A foreign
  native engine *program* runs sandboxed on a worker thread
  (`rarext.worker-engine.node-cjs.v1`), and a foreign *binary* runs as WebAssembly
  (`rarext.wasm-engine.wasm.v1`). What remains genuinely blocked here is a raw
  **ELF/Mach-O image**: executing machine code needs a kernel/OS sandbox — a
  container runtime, seccomp/`sandbox-exec`, or a VM — and this environment
  provides none, so the provider refuses it rather than pretend. RAREXT's own engine now
  covers qwen2, llama/mistral, **mixtral** (top-k expert routing over a stacked
  expert bank) and **gemma** (GeGLU, norm weights biased by +1, and the
  `sqrt(n_embd)` embedding scale), **phi3** (partial NeoX rotary, fused QKV,
  fused gate/up, LongRoPE factors) and **phi2** (LayerNorm with bias, GELU,
  parallel FFN residual), plus every tensor type listed above, including the
  IQ2/IQ3/IQ1 grid quants. The grid-quant decoders are verified two ways:
  hand-computed values taken from ggml's own grid rows plus a full IQ2_XXS
  decode through the quant-domain dot path (all seven types), and real
  IQ-quantized GGUFs served end-to-end at 34/34 with a replayed decode trace
  (`Qwen2.5-0.5B-Instruct-IQ2_M`, IQ2_S+IQ3_S tensors; `…-IQ3_XS`, IQ3_S
  tensors). Hugging Face safetensors are ingested by RAREXT's own converter into
  the `RXHF` container, so no llama.cpp tooling is needed to serve them; that
  ingest implements qwen2/llama with both a byte-level BPE `tokenizer.json` and a
  **SentencePiece `tokenizer.model`**, whose protobuf it parses directly (no
  `sentencepiece` dependency). It also **quantizes**: the third argument selects
  `F32`, `Q8_0`, `Q4_0`, `IQ4_NL` or **`Q4_K`** (the K-quant super-block: 8 six-bit
  scales and 8 six-bit mins packed the way ggml reads them). A 2-D weight matrix
  is quantized when its columns span whole blocks — 32 values for Q4_0/Q8_0/IQ4_NL
  and 256 for Q4_K. Under `Q4_K`, a weight row too narrow for a 256 super-block
  falls back to `Q8_0` (a GGUF "K_M" mix) for a smaller container, and
  norms/biases keep the checkpoint's F16/BF16/F32 dtype, so the container always
  decodes. Sixteen-bit weights are not a slow path: the engine converts F16 and
  BF16 through precomputed 64K tables (BF16 is just the top half of a float32),
  so a 16-bit-heavy container fits the gateway's upstream window without any
  fallback — a 0.5 B model runs ~3 s/token, not ~86 s. The compute is the
  provider's.
