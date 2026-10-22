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

What is still missing, and honestly so: the front door (a domain and a host), the
write path (who may publish), and the economics between holders. The first is fixed
by decentralized naming over a content hash; the second is fixed by many registries
accepting the same signed publications and gossiping between them. The third — who
pays a holder, and how a holder proves it is still serving — is open. The transport
a holder needs in order to join is no longer missing: see
[RFC 0005](../rfcs/0005-durable-placements.md).

## Erasure coding: replication becomes reconstruction

Replication is the naive durability story: keep m full copies and hope at least one
survives. Erasure coding is the better one: cut the blob into `k` data blocks, emit
`n = k + m` shards with a systematic Reed-Solomon code over GF(256), and rebuild the
blob from **any** `k` of the `n` shards. With `k = 4, m = 2` a node holds 1.5× the
bytes and survives the loss of any one shard — the same durability as three full
copies for half the storage.

The primitive lives in `apps/api/src/erasure.ts`. A runnable example that stores the
shards, deletes one, and rebuilds from the rest is in
[`examples/erasure/`](../examples/erasure/). Its contract:

- `encodeBytes(payload, k, m)` returns `k + m` shards; the first `k` are the data
  blocks, the rest are parity.
- `decodeBytes(shards)` accepts any `k` distinct shards, rejects duplicates, and
  verifies the reconstructed payload against the digest the shards commit to.
- Each shard's digest covers its index, the code parameters, the original length,
  the payload digest, and its own bytes. A corrupted shard fails its digest; a shard
  relabelled with another index fails its digest; a shard borrowed from a different
  set fails the set check. None of those failures are silent.

Two independent replicas encoding the same blob produce byte-identical shards, so
they can compare digests instead of paying for a third opinion.

What this does *not* do, yet: it does not place shards, schedule retention proofs
against them, or price them. Those are the rest of the durability contract:

1. **Placement** — a target shard count across independent holders.
2. **Retention proofs** — the existing time-locked commitment, challenged on a
   schedule rather than only at upload.
3. **Durability tier** — `ephemeral`, `pinned`, `durable`, with the actual replica
   count published, so a reader can see whether "forever" is one laptop or six
   holders.
4. **Pricing** — per byte-month, per the metering above.

Until a publication carries a durability tier and a replica count, its permanence is
a claim the operator makes, not one a reader can check.

## Durability: holders, challenges, repair

Erasure coding says a blob *can* be rebuilt. Durability is the claim that enough
independent holders still have the shards to do it. `apps/api/src/durability.ts` is
that contract, and `npm run demo:durability` runs it end to end.

**Placement.** `place(shards, holders, tier)` refuses duplicate holders, refuses
fewer holders than shards, and never puts two shards of one blob on one holder. The
assignment is deterministic from the payload digest, so two independent nodes compute
the same placement for the same holder set.

**Challenge.** Each shard is committed as a Merkle root over 4 KiB leaves. A
challenge picks a random leaf and a nonce; the holder answers with the leaf, its
path, and `sha256(nonce:leaf)`. The verifier checks the path against the committed
root (possession) and the nonce binding (freshness). The auditor never needs the
shard itself.

**Audit.** A success is live for a window (24 hours by default). `audit()` reports
`live` and `required`, and returns `under-replicated` rather than rounding up. The
tier decides `required`: `ephemeral` 1, `pinned` k+1, `durable` k+m.

**Repair.** `repair()` rebuilds every failed shard from any k survivors, verifies
the payload digest, and places the new shard on a holder that does not already hold
one for that blob and that answers a reachability probe. It reports both directions.
A spare holder is required by design — repair never co-locates.

Availability can be sampled before a full download: random 4 KiB chunks with Merkle
proofs give the bound in [RFC 0010](../rfcs/0010-data-availability-sampling.md). Sampling
measures what is served now; it does not replace the retention schedule or repair.

Repair cost is measured, not asserted: [`bench/repair`](../bench/repair/README.md) rebuilds
one lost shard of a 1 GiB blob and records the bytes actually moved. For the shipped
systematic code the floor is `1 + 1/k` of the payload, which is above the contract's older
`< 1/k` target; reaching that target needs local reconstruction or sub-chunking, not a
tuning change.

The accounting is worth stating exactly. With `k = 4, m = 2`, the stored set is
`1.5×` the payload. Repairing one failed shard reads the five survivors
(`1.25×` the payload) and writes one shard (`0.25×` the payload). It is not cheaper
to repair early than to repair late; it is cheaper to keep `required` than to fall
below it.

**Holders on other machines.** `apps/api/src/holder-server.ts` is the wire protocol
in [RFC 0005](../rfcs/0005-durable-placements.md): a holder stores shard bytes under
their own digest, answers nonce-bound leaf challenges with a Merkle path, and never
learns the blob hash or the placement. `npm run holder` starts one
(`RAREXT_HOLDER_ID`, `RAREXT_HOLDER_DIR`, `RAREXT_HOLDER_PORT`). `httpHolder()` is
the client the ledger uses, so the same `place`, `challenge`, `audit`, and `repair`
calls work across processes. The transport test runs eight holders over HTTP, stops
one, watches the audit go `under-replicated`, repairs onto a reachable spare, and
decodes the payload from the new placement.

**A schedule, not a button.** `apps/api/src/durability-schedule.ts` runs the challenge
pass on an interval — six hours by default, `RAREXT_CHALLENGE_INTERVAL_MS` to change it —
whenever the node starts with holders configured
(`RAREXT_HOLDERS=holder-0=http://…,holder-1=https://…`). A run challenges every placed
blob, records the audits, the under-replicated blobs, and any errors, then schedules the
next run after it finishes; runs never overlap, and concurrent callers share one run.
`GET /v1/durability` returns the schedule state and the current audits, and
`POST /v1/durability/challenge` runs the same pass on demand. The node also repairs
what a run finds: a failed shard is rebuilt from any `k` survivors onto a spare holder,
challenged again, and only then reported `ok`. The run lists `repairs` (filled shards,
bytes read and written) and `repairErrors` (for example, no free holder), so healing is
as auditable as the loss that triggered it.

A shard lost between runs therefore shows up as `under-replicated` on the next run with
nobody asking. Two limits are worth saying out loud: the schedule is per-process state and
does not survive a restart, and it does not alert anyone yet — it records. What it does
guarantee is that `live` in an audit is the result of a challenge this process actually
ran, not a value copied from the placement record.

**Durability on the publication.** A reader should not have to find a placement
registry to know whether a manifest's bytes still have holders. When a publication's
artifact lists blobs, the API attaches a `durability` block computed on the way out —
an observation by the reader, not a field the author signed:

```json
{
  "policy": "durability-v1",
  "source": "registry-observation",
  "tier": "durable",
  "required": 5,
  "live": 5,
  "status": "ok",
  "observedAt": "2026-10-23T00:00:00.000Z",
  "windowMs": 86400000,
  "blobs": [
    {
      "hash": "…",
      "tier": "durable",
      "required": 5,
      "live": 5,
      "status": "ok",
      "sequence": 0,
      "placementDigest": "…"
    }
  ]
}
```

`live` is the number of shards that answered a challenge inside the ledger window, and
`required` comes from the tier. `status` is `unplaced` when no signed record names the
blob, `unverified` when a record exists but no challenge has run since boot, and only
then `ok` or `under-replicated`. `placementDigest` pins the exact record the observation
used, so a reader can fetch it from `/v1/placements/:blobHash`, verify the steward's
signature, and re-run the challenges themselves. A manifest with several blobs reports
every blob and the weakest tier; the publication is `ok` only when every blob is.

This is deliberately not inside the author's signature. The author signs the bytes they
published; whether those bytes still have holders is a fact about the world that changes
after signing, and it should be dated (`observedAt`) rather than frozen.

**Signed placement records.** `apps/api/src/placements.ts` signs a placement with the
steward's key, embeds the public key, and chains each repair as a new record
(`sequence` + `previous` digest). `POST /v1/placements` appends one;
`GET /v1/placements/:blobHash` returns the latest;
`GET /v1/placements/:blobHash/history` returns the chain. The registry verifies every
record and refuses a fork, but it is a mirror, not an authority: a holder can re-serve
the record that names it and a reader can verify it without the registry.

What this does **not** prove: a holder could keep every leaf, discard the bytes, and
still answer challenges. That is the gap between proof of possession and proof of
retrievability, and it is a research step, not a solved problem. The map now survives
the node (signed records, persisted by the registry), but two registries can still
disagree about a fork: the protocol detects it and has no rule yet to resolve it. That
rule belongs with the chain anchor.

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
