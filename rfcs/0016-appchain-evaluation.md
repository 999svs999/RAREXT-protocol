# RFC 0016: Appchain evaluation — native anchors, canonical identity, and the cost of a chain

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Requires:** RFC 0001 (Trac anchoring), RFC 0004 (storage economy and the chain path)
- **Implementation:** none. This is an evaluation. The recommended decision is **Deferred**: stay on anchored transports and revisit only behind the gate in §Decision gate.

## Summary

RAREXT should **not** run its own appchain now. The two things an appchain would
unlock are real — a first-class anchor transaction and a canonical identity
namespace — but neither requires a chain today, and both would add a validator set
and fixed operating cost before there is settlement volume to pay for it.

The strongest evidence is the recent Trac anchor spike. RESET/trac-peer 0.4.11 is
the Trac-native reference implementation pinned for that spike, and even there an
anchor root cannot be added without changing the protocol: message moves are a
closed, exact-key set and contract transactions accept only three commands (see
§What an appchain would unlock and §Evidence base). If adding one field is a
protocol change inside an existing app, it is not a client-side feature RAREXT can
adopt cheaply.

Recommendation: keep the shipped anchored transports, make the audited EVM anchor
contract the next public-proof milestone, measure demand for 90 days, and treat the
existing `apps/chain` interface as the place where consensus can be dropped in
later. Do not fund validators or introduce a token before the gate.

**Citation convention.** `reset:<path>:<lines>` means the file at that path in the
pinned RESET checkout, `Trac-Systems/reset` at commit
`6f432e4391893e859bd100ba395f2fe70cd73aba` (2026-10-21). That commit pins
`trac-peer` 2e6f458 (0.4.11), `trac-msb` ea72a9c, and upstream Intercom 4ab5299
(`reset:docs/SPEC.md:3-6`). RAREXT paths are relative to this repository.

## Motivation

The roadmap gates a consensus chain on "real settlement volume" (`ROADMAP.md:45`)
and puts "RFC: appchain evaluation" in the unscheduled v3 section (`ROADMAP.md:82`).
This RFC exists to answer the question before anyone builds validator
infrastructure out of ambition rather than demand.

Today RAREXT already has:

- local Merkle anchors over batched publication leaves (`docs/ARCHITECTURE.md:243-247`);
- an operator webhook for Trac announcements (`apps/api/src/adapters/trac-transport.ts:1-9`);
- a RAREXT chain node that is a **single-writer notary with a chain's interface**
  — hash-linked, signed, with inclusion proofs, but no multiple writers, consensus,
  finality rules, or incentive (`docs/CHAINS.md:46-88`);
- multi-chain adapters, including an EVM anchor path that is specified but not yet
  deployed and audited (`docs/CHAINS.md:105-117`).

So the choice is not "chain or no proof." It is whether a chain adds enough over a
signed notary plus public anchor contracts to justify its standing cost. The rest of
this RFC evaluates that.

## What an appchain would unlock

### 1. Native anchor moves

An appchain lets RAREXT define an `anchor` transaction as a first-class state
transition: the root is in consensus state, an inclusion proof is a consensus
proof, and no operator webhook sits between the registry and the record. That is a
real improvement over "the operator says it posted the root."

The Trac spike shows why this is not free. RESET's message envelope is exactly
`{v,t,b,h,p,w}`, the `t` value is restricted to seven move types, and each payload
has a fixed shape (`reset:contract/rules/index.js:9,47-66`;
`reset:docs/SPEC.md:40-45,61-70`). There is no spare field and no memo. The
transaction path is equally closed: the contract's transaction mapper accepts only
`transfer`, `gw_set`, and `params_set` with exact keys
(`reset:contract/protocol.js:18-28`). The signer builds a strict transfer command
and commits to a BLAKE3 hash of its JSON
(`reset:signer/lib/wire.mjs:82-87,104-122`); the gateway prepares and hashes the
command before submission (`reset:features/gateway/index.js:68-80`). The only
free-form channel is the optional miner chat, and it is explicitly off-chain and
in memory (`reset:docs/SPEC.md:124-126`), so it cannot back an inclusion proof.

The lesson is not "Trac is bad." It is that **an anchor slot is a protocol
feature**. An appchain would give RAREXT that slot because RAREXT would own the
schema, the clients, and the upgrade path — not because a chain automatically
provides one.

### 2. Canonical identity

RAREXT identity today is a public key plus a handle, with a Trac link as a proof
rather than the canonical record (`rfcs/0001-trac-integration.md` §1). RESET's
identity is a 64-hex Ed25519 address (`reset:contract/rules/index.js:8`) with a
`trac1…` bech32m display/transport alias (`reset:signer/lib/trac-address.mjs:1-35`),
and login is a signed, audience-bound challenge (`reset:signer/lib/wire.mjs:124-132`;
`reset:docs/SPEC.md:129-131`). The account surface is address-keyed
(`reset:docs/SPEC.md:109`), and we found no portable handle registry in the pinned
tree.

An appchain could make a RAREXT key the account key, put handles, rotations, and
delegations into consensus state, and let another app resolve an identity without
calling the RAREXT API. That is a genuine unlock. It is also a product decision
that a chain only orders: the registry, the recovery policy, and the delegation
semantics still have to be designed. A chain does not create them.

### 3. Native settlement and finality

An appchain could settle storage byte-months, claim bounties, marketplace escrow,
and anchor ordering in one state machine with published finality rules. The
existing `apps/chain` node deliberately stops short of that: one writer, no
consensus, no reorg rule, no incentive (`docs/CHAINS.md:70-88`).

RESET shows both the value and the cost of an existing settlement layer. Transfers
go to up to three validators, the gateway may wait up to six hours for the MSB to
append, and an accepted submission is not final (`reset:docs/SPEC.md:113-119`).
RESET also counts Bitcoin headers six deep before they are final
(`reset:docs/SPEC.md:82-84`). A RAREXT chain could choose faster finality, but it
would have to define and defend that choice rather than inherit one.

### 4. Composability and censorship resistance

Multiple independent writers would let other apps read RAREXT state without
trusting one API, and would make a single operator's censorship or outage less
decisive. That is the same argument the multi-chain anchor design already makes
for roots (`docs/CHAINS.md:90-103`). It only holds if there are enough independent
validators; a chain with one operator is the current notary with extra steps.

### What it would not unlock

An appchain would not store blob bytes, make the sealed tier confidential, create
a bridge, or justify a token. Those are separate designs. RAREXT's own storage
path already says the chain is a notary, not the database
(`docs/STORAGE-ECONOMY.md:313-325`). Keeping that boundary is part of the
recommendation.

## What it costs

### Validator set

A useful appchain needs more than a binary. A Byzantine-fault-tolerant set with
one fault needs at least four validators; five is a reasonable planning case. That
means at least three independent operators, two legal jurisdictions, published key
custody, upgrade coordination, monitoring, incident response, and an explicit
slashing or accountability rule. Someone must be on call when the chain halts.

The RESET devnet is a useful lower bound on component count, even though it is a
test fixture: it runs three HyperDHT bootstraps, a real MSB validator and client,
an admin/indexer, three registered gateway writers, three MCP services, a blind
relay, and a miner (`reset:docs/DEVNET.md:3-8`). Players are never writers;
gateways are writers added by the admin (`reset:docs/SPEC.md:26-27`). A production
RAREXT network would need the same kind of operator surface plus independent
organizations, not one machine running every role.

The liveness cost is also visible in RESET. Message capacity is bounded per tip
height — default 600 moves total and 6 per address — with difficulty adjusted by
demand (`reset:docs/SPEC.md:52-57`; `reset:contract/rules/index.js:13,87-90`).
Messages are capped at 8 KiB and transactions at 4 KiB
(`reset:docs/SPEC.md:35`). These are contract limits, not a general chain's
throughput, but they show that "just add a chain" also means choosing and
operating new limits.

**Indicative planning budget.** This is an estimate for the gate, not a quote or a
commitment:

| Item | Annual planning cost |
|---|---:|
| 5 validators (infra, monitoring, on-call stipends) | $90k |
| RPC, indexer, explorer, backup | $36k |
| 0.5 FTE protocol/operations engineer | $100k |
| Audit amortization and bug bounty | $50k |
| Legal, governance, insurance | $30k |
| Contingency (15%) | $46k |
| **Total** | **~$352k/year** |

One-time consensus and contract audits, validator onboarding, and a public testnet
are additional. A token would add market, legal, and governance costs; this RFC
does not assume one.

### Settlement volume required

The roadmap gate is "real settlement volume" (`ROADMAP.md:45`), not raw
publications. Define a **settled action** as a state change the chain must order:
an anchor root, a storage byte-month settlement, a claim bounty, or an escrow
release. Batched publications are amortized into one anchor and should not be
counted individually.

A chain at ~$352k/year needs fee-equivalent demand above that cost, with margin:

| Average fee per settled action | Actions/year to cover $352k | Actions/day |
|---:|---:|---:|
| $0.05 | 7.04M | 19.3k |
| $0.10 | 3.52M | 9.6k |
| $0.25 | 1.41M | 3.9k |
| $1.00 | 352k | 964 |

So a defensible volume gate is **10,000 settled actions per day at an average fee
of at least $0.10**, or an equivalent committed revenue figure. At $0.05 the same
volume covers only about half the cost and should not pass. The public registry is
pre-alpha and we have not published a settlement series that meets this; the gate
is therefore not close.

The other costs are social and security costs: consensus bugs, finality and reorg
ambiguity for already-published anchors, validator collusion or capture, token
pressure in a project whose stated model has no token (RFC 0001, Non-goals), and the opportunity cost of
months of protocol engineering that could go into verifiers, storage settlement,
and public anchor proofs instead.

## Alternatives considered

### A. Stay on anchored transports (recommended)

Local Merkle anchors plus the Trac webhook, then an audited EVM anchor contract.
This is cheap, reversible, needs no validator set, and already fits the adapter
model: an anchor is a root plus receipts (`docs/CHAINS.md:90-103`). The webhook is a
transport, not a trust root; the registry re-reads the chain it can and records a
receipt per adapter. This is the status quo plus the next public-proof step, and it
is enough for the current stage.

Weakness: the webhook receipt is operator text unless a public chain confirms it.
That is why the EVM contract, not an appchain, is the next milestone.

### B. Webhook transport only

The shipped webhook is the smallest real transport: one `rarext.anchor.v1` POST per
Merkle root (`apps/api/src/adapters/trac-transport.ts:1-9`), configured by
`TRAC_ANCHOR_URL`. It is useful for development and for an operator with a trusted
endpoint. It is not an independent inclusion proof, and it inherits the operator's
availability and honesty. Rejected as the final answer; retained as a fallback.

### C. Audited EVM anchor contract

Deploy the small anchor contract the chain adapter already expects — an
`anchors(uint256)` read and an `anchor(bytes32,bytes32[])` entry point
(`docs/CHAINS.md:105-112`). This gives a public, independently readable inclusion
proof on an existing validator set, with mature tooling and an established audit
market. It does not need a RAREXT validator set, a token, or a new consensus
protocol.

Weakness: gas per anchor batch, EVM chain liveness/censorship, contract upgrade
and key-management risk, and dependence on one VM family. Multi-chain receipts
mitigate the last two. This is the recommended next public-proof milestone.

### D. Extend RESET/trac-peer with an anchor move or transfer memo

This is the "native Trac anchor" path investigated in the 618ce25 spike. It would
require changing the closed move set and payload schemas
(`reset:contract/rules/index.js:9,47-66`), the transaction mapper
(`reset:contract/protocol.js:18-28`), the signer and gateway commit path
(`reset:signer/lib/wire.mjs:82-87`; `reset:features/gateway/index.js:68-80`), and
every indexer and client that validates them. It is a hard fork of a live coin
contract, not a RAREXT-controlled change.

Even if it shipped, the anchor would live in RESET's state, and identity would
remain RESET's 64-hex address rather than a RAREXT canonical identity. That does
not meet either unlock in §What an appchain would unlock. Rejected.

### E. Public append-only log plus signed checkpoints

A fallback from RFC 0001: publish a hash-linked log and periodic checkpoints
without consensus. It is cheaper than a validator set and more independent than a
single webhook, but it has weaker liveness and no native settlement. It is a
reasonable bridge to the EVM contract, not a substitute for the gate. Rejected as
the primary path for now.

### F. Upgrade the RAREXT chain node to consensus

This is the right long-term path if the gate is met. The interface is already
fixed: a consensus implementation can be dropped behind the same `/chain/*` API
without changing the protocol (`docs/CHAINS.md:70-88`). It is cheaper than forking
RESET because RAREXT controls the schema, and it preserves the existing anchor
proofs. The only question is timing, and the gate answers it.

## Recommendation

1. **Defer the appchain.** Do not allocate validator, consensus, or token work in
   v2/v3 until the gate below holds for 90 consecutive days.
2. **Ship the audited EVM anchor contract next.** It is the smallest step that
   turns an anchor receipt into a public proof on an existing chain.
3. **Keep the `apps/chain` interface.** Treat the single-writer notary as a
   compatibility layer; a consensus chain can replace its internals later.
4. **Measure before building.** Publish a settlement series — anchor roots,
   storage byte-months, claim bounties, escrow — so "real settlement volume" is a
   number, not a feeling.
5. **No token by default** (RFC 0001, Non-goals). If a future chain needs one, it
   requires a separate RFC, legal review, and governance approval.

## Decision gate

All conditions must hold for 90 consecutive days before a follow-up RFC may
propose building the chain. The default is **no**.

**1. Demand.** At least one of:

- 10,000 settled actions/day, with at least 25% from five or more external
  integrations; or
- $500k/year of signed, repeatable fee-equivalent demand with a published fee
  schedule.

**2. Economics.** Projected annual revenue is at least 1.5× projected annual
operating cost under the published cost model, with 12 months of funded runway
that does not depend on token appreciation.

**3. Necessity.** At least one of:

- anchor inclusion latency has a p95 above 2 minutes for 30 days at the target
  cadence despite batching; or
- three or more external integrations require consensus-native RAREXT state
  (identity writes, settlement, registry) and cannot use anchored receipts; or
- a security requirement — for example, multi-writer ordering — that the
  single-writer notary cannot meet.

**4. Validator supply.** Five or more independent validators across three or more
organizations and two or more legal jurisdictions; a public testnet with at least
three external validators for six months; published key-custody, upgrade,
incident-response, and slashing/accountability policies.

**5. Security.** An independent audit of consensus, finality, upgrade, and identity
migration; a funded bug bounty; reproducible builds; no bridge in the first
release.

**6. Governance.** Roadmap governance approval and a migration plan for the
`apps/chain` state, anchors, identities, handles, delegations, and storage
metering.

**Kill criterion.** If the testnet has fewer than four validators for 30 days, or
cannot cover 50% of operating cost after 12 months, stop and return to anchored
transports. Anchors remain valid; no user funds are at stake; the change is
reversible.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Validator cartel or capture | Independent operators, jurisdiction diversity, transparent rotation, published accountability |
| Consensus or finality bug | Formal spec, audit, public testnet, conservative finality, kill criterion |
| Token pressure in a tokenless design | Explicit no-token default; separate RFC and legal review before any token |
| Migration breaks existing anchors or identities | Keep the `/chain/*` interface, dual-read/read-back, snapshot before migration, rollback to anchored transports |
| Fixed cost outruns demand | Revenue gate, 1.5× margin, 12-month runway, kill criterion |
| Reorg invalidates a published anchor | Record height and chain, re-anchor on finality, keep multi-chain receipts |
| Regulatory exposure | No custody, no bridge, no token without review |

## Migration and compatibility

If the recommendation is adopted, there is no migration: existing anchors,
receipts, identities, handles, and storage records remain valid. The EVM contract
is additive and records another receipt for the same root.

If the gate is met later, the `/chain/*` API is the seam. A consensus
implementation can serve the same routes, and the adapter can keep reading blocks
and proofs without a protocol change (`docs/CHAINS.md:70-88`). Identity and handle
migration would need a signed snapshot and a challenge window; that is a separate
RFC, not a side effect of deploying validators.

## Open questions

1. What exactly counts as a settled action for RAREXT: anchor root, storage
   byte-month, claim bounty, escrow release, or a weighted basket?
2. Who pays validators, and in what unit, without a token? Is fee-equivalent
   revenue from storage and marketplace enough?
3. Is canonical identity a chain account, or a keypair with on-chain pointers to a
   handle and delegation records?
4. What is the minimum validator set and finality rule: BFT with fixed validators,
   or proof of stake with slashing? What is the reorg policy for published anchors?
5. Does an audited EVM anchor contract defer the appchain indefinitely by covering
   the public-proof need?
6. How do handles, rotations, and delegations migrate without breaking existing
   signatures and links?
7. How do we measure demand without counting test traffic or operator self-use?

## Decision

**Deferred.** Stay on anchored transports, ship the audited EVM anchor contract,
keep the `apps/chain` interface, and revisit only when the decision gate holds.
This is not a rejection: the appchain remains the long-term option if settlement
demand pays for it.

## Evidence base

Pinned reference: `Trac-Systems/reset` at
`6f432e4391893e859bd100ba395f2fe70cd73aba` (2026-10-21). The tree describes itself
as an Intercom/trac-peer coin contract clocked by Bitcoin headers, using MSB for
contract transactions with a TNK fee, and pins upstream Intercom 4ab5299,
trac-peer 2e6f458 (0.4.11), and trac-msb ea72a9c (`reset:docs/SPEC.md:3-6`).

| RESET claim used in this RFC | Pinned file and lines |
|---|---|
| Coin contract on Trac, Bitcoin-clocked, MSB transfers with TNK fee | `docs/SPEC.md:3-6`, `docs/SPEC.md:32-33` |
| Identity is a 64-hex Ed25519 address | `contract/rules/index.js:8`, `docs/SPEC.md:36-37` |
| `trac1…` is a bech32m alias for the 64-hex key | `signer/lib/trac-address.mjs:1-35` |
| Login is a signed `reset-mcp-login` challenge | `signer/lib/wire.mjs:124-132`, `docs/SPEC.md:129-131` |
| Account lookup is address-keyed; no handle registry in the pinned surface | `docs/SPEC.md:109` |
| Move envelope is exact `{v,t,b,h,p,w}` and canonical stable JSON | `contract/rules/index.js:47-66`, `contract/rules/json.js:1-9` |
| Only seven move types; payload shapes are fixed | `contract/rules/index.js:9,47-66`, `docs/SPEC.md:61-70` |
| Message capacity is 600/height and 6/address, with demand-adjusted bits | `docs/SPEC.md:52-57`, `contract/rules/index.js:13,87-90` |
| Message ≤ 8 KiB, transaction ≤ 4 KiB | `docs/SPEC.md:35` |
| Contract transactions are only `transfer`, `gw_set`, `params_set` | `contract/protocol.js:18-28` |
| Transfer command is strict; BLAKE3 commit over its JSON | `signer/lib/wire.mjs:82-87,104-122` |
| Gateway prepares and hashes the transfer command | `features/gateway/index.js:68-80` |
| Chat is off-chain and in memory only | `docs/SPEC.md:124-126` |
| Players are never writers; gateways are admin-added | `docs/SPEC.md:26-27` |
| Bitcoin headers are final after six confirmations | `docs/SPEC.md:82-84` |
| Transfers go to up to three validators; up to six-hour wait; accepted is not final | `docs/SPEC.md:113-119` |
| Devnet needs a validator, admin/indexer, three gateways, three MCPs, relay, miner | `docs/DEVNET.md:3-8` |

Related RAREXT evidence: RFC 0001 §1 (identity link) and §4 (native transport
blocker); `apps/api/src/adapters/trac-transport.ts:1-50`; `docs/CHAINS.md:46-117`;
`docs/ARCHITECTURE.md:243-247`; `docs/STORAGE-ECONOMY.md:305-325`; `ROADMAP.md:45,82`.
