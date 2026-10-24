# web4

**web4 is the network this protocol is building toward.** Not a token, not a chain,
not a browser: the layer where any object, any claim, and any agent carries its own
proof, and anyone with a device can hold bytes, verify work, and be paid for it.

RAREXT is the protocol. ApesDaily is where the public meets it. web4 is the shape of
the network the two add up to.

## Why a new name

- **Web1** — pages you read.
- **Web2** — apps you write into, and platforms that own what you wrote.
- **Web3** — tokens and chains; ownership as an asset, often with new gatekeepers at
  the on-ramp.
- **web4** — verification as the primitive. You do not ask a platform whether
  something is true; you recompute it. Storage and compute are contributed by
  participants, not rented from a company. Identity is a keypair. Reputation is
  portable because the claims that produce it are portable.

The name is a working name. "Web4" is already used for other things — AI-native
browsing, ambient agents, a few standards efforts. This document is the definition we
mean: the verifiable, participant-held layer. If the term settles elsewhere, the
protocol does not depend on it, and neither should you.

## The four primitives

| Primitive | What it means | Status in this repo |
| --- | --- | --- |
| **Identity** | A keypair, not an account. ECDSA-P256 or ML-DSA, suite recorded with every signature. | Shipped |
| **Storage** | Content-addressed bytes, k-of-n erasure shards, placement across holders, challenges, repair. | Blobs, shards, placement, a holder HTTP transport, scheduled nonce-bound challenges, repair, and advertised durability shipped; payment for retention is open work |
| **Verification** | Deterministic recompute; one verifier running unchanged in a browser and on a server, plus independent operator attestations that name who signed. AI claims carry an explicit representation kind — exact bytes, generative replay from a committed model + seed, or a bounded metric against a committed reference — and every surface recomputes them from the same core math. | Recomputed and operator modes shipped; AI representation kinds with local re-verification shipped ([AI-VERIFICATION.md](AI-VERIFICATION.md)) |
| **Settlement** | Work and byte-months paid from demand, not from an emission schedule. No protocol token. | Work economy shipped; byte-month pricing designed, not shipped |

## What has to be true

1. **No gatekeeper for reading.** A published payload is reachable from a hash and a
   mirror, not from a company's permission.
2. **No gatekeeper for verifying.** The verifier is a file you can read and run. A
   browser tab is enough.
3. **No single holder required for durability.** k-of-n shards, tracked replica
   counts, and repair when a holder leaves. This is partly built and openly
   incomplete; the contract is written down in
   [`STORAGE-ECONOMY.md`](STORAGE-ECONOMY.md) and tracked on the roadmap.
4. **No platform required for identity or reputation.** A key signs; the claims it
   signed travel with it; a new app can check them without asking us.
5. **No protocol token.** Apps may launch tokens; the protocol's job is to make those
   launches checkable, not to issue anything itself.

## What web4 is not

- **Not "free storage."** The protocol charges nothing to write, read, or verify.
  Bytes still live on hardware somebody pays for. One holder is one copy, not
  durability. See [`STORAGE-FRONTIER.md`](STORAGE-FRONTIER.md).
- **Not a faster chain.** Chains here are notaries, not databases. Anchoring is a
  receipt, not the record.
- **Not a jurisdiction.** A permanent commitment and a servable byte are different
  things. Commitments are signed and permanent; serving can be revoked, and the
  revocation is published.
- **Not a promise that nothing can be removed.** It is a promise that removal is
  visible and signed.

## Honest status

This is pre-alpha. The mechanics of durability — placement, challenges, and repair —
exist, the holder has a wire protocol so it can be another machine
([RFC 0005](../rfcs/0005-durable-placements.md)), placements are signed,
sequenced records that survive the node that made them, and challenges run on a
schedule without a caller, and a publication reports its durability tier and live,
challenged replica count as a dated observation beside the signed bytes. What is
missing is the rest of the network: payment and retention contracts between
publisher and holder, and a rule for resolving conflicting placement histories. Until those exist, "the network has it"
means "a set of machines this process can reach has it", which is better than one
process and not yet a web4 network.

That is the gap between a protocol that can describe web4 and a network that is web4.
The roadmap says so, and the benchmark harness in
[`STORAGE-FRONTIER.md`](STORAGE-FRONTIER.md) is how the gap gets measured.

## How to join

You do not need permission to fork, run a registry, publish a verifier, or hold
bytes. If you want to work on the missing part, start with the issues labelled
`help wanted` — the durability contract is the one that matters most.
