# Fair launches

A token launchpad's real problem is not listing coins. It is that a buyer cannot
tell a fair launch from a rug, and the venue that lists both gets blamed. The
industry answer is a badge. The protocol answer is a claim somebody else can
check.

RAREXT already runs a launchpad with real anti-rug checks. This document describes
how those checks become a public, re-runnable protocol artifact instead of a
proprietary badge, and what that means for a token economy that has to survive.

## From badge to attestation

Today the launchpad runs a certifier that reads the chain and prints a verdict:
mint revoked, freeze revoked, contract not upgradeable, supply burned, no whale,
liquidity burned, no transfer tax. The verdict is cached to a blob and rendered as
"Certified safe".

A buyer has to trust that. The checks might be right; nobody can tell.

Under the protocol, each launch is published as an artifact and checked by a
verifier:

```
launch.plan artifact  ──▶  fair-launch verifier  ──▶  attestation  ──▶  anchor
   (the plan)             (open implementation)      (the proof)      (the chain)
```

- The **policy** is the challenge spec, versioned with the challenge and pinned by
  a semantics record. "Fair" is a defined meaning with a named owner.
- The **verifier** is open source, and its rules hash travels in the attestation's
  `verifierHash`. A claim is bound to the code that checked it.
- The **attestation** records the policy hash, the block it was read at, every
  check with its result, and the raw observations.
- The **anchor** fixes *when* the claim was made.

Anyone can re-run the verifier against the same block and get the same answer, or
run it later and get a different one — which is the point.

## Fairness is a trajectory, not a badge

A launch that was safe at block N can be unsafe at block N+1,000. A static badge
cannot express that, and it hides it: a coin certified once looks certified forever.

Point-in-time attestations compose into a trajectory. The registry can answer
"safety was verified at every check since launch, N checks, 0 failures", and a
buyer can verify the whole series from the anchored attestations rather than
trusting a summary. The same machinery that makes provenance portable makes
*continuous* verification portable, which is the property a badge cannot offer and
the one that actually protects a buyer.

This is the strongest reason the protocol and the launchpad belong together: the
launchpad already runs a continuous certifier, and the protocol turns its output
from a private snapshot into a public, auditable record.

## Fail closed

Anything the verifier cannot read is not a pass. Unreadable data yields level
`UNKNOWN`, and `UNKNOWN` is not correct. The policy, not the operator, decides
which fields are required — so a verifier that quietly stops reading a field
cannot turn a failing launch into a passing one without changing the policy, which
changes the challenge, which breaks the semantics binding and shows up as drift.

## The policy is the product

The check set and thresholds live in the challenge spec, not in the verifier code:

| Limit | Value | Why |
| --- | --- | --- |
| `minSupplyBurnedPct` | 25% | removes a mint-and-dump vector |
| `maxTopHolderPct` | 3% | rules out a single whale |
| `minUniqueTopHolders` | 5 | rules out a bundle pretending to be distribution |
| `maxCreatorAllocationPct` | 5% | caps what the deployer can dump |
| `maxTransferTaxPct` | 1% | keeps the token transferable and cheap |

Bumping a limit is a policy change: a new challenge version, a new semantics
version, a repinned hash, and a visible diff. Buyers can see when the rules moved
and when a launch was certified under the older ones. That is the difference
between "we promise fair launches" and "here is the rule set, here is its
history".

## Economics: what must survive

The store is the business. The token layer is additive and must never become a
dependency of it. Three rules, each with a mechanism rather than an intention:

1. **Never let the token become the revenue.** Product margin pays the bills;
   launchpad fees are upside. Mechanism: a treasury policy — fees accrue to a
   published treasury, and treasury spend may not exceed fee income over a
   trailing period. A launchpad that spends its way into a deficit is a launchpad
   that has to rug to survive, which is the failure mode this whole document
   exists to prevent.
2. **Never let the token contaminate the attention engine.** A social platform
   that posts coin promotion loses the account. Mechanism: the store's posts never
   carry coin calls; the launchpad is a separate surface with its own links.
3. **Never let the token promise a return.** Mechanism: claims are `satisfies`
   against a pinned policy, and the semantics record says in plain words that the
   claim is about one token at one block, is not a guarantee against later
   rugging, and is not a statement about profit. "Certified safe" is a structural
   claim, never a financial one.

## Fairness and creator allocations

The obvious revenue line for a launchpad — buy an allocation at launch, sell into
the spike — is the exact behaviour that makes a venue untrustworthy, and it is
also a fraud-shaped practice in most jurisdictions. The policy can express the
difference:

- Allowed: a disclosed creator allocation above the cap, held in a published
  wallet, with a published vesting schedule, and a claim that says `RISK` with
  the reason.
- Not allowed: selling the allocation into the spike it creates, or hiding it.

That distinction is only enforceable if it is written into the policy, checked by
the verifier, and published in the attestation. `creator_allocation` is already a
check; the vesting-lock and the sale-discipline rules are the natural next two.

## Fairness is venue-agnostic

The attestation rail does not care where the token lives. A launch on an existing
venue can be certified against the same policy and anchored the same way, which
means the daily ritual can start on rails that already have liquidity while the
own launchpad is built — the order the roadmap already argues for, with the
verification layer present from day one instead of bolted on later.

## What is not claimed

- A fair launch is not a safe investment, and the protocol does not say it is.
- An attestation is not a guarantee about the future of a token.
- The verifier operator is trusted to read the chain honestly. That trust is
  reduced, not removed, by publishing the rules hash: drift is detectable, and
  independent verifier implementations can be run against the same policy.
- A policy can be written to rubber-stamp anything. The defence is publication:
  the policy, its owner, its history, and the attestations are all public.
