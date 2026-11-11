# Generations

RAREXT names its network **web4**. This page is what "and the generations after
it" means, written down as one canonical object: `rarext.generations.v1`.

It is not a roadmap slide. It is the same shape as every other commitment in the
protocol — a plain object, canonical JSON, one sha256 — so a reader can fetch it,
recompute the digest, and disagree with the bytes rather than with the pitch.
`npm run demo:generations` prints it and checks it.

## The four axes

| Axis | Ladder | What an entry means |
| --- | --- | --- |
| **web** | web4 → web8 | A naming generation of the web, and the primitive it adds |
| **network** | 5G → 8G | A declared transport budget: downlink, uplink, median latency, edge tier |
| **model** | 1G → 8G | A model-size class in GiB: committed weight bytes, a planning memory floor, and a shard plan |
| **protocol** | gen-4 → gen-8 | A generation of the publication leaf, keyed to its `leafVersion` |

The ids are stable. The validator refuses a ladder that renumbers, reorders,
duplicates an id, or carries a non-finite profile, so the digest cannot move
silently underneath a reader.

## Declared, not measured

Every entry carries `shipped`. Exactly what the reference implementation ships
today is the shipped one on each axis:

```
web=web4   network=5G   protocol=gen-4   model=1G
```

The rest are **targets**, and the object says `status: "declared"` so nobody
reads "8G" as a measurement. The model ladder is anchored by what the reference
actually serves: a `1G` class (GGUFs and RXHF containers under 1 GiB) is
`shipped`, and **no 6 GB, 7 GB, or 8 GB weight class is claimed as served** — those
rungs are the *plan*, not a result. When a class of that size is actually run end
to end through the storage-native path ([WEB4-MODEL.md](WEB4-MODEL.md)), its
`shipped` flag is where that fact moves.

## The commitment

```bash
npm run demo:generations          # print the ladder, the digest, and a plan
npm run demo:generations -- --json  # the object and its digest, for a machine
```

The digest is `sha256(canonicalize(GENERATIONS))`, computed with the caller's own
hash — node's `createHash` in the demo, WebCrypto in a browser — because
`@rarext/core` carries no crypto dependency, exactly like the AI models it
replays. The core test recomputes the published digest the way a stranger would
and fails if the object and its digest ever drift.

## The helpers

The ladder is data; the point is the pure functions over it, which every surface
can recompute from the same bytes:

- `networkMeets(id, requirement)` — does a named generation cover a transport
  budget (`downlinkMbps`, `uplinkMbps`, `maxLatencyMsP50`, `edge`)? An id the
  ladder does not name is `false`: a transport that is not declared is not
  assumed to exist.
- `planModelShards(id, { shardBytes })` — `ceil(sizeBytes / shardBytes)`, so
  every byte of a class is covered, and the class size stays the commitment.
- `nextGeneration(axis, id)` — the declared entry after one, or `null` at the end
  of the listed ladder. The ladder is open-ended by construction, which is what
  "and etc" means here: a new rung is one data entry, and the only two things that
  must then agree are the validator and the digest.
- `shippedGeneration(axis)` — the highest generation the reference ships, or
  `null`.

## Where it lives

- `packages/core/src/generations.ts` — the object, the digest, the validator, the
  helpers. No I/O, no clock, no hash implementation.
- `packages/core/test/generations.test.ts` — stability, refusals, and the helpers.
- `scripts/generations-proof.mjs` — the FUTURISTIC-facing proof (`npm run
  demo:generations`).
- `scripts/brand-demo.mjs` — the brand view of the same ladder.

## What it does not claim

A generation in the ladder is a **declared target**, not a shipped capability and
not a measurement of any network or engine. `networkMeets` compares budgets the
object itself declares; it does not measure a link. `planModelShards` plans
shards; it does not promise a run fits in memory. The one thing it does assert,
mechanically, is that the ladder and its digest agree — the same test every other
commitment in RAREXT passes.
