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

1. **What is the retention proof?** — **ANSWERED: the SCHEDULED challenge, and no
   committee.** The durability schedule releases challenges on a cadence (`intervalMs`,
   defaulting to `DEFAULT_INTERVAL_MS`) and the holder answers with a bounded nonce, so
   the proof is a challenge anyone can verify rather than an attestation someone must be
   trusted to have made. A committee signature would add a party whose word is believed;
   the whole point of the challenge is that no word is needed.
2. **Who pays for replication in the free tier?** — **ANSWERED: the operator, and the
   pricing says so.** A tier whose rate is zero comes out `free: true` — the protocol prices it at zero rather
   than pretending a third party pays, which is a smaller claim
   and a true one. A bounty pool, or a storage provider carrying it as a business, are
   later arrangements the protocol does not model and therefore does not promise.
3. **Does the sealed tier need a key-recovery service?** — **ANSWERED: no, and it could
   not have one.** Encryption is client-side and the registry REFUSES a server-side
   sealed write, saying so in as many words (encrypt before upload, or store ciphertext
   as a public blob). A recovery service is therefore not merely absent but incompatible: whoever can recover the key can read the bytes, which is exactly the
   property the tier is named for.
4. **What is the settlement cadence?** — **ANSWERED: none yet, and the two units are
   already distinct.** Rent is priced in byte-months and the reward
table pays per claim bounties; neither is settled, because no settlement exists. The cadence is owed by
   the first adapter that settles — and the quote-versus-net-positions question is
   decided there rather than here.
5. **Should the storage app be its own repository?** — **ANSWERED: not yet, and the test is whether the surface still serves the protocol.** Today it does: the durability
   report, the challenge schedule and the sealed envelope are protocol artifacts, each
   derived from the rules above rather than from an app's product needs. The question
   reopens when that stops being true, which is a condition rather than a date.

## Implementation status

The core is implemented: content-addressed blob storage with self-verifying names,
storage manifests, a possession verifier that fails closed, inclusion proofs that
chain from a digest to an anchor root, published tiers with their semantics
binding, and metered usage. Quote-only rent accounting is implemented in
[RFC 0018](0018-storage-rent-settlement.md); the RFC remains draft because the
settlement layer, the retention proof, and the replication economics are
unresolved.
