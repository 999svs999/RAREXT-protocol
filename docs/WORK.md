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

The numbers above are the *base*; the payout for a specific job is the base scaled by
the difficulty of that job. A hard challenge pays more than a trivial one, and a rare
action pays more than a common one.

## Nothing is minted on a schedule

Rewards come from **demand**, not dilution:

- A challenge carries a bounty — somebody who needs it verified pays for it.
- Storage is paid by the person whose data it is.
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

Credits are not money yet. They are a unit of account for work delivered, redeemable
for services the platform provides — storage, verification, mirrors. The chain settles
them.

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
