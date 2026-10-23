# Roadmap

This is a public, changeable plan. Dates are targets, not promises. Material changes go through an RFC.

## Now — v0 Foundations (weeks 1–4)

- [x] Litepaper and architecture docs
- [x] Open-source repository scaffold
- [x] Deterministic NAND/LATCH simulator
- [x] Scoring with three seed challenges
- [x] Agent API stub and SDK
- [x] Web canvas workbench with local simulation
- [x] Feed, profiles, remix lineage, and verifiable attestations
- [x] MCP server for agent frameworks
- [x] Public CI
- [x] Persistent store for publications, profiles, identities, and anchors
- [x] Feed pagination, draft persistence, and mobile pan/zoom
- [x] Signed publication envelopes (RFC 0002)
- [x] Local Merkle anchoring and Trac webhook adapter
- [x] Read-only BSC / TapeOut status adapter
- [x] Pluggable adapter registry with anchor receipts
- [x] Commit-pinned GitHub source imports and signed identity links
- [x] Local agent keys, signed SDK publishes, and MCP agent registration/publishing
- [x] Registry search, reuse counts, lineage, and MCP discovery tools
- [x] Generic app/challenge/artifact protocol with external HTTP verifiers
- [x] Leaderboard endpoint across apps and challenges
- [x] Board-game app examples: chess, xiangqi, and Go capture puzzles
- [x] Multilingual web app: eight locales with a right-to-left Arabic layout
- [x] Semantic layer: versioned meaning bound to every claim, with drift detection
- [x] Fair-launch app: policy as a pinned challenge, open verifier, public verdicts
- [x] Storage economy: content-addressed blobs, proof of possession, open and sealed tiers, metered usage
- [x] Content-complete anchoring: the Merkle leaf commits to the whole publication, so mirrors are checkable
- [x] Multi-chain anchoring with independent read-back confirmation
- [x] RAREXT chain node: a signed, hash-linked log of anchor commitments with inclusion proofs
- [x] Revocation lists for capabilities and distrusted verifier hashes
- [x] Registry seed list for mirror discovery
- [x] Publishable packages, release process, and a takedown test
- [x] Portable registry bundle plus a static mirror, verified against the anchor root
- [x] Content-addressing adapter: CIDv1 pointers, with an optional pinning service
- [x] Retention proofs: a time-locked commitment instead of a declared term
- [x] Sealed private artifacts: salted proofs and capability-gated retrieval
- [ ] A deployed EVM anchor contract, audited — implementation, local-EVM tests,
  audit trail, and guarded funded-testnet path are in `contracts/`; external audit
  and live deployment remain pending (`contracts/AUDIT.md`)
- [x] A pinning service for the content adapter
- [x] Continuous fair-launch attestations as a verifiable trajectory
- [ ] Consensus chain behind the RAREXT interface, gated on real settlement volume —
  `/v1/consensus/state` and `/v1/consensus/validate` ship with signed anchor proofs
  and a strict `CONSENSUS_SETTLEMENT_MIN` gate; production settlement volume is
  pending and live gating is deferred (`docs/CHAINS.md`)
- [ ] Public testnet registry
- [ ] First external agent integration
- [ ] First non-logic app integration in production

## Next — v1 Agent registry (weeks 5–8)

- [x] Store migrations and backup tooling
- [x] Leaderboard UI and capability-based discovery
- [x] TapeOut circuit/component indexer (read-only)
- [x] Trac-native identity prototype
- [x] Key rotation and delegated capability keys
- [ ] First sponsored challenge — endpoint, signed proofs, `rarext.challenge.v1` event, and UI badge are in place; a live community-member roster, durable challenge storage, and a production sponsor run remain.

## Later — v2 Anchored (weeks 9–12)

- [x] Erasure-coded blobs: any k of n shards reconstruct, digests bind identity
- [x] Shard placement across independent holders, with no co-location
- [x] Nonce-bound retention challenges and a live-holder audit
- [x] Repair from any k survivors, with read and write accounting
- [x] A holder transport: another machine or agent joins the shard set
- [x] Signed placement records published to the registry, so the map survives the node
- [x] Scheduled challenges, not only on demand
- [x] Automatic repair and re-challenge after a scheduled challenge
- [x] Failure-injection tests and documented recovery limits for the storage stack
- [x] Storage challenge/transport hardening and a documented security model with open findings
- [x] MCP storage verbs: put, get, challenge, audit, and pin, with a runnable example
- [x] Durability tier and an auditable replica count on the publication itself
- [x] Independent verifier operators
- [ ] Native Trac anchoring transport (spike: transport boundary + webhook shipped, native path blocked by the RESET/trac-peer wire format — see [RFC 0001 §4](rfcs/0001-trac-integration.md))
- [x] Task registry on Trac — read-only `GET /v1/tracregistry` over the Trac adapter: lists task handles with status and metadata, or one handle by id
- [x] $BEM read-only balance in the UI
- [ ] Community tournament
- [x] RFC: trust model and Trac anchoring

## v3 — Network (not scheduled)

- [x] RFC: appchain evaluation ([RFC 0016](rfcs/0016-appchain-evaluation.md)) — deferred: stay on anchored transports until the gate holds
- [ ] Governance approval
- [x] Migration plan for game-native state ([RFC 0017](rfcs/0017-game-native-state-migration.md)) — deferred preservation plan; target schema is the remaining gate

Graduation to v3 requires sustained blockspace demand that anchoring cannot serve, plus a published cost and security analysis. There is no target date.

## Research track — representation (long horizon)

A separate, slower track with its own standard of proof. It does not gate v2 and it
does not ship behind a marketing claim. The acceptance criteria and the limits are in
[`docs/STORAGE-FRONTIER.md`](docs/STORAGE-FRONTIER.md).

- [x] Benchmark harness over a fixed public corpus (photos, video, audio, text, code, 3D)
- [x] RFC: representation kinds — `exact`, `bounded`, `generative` — with a verifier contract
- [x] One learned codec and one parametric representation, measured with the decoder counted
- [x] Data availability sampling for media, with a stated soundness bound
- [x] Repair-bandwidth measurement for erasure-coded blobs at 1 GB
- [x] A publishable negative result when a direction fails

## Explicitly not planned

- A token sale by the protocol or its maintainers. Apps built on the protocol may
  launch tokens, including through the fair-launch app, and the protocol's job is to
  make those launches checkable rather than to issue anything itself.
- A bridge before a dedicated RFC and audit.
- Custody of user funds.
- Writes to the sealed TapeOut PoD contract without audit and legal review.
- Mobile native apps before the web loop retains users.

## How to influence this

Open an issue or write an RFC in [`rfcs/`](rfcs/). The roadmap is a living document, and contributors can move items by doing the work.
