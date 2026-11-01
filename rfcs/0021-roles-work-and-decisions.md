# RFC 0021 — Roles, work, and how the community decides

**Status:** Partly implemented, partly proposed, and this section says which is which.

Implemented today: the **action board** (`apps/api/src/work.ts` — `ACTIONS`, `actionFor`,
`workOrders`, `summarizeEarnings`, `CreditRecord`, `submissionDigest`), per-key credit
records in the store, storage rent (`apps/api/src/storage-rent.ts`, RFC 0018), and the work
rules in `docs/WORK.md`. An operator, a builder and an agent can already be paid for work.

Implemented since this RFC was written: the **tally** — `proposalRoot`, `voteStatement`,
`tallyVotes` and `tallyRoot` in `packages/core/src/governance.ts`, with `proposalProblems` and
`voteProblems` as the one shape validation both the tally and the routes use — and the **route a
vote travels over**: `POST /v1/governance/proposals`, `GET /v1/governance/proposals/:root` and
`POST /v1/governance/proposals/:root/votes`, with proposals and votes in the store's snapshot so a
decision survives the process that recorded it. The node is a bulletin board on that path, never a
judge: it refuses an unusable row at the door (a proposal the tally could not compute, a signature
that does not verify) and recomputes the verdict with the same core function a stranger runs
offline.

Implemented too: **who pays for a vote**. A ballot can now be sponsored —
`POST /v1/governance/proposals/:root/votes/sponsored`, with `verifyVoteSponsorship` reusing the
sponsorship machinery that already exists for challenges (the same member roster, the same
freshness window, the same durable nonce) — and the payer is recorded beside the vote
(`voteSponsorships` in the snapshot) rather than being implied. Two signatures are required and
they mean different things: the sponsor's assertion carries the whole ballot, so a sponsor cannot
be tricked into paying for a different one, and the ballot's OWN signature is verified, so a
sponsor cannot push a vote nobody cast. Money buys storage; it never buys a choice.

Proposed here and still not implemented: the **role model** stated as one thing rather than
scattered across the board, and the position on **tokens**.

## The problem

The network has verbs and payouts, and no answer to three questions a person arriving with an
idea will ask in the first hour:

1. What am I here — a user, a host, a builder, a machine?
2. Where does money come from, and where does it not?
3. Who decides what is good?

Today a reader can reconstruct answers from `docs/WORK.md` and the RFCs, which is fine for
someone auditing the design and useless for someone deciding whether to bring a server, an
agent, or a business here. And the third question has no answer at all: the ROADMAP lists
"Governance approval" as an unchecked v3 item, and nothing in the tree says what a decision
would even look like.

## Roles, stated once

Every role below is a **worker with a key**, and the difference between roles is what the work
is, not who is allowed. There is no roster, no approval, and no permissioned tier.

| Role | What it does | What pays it |
| --- | --- | --- |
| **Operator (經營者)** | Runs a node: serves the API and the registry, holds bytes, mirrors an anchored root, relays an anchor to a chain | `store`, `mirror`, `relay` — paid by whoever's data it is and by the protocol's fee share |
| **Builder** | Publishes artifacts, answers a challenge, derives a remix | `publish`, `remix` |
| **Verifier** | Recomputes a claim and reports the verdict — a phone browser counts | `verify` |
| **Reporter** | Finds a key that should be revoked and proves it | `report` |
| **Participant** | Holds a key, reads, verifies, speaks, brings others | **nothing, and that is deliberate**: participation costs nothing and pays nothing |
| **Agent** | An AI (or a robot) that attests, publishes, verifies, stores — a worker whose key is its own | the same board as anyone else |

The operator's economics are the part most often misread, so state it plainly: an operator is
not paid for running software, and not for holding a key. An operator is paid for **provable
work** — a possession proof, a root rebuilt from a bundle, a chain read back — and the receipt
is an attestation anyone can recompute. That is the honest kernel of the mining analogy: the
cost is real (storage, bandwidth, electricity), the payout is for verified work, and nothing is
minted on a schedule (`docs/WORK.md`).

## Where money comes from, and where it does not

Credits exist and are recorded against a **key**, not a device, so a worker carries its earnings
with it. They are a unit of account for work delivered, redeemable for the platform's own
services, settled by the chain (RFC 0018). Three things follow, and all three are already true
in the tree:

- **Demand pays.** A challenge carries a bounty, storage is paid by whose data it is, mirroring
  and relaying come from the fee share. When demand stops, work stops, and nothing inflates.
- **Presence does not pay.** No faucet, no daily bonus, no leaderboard by default: a board that
  ranks people produces farming rather than verification.
- **Nothing is minted by the protocol.** This is not a detail of this RFC; it is the ROADMAP's
  standing refusal to run a token sale, and this RFC does not reopen it.

One more property belongs to the money half, because without it the accounting is a node's word: a
publication's identity is recomputed from the record (`publicationRoot`), and a CREDIT carries its
own recomputable root (`creditRoot`) — every field of a receipt is content, because a credit record
has no minted label at all, so the receipt a worker holds for its earnings is checkable by whoever
it is shown to. And the ledger as a whole carries a commitment: `creditLedgerRoot` is recomputed
from the records alone — leaves sorted by the records' own identities, so order does not matter —
and a node publishes it, which makes a payment dropped, edited, or quietly added produce a different
root instead of a quieter ledger. A receipt travels with its inclusion proof, so a worker proves its
payment is in the committed ledger rather than asking to be believed. The entries a node holds can
be checked by whoever holds them. The same published content is the same object whichever node
wrote it down, a copy that differs in one covered field is a different object, and the `id` a
publisher mints stays a label rather than becoming identity. What a covered field is, is stated in
one place and held by a test that enumerates the record's fields — adding a field to a publication
fails the gate until somebody decides whether it is content or bookkeeping.

### On AI tokens

"AI lives on RAREXT" has an economic reading, and it is not "the protocol issues a coin". It is
that **an agent is a worker**: it can attest a run, verify someone else's claim, store bytes,
mirror a root — and be paid in the same credits, attributed to the same kind of key, with the
same portability. The AI token, in substance, is the credit its work earns, and it exists today
because the board exists today.

If a community wants those credits to be transferable or traded, that is an **application**, not
the protocol — exactly as a launchpad is an application and the protocol's job is to make the
launch checkable rather than to issue anything. An application that issues a token can publish
its issuance policy as an artifact and certify against it, so a buyer can check the claim
instead of trusting the issuer. The protocol supplies the accounting; the application supplies
the token; the boundary is stated here so nobody has to guess whose job it is.

## How the community decides

The third question — who decides what is good — gets a mechanism in the same shape as
everything else here: **a decision is an artifact, and its outcome is recomputed, never
announced.**

- A **proposal** is a document with a pinned root: what is being decided, what the choices are,
  when voting closes, and which **policy** governs the tally.
- A **vote** is a signed attestation over `(proposalRoot, choice, voter, issuedAt)` — the same
  payload and signature primitives the protocol already uses for publications. It can be
  published as an artifact, mirrored, anchored, and read offline like anything else.
- The **tally** is a pure function of the published votes and the pinned policy
  (`tallyVotes` in core, with signature verification and the credit ledger taken as PORTS, so the
  rule never touches a key or a balance). Anyone — a browser, an operator, a stranger auditing the
  vote — recomputes it and gets the same bytes; `tallyRoot` is what they compare. **The tally is
  recomputed, never announced.** The property is stronger than a count: the same votes in a
  different order recompute to the same root, refusals included, so arrival order is never
  evidence. Every vote that does not count is reported by name — a wrong proposal, an unknown
  choice, a time outside the window, a forged or edited signature, a second ballot from one voter,
  a voter the ledger does not know — because a silent subtraction is not an audit.
- The **result** is published beside the votes, so the decision and its evidence travel
  together, and a decision that changes the rules must itself be made under the rules that were
  pinned before it.

Two properties this gives the ecosystem, both of which are the point:

**The identity that votes is the key, not the label.** A vote carries a `voter` field for
attribution — a name a voter chooses for itself — and a `publicKey` the signature was verified
against. Everything that must identify a voter (one key is one vote; the account a work-weighted
policy reads) uses the KEY. Implemented against the label first, which meant one key could vote
every choice simply by relabelling itself, and the count showed two voters; the tally now keys on
`canonicalize(publicKey)`, and the weight port receives the vote rather than a voter name so the
ledger it reads is the one the ballot was actually signed by.

- **No committee.** There is no body whose word is the outcome. There is a function, and
  whoever disagrees runs it.
- **The rules are policy, not code.** One key one vote, work-weighted by credits, an operator's
  attestation, a paid proof, an invite — the protocol does not choose. The community pins a
  policy document, the tally reads it, and a reader can see exactly which rule produced the
  number. Deciding what is good is left to the people deciding, which is what letting them
  decide means.

A budget line exists as protocol rules **and as wiring**. A pledge is the pledger's signed
commitment — the payload names the proposal by its ROOT, the identity everything else defers to,
names the choice whose decision triggers payment, and is signed by the key that will be debited. It
is refused by name if the proposal is unsound, the amount is not a positive integer, the payer and
payee are the same key, the pledging key is not a registered identity, or `payOn` is not a choice
the proposal offers. `budgetPaymentRecords` derives what execution becomes: exactly TWO ledger
entries, the pledger debited and the recipient credited, both referencing the decision's root — the
same field the board uses to keep the same work from being paid twice, so a decision is payable
once, and a replay is refused rather than re-paid. The protocol never mints: the debit and the
credit sum to zero, and the ledger commitment covers both sides with no new machinery.

Execution is gated on what the NODE recomputes, not on anyone's request: the vote window must be
closed, the outcome must be DECIDED (a tie funds nothing; an unmet quorum funds nothing), and the
decided choice must be the one the budget named — otherwise the refusal says nothing is owed. The
rules shipped first (#17) because they are the part that must be right; the wiring followed them
rather than leading them.

### Participation recorded, paid by decision

The user's side of the roles: a reader who verifies a mirror against a pinned root has done
work the network can corroborate. `POST /v1/work/participation` records it — a receipt with
kind `rarext.participation.v1` in the same ledger, same commitment, `bounty: 0` — and the
receipt's VALUE arrives, if it does, when a community budget decides to pay the participants a
decision names. Nothing is minted; the record is what makes participation countable.

### Admitting a registry: the same decision, a different effect

A federation list that only the registry operator can edit is a guest list, not a federation.
The seed list gains its entries through the same rail that moves money: an operator attaches an
admission document to a proposal — `POST /v1/governance/proposals/:root/admission`, kind
`rarext.registry-admission.v1` — whose `registry` field is the seed's own entry shape (id, url,
operator, chains, note) and whose `payOn` names the choice that applies it. The attach route
refuses a document that is not an admission, a `payOn` the proposal does not offer, and an id
already admitted or already pending under another proposal (one open decision per registry —
two open decisions over one registry is an ambiguity a federation list must never reach a tally
with).

Execution is the budget route's mirror: the same window, tally, and decided guards; the decided
choice must be the one the admission named; the decision applies exactly once; and the admitted
entry is served at `GET /v1/registries` in the seed's own shape — parseable by
`parseRegistrySeedList`, carrying the proposal root that admitted it. A rejected decision
changes nothing and says so. The admission proposes a LISTING, never a fact about reachability:
clients verify copies against roots as with every other registry.

## The constraint, verified rather than assumed

Keys are free, so **one key is not one person**, and this RFC does not pretend otherwise. An
attacker can generate ten thousand keys and vote with all of them. What is claimed here is
narrow and worth having: a verifiable tally, published evidence, and no privileged decider.
What is NOT claimed: proof of personhood.

If a community needs to resist sybil weight, it pins a policy that names how weight is earned —
an operator's attestation about a member, a paid proof, an invite chain, work-weighted credits
that cost real resources to earn — and the tally applies it. The legitimacy of a vote is then
exactly the legitimacy of its pinned policy, visible to anyone, instead of an assumption
distributed invisibly through a committee.

## Decision

Adopt the role table above as the model the docs describe; keep the money exactly as it is
(board, per-key credits, demand-paid, nothing minted); and treat the governance shape —
proposal artifact, signed votes, recomputable tally, pinned policy, published result — as the
design to implement when a community asks for it. Nothing in this RFC requires a new chain, a
new token, or a new server: proposals are documents, votes are attestations, and the tally is a
function.

## Security considerations

- **Sybil weight.** Stated above and not solved by a key: the pinned policy decides, and the
  policy is published with the tally.
- **Vote buying and coercion.** Votes are public artifacts, so buying them is visible and
  verifiable — visibility is the mitigations' whole supply. A community that needs secret
  balloting must say so in the policy, and this RFC does not claim to provide it.
- **Replay.** A vote is bound to a proposal root and an issue time; the same freshness and
  nonce discipline the rest of the protocol uses applies (see `SECURITY.md` and `docs/HARDENING.md` and the
  revocation and rotation primitives, `isRevoked` and `keyRotationPayload`).
- **Meaning drift.** A vote's question is a document with a root, and what its words mean is
  carried by a semantics record like every other claim here — so "we voted to do X" is checkable
  against the X that was pinned, not against a later paraphrase.

## Compatibility

Additive. The board, the credit records and the rent are unchanged. A governance artifact is a
publication-shaped signed record, so existing storage, mirroring, anchoring and offline
verification apply without modification, and a deployment that never holds a vote is unaffected.

## Non-goals

- **No token sale by the protocol or its maintainers** — unchanged from the ROADMAP.
- **No committee, no privileged operator, no unilateral parameter change.** Parameters that
  matter are pinned documents.
- **No on-chain requirement.** A tally is a recomputation; anchoring is optional ordering.
- **No emission, no presence rewards, no leaderboards by default.**
- **No claim of personhood, and no secret ballot.**

## Open questions

1. **Should the default weight be one key one vote or work-weighted credits?** —
   **ANSWERED: the protocol does not pick one, and that is the design rather than an
   evasion.** Weight is the thing the community is deciding about, so a default baked
   into the protocol would let the most consequential question be answered by whoever
   wrote this document. The pinned policy carries it, the tally reads it, and a reader
   can see which rule produced the number — which is what the Decision section means by
   leaving goodness to the people deciding. A deployment that wants a fixed default may
   publish a policy that says so; what it may not do is have the default be unstated.
2. **Quorum and duration — pinned per proposal, or a protocol default with an override?** —
   **ANSWERED: pinned per proposal, for the same reason as weight.** A quorum nobody voted
   on is a legitimacy that arrived from outside the vote, and an override that can change it
   after the fact is worse than no rule: the proposal document carries both, and both are
   part of the root the votes are bound to.
3. **Must a result be anchored, or is recomputation from published votes enough ordering?** —
   **ANSWERED: recomputation is what makes the tally trustworthy, and anchoring is what makes
   its order checkable — so anchoring is optional and useful exactly when a decision must be
   sequenced against other artifacts.** RFC 0020's argument applies unchanged: an anchor
   gives ordering, not truth, and the tally's truth is its recomputability from votes anyone
   can fetch.
4. **Who pays for a vote, when the participant has no credits?** —
   **ANSWERED, and since this RFC was written, implemented: a sponsor can.** A ballot may be
   submitted sponsored, with a member's signed assertion carrying the whole ballot and the voter's
   own signature still required, and the payer is recorded next to the vote. What the sponsorship
   machinery deliberately does NOT decide is who should need sponsoring: that is the community's
   pinned policy, and a roster is something an operator configures rather than something this
   protocol invents. Storage rent (RFC 0018) and the pin service remain the other ways to pay for
   someone else's bytes.
