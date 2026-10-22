# The storage economy

The goal: an economy for storing things online that is open, secure, and free for
anyone — with enterprise tiers on top, and without a single operator able to take
it down or read what it holds.

Storage is the right first economy for this protocol, for three reasons.

1. **Storage is already a chain-shaped problem.** A storage contract is a promise
   about bytes over time: here they are, here is the digest, here is the term, here
   is the moment. That promise is exactly a claim, and the protocol already knows
   how to make claims checkable.
2. **Storage is what every other app needs.** Social media needs it for media.
   Marketplace needs it for listings and escrow receipts. An ERP needs it for
   documents, and needs it *sealed* for the parts nobody else may read. Build the
   primitive once and every app inherits it.
3. **It has a natural free tier.** The marginal cost of an open blob is near zero
   and the *proof* is what has value, so the network effect is real: more storage
   nodes make the proof more useful, not the storage scarcer.

## The primitive: proof of possession

A storage manifest lists blobs and the terms they are held under:

```json
{
  "policy": "storage-v1",
  "blobs": [
    {
      "hash": "0faefba2dc363808a727f868245c2d2c791d88314032b35c22e309b21517222b",
      "size": 31,
      "tier": "public",
      "sealed": false,
      "retentionUntil": "2027-01-01T00:00:00.000Z"
    }
  ]
}
```

The manifest is an artifact. The storage verifier reads the referenced bytes and
checks that what is on disk is what the manifest claims: the content hashes to the
named digest, the size matches, the tier is licensed by the policy, and a sealed
entry really is stored as a sealed envelope rather than plaintext. It fails
closed — a missing blob, a mismatched digest, or an unreadable directory is not a
pass.

The result is a chain of trust that a holder of the bytes can walk without trusting
the operator:

```
bytes ──sha256──▶ digest ──leaf──▶ manifest root ──publication──▶ anchor root ──▶ chain
```

- `GET /v1/blobs/:hash` returns the bytes and their digest.
- `GET /v1/blobs/:hash/proof` returns the inclusion proof: the manifest leaf, the
  Merkle proof up to the manifest root, the manifest publication, and the anchor
  root that publication was anchored with.

Anyone can re-verify the whole chain. A storage node that loses the bytes cannot
produce the attestation; a storage node that lies about them cannot produce a
matching root. That is what makes storage *sellable*: the buyer verifies, the
seller cannot bluff.

## The tiers

Tiers are policy, not marketing. Each one is a semantics record with a named owner
and a pinned spec hash, so the meaning of a tier cannot drift silently.

| Tier | Open? | Who can read it | What the claim covers |
| --- | --- | --- | --- |
| `public` | Yes | Everyone | Possession, digest, terms |
| `sealed` | No | Only the key holder | Possession and terms, never content |

A sealed blob is encrypted by the client before upload. The node stores ciphertext
it cannot read, and the claim covers the fact that the ciphertext is held, not what
it says. This is the same envelope design as the private-artifact work, applied to
bytes, and it is what makes the enterprise tier possible: the operator can prove
custody of something it cannot read.

## Metering: the unit of the economy

```
GET /v1/storage/usage
```

returns bytes, blob counts, and retention per tier. That is the ledger a settlement
layer prices. The unit is **byte-months** — bytes held, times the time they are
committed for — because that is what a storage provider actually spends, and
because it makes a retention promise cost something.

Two other units will exist:

- **Claim bounties** — payment for verification work. A third party runs a verifier
  for a challenge and is paid for attestations nobody else produced.
- **Attention** — the ApesDaily side, monetised off-chain by products and, later,
  by launchpad fees.

Prices are set by policy, not by the protocol. The protocol's job is to make the
metering public and the settlement verifiable.

## Why this is decentralised

The storage node is one operator. The *proof* is not. Anyone can run a node, anyone
can verify, and the content is addressed by its own hash, so a mirror is a copy of a
directory. With the anchor root committed to the bytes:

- The operator can go offline and the content survives on mirrors.
- The operator can lie and the proof breaks.
- The operator can delete and the record of the commitment stays.

What is still centralised, and honestly so: the front door (a domain and a host),
and the write path (who may publish). The first is fixed by decentralized naming
over a content hash; the second is fixed by many registries accepting the same
signed publications and gossiping between them — the publications are already
portable, they are signed envelopes.

## The chain path

The protocol is chain-agnostic by construction: an anchor is a Merkle root plus
receipts, and the adapter registry already treats the chain as one adapter among
several. The sequence:

**Stage 0 — chain-agnostic (now).** Local anchor plus a Trac webhook. The state
model is a root; the chain is a notary.

**Stage 1 — multi-chain and pinning.** Anchor the same root to a second chain
(EVM L2) so no single chain's outage or censorship matters, and pin the storage
bundle to IPFS or Arweave. The bundle's CID becomes a mirror pointer; the chain
root proves *which* bundle. The adapter interface takes a root and returns
receipts, so this is a small addition, not a redesign.

**Stage 2 — the RAREXT chain.** Own network, when a gate is met:

- the protocol has a chain-independent state model — it does;
- there is real volume to settle — storage byte-months, claims per day, or
  marketplace value;
- the chain's job is written down and narrow: ordering, settlement, identity, and
  the task and semantics registry. Not storage, not media;
- the consensus, validator set, and audit are funded and reviewed.

What the own chain would do: batch anchor roots, settle storage metering and claim
bounties, host task and semantics registration, anchor agent identity, and be the
settlement layer for a marketplace or escrow.

What it would never do: hold user funds, store blob bytes, or act as a custodian of
anyone's data. Storage is content-addressed and replicated; a chain is a notary.
Conflating them is how "decentralized storage" projects end up as centralised
databases with extra steps.

## Social media and MIS/ERP on this

**Social.** Posts are artifacts, the media is the storage economy, and the feed is
a replicated index. Two properties follow:

- The app can be taken down and the content survives, because both are
  content-addressed and mirrorable.
- A post can be removed without a server-side decision, because a removal is a
  *published revocation claim* that mirrors must honour — auditable, contestable,
  and not a private act by one operator.

**MIS/ERP.** Here the honest answer is **federated, not leaderless**. An ERP is a
single source of truth by definition, and enterprises need auditability and privacy
far more than they need eleven peers. The useful shape is: each organisation runs a
node, the data stays sealed (enterprise tier), and the *interchange* is claims —
so no party can rewrite another's claims, and no party can be compelled to hand
over data it holds about you. An auditor is a third node that can verify the
exchange without seeing the data.

Calling that "decentralised MIS/ERP" would be overselling. Calling it *federated
and verifiable* is both true and worth paying for.
