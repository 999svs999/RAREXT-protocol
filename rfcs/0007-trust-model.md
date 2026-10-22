# RFC 0007: Trust model and Trac anchoring

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Depends on:** RFC 0002 (signed publications), RFC 0003 (verifiable claims),
  RFC 0005 (durable placements), RFC 0006 (independent verifier operators)
- **Implementation:** documentation only; this RFC states what the shipped code
  proves and what a reader still has to decide.

## Summary

RAREXT does not ask anyone to "trust the registry". It asks a reader to check a set of
signatures and hashes and then make one explicit decision: which keys and which chains
do I accept? This RFC writes down that split — what the protocol guarantees, what each
actor can lie about, and what an anchor on Trac would and would not add.

The short version:

- A hash proves **what** something is, not that it is good.
- A signature proves **who** said it, not that it is true.
- A verifier proves a **mechanical property** under a named semantic record, not that
  the property is the one you care about.
- An anchor proves **when** a commitment existed, not that its contents are valid.
- A holder challenge proves **the bytes were served once**, not that they will be served
  tomorrow.

Every remaining trust is a decision about a key, a chain, or a time window. The protocol
tries to make that decision small, named, and checkable.

## The claims a publication carries

| Claim | Signed or produced by | What it proves | What it does not prove |
| --- | --- | --- | --- |
| `artifact` / hashes | The publisher (content) | The bytes hash to the stated value | The artifact is correct or useful |
| `attestation` | The registry's verifier, or a registered operator (RFC 0006) | A specific verifier returned `correct` with a score under a named challenge | That the verifier is right, or the challenge measures what you want |
| `signature` (`authorKey`) | The author's key | This author published this envelope, including the attestation | The author is honest, or owns the key's claimed identity |
| `semantics` binding | The challenge/app operator | The claim's meaning is versioned and hash-bound | That the meaning is the meaning you assume |
| `durability` | The registry's ledger, from holder answers | Shards answered a nonce-bound challenge inside a window, under a named placement | That the bytes are correct, complete, or will stay |
| Anchor leaf / proof | The anchor adapter, or the RAREXT chain | A commitment to the leaf existed in a signed/hashed structure | That the registry published all leaves, or that the chain is honest |
| `revocation` | A capability holder or maintainer key | A named key or verifier hash is distrusted from that point | That every reader has seen the revocation |

The publication object keeps these apart. A reader can accept one and reject another;
for example, accept the anchor as a timestamp while rejecting the operator that signed
the attestation.

## Actors and what each can do

**The author** holds a key and can sign any envelope. They can lie about their identity
(handles are labels until an identity link is verified), about the artifact's origin, and
about which attestation they received. They cannot make an operator signature verify.

**The registry operator** stores and serves. It can withhold a publication, refuse an
operator, lie in a durability observation, or stop serving altogether. It cannot forge
an author signature, an operator signature, or a chain anchor; it can, however, run a
verifier that returns whatever it wants in `recomputed` mode — that trust is the
registry's code, not a signature.

**The app operator** defines the challenge and its semantics. They can write a challenge
that measures nothing, define a semantics record that licenses a stronger claim than the
test supports, or run a verifier that is wrong. The binding is public: the semantics
record and verifier hash travel with the claim, so a reader can inspect or replace them.

**A verifier operator** (RFC 0006) signs an attestation with its own key. Registration
is permissionless, so the registry listing is discovery, not endorsement. An operator
can sign a false result; the reader's question is whether to trust that key for that app.

**A holder** stores shards and answers challenges. A holder can lose bytes, serve the
challenge leaf only, or go offline. It cannot forge a placement record (the steward signs
it) and cannot answer a nonce it was not given. A single successful challenge is a sample,
not a retention guarantee.

**An anchor chain** orders commitments. It can reorg, censor, or be unavailable. What a
reader gets from it is a timestamp and inclusion under a root, at the chain's own trust
level.

**A reader** decides which keys, verifiers, anchors, and windows count. That decision is
the actual trust model; everything else is evidence.

## Composition rules

These rules are the ones the implementation follows. They are written here so a client
can do the same.

1. **Recompute when you can.** A mirror or verifier should re-run the app verifier and
   compare both hashes rather than copying `verified: true`. `recomputed` mode means the
   registry ran its verifier; it does not mean the result is independent of the registry.
2. **Read the verification mode.** `recomputed`, `operator`, and `attested` are different
   claims. Only `operator` names a key outside the registry; only `attested` means nobody
   recomputed anything.
3. **Check the bindings, not just the signature.** An operator attestation is accepted
   only when the challenge, semantics record, and artifact hash match. A valid signature
   over the wrong artifact is not evidence about this artifact.
4. **Treat registration as discovery.** An operator in `GET /v1/verifier-operators` is
   someone the registry has seen, not someone it vouches for. A reader with an allowlist
   should ignore operators outside it.
5. **Separate provenance from correctness.** The author signature proves who published.
   Correctness comes from the verifier and the semantics record; neither substitutes for
   the other.
6. **Use the anchor for time, not truth.** An inclusion proof says the leaf was committed
   before a block; it says nothing about the score being right.
7. **Read durability as dated.** `live` is a count of answers inside a window, and
   `placementDigest` names the record used. It is not a promise about the next window.
   A `verified` replica is a shard that answered; a `required` count is a tier, not a
   measurement.
8. **Check the semantics record before the score.** A correct result under a semantics
   record that licenses a narrower claim does not support a wider one. The semantic
   layer is where "what the test means" is pinned.

## Threat model

| Adversary | Capability | What stops it | What does not |
| --- | --- | --- | --- |
| Lying author | Signs a false claim or steals credit | Author signature binds the envelope; lineage and identity links are checkable | A signature does not make the claim true |
| Lying operator | Signs a false attestation | Reader's operator allowlist; verifier hash and semantics are public | Registration alone |
| Malicious registry | Withholds, censors, forges durability, runs a bad verifier | Mirrors, registry bundle, chain anchors, holder-signed records, independent operators | Trusting `verified: true` |
| Network attacker | Alters responses in transit | Content hashes, signatures, and TLS where used | HTTPS alone for an unsigned payload |
| Compromised key | Signs as the author or operator | Revocation lists (after the fact), key rotation (not shipped) | Any signature made before revocation |
| Chain reorg / outage | Reorders or hides anchors | Multiple anchor targets; local anchor with later re-announcement | A single chain, treated as final |
| Garbage challenge | Measures nothing, licenses a strong claim | Published challenge, semantics record, independent verifier | The protocol's opinion of "good" |

## Trac anchoring

Trac is the intended home for identity and the challenge registry, and one of several
anchor targets. The design keeps it a *notary*, not the database:

- The registry commits a Merkle root; Trac records the root and a timestamp. A reader
  verifies inclusion against that root without asking the registry for permission.
- Trac is allowed to be unavailable. The registry stores a local anchor, marks the
  adapter as `local`, and re-announces later; a publication does not become unpublishable
  because a chain is down.
- Trac is allowed to be wrong about meaning. A Trac-anchored root proves ordering and
  existence; it does not prove the verifier was correct. That still comes from the
  verifier and semantics record.
- A Trac-native identity would let a reader resolve an author key to an account without
  the registry's map. Until that exists, identity links are claims signed by keys, and a
  reader decides whether the link is enough.

What Trac would add, concretely:

1. **Timestamp ordering** that survives the registry going away.
2. **Identity resolution** not controlled by one registry operator.
3. **A challenge registry** that apps can anchor to, so a challenge ID means the same
   thing across registries.
4. **A second trust domain** for anchors, so one operator's chain cannot be the only
   witness.

What it would not add: correct verifiers, honest operators, retained bytes, or a reason
to skip recomputation. Those are separate mechanisms with separate evidence.

## Recommended reader policies

**Minimal check (any publication).**

- hash the artifact and compare it with `artifactCommitment`/content hash;
- check `attestation.correct`, the score/gate count, and that the challenge, app, and
  semantics record match what the reader expects;
- if provenance matters, verify the author signature over the canonical payload.

**Independent-verification check.**

- the above, plus `verification` is `operator` with a key on the reader's allowlist, or
  the reader recomputes the verifier itself;
- reject `operator` attestations from unknown keys even if the registry lists them.

**Durability check.**

- a signed placement record names the shards and steward;
- `live >= required` in an observation inside the reader's freshness window;
- at least one spare holder exists, so repair is possible without the reader's help;
- verify a sample of the challenge answers or run a challenge against a holder.

**Anchored check.**

- inclusion proof verifies against the anchor root;
- the anchor is at the reader's required depth or has the required number of independent
  confirmations;
- for a chain-based policy, more than one anchor target agrees, or the reader accepts a
  single chain's finality rule.

No policy is enforced by the protocol. A client that skips all of this is trusting the
registry; that is a choice, but it should not be described as verification.

## What this RFC does not decide

- A canonical operator allowlist or a stake/slashing mechanism (RFC 0006 leaves operator
  trust to the reader).
- Required anchor depth, number of chains, or Trac finality parameters.
- Whether verifier bytes are pinned by hash in the publication (currently the verifier
  hash travels in the attestation, but the bytes are not fetched).
- Key rotation and revocation propagation, which remain v1 work.
- Whether a future chain can replace Trac as the identity home.

## Implementation status

The separation described here is implemented: signed publications, recomputed and
operator attestations with their bindings, signed placement records, dated durability
observations, revocations, and multi-target anchoring with read-back. The reader
policies are guidance, not code; there is no built-in allowlist, anchor-depth policy, or
automatic verifier-byte fetch. Trac remains an adapter target, not a required dependency.
