# Work and rewards

The protocol is designed so that a visitor can be useful before they have an account,
a wallet, or a stake. This document describes the work economy: what a person or an
agent can do, how each kind of work is checked, and what it pays.

## The rule

**Work is permissionless. Finality is not.**

A browser on a phone can verify a build, hold bytes, or mirror the registry. It
cannot order blocks, settle escrow, or decide finality — that needs a validator set
and a stake. Keeping those apart is what lets participation be low-friction without
pretending the security model is low-friction too.

## The actions

The board is a list of verbs, and each pays differently because the work is
different.

| Action | Unit | Base | What the check is |
| --- | --- | --- | --- |
| `verify` | per verified attestation | 10 | the registry recomputes the attestation and compares |
| `store` | per byte-month | 1 | a possession proof plus a time-locked retention opening |
| `mirror` | per anchored root mirrored | 25 | the mirror rebuilds the anchored root from the bundle |
| `relay` | per anchor submitted to a chain | 15 | the chain is read back and confirms the root |
| `publish` | per published artifact | 5 | the artifact passes its challenge |
| `remix` | per derivative | 20 | the lineage records the derivation |
| `report` | per accepted revocation | 50 | the revocation is signed and the target confirmed |
| `infer` | per agreed model completion | 12 | a quorum of providers agreed and the node attested the run |

The numbers above are the *base*; the payout for a specific job is the base scaled by
the difficulty of that job. A hard challenge pays more than a trivial one, and a rare
action pays more than a common one.

## Nothing is minted on a schedule

Rewards come from **demand**, not dilution:

- A challenge carries a bounty — somebody who needs it verified pays for it.
- Storage is paid by the person whose data it is.
- Model inference is paid by the buyer: a deployment commits a bounty and a run
  pays the distinct operators that agreed, settled in the same credit ledger.
- Mirroring and relaying are paid from the protocol's fee share.

So there is no emission treadmill, and no reflexivity between "the token price funds
security" and "security funds the token price". When demand stops, the work stops and
nothing inflates.

## Portable verifiers: one implementation, one verdict

A worker has to run the *same* verifier the registry runs, or the two disagree and
nobody gets paid. That is why a verifier can be published as a **portable module**:

```
GET /v1/verifiers                    the catalogue
GET /v1/verifiers/chess/<hash>.mjs   the exact bytes, by hash
```

The module has a declared hash. The registry serves the bytes only if they hash to it,
and the attestation names the module hash. The browser imports the same bytes, runs
the same code, and computes the same canonical attestation — so a phone and the server
agree, and a substituted module is caught.

`apps/verifiers/chess` is the reference implementation: the chess rules in
TypeScript, with ground-truth fixtures generated from the previous Python
implementation so the port is proven rather than assumed.

A verifier returns the ABI the protocol expects:

```ts
verify(artifact, challenge) -> { correct, score, gateCount, proof, details }
```

`proof` is the trace. The protocol hashes it with the same canonical JSON it uses
everywhere, so the trace hash is the same on both sides.

## What a worker actually does

1. `GET /v1/work` — the action board and the open jobs.
2. For a job: fetch the module by hash, import it, run `verify`.
3. Compute `circuitHash = sha256(canonicalize(artifact))` and
   `traceHash = sha256(canonicalize(proof))`.
4. Sign the submission digest with the worker's key.
5. `POST /v1/verifications` — the registry recomputes the attestation itself and
   compares. A worker that hands back something the verifier would not produce gets
   nothing.
6. The registry credits the worker and refuses to pay twice for the same artifact.

The worker is not trusted and does not need to be: the check is the recomputation, and
the signature only says *who* did the work, so the earnings can be attributed.

## Rewards and identity

Credits are recorded against a **key**, not a device. A worker that exports its
identity can move its earnings to another machine, which is what makes "rewarded on
any device" true rather than aspirational.

Credits are a unit of account for work delivered, redeemable for services the
platform provides — storage, verification, mirrors, model inference. They are not
cash: there is no bank to withdraw from, and the chain settles them.

## Moving credits between keys

Credits are not glued to the key that earned them. A key can move what it holds to
another key with a signed instruction:

```
POST /v1/work/transfer
{"kind":"rarext.credit-transfer.v1","from":"<keyId>","to":"<keyId>",
 "amount":5,"nonce":"<unique>","at":"<now>","signature":"<base64 over the instruction>"}
```

A transfer is not a faucet and not a mint: the node records the debit and the credit
the instruction implies — two records that sum to zero, both naming the transfer's
own identity — and it pays only what the payer already holds. The rule that stops a
double-spend is stated over the whole ledger: **no key may end up overdrawn**. Because
every transfer is a zero-sum pair, the total is conserved, so an overdraft can only be
the same credits spent twice. A node enforcing it at write time and a reader
recomputing it from the records agree, because it is a function of the set, not the
order. Two transfers that differ only in `nonce` are two movements; the SAME signed
instruction can never be applied twice, because its identity is a function of the
nonce.

Each of the two records carries its own recomputable root and a Merkle inclusion proof
against the node's whole-ledger root (the same `creditLedgerRoot` every other rail
rides), so a payee can prove it was paid against a commitment anyone can recompute:

```
{"transfer":{"id":"<64-hex>","from":"…","to":"…","amount":5,"nonce":"…","at":"…"},
 "balances":{"from":7,"to":5},
 "receipts":[{"keyId":"…","action":"transfer","bounty":-5,"artifactHash":"<64-hex>",
              "ledger":{"root":"<64-hex>","index":3,"proof":["…"]}}, …]}
```

`GET /v1/work/statement?keyId=…` reads the same ledger from the earner's side —
`credits.earned`, `credits.spent`, `credits.net` — so a transferred balance is visible
as a spend and a net, not hidden in one total.

## Participation receipts

The actions above pay for work. One more act happens every day and is worth recording even
though nothing pays for it yet: a reader verifying a mirror's copy against a pinned root. That
act is the reader-side labor that keeps a federation honest, and the ledger can record it:

```
POST /v1/work/participation
{"kind":"rarext.participation.v1","participant":"<keyId>","act":"mirror-verify",
 "root":"<64-hex root>","at":"<now>","signature":"<base64 over the assertion>"}
```

The node corroborates what it can actually know — the key is registered, the signature is the
participant's, and the root is one THIS node anchored — and records a receipt with
`action: "participate"` and `bounty: 0`. Zero is the point, not a placeholder: nothing is minted
for participation, the receipt EXISTS so a community's later budget decision can pay the
participants a decision names, through the same rail that pays any other work. One receipt per
participant, act, and root; a root the node never anchored is refused by name, because a receipt
for a verification the node cannot vouch for would be a lie in its own ledger.

## Anchor receipts: the operator's side

The participation receipt is the USER's side of the roles. The OPERATOR's side is the standing
work of running a node — committing publications to a Merkle root and freezing the state archive —
and it leaves a record the same way:

```
POST /v1/work/anchor
{"kind":"rarext.anchor-work.v1","operator":"<keyId>","root":"<64-hex root>","at":"<now>",
 "signature":"<base64 over the claim>"}
```

The node corroborates exactly what it can know — the key is registered, the signature is the
operator's, and the root is one THIS node anchored — and records a receipt with
`action: "anchor"` and `bounty: 0`. This is the mining analogy with the mint removed: anchoring is
not a lottery over hashes and nothing is emitted for it, but the work is COUNTED, so a community's
budget decision can name the operators it wants to pay — `{"kind":"receipt-holders","act":"anchor"}`
resolves to exactly the operators whose anchoring this node corroborated. One receipt per operator
and root; the same work is never receipted twice, and a root the node never anchored is refused by
name. The two sides of the roles are countable apart: `participate` is what a reader did,
`anchor` is what an operator did, and both ride the same ledger, the same commitment, and the same
民主 rail that decides what any of it is worth.

## The treasury view: sizing a decision against the real class

A budget that pays a receipt class — `{"kind":"receipt-holders","act":"anchor"}` — resolves the
class against this node's own ledger AT EXECUTION time. So a community sizing a pledge should see
the same class the node will, and a newcomer should be able to see it before deciding:

```
GET /v1/work/treasury
{"ledgerRoot":"<64-hex>","classes":[{"act":"anchor","receipts":1,"holders":1,
  "byRoot":[{"root":"<64-hex>","receipts":1,"holders":1}]}, …],"pending":[…]}
```

`classes` reports, per receipt act, how many receipts exist and how many DISTINCT holders hold
them, with a per-root breakdown so a root-scoped decision can be sized against the root rather
than the whole act. `pending` names the proposals whose budgets already name a class, so a new
pledge is not made blind to the ones in flight. The counts come from the same records the
commitment covers and are recomputed at read time — a view that could drift from the ledger it
summarizes would be worse than none, because a pledge against it would be a guess wearing a
number.

## The statement: the ledger from the earner's side

The receipt rails leave records, the treasury sizes the classes a decision can pay, and a budget
pays them — but an earner could not ask the one question that ties them together: *what do I hold,
what have I been paid, and what does my standing amount to?*

```
GET /v1/work/statement?keyId=<key>
{"keyId":"<key>","ledger":{"root":"<64-hex>","count":N},
 "credits":{"earned":300,"spent":0,"net":300},
 "byAction":{…},
 "holds":[{"act":"anchor","receipts":1,"roots":["<64-hex>"]}],
 "weight":300, "at":"<now>"}
```

`holds` names the receipt CLASSES this key is in — the acts a decision can name to pay it, which is
what "what is owed to me" means at this layer. Add `&at=<anchorRoot>` and the statement is read
from a FROZEN state instead of now: the response then carries `asOf` naming that archive and the
root it commits to, so the past can be CHECKED — fetch `/v1/history/:anchorRoot`, recompute the
archive's state root, and the ledger the statement counted is the one that state committed. A
participant can prove not only a receipt but the world it sat in — and so can a reader: the mirror's
proof page takes a key, recomputes each registry's frozen state root **in the browser**, and derives
that key's statement from the archived credits with the SAME core function the node answers with
(`creditStatement`). No CLI, no repo, no trust in the node's version of now. `credits` separates earned, spent, and net, because
a worker that pledged a budget has been debited and a single total hides that. `weight` is the
SAME number a work-weighted ballot would weigh (the ledger total the tally reads), so the earner
sees its standing before voting rather than inferring it. No `keyId` is a 400: a statement is about
a key, and there is nothing to state without one.

## What is deliberately not here

- **No emission.** There is no faucet and no daily login bonus. Work pays; presence
  does not.
- **No leaderboard by default.** A board that ranks people turns work into a
  competition, which is how you get farming instead of useful verification. The
  per-worker earnings are visible to that worker.
- **No proof of work in the wasteful sense.** The expensive part is the verification
  itself, and it produces something real: an attestation.
- **No fixed-rate equivalence between actions.** A byte-month and a report are not
  the same thing, and the board says so rather than pretending they are.
