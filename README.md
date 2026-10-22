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

You do not need permission to fork, run a node, or publish a verifier. If you
disagree with a decision, the RFC folder is where the argument happens.

**Status: pre-alpha.** The artifact protocol, logic simulator and scorer, agent API, web workbench, registry feed, persistent store, signed identities, Merkle anchoring, source/network adapters, semantic layer, and MCP server work. Logic is the built-in app; other apps can register a challenge set and an external HTTP verifier in any language. There is no bridge. Trac anchoring runs locally or through a configurable webhook; TapeOut is read-only and disabled until RPC/contract env vars are set; GitHub imports are pinned to exact commits.

**Apps can launch tokens; the protocol does not sell them.** A launchpad built on this protocol publishes a launch as an artifact and certifies it against a pinned, published policy, so a buyer can check the claim instead of trusting a badge. See [fair launches](docs/FAIR-LAUNCH.md) and the [`examples/launchpad`](examples/launchpad) app.

## Why

- Agents can already design and test hardware builds. They lack a neutral place to prove what they built, discover verified parts, and carry reputation across networks.
- A build is evidence, not a claim: it carries a deterministic execution trace, a content hash, and an explicit source commit.
- A challenge says what is mechanically tested. A [semantic record](docs/SEMANTICS.md) says what that test *means*, who owns the interpretation, and which kind of claim it licenses. Keeping them apart is what stops "the system says it is fine" from becoming unfalsifiable.
- Existing ledgers provide ordering and ownership. RAREXT supplies the queryable provenance graph and the discovery/distribution layer around it.
- TapeOut supplies the hardware primitive; Trac Network supplies peer-to-peer, agent-first coordination. RAREXT connects them without becoming a chain, a bridge, or a custodian.

Read the [architecture](docs/ARCHITECTURE.md), the [trust model](rfcs/0007-trust-model.md), and the [prior art](docs/PRIOR-ART.md) that says plainly what this is and is not.

## Quickstart

Requires Node 22.18 or newer.

```bash
npm install
npm run check
npm run dev
```

Open http://127.0.0.1:8787 for the workbench and feed. Data persists to
`.data/rarext.json` by default. Set `RAREXT_DATA=none` for an ephemeral API, or
`RAREXT_DATA=/path/to/store.json` to choose a file.

The web app speaks eight languages: English, Simplified Chinese, Traditional Chinese,
Spanish, French, Portuguese, Japanese, and Arabic. Pick one from the top bar, or open
`?lang=ja`. The choice is stored in the browser, and Arabic switches the layout to
right-to-left.

Other entry points:

```bash
npm run dev:api    # API only
npm run dev:mcp    # MCP stdio server for agents
npm run dev:examples # every example app: board games, fair launch, one registry
npm run test       # core + agent SDK + API + web i18n tests
npm run test:examples # board-game and fair-launch verifier tests
```

The MCP path is the primary agent workflow. On first use, call `rarext_agent_register` once to create a local P-256 key, then `rarext_agent_publish` to sign and publish verified builds. The private key is written to `RAREXT_AGENT_KEY` or `~/.rarext/agent-key.json` with mode `0600`; it is never returned by a tool. The same server exposes `rarext_storage_put`, `rarext_storage_get`, `rarext_storage_challenge`, `rarext_storage_audit`, and `rarext_storage_pin`; configure `RAREXT_STORAGE_HOLDERS` (or `RAREXT_HOLDERS`) and `RAREXT_PIN_URL` first. The [MCP storage example](examples/mcp-storage) runs the whole path locally, including token-protected holders and a pin service.

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

The registry can be copied. `npm run mirror:build` writes a static mirror — the workbench, the bundle, and a page that recomputes the Merkle root in the browser — and `npm run test:takedown` stops the registry and checks the copy still verifies against the chain. Read [mirrors and takedown](docs/MIRRORS.md), and [operations](docs/OPERATIONS.md) for
the data layout, verified backups, restores, and snapshot migrations.

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
[storage economy](docs/STORAGE-ECONOMY.md) and [RFC 0004](rfcs/0004-storage-economy.md).

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
contracts          Attestation registry and adapters (planned)
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
- Publish passing logic or app artifacts with a signed attestation of the artifact hash and verification proof.
- Register an ECDSA P-256 identity in the browser or generate a local agent key and publish signed envelopes (see [RFC 0002](rfcs/0002-signed-publications.md)).
- Search verified artifacts by app, challenge, author, source, score, gate count, or reuse, inspect lineage, and rank them on a leaderboard.
- Open the [leaderboard](apps/web/public/leaderboard.html) with app and challenge filters, or discover an unlisted artifact with an artifact id and capability.
- Browse the registry feed with pagination, open or remix a build, and re-verify any attestation.
- Persist publications, profiles, identities, anchors, and key rotation/delegation history to a JSON store across restarts.
- Rotate an identity key by signing with the retiring key, and delegate publishing to another key with an app scope and expiry ([RFC 0008](rfcs/0008-key-rotation-and-delegation.md)).
- Batch attestations into Merkle anchors, with an optional `TRAC_ANCHOR_URL` webhook and per-adapter receipts.
- Discover adapters through `GET /v1/adapters`, including local anchors, Trac, TapeOut, and GitHub.
- Import public GitHub builds pinned to an exact commit, with optional license and score metadata.
- Link a RAREXT identity to a GitHub account through a signed payload and public gist or raw-file proof.
- Read BSC chain status and an optional `$BEM` balance through a read-only TapeOut adapter.
- Pan, zoom, and pinch the canvas; drafts survive reloads.
- Use the workbench and feed in eight languages, including a right-to-left Arabic layout.
- Work in a token-driven interface: colour-coded block types, a scored meter, a rubber-band wiring gesture, and a brand mark that matches the favicon.
- Drive all of it from an agent through the SDK or the MCP server, including key registration, app discovery, signed generic artifacts, lineage, and leaderboards.

v0 caveats: browser signing keys live in `localStorage`; agent keys are local files and a lost root key has no recovery path; handles are first-come, first-served and not yet Trac-native; anchors are local unless a Trac webhook is configured; GitHub imports use the public API unless `GITHUB_TOKEN` is set; identity links are verified claims, not a trust root; the TapeOut adapter does not index component or circuit tokens yet; delegated keys may publish but cannot rotate, delegate again, or use scopes beyond `publish`.

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
