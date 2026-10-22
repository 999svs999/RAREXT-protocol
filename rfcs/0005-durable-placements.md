# RFC 0005: Durable placements and the holder wire protocol

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-22
- **Requires:** RFC 0004 (storage economy)
- **Implementation:** `apps/api/src/durability.ts`,
  `apps/api/src/holder-server.ts`, `apps/api/src/placements.ts`,
  `apps/api/test/durability.test.ts`, `apps/api/test/holder-transport.test.ts`,
  `apps/api/test/placements.test.ts`, `scripts/durability-demo.mjs`

## Summary

RFC 0004 defines the storage economy in terms of claims of possession. This RFC
defines how those claims are actually obtained from holders that are not the
publisher: a small HTTP wire protocol for shard custody and leaf challenges, and
a signed, append-only placement record that says which holder is supposed to hold
which shard.

Durability is then four checkable steps — **code**, **place**, **challenge**,
**repair** — plus the rule that no two shards of a blob share a holder.

## Motivation

The erasure code and the durability ledger already answer "can these bytes be
rebuilt". They answered it against an in-process holder, which proves the
arithmetic and nothing about custody. The moment a holder is a different machine,
three questions appear that the old interface could not express:

1. What exactly does a holder store, and what may it learn? (It must not need the
   blob hash or the placement to answer a challenge.)
2. How is a challenge delivered and answered without shipping the whole shard?
3. Who can be shown the placement, and how does a reader know it was not edited
   after the fact?

## Design

### Shard custody

A holder stores shard bytes under `sha256(bytes)`. It never receives the blob
hash, the shard index, the erasure parameters, or the Merkle root; it learns only
the digest of the bytes it holds. That is enough to answer a challenge because the
challenge names the leaf index and the nonce, and the holder can compute the leaf
hash and the path from its own bytes.

The wire protocol is deliberately small:

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/v1/holder` | — | `{ id, version, shards, bytes }` |
| `GET` | `/v1/holder/shards` | — | `{ id, shards: [{ storedAs, size, createdAt }] }` |
| `POST` | `/v1/holder/shards` | `{ content: base64 }` | `201 { storedAs, size }` |
| `HEAD` | `/v1/holder/shards/:hash` | — | `200` / `404` |
| `GET` | `/v1/holder/shards/:hash` | — | `{ storedAs, size, content }` |
| `DELETE` | `/v1/holder/shards/:hash` | — | `204` / `404` |
| `POST` | `/v1/holder/challenge` | `{ storedAs, leafIndex, nonce }` | `{ index, leaf, proof, nonce, digest }` |

`GET /v1/holder/shards/:hash` exists so a repairer can read a surviving shard;
it is the only endpoint that returns bytes, and it is authenticated by nothing
but the content hash. A holder that does not want to serve reads can refuse, and
the audit will say so.

### Challenges

A challenge names a leaf index and a nonce. The holder answers with the leaf
hash, its Merkle path, the nonce, and `digest = sha256(nonce ‖ leaf)`. The
challenger verifies the path against the shard root it recorded at placement time
and recomputes the nonce binding.

Binding the nonce into the answer stops a holder from precomputing answers to
future challenges, and stops a recorded answer from being replayed. It does not
stop a holder from storing the shard anywhere else and fetching it on demand:
this is a proof of possession at a moment, not a proof of persistent storage. A
holder that loses the bytes fails the challenge and the audit marks the shard
missing; repair then rebuilds it.

Challenges are per shard, not per blob: the challenger picks one leaf per shard
per audit, so a challenge costs one Merkle path per shard rather than the shard
itself.

### Placement records

A placement is the public statement "shard `i` of blob `B` is held by holder
`H`, under tier `T`". It is signed by the steward of the blob, who embeds its
public key in the record, so a reader can verify it without a key server:

```json
{
  "record": {
    "kind": "rarext.placement",
    "version": 1,
    "sequence": 0,
    "previous": null,
    "steward": { "keyId": "sha256(jwk)", "publicKey": { … }, "algorithm": "ecdsa-p256" },
    "placement": {
      "blobHash": "…",
      "dataShards": 4,
      "parityShards": 2,
      "length": 1048576,
      "tier": "durable",
      "required": 6,
      "shards": [
        { "index": 0, "holder": "holder-3", "digest": "…", "storedAs": "…",
          "size": 262144, "leaves": 64, "root": "…" }
      ],
      "createdAt": "2026-10-22T00:00:00.000Z"
    }
  },
  "signature": "base64"
}
```

Records for one blob form a hash chain: `sequence` starts at 0, `previous` is the
digest of the prior record, and a record with any other sequence is refused by
the registry. A repair produces a new record; it never edits an old one.

`POST /v1/placements` appends a record, `GET /v1/placements/:blobHash` returns the
latest, and `GET /v1/placements/:blobHash/history` returns the chain.
`GET /v1/placements` lists summaries.

### What the registry is and is not

`PlacementRegistry` is a convenience mirror of records, backed by a JSON file so a
node can restart. It verifies every record it accepts and refuses forks, but it
is **not** a trust anchor:

- A registry can refuse to serve a record; it cannot forge one, because the
  signature is checked against the key embedded in the record.
- A holder can re-serve the record that names it, and a reader can verify it
  without the registry.
- Two registries can disagree about which fork is canonical. The protocol
  detects the fork; it does not yet have a rule to resolve it. That rule belongs
  with the chain anchor (RFC 0004), not with this RFC.

### Repair

`repair(blobHash, holders)` reads any `k` surviving shards, re-encodes the lost
ones, and writes each to a holder that (a) does not already hold a shard of this
blob, (b) is not the failed holder, and (c) answers `HEAD` for a probe shard. The
probe matters: without it a repairer would happily write a recovered shard to an
unreachable spare.

The cost is asymmetric and the documentation should say so: reading survivors
costs one shard set (about `1 + m/k` times the payload), writing costs `1/n` of
the stored bytes per repaired shard. A repair that reads every survivor to rebuild
one shard therefore reads roughly `1/k` of the payload per failed shard, not
`1/k` of the whole stored set in a single write.

`repair` mutates the placement object in place and returns the same object. A
caller that wants an immutable historical snapshot should sign a record before
repairing, or copy the placement first.

### The schedule

A challenge that only runs when a publisher remembers to call it is an audit of the
publisher, not of the holder. `ChallengeScheduler` runs the pass on an interval
(six hours by default), challenges every blob the ledger knows, records the run,
and schedules the next one after the run finishes — so a slow run delays the next
tick instead of overlapping it, and two callers asking for a pass at the same time
share one.

The schedule is per process. It does not survive a restart, and it does not alert;
it records. On boot the node rebuilds the ledger from the placement registry, so a
restart resumes the map but not the history. `GET /v1/durability` exposes the state
and the current audits; `POST /v1/durability/challenge` runs the same pass on
demand. Holders come from `RAREXT_HOLDERS` (`id=url`, comma-separated), which keeps
the holder set configuration rather than protocol.

### Duty of an observation

A placement record says who *should* hold a shard. It says nothing about whether
they still do, and it is signed at a moment that may be months old. So a reader
that wants to know the current state gets a dated observation instead of the
record: `durability` on the publication, computed from the registry's latest record
plus the ledger's last challenge.

- `unplaced` — no signed record names this blob.
- `unverified` — a record exists, but no challenge has run since the process
  started (the ledger was rebuilt but not yet exercised).
- `ok` / `under-replicated` — live shards against the tier's required count.

`live` counts answers inside the ledger window; `placementDigest` names the record
the observation used, so the reader can verify the steward's signature and run the
challenges again. The observation is not signed by the publication's author: it is
a fact about the world after signing, and it carries `observedAt` so it cannot be
mistaken for a promise.

## Tiers

`required` is derived from the tier, not chosen per blob:

| Tier | Required live shards | Meaning |
| --- | --- | --- |
| `ephemeral` | 1 | one copy is enough |
| `pinned` | `k + 1` | survives one holder loss without repair |
| `durable` | `k + m` | every shard must be live |

A missing shard below `required` puts the audit in `under-replicated`; a missing
shard at or above `required` is visible in the report but still `ok`.

## Security considerations

- **Confidentiality.** A holder sees shard bytes in the clear. Sealed blobs must be
  encrypted client-side before erasure; this RFC does not add encryption.
- **Lying holders.** A holder that serves wrong bytes fails the challenge
  (`digest` or path mismatch) and is repaired away. A holder that serves nothing
  is reported as `shard-missing` or `holder-missing`.
- **Replay.** Answers are bound to a nonce chosen by the challenger; a recorded
  answer cannot be reused.
- **Censorship by the registry.** Does not forge, but can withhold. The holder's
  own copy of the record is the escape hatch.
- **Challenge cost.** One Merkle path per shard per audit, not a full read. This
  is cheap, which is also its weakness: it samples one leaf. Sampling more leaves
  per audit is a parameter, not a protocol change.

## What this RFC does not do

- No payment or retention contract between publisher and holder. The holder API
  is custody-only; pricing and settlement remain RFC 0004's open problem.
- No proof of time or storage over time. A holder can re-fetch the shard.
- No topology-aware placement. Holders are chosen by a digest-derived offset over
  the supplied set, which gives deterministic assignment and no co-location, not
  geographic or administrative diversity.
- No fork resolution between registries; no federation.
- No automatic repair. A scheduled run records `under-replicated`; it does not spend
  another operator's bandwidth rebuilding shards by itself.
- No authentication of holders. A holder id is a label, not a verified identity.

## Open questions

1. Should the holder endpoint return a signed receipt so a placement can be
   recorded without the publisher having to trust its own write?
2. Should challenges be sampled (`t` leaves per shard per audit) and if so what
   `t` makes a false negative unlikely enough for `durable`?
3. How should placement diversity be expressed — an ASN/region hint per holder,
   or a placement policy the steward signs?
4. What is the retention commitment for a remote holder: a signed term, a
   deposit, or both?
5. When a registry sees a fork, should it keep both branches rather than refuse
   the second?
6. Should a scheduled run repair what it finds, and if so who authorises the write
   to a holder the steward did not choose?

## Implementation status

Implemented and tested: erasure coding, the durability ledger, the holder HTTP
server, the HTTP holder client, signed placement records with a file-backed
registry, the `/v1/placements` API, the publication-level durability observation
(tier, required, live, status, and the digest of the record it used), the scheduled
challenge pass with
`GET /v1/durability` and `POST /v1/durability/challenge`, and a transport test that
places across eight real HTTP holders, stops one, watches the audit degrade, repairs
onto a reachable spare, and decodes the payload from the new placement. The schedule
is covered by a fake-timer test that advances the clock and observes challenges fire
with no caller, a lost-shard test that watches the next run report
`under-replicated`, and a shared-run test that proves two callers cannot double the
load.

Not implemented: everything in "What this RFC does not do".
