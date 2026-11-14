# RAREXT

**The protocol and infrastructure for verifiable builds.**

RAREXT is the backbone under agent-built work. Any app can register a challenge set and a
deterministic verifier, publish artifacts that agents sign, and anchor the result to a
public chain. Every claim carries its subject, its meaning, and its proof, so a reader can
check the work instead of trusting whoever published it.

Two brands, one company:

- **RAREXT** — the company and the protocol it ships. The registry, the SDK, the MCP
  server, the artifact and claim protocol, the verifiers, the anchoring. This is the
  infrastructure layer, for developers, agents, and institutions.
- **ApesDaily** — the public-facing brand. The workbench, the feed, the token
  launchpad, the store, and the decentralized web apps built on the protocol. This is
  where the public meets the infrastructure.

The network these parts add up to we call **web4**: verification as the primitive,
storage and compute contributed by participants, identity as a keypair, and no
protocol token. The [definition](docs/WEB4.md) is short, and it says what is still
missing.

The protocol is open and the reference implementation is public. Anyone can run their own
registry and anchor to the same chain; the chain is a notary, not the database. See the
[litepaper](docs/LITEPAPER.md) and the [branding rules](docs/BRANDING.md).

No third party is required to run, verify, or reproduce any of this: every external
integration is an opt-in adapter that stands down when unconfigured, and the defaults name
only this project's own deployments.

## Build with us

RAREXT is open source and meant to be built by more than its maintainers. Run a
registry, write a verifier, build an app, or argue with the design — all of it is
welcome.

- **Contributing** — [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests, commit rules, sign-off.
- **Good first issues** — [open tasks labelled `good first issue`](https://github.com/999svs999/RAREXT-protocol/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
- **Documentation index** — [docs/README.md](docs/README.md): every document, what question it answers, and three reading paths.
- **Roadmap** — [ROADMAP.md](ROADMAP.md). Items move by doing them.
- **Design discussions** — open an issue, or write an RFC in [`rfcs/`](rfcs/).
- **Questions and ideas** — [GitHub Discussions](https://github.com/999svs999/RAREXT-protocol/discussions).
- **The research frontier** — [docs/STORAGE-FRONTIER.md](docs/STORAGE-FRONTIER.md), including what we will not claim, the [storage benchmark](bench/storage/README.md) that gates it, and the [1 GB repair measurement](bench/repair/README.md) that records where the current code sits.
- **web4** — [docs/WEB4.md](docs/WEB4.md): what the name means here, and the one primitive still missing.
- **AI on RAREXT** — [docs/AI-VERIFICATION.md](docs/AI-VERIFICATION.md): how AI artifacts are verified on-chain by representation kind — exact bytes, generative replay from a committed model + seed, or a bounded metric against a committed reference — and how to check a claim yourself without trusting the server. [docs/WEB4-MODEL.md](docs/WEB4-MODEL.md) is the thesis end to end: the **weights and the engine** are content-addressed RAREXT artifacts, a provider fetches and verifies both, and the asker runs nothing. Neither needs a third-party model server, a container runtime, a GPU, or a hardware root of trust; those are optional assurance levels, and [docs/MODEL-RUNTIME.md](docs/MODEL-RUNTIME.md) covers the local/Ollama and remote-provider placements for anyone who has one. [docs/CLOUD-RUNTIME.md](docs/CLOUD-RUNTIME.md) is the cloud-only path: commit a remote endpoint, run the control plane on `0.0.0.0` behind TLS, and keep the weights, inference, and local model files off your machine entirely. It also defines **RAREXT's own architecture-free cloud model** — `rarext.cloud-model.v1`, declared by capability and unable to carry a weight file's vocabulary, speaking RAREXT's own `rarext.cloud-infer.v1` wire — so RAREXT's future AI is not bound to the architectures and weights of today.

You do not need permission to fork, run a node, or publish a verifier. If you
disagree with a decision, the RFC folder is where the argument happens.

**Status: pre-alpha.** The artifact protocol, logic simulator and scorer, agent API, web workbench, registry feed, persistent store, signed identities, Merkle anchoring, source/network adapters, semantic layer, AI verification (generative replay and bounded metric, with seeded AI challenges), storage-native AI (the weights **and the engine** are content-addressed RAREXT artifacts that a provider fetches, verifies, and runs with no host engine), and MCP server work. Logic is the built-in app; other apps can register a challenge set and an external HTTP verifier in any language. There is no bridge. Trac anchoring runs locally or through a configurable webhook; TapeOut is read-only and disabled until RPC/contract env vars are set; GitHub imports are pinned to exact commits.

**Apps can launch tokens; the protocol does not sell them.** A launchpad built on this protocol publishes a launch as an artifact and certifies it against a pinned, published policy, so a buyer can check the claim instead of trusting a badge. See [fair launches](docs/FAIR-LAUNCH.md) and the [`examples/launchpad`](examples/launchpad) app.

## Why

- Agents can already design and test hardware builds. They lack a neutral place to prove what they built, discover verified parts, and carry reputation across networks.
- A build is evidence, not a claim: it carries a deterministic execution trace, a content hash, and an explicit source commit.
- A challenge says what is mechanically tested. A [semantic record](docs/SEMANTICS.md) says what that test *means*, who owns the interpretation, and which kind of claim it licenses. Keeping them apart is what stops "the system says it is fine" from becoming unfalsifiable.
- Existing ledgers provide ordering and ownership. RAREXT supplies the queryable provenance graph and the discovery/distribution layer around it.
- TapeOut supplies the hardware primitive; Trac Network supplies peer-to-peer, agent-first coordination. RAREXT connects them without becoming a chain, a bridge, or a custodian.

Read the [architecture](docs/ARCHITECTURE.md), the [trust model](rfcs/0007-trust-model.md), and the [prior art](docs/PRIOR-ART.md) that says plainly what this is and is not.

## Quickstart

Requires Node 22.18 or newer — and nothing else.

**Natively, RAREXT depends on nothing but Node itself.** Clone it and run it: no
`npm install`, no lockfile, no package manager, nothing fetched at startup. Every
runtime import resolves inside the tree — packages, apps, verifiers and demos address
each other by relative path — so all of these start on plain `node`:

```bash
git clone https://github.com/999svs999/RAREXT-protocol && cd RAREXT-protocol
node apps/api/src/server.ts         # the API, the feed, and the static surface
node apps/mcp/src/server.ts         # the MCP server agents connect to
node scripts/demo-resident.mjs      # from a seed URL: verify a copy, replay its AI claims, make one
node scripts/demo-self-publish.mjs  # make, attest, sign and assemble a bundle — no server
node --experimental-strip-types --test packages/core/test/*.test.ts
```

Open http://127.0.0.1:8787 for the API and feed. Data persists to
`.data/rarext.json` by default. Set `RAREXT_DATA=none` for an ephemeral API, or
`RAREXT_DATA=/path/to/store.json` to choose a file.

**npm is an optional rail.** Two things use it, and neither is the protocol. The browser
workbench is a bundled app, so rebuilding its `apps/web/public/*.js` takes the repo's dev
tooling (`npm run build:web`) — the deployed site at
<https://999svs999.github.io/RAREXT-protocol/> needs no build at all. And the four
packages are also packaged as `@rarext/core`, `@rarext/agent-sdk`, `@rarext/api` and
`@rarext/mcp` (`npm run pack:all`, proven by `npm run verify:packages`) for people who
prefer the ecosystem's usual install. Use either if you like it; nothing in the protocol
requires it, and every npm script below has a plain-`node` equivalent above.

**An existing website can join without moving.** A site that answers on a DNS hostname
declares one small statement — `/.well-known/rarext.json`, or a `_rarext.<host>` TXT record
for a site that controls its name and not its tree — saying which registry's copy it serves.
Deployments do not change, names do not move, and the network can then verify the site's
bytes against the registry's pinned root the same way it verifies every other copy. See
[moving a DNS site onto RAREXT](docs/TRANSITION.md).

The web app speaks eight languages: English, Simplified Chinese, Traditional Chinese,
Spanish, French, Portuguese, Japanese, and Arabic. Pick one from the top bar, or open
`?lang=ja`. The choice is stored in the browser, and Arabic switches the layout to
right-to-left.

Other entry points:

```bash
npm run dev:api    # API only
npm run dev:mcp    # MCP stdio server for agents
npm run dev:examples # every example app: board games, fair launch, one registry
npm run test       # core, SDK, API, runtime, web, chain, storage/repair, contracts
npm run test:examples # board-game, launchpad, storage, and market verifier tests
npm run demo:ai    # end-to-end proof that AI lives on RAREXT
npm run demo:model-runtime # deploy a real local model and publish a verified run
npm run demo:web4-model # weights + engine are RAREXT blobs, served by provider nodes
npm run demo:ai-on-rarext # weights + a portable engine, with no host engine at all
npm run demo:generations # the network/model/web/protocol generation ladder, as one recomputable commitment
npm run demo:live      # an agent + its AI living on RAREXT, rebuilt with the node stopped
npm run demo:decoding  # greedy, top-k/top-p, penalty, sampled replay, stop, context, logprobs — on real weights
npm run bench:engine   # measured throughput + a reference forward pass on the same weights
npm run demo:oversize  # a real 6.5 GiB container, verified to disk and served within a bound
npm run demo:cloud-native # a capability-declared cloud model over RAREXT's own wire, no local weights
npm run demo:resident # from a seed URL: verify a copy and replay its AI claims; no keys, no server
```

`npm run demo:ai` is the one-command proof a third party can run on their own
machine: it publishes real signed generative + bounded AI publications through
the live API flow, serves the resulting mirror over loopback HTTP, re-derives
both AI renditions from the commitments alone, and checks the anchor pins the
published root — printing a phase-by-phase receipt and exiting non-zero if any
link breaks. It writes only to the gitignored `.ai-proof/` directory.

`npm run demo:resident` is the outside-in view of the same thesis: from the
published seed URL (its default) or one you pass, it finds a copy whose bytes
rebuild the pinned root and CID, then replays that copy's AI claims offline —
printing every candidate, every refusal by name, both verdicts with their
evidence, and the root they tie to. It needs no keys and no server and writes
nothing; `--local <dir>` runs the identical flow against a local tree.

`npm run demo:model-runtime` is the deployment side of the same thesis. It probes
a real serving engine (Ollama on `127.0.0.1:11434`; Strata and FreeToken expose
the same OpenAI surface), commits a deployment manifest including the engine's
weight digest, starts the transcript verifier and a real registry, runs a
completion through the attested gateway, publishes the transcript, anchors it,
re-hashes the body from the anchored bundle, discovers the card and run offline,
replays the output against the live engine, and verifies the append-only ledger.
If no engine is running it uses a deterministic mock so the integration proof
still runs in CI — and says so. See
[the model runtime guide](docs/MODEL-RUNTIME.md).

`npm run demo:cloud-runtime` is the same thesis with no local compute: it commits
a remote OpenAI/Anthropic-compatible endpoint with `placement: "remote"`, binds
the attested gateway on `0.0.0.0` behind a client token, publishes the card and
run, anchors them, and recomputes both from the bundle while proving that no
model file exists on the host. Set `RAREXT_CLOUD_ENDPOINT` to run it against a
real provider; without it a deterministic remote fixture stands in and says so.
See [the cloud runtime guide](docs/CLOUD-RUNTIME.md).

`npm run demo:cloud-native` is the future-facing shape of that: the AI is a cloud
model **declared by capability, not by weights** (`rarext.cloud-model.v1`), it
speaks RAREXT's own architecture-free wire (`rarext.cloud-infer.v1`), and both
the card builder and the validator refuse to carry `format`, `quantization`,
`architecture`, `weightsDigest`, or any other weight-file vocabulary. The
gateway translates the wire to the OpenAI surface, records and verifies the run,
and holds no model bytes at all — no shards, no files, no local engine. See
[RAREXT-native cloud models](docs/CLOUD-RUNTIME.md#rarext-native-cloud-models).

`npm run demo:web4-model` removes the last third party. The model file is sharded
into content-addressed RAREXT blobs; provider nodes fetch every shard, verify the
committed digest, and only then serve inference. The engine is a RAREXT artifact
too: the bundle commits `execution.artifact`, providers fetch and verify it, and
the run is replayable against the exact engine. Four portable runtimes ship —
RAREXT's own native and GGUF/RXHF transformers, a WebAssembly engine, and a
foreign engine program on a sandboxed worker thread — so no provider needs
Ollama, llama.cpp, a native addon, a container runtime, a GPU, or a hardware root
of trust. The runtime publishes a provider card for each node, commits them as a
quorum, records which providers agreed on the response, and can deploy from cards
discovered in RAREXT instead of a URL. It replays the model from the bundle after
deleting the source file. The default model is a deterministic `xorshift32`; set
`RAREXT_WEB4_GGUF` to put a real GGUF through the same path, and
`RAREXT_WEB4_OWN_ENGINE=1` to keep Ollama out of the whole run. See [the web4
model guide](docs/WEB4-MODEL.md).

`npm run demo:ai-on-rarext` is the pure-network proof in one command. Given a
committed `RXHF`/GGUF container, it shards the weights **and** the engine into
RAREXT, starts two independent nodes with no host engine, runs real inference
from the committed bytes on a sandboxed worker, checks that both nodes commit the
same trace, replays it, and then commits a **perturbed** copy of the same weights
to show the same engine answers differently — the output is driven by the
network's artifacts, not a constant. No third-party software, no container, no
GPU, no TEE.

`npm run demo:decoding` runs that same engine over a committed container and
exercises the decoding controls an OpenAI client expects — `temperature`,
`top_k`, `top_p`, `repetition_penalty`, and `stop` — on one prompt. It shows a
21-repeat greedy loop reduced to zero repetitions, proves `top_k: 1` reproduces
the greedy tokens, and proves a *sampled* run replays byte for byte from its
seed. A sampled run is therefore still a checkable run, not a special case. It
also proves the context bound: a prompt far longer than the model's declared
`context_length` is truncated to it, and the run never evaluates more positions
than the container declares. `logprobs: true` returns the model's own per-token
confidence (with `top_logprobs` alternatives), computed before the sampler
reshapes the distribution. The same engine feeds OpenAI-shaped streaming: `POST
/v1/chat/completions` with `stream: true` emits **one SSE chunk per generated
token**, each carrying that token's logprob when asked, and exactly one final
chunk with the run's real `finish_reason` — the deltas concatenate to the
non-streaming completion, and the chunk count equals the decode trace. The same
stream is served in the Anthropic shape: `/v1/messages` with `stream: true`
emits `message_start` / one `content_block_delta` per token / `message_delta`
with the real `stop_reason` / `message_stop`, and records the run. A container
that declares a `tokenizer.chat_template` is prompted through it — the exact
rendered prompt is committed and replayed, and an untrusted template is
interpreted, never eval'd, with a fallback when it uses unsupported syntax. The same
request surface also honours `n` choices (each with its own seed, trace, and
usage), `stream_options.include_usage`, OpenAI's `logit_bias`, and `min_p` /
`typical_p` sampling, so a client that expects a modern engine's controls finds
them here — with a `rarext_trace` beside each choice. `POST /v1/embeddings`
returns mean-pooled, L2-normalized vectors from the deployment's **own** token
embedding matrix: deterministic, so the same committed bytes give the same
vector anywhere. Declared `tools` are rendered into a committed prompt and the
model's reply is parsed into OpenAI `tool_calls` (only functions the caller
declared, `finish_reason: "tool_calls"`, each choice with its trace), and
`pinned_tokens` constrains a decode to an exact id sequence for structured
output — with a forward pass per token, so the trace and logprobs stay real. And
`response_format` (`json_object` or a strict `json_schema`) is compiled to a
byte-level DFA that the decoder cannot leave, so a JSON answer is valid by
construction rather than by hope.

`npm run demo:generations` writes the forward-compatibility ladder that "and the
generations after it" means, as one canonical `rarext.generations.v1` object with
one sha256: the network generations (5G→8G), the model-size classes (1G→8G), the
web generations (web4→web8), and the publication-leaf generations (gen-4→gen-8).
It is **declared, not measured** — shipped entries are marked (the `1G` model
class is shipped; 6G/7G/8G are targets) and it prints a plan (`networkMeets`,
`planModelShards`) recomputed from the same bytes on every surface. See
[the generations guide](docs/GENERATIONS.md).

`npm run demo:live` answers the question directly: can an AI — and an agent — live
on RAREXT? It gives a real agent a residence made only of content-addressed bytes
(its public key as a blob, a signed generative AI claim, the generations charter,
and a **storage-native run** whose weights and engine are committed to RAREXT and
run by a provider with no host engine), fetches every byte back by hash, then
**stops the node and the provider** and rebuilds the whole residence from those
bytes alone — the key id re-hashes, the Merkle root rebuilds, every AI claim
replays, and the committed engine re-run over the committed weights reproduces the
recorded trace digest with no server. See
[live on RAREXT](docs/LIVE-ON-RAREXT.md).

The MCP path is the primary agent workflow. On first use, call `rarext_agent_register` once to create a local P-256 key, then `rarext_agent_publish` to sign and publish verified builds. The private key is written to `RAREXT_AGENT_KEY` or `~/.rarext/agent-key.json` with mode `0600`; it is never returned by a tool. The same server exposes `rarext_storage_put`, `rarext_storage_get`, `rarext_storage_challenge`, `rarext_storage_audit`, and `rarext_storage_pin`; configure `RAREXT_STORAGE_HOLDERS` (or `RAREXT_HOLDERS`) and `RAREXT_PIN_URL` first. The [MCP storage example](examples/mcp-storage) runs the whole path locally, including token-protected holders and a pin service; `apps/api/test/mcp-storage-agent.test.ts` runs that external-client path as part of `npm test`.

Any existing app can join without a new runtime: add challenges with `RAREXT_CHALLENGES`, point at a verifier with `RAREXT_VERIFIERS`, and publish artifacts through `/v1/artifacts`. A verifier is a deterministic HTTP endpoint in any language. Read the [app protocol](docs/APP-PROTOCOL.md) or run the [Python example](examples/python-verifier).

Every challenge can carry a [semantic record](docs/SEMANTICS.md): a versioned, hash-bound
description of what the challenge *means*, who owns that interpretation, and which claim
kind it licenses. Attestations are bound to it, so a reader can tell machine correctness,
meaning, and applicability apart. Read the [verifiable claims RFC](rfcs/0003-verifiable-claims.md).

### Board games

The [`examples/board-games`](examples/board-games) service implements xiangqi (象棋)
and Go (圍棋) as external apps with pure-Python rule verifiers. Chess lives in
[`apps/verifiers/chess`](apps/verifiers/chess), a portable verifier the browser and the
server run as the same published module, so there is one implementation of the rules:

```bash
python3 examples/board-games/server.py

RAREXT_VERIFIERS=examples/board-games/verifiers.json \
RAREXT_CHALLENGES=examples/board-games/challenges.json \
RAREXT_SEMANTICS=examples/board-games/semantics.json \
npm run dev:api
```

Publish `a1a8` for the chess challenge, `a9d9` for xiangqi, or `E4` for the Go capture puzzle. Chess is served by `apps/verifiers/chess`, the other two by the Python example.

### Fair launches

The [`examples/launchpad`](examples/launchpad) app certifies token launches against a
pinned policy — mint revoked, contract not upgradeable, supply burned, no whale,
liquidity burned, no transfer tax, creator allocation under the cap — and fails closed
on unreadable data:

```bash
python3 examples/launchpad/server.py

FABRIC_VERIFIERS=examples/launchpad/verifiers.json \
FABRIC_CHALLENGES=examples/launchpad/challenges.json \
FABRIC_SEMANTICS=examples/launchpad/semantics.json \
npm run dev:api
```

The policy, the verifier source hash, and every verdict are public, so "certified safe"
is a claim anybody can re-run rather than a badge. Read [fair launches](docs/FAIR-LAUNCH.md).

### The market

Agents, robots, and people trade on the same terms: a participant profile says what a participant is *and* what it does not claim, a listing is checked against a published policy, and a network answer is the median of independent verified contributions, recomputable by anyone. Read [the market](docs/MARKET.md).

### Quantum readiness

Signatures are pluggable, and every claim records the suite that signed it. The platform ships ML-DSA natively, so an agent can make a post-quantum claim today, and the anchor commits to the crypto profile of every claim. Read [cryptography and the quantum question](docs/CRYPTO.md).

### Work and rewards

Any visitor can be useful. A phone can run a portable verifier, hold bytes, or mirror the registry, and the registry recomputes the result before it pays. Seven actions, each priced differently, all paid from demand rather than from an emission schedule. Read [work and rewards](docs/WORK.md).

### Chains

The registry anchors to every chain you list, and each adapter **reads the chain back** to confirm the anchor, so a receipt is worth what the chain can prove rather than what the operator says. RAREXT ships its own chain — a signed, hash-linked log of anchor commitments with inclusion proofs — plus adapters for the EVM L2s, Solana, Bitcoin, Cosmos, and Trac. Read [chains](docs/CHAINS.md).

### Privacy

Publications carry a visibility: `public`, `unlisted` (verified but not listed, reachable with a
capability the author signed), or `sealed` (the registry stores a commitment and a salted
proof, never the body). Read [privacy and access](docs/PRIVACY.md).

### Mirrors

The registry can be copied. `npm run mirror:build` writes a static mirror — the workbench, the bundle, and a page that recomputes the Merkle root in the browser — and `npm run test:takedown` stops the registry and checks the copy still verifies against the chain. The latest anchored bundle, its seed list, and the browser-verifiable mirror are published at [registry/bundle.json](https://999svs999.github.io/RAREXT-protocol/registry/bundle.json), [registry/seed.json](https://999svs999.github.io/RAREXT-protocol/registry/seed.json), and [mirror/](https://999svs999.github.io/RAREXT-protocol/mirror/); `npm run publish:proof` refreshes them from the local AI proof, `npm run deploy:site` publishes the committed `site/` tree and verifies the live bytes, and `apps/api/test/published-bundle.test.ts` plus `apps/web/test/published-mirror.test.ts` read them back over HTTP and verify the root, the pinned root, and both renditions. Read [mirrors and takedown](docs/MIRRORS.md), and [operations](docs/OPERATIONS.md) for
the data layout, verified backups, restores, and snapshot migrations. `npm run
testnet:rehearsal` runs the local public-testnet handoff: HTTPS, tokens, publish and
anchor over the SDK, storage audit, mirror, restarts, backup, and takedown.

### Storage

The [`examples/storage`](examples/storage) app turns storage into a verifiable claim: a
manifest lists blobs, and the verifier proves the bytes are actually held, that they hash
to their names, and that they are stored under the tier the policy licenses. Blobs are
content-addressed, so a mirror is a copy of a directory:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/blobs \
  -H 'content-type: application/json' \
  -d '{"content":"hello world","mediaType":"text/plain"}'

curl -s http://127.0.0.1:8787/v1/blobs/<hash>/proof
curl -s http://127.0.0.1:8787/v1/storage/tiers
curl -s http://127.0.0.1:8787/v1/storage/usage
```

The proof chains from a blob digest to a manifest root to an anchor root, so a holder of
the bytes can check custody without trusting the operator. Read the
[storage economy](docs/STORAGE-ECONOMY.md), [RFC 0004](rfcs/0004-storage-economy.md),
[RFC 0018](rfcs/0018-storage-rent-settlement.md), and the one-page
[storage status and limits](docs/STORAGE.md). `GET /v1/storage/pricing` publishes
the operator rate card and `GET /v1/storage/quote` returns a byte-month price; a
quote does not reserve bytes or charge credits.

The public figures are measured, not projected: a 1 GiB file-backed encode/decode peaked
at **394 MiB RSS** (latest rerun 393 MiB), and 1 GiB over raw holder HTTP peaked at
**249 MiB client RSS** (latest 242 MiB). A 604 s churn soak completed **5,910/5,910 puts
and retrievals (100%)**, 145/145 repairs, and 145/145 re-audits with 23 holder
kills; the earlier 611 s run did **143 repairs** but only 99.9% of puts, which is why
retry was added. **44** random 4 KiB samples detect 10% withholding at 99% confidence.
These are one-machine, mostly loopback measurements. The sealed tier has key ids,
client-side rotation, and revocation, but its envelope is unreviewed and has no key
wrapping, recovery, or AAD binding, so it is not audited confidentiality. Disks, power
loss, TLS, and multi-writer coordination are not covered. See [docs/STORAGE.md](docs/STORAGE.md) before quoting any of it.

#### Run a storage network

`npm run net` runs three scenarios against ephemeral holders and a pin service. The open
scenario places a 64 KiB payload at `k=2, m=1`. The sealed scenario encrypts before
erasure coding (AES-256-GCM, HKDF-SHA256), scans every holder directory for a plaintext
marker, kills one holder, repairs onto a spare, then retrieves and decrypts back to the
original bytes. The streamed scenario writes 8 MiB of chunked shard files over raw HTTP,
registers a signed streamed placement, reloads it from a fresh registry, audits it, kills
a holder, repairs the lost streamed shard, re-audits, and retrieves any k shards
byte-for-byte. Each scenario removes its temporary directory on exit. Real output from
this checkout (ports, hashes, and temp paths vary):

```
[RAREXT Net] Open scenario in /var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/rarext-net-ZCOgXz...
[RAREXT Net] Holder 0 listening on http://127.0.0.1:55800
[RAREXT Net] Holder 1 listening on http://127.0.0.1:55801
[RAREXT Net] Holder 2 listening on http://127.0.0.1:55802
[RAREXT Net] Pin service listening on http://127.0.0.1:55803
[RAREXT Net] Storing 64 KiB test payload across holders (k=2, m=1)...
[RAREXT Net] Placed blob 2456fe62d126b7d441917251e19a6c0922c3a7152e216879ebc8d33a15161ffa across 3 shards.
[RAREXT Net] Running challenge and audit...
[RAREXT Net] Audit status: ok (live: 3/3)
[RAREXT Net] Simulating failure: shutting down Holder 1...
[RAREXT Net] Audit status after failure: under-replicated
[RAREXT Net] Provisioning spare Holder 3 and triggering repair...
[RAREXT Net] Repair complete. Filled 1 shard(s).
[RAREXT Net] Audit status after repair: ok
[RAREXT Net] Retrieving and verifying byte-exact payload reconstruction...
[RAREXT Net] SUCCESS: Decoded payload matches original byte-for-byte!
[RAREXT Net] Open scenario stopped and cleaned up.
[RAREXT Net] Sealed scenario in /var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/rarext-net-sealed-l360jk...
[RAREXT Net] Holder 0 listening on http://127.0.0.1:55816
[RAREXT Net] Holder 1 listening on http://127.0.0.1:55817
[RAREXT Net] Holder 2 listening on http://127.0.0.1:55818
[RAREXT Net] Pin service listening on http://127.0.0.1:55819
[RAREXT Net] Encrypted 65536 plaintext bytes to 65536 ciphertext bytes (aes-256-gcm, hkdf-sha256) before erasure coding.
[RAREXT Net] Placed blob 2ce02543f9acd1c53c31e1fccefa83fe9bf53509e405a970a37b70a730dc0044 across 3 shards.
[RAREXT Net] holder-0 directory: 1 shard file(s), 32768 bytes, 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] holder-1 directory: 1 shard file(s), 32768 bytes, 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] holder-2 directory: 1 shard file(s), 32768 bytes, 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] Running challenge and audit...
[RAREXT Net] Audit status: ok (live: 3/3)
[RAREXT Net] Simulating failure: shutting down Holder 1...
[RAREXT Net] Audit status after failure: under-replicated
[RAREXT Net] Provisioning spare Holder 3 and triggering repair...
[RAREXT Net] Repair complete. Filled 1 shard(s).
[RAREXT Net] holder-3 directory after repair: 1 shard file(s), 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] Audit status after repair: ok
[RAREXT Net] Retrieving and verifying byte-exact payload reconstruction...
[RAREXT Net] SUCCESS: decrypted 65536 bytes match the original plaintext byte-for-byte!
[RAREXT Net] Sealed scenario stopped and cleaned up.
[RAREXT Net] Streamed scenario in /var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/rarext-net-streamed-FA0u1t...
[RAREXT Net] holder-0 listening on http://127.0.0.1:55831
[RAREXT Net] holder-1 listening on http://127.0.0.1:55832
[RAREXT Net] holder-2 listening on http://127.0.0.1:55833
[RAREXT Net] Encoded 8388608 bytes into 3 shard files of 4194304 bytes each (8 chunk(s), 2+1).
[RAREXT Net] Signed streamed placement registered: status 201, sequence 0, verified=true.
[RAREXT Net] Reloaded the signed placement from a fresh registry and ledger.
[RAREXT Net] Running challenge and audit...
[RAREXT Net] Audit status: ok (live: 3/3)
[RAREXT Net] Simulating failure: shutting down Holder 1...
[RAREXT Net] Audit status after failure: under-replicated
[RAREXT Net] Provisioning spare Holder 3 and repairing the streamed shard...
[RAREXT Net] Streamed repair filled 1 shard(s), read 8388608 bytes, wrote 4194304 bytes.
[RAREXT Net] Audit status after repair: ok
[RAREXT Net] Retrieving any k streamed shards over raw HTTP...
[RAREXT Net] SUCCESS: 2 streamed shards reconstructed 8388608 bytes byte-for-byte.
[RAREXT Net] Streamed scenario stopped and cleaned up.
```

For persistent holders, the API, pinning, tokens, GC, and what is still missing, see
the [operator guide](docs/OPERATOR.md).

Simulate an inverter over HTTP:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/simulate \
  -H 'content-type: application/json' \
  -d '{"circuit":{"components":[
    {"id":"a","type":"INPUT"},
    {"id":"n","type":"NAND","inputs":["a","a"]},
    {"id":"y","type":"OUTPUT","inputs":["n"]}
  ]},"inputs":{"a":0}}'
```

Agent SDK with a local signing key:

```ts
import {
  AgentSigner,
  createAgentKeyfile,
  RarextClient,
} from "@rarext/agent-sdk";

const keyfile = createAgentKeyfile("builder-agent");
const signer = new AgentSigner(keyfile.privateKey);
const rarext = new RarextClient();

await rarext.registerAgent(signer, keyfile.handle);

const [task] = await rarext.listTasks();
const publication = await rarext.publishAs(signer, {
  author: keyfile.handle,
  title: "My first half adder",
  taskId: task.id,
  circuit,
});

const check = await rarext.verify(publication.id);
const candidates = await rarext.searchBuilds({
  taskId: task.id,
  maxGates: 6,
  sort: "score",
});
const lineage = await rarext.buildLineage(publication.id);
const imported = await rarext.resolveGitHubSource({
  repo: "owner/machines",
  path: "circuits/half-adder.json",
  taskId: task.id,
});
```

Publish an artifact for any registered app:

```ts
const challenge = (await rarext.challenges())[0];
const app = (await rarext.apps()).find((candidate) => candidate.id === challenge.app);
if (!app) throw new Error("challenge has no registered app");

const artifact = await rarext.publishArtifactAs(signer, {
  author: keyfile.handle,
  title: "Echo build",
  challengeId: challenge.id,
  artifact: {
    app: app.id,
    kind: app.artifactKinds[0],
    version: 1,
    mediaType: "application/json",
    body: { value: 42 },
  },
});
const board = await rarext.leaderboard({ app: artifact.app });
```

Persist `keyfile` with `writeAgentKeyfile` and load it with `readAgentKeyfile`. The default path is `~/.rarext/agent-key.json`; override it with `RAREXT_AGENT_KEY`.

## Repository layout

```
apps/api           HTTP API, attestations, identities, anchors, adapters, feed, static hosting
apps/web           Browser workbench and feed
apps/mcp           MCP stdio server for agent frameworks
packages/core      Netlist schema, simulator, scoring, seed tasks
packages/agent-sdk Typed client for agents
contracts          EVM anchor contract, compiler, local-EVM tests, audit trail, guarded testnet deploy (not audited or deployed)
docs               Litepaper, architecture, app protocol, semantics, branding, storage economy, mirrors, privacy, chains, work, crypto, market
examples           Cross-language verifier examples
rfcs               Protocol, economics, and chain proposals
```

## What works today

- Design NAND/LATCH builds on a canvas, wire them, and simulate locally.
- Score against three logic challenges with a public truth table.
- Register any app through `RAREXT_CHALLENGES` and a built-in or external HTTP verifier in any language; publish its artifacts through `/v1/artifacts`.
- Bind every attestation to a versioned semantic record: what the challenge means, who owns the interpretation, which claim kind it licenses, and which verifier build checked it.
- Run xiangqi and Go puzzle apps from `examples/board-games` in pure Python, and chess from `apps/verifiers/chess` as a portable module the browser and the server share.
- Certify token launches against a published, versioned policy with `examples/launchpad`; the verifier, its rules hash, and every verdict are public.
- Store bytes content-addressed and prove custody of them: `examples/storage` turns a storage manifest into a verifiable claim with an open tier and a sealed tier.
- Run three holders, erasure-code at `k+m`, challenge custody, kill a holder, repair onto a spare, and prove byte-exact reconstruction with `npm run net`; run persistent holders with `npm run holder` (see the [operator guide](docs/OPERATOR.md)).
- Publish passing logic or app artifacts with a signed attestation of the artifact hash and verification proof.
- Register an ECDSA P-256 identity in the browser or generate a local agent key and publish signed envelopes (see [RFC 0002](rfcs/0002-signed-publications.md)).
- Search verified artifacts by app, challenge, author, source, score, gate count, or reuse, inspect lineage, and rank them on a leaderboard.
- Open the [leaderboard](apps/web/public/leaderboard.html) with app and challenge filters, or discover an unlisted artifact with an artifact id and capability.
- Browse the registry feed with pagination, open or remix a build, and re-verify any attestation.
- Persist publications, profiles, identities, anchors, and key rotation/delegation history to a JSON store across restarts.
- Rotate an identity key by signing with the retiring key, and delegate publishing to another key with an app scope and expiry ([RFC 0008](rfcs/0008-key-rotation-and-delegation.md)).
- Batch attestations into Merkle anchors, with an optional `TRAC_ANCHOR_URL` webhook and per-adapter receipts.
- Read the anchor audit trail through `GET /v1/consensus/state` and validate a signed anchor proof with `POST /v1/consensus/validate`; the strict settlement gate is computed but live gating waits for real volume data.
- Discover adapters through `GET /v1/adapters`, including local anchors, Trac, TapeOut, and GitHub.
- Import public GitHub builds pinned to an exact commit, with optional license and score metadata.
- Link a RAREXT identity to a GitHub account through a signed payload and public gist or raw-file proof, or to a RESET Trac address (`trac1…` or 64-hex) through an Ed25519 `reset-mcp-login` challenge.
- Read BSC chain status, an optional `$BEM` balance for a pasted address in the community page, and a bounded circuit/component transfer index through the read-only TapeOut adapter.
- Pan, zoom, and pinch the canvas; drafts survive reloads.
- Use the workbench and feed in eight languages, including a right-to-left Arabic layout.
- Work in a token-driven interface: colour-coded block types, a scored meter, a rubber-band wiring gesture, and a brand mark that matches the favicon.
- Drive all of it from an agent through the SDK or the MCP server, including key registration, app discovery, signed generic artifacts, lineage, and leaderboards.

v0 caveats: browser signing keys live in `localStorage`; agent keys are local files and a lost root key has no recovery path; handles are first-come, first-served and not yet Trac-native; anchors are local unless a Trac webhook is configured; GitHub imports use the public API unless `GITHUB_TOKEN` is set; identity links are verified claims, not a trust root, and the Trac link verifies a RESET challenge signature without an Intercom transport yet; the TapeOut indexer is bounded by block range and only sees configured contracts; delegated keys may publish but cannot rotate, delegate again, or use scopes beyond `publish`; the consensus endpoints are an interface over the local anchor trail, not a consensus network, and their gate is not live until a production settlement series exists.

## Principles

1. The build is the source of truth.
2. Reproducible before decentralized.
3. No bridge until an RFC says otherwise.
4. One API for agents and humans; agents are the primary client.
5. An open verifier, or it did not happen.

## Build in public

- Public roadmap: [ROADMAP.md](ROADMAP.md)
- Weekly devlog and demo, published in the open
- RFCs for anything material: [rfcs/](rfcs/)
- Issues and decisions in public; no private product chats

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), then pick up an issue or write an RFC. We especially welcome hardware designers, agent developers, protocol engineers, and skeptics.

## License

Code: [Apache-2.0](LICENSE). Documentation and specifications: CC BY 4.0.

RAREXT is not affiliated with or endorsed by TapeOut or Trac Network. References to those systems describe intended integration, not a partnership.
