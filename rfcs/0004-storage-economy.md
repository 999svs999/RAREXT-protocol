# RFC 0004: Storage economy and the chain path

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-22
- **Requires:** RFC 0002 (signed publications), RFC 0003 (verifiable claims)
- **Implementation:** `apps/api/src/storage.ts`, `examples/storage/`,
  `docs/STORAGE-ECONOMY.md`

## Summary

This RFC proposes a storage economy for the protocol: content-addressed storage
with a free open tier and a paid sealed tier, where the unit of value is a
verifiable claim of possession rather than a promise, and where the accounting
(byte-months) is public and ready to be settled on a chain.

It also states the path to an own chain, with a gate, and the honest limit of what
"decentralised" means for the apps that will run on it.

## Motivation

Three pressures point at storage.

**Availability.** A site on one cloud provider's CDN goes down when that provider
does. The DeWeb answer is replication plus content addressing: the bytes are
addressed by their own hash, so a mirror is a copy of a directory and the proof of
which copy is authoritative is a chain commitment, not a provider's uptime page.

**Privacy.** Enterprises and individuals will not put anything on a platform that
can read it. A sealed tier — client-side encryption, node-held ciphertext, claims
about custody rather than content — is what makes storage usable for anything
sensitive, and it is the same envelope work the private-artifact proposal needs.

**An economy needs a unit.** Attention is monetised elsewhere. Storage has an
intrinsic, measurable unit (byte-months), a natural free tier, and a natural
verification cost. It is the first economy that the protocol can price honestly
without a token.

## Design

**Blob.** Bytes stored under `sha256(bytes)`. The name is the claim. Writes are
atomic; reads re-hash and refuse to serve bytes that do not match their name.

**Manifest.** An artifact of kind `storage.manifest` listing blobs with the terms
they are held under. Its Merkle root binds the entries, and the manifest is a
publication, so it is anchored like everything else.

**Verifier.** The storage verifier reads the bytes and checks possession, digest,
size, and tier. It fails closed. The claim it produces is bound to the semantics
record `storage/storage-v1`, whose summary says in plain words that the claim is
about one storage node at one moment and says nothing about the contents of a
sealed blob.

**Proof of inclusion.** `GET /v1/blobs/:hash/proof` returns the chain of trust:
digest → manifest leaf → manifest root → manifest publication → anchor root. The
holder of the bytes can walk it without trusting the operator.

**Tiers.** `public` (open, free, replicated) and `sealed` (client-side encrypted,
the node cannot read it). A tier is a semantics record with a named owner, so
"sealed" means something checkable rather than something promised.

**Metering.** `GET /v1/storage/usage` returns bytes, counts, and retention per
tier. That is the ledger a settlement layer prices. The unit is byte-months.

**Chain path.** Stage 0 today: chain-agnostic anchoring with a local anchor and a
Trac webhook. Stage 1: multi-chain anchoring plus IPFS/Arweave pinning of the
bundle, so the bundle's CID is a mirror pointer and the chain root proves which
bundle. Stage 2: an own chain, gated on a chain-independent state model, real
volume to settle, a written and narrow job for the chain, and a funded validator
set.

## Consequences

**Good.** Storage becomes sellable because possession is verifiable. The protocol
gains a free tier that makes it a utility rather than a vendor. Every app that
follows inherits media, documents, and a metering ledger.

**Bad.** A storage node is a real cost. "Replicated" means someone pays for the
copies, and until the settlement layer exists, that is the operator. The metering
is public, which means the operator's cost is visible too.

**Bad.** A sealed tier only protects the content if the client really encrypts.
The verifier can check that the stored object is a well-formed envelope; it cannot
prove the plaintext was never uploaded. The claim is about custody, and the
semantics record says so.

**Bad.** The own-chain path has a real temptation: to become the product rather
than the settlement layer. The RFC's stage-2 gate exists to resist it.

## Alternatives considered

- **Only sealed storage.** Rejected: it makes the free tier impossible and hides
  the protocol behind a key-management problem.
- **Only open storage.** Rejected: it cannot carry anything an enterprise or an
  individual would not publish, which is most of the value.
- **A chain-native storage market.** Rejected for now: it puts byte prices on a
  chain before there is a chain, and it makes the storage provider a chain
  operator. The protocol meters publicly first and settles later.
- **Proof of retrieval as the primitive.** Considered; rejected for v0 because
  time-lock requires a trusted clock and a challenge window, which is a second
  protocol. Retention is currently a declared term, and a time-locked variant is
  the obvious next step once the settlement layer exists.
- **The chain as the database.** Rejected: storing bytes on chain is expensive and
  loses the content-addressed replication that makes mirroring work.

## Open questions

1. What is the retention proof? A time-locked challenge signed by a committee, or
   a chain slot that releases a challenge after a delay?
2. Who pays for replication in the free tier — the operator today, a bounty pool
   later, or the storage provider as a business?
3. Does the sealed tier need a key-recovery service, and does that break the
   "the node cannot read it" property?
4. What is the settlement cadence, and does the chain settle byte-months, or only
   the claim bounties?
5. Should the storage app be its own repository once the surface outgrows the
   protocol's needs?

## Implementation status

The core is implemented: content-addressed blob storage with self-verifying names,
storage manifests, a possession verifier that fails closed, inclusion proofs that
chain from a digest to an anchor root, published tiers with their semantics
binding, and metered usage. Quote-only rent accounting is implemented in
[RFC 0018](0018-storage-rent-settlement.md); the RFC remains draft because the
settlement layer, the retention proof, and the replication economics are
unresolved.
