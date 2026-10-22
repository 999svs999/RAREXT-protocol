# RFC 0010: Data availability sampling for media

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Depends on:** RFC 0005 (durable placements), RFC 0009 (representation kinds)
- **Implementation:** `apps/api/src/das.ts`, holder leaf endpoint, `apps/api/test/das.test.ts`

## Summary

A holder audit asks one holder to prove it still has one shard. That is enough for
retention, but it does not tell a reader whether the bytes of a media file can be read
*now* without downloading all of it. This RFC adds data availability sampling over the
same 4 KiB chunk commitments the durability protocol already uses.

The reader picks `t` distinct chunks uniformly across all shards, fetches only those
chunks, and verifies each against its committed Merkle root. If at least `a` of the
`N` chunks are unavailable, the chance the sample misses all of them is at most

```
C(N - a, t) / C(N, t) <= (1 - a/N)^t
```

That is the stated soundness bound. It is a bound on *sampled bytes*, not a proof that
the whole file is reconstructable, and it is point-in-time.

## Commitment

The commitment is built from the shards a placement already commits to:

```json
{
  "version": 1,
  "blobHash": "<payload digest>",
  "chunkBytes": 4096,
  "units": 9216,
  "shards": [
    { "index": 0, "storedAs": "<holder key>", "root": "<Merkle root>", "leaves": 1536, "bytes": 6291456 }
  ]
}
```

- `units` is the total number of 4 KiB chunks across every shard.
- `root` is the Merkle root of `sha256` leaf hashes, using the same chunking and proof
  format as the holder challenge (`chunkLeaves`, `merkleProof`, `verifyProof`).
- `storedAs` is the holder's content key, so a reader can address the leaf without
  learning the blob hash.
- The commitment should be published with the placement record it describes. This RFC
  defines the object; wiring it into every placement response is a follow-up.

## Sampling

For each sampled ordinal:

1. Map the ordinal to `(shard, leaf)` over the concatenated shard trees.
2. `GET /v1/holder/shards/:storedAs/leaves/:leaf` returns the raw chunk and its Merkle
   path.
3. Hash the chunk; check the hash and path against the shard root and leaf index.
4. Count a failure if the holder is unreachable, the chunk is missing, or the proof does
   not verify. Do not retry a failed sample; retrying changes the bound.

A pass means every sampled chunk was served and proven. A single failure is evidence of
unavailability and the sample fails.

The reader never asks for a whole shard and the holder never learns the blob hash.

## Soundness

Let `N` be the committed chunks, `a` the number withheld, and `t` the number sampled
without replacement. If all `t` samples succeed, the probability of missing an
unavailable fraction `f = a/N` is

```
P(miss) = C(N - a, t) / C(N, t) <= (1 - f)^t.
```

The implementation uses the exact hypergeometric product in log space and also exposes
the simpler `(1 - f)^t` bound. For a required confidence `1 - epsilon`, choose the
smallest `t` with `P(miss) <= epsilon` (`samplesForMissingFraction`).

For the 36 MiB photo slice (9,216 chunks):

| Withheld | Detected at 99% | Sample bytes | Detected at 99.9% | Sample bytes |
| ---: | ---: | ---: | ---: | ---: |
| 20% | 21 | 84 KiB | 31 | 124 KiB |
| 10% | 44 | 176 KiB | 66 | 264 KiB |
| 5% | 90 | 360 KiB | 134 | 536 KiB |
| 1% | 444 | 1.7 MiB | 657 | 2.6 MiB |

At 10% withholding, 44 random 4 KiB chunks cost 176 KiB, about 0.5% of the media, and
miss the loss with probability below 1%. The table is computed by
`samplesForMissingFraction`, not hand-tuned.

## What the bound does and does not mean

- It bounds the chance that a *sampled* set avoids withheld content. It does not prove
  that every byte is correct or that the file reconstructs.
- It assumes the adversary chooses the withheld set before sampling. An adversary that
  can predict the sample (for example, because the reader's randomness is public) can
  defeat it; use a local CSPRNG.
- It is point-in-time. A holder can serve a chunk and delete it afterwards. Repeat
  sampling over time, or keep the retention challenge schedule, for persistence.
- Sampling full shards unevenly would leak which shard failed; this implementation
  samples uniformly over all chunks, so a whole missing shard appears as its chunk
  fraction.
- Merkle proofs prove inclusion under the committed root. The root itself must be
  committed by a signed placement or publication; otherwise a holder could choose a
  root after the fact.
- It does not replace repair. Repair moves bytes; DAS only measures whether bytes are
  currently served.

## API and SDK surface

- `availabilityCommitment(shards, storedAs[])` builds the commitment.
- `sampleAvailability(commitment, reader, { samples, random })` returns
  `{ ok, sampled, bytesRead, failures, falseNegativeAt10Percent, detectableFractionAt99Percent }`.
- `httpLeafReader(holderUrl)` implements the reader against the holder route.
- `missProbability`, `missProbabilityFraction`, `samplesForMissingFraction`, and
  `detectableFraction` expose the bound for callers that want to choose `t`.
- Holder route: `GET /v1/holder/shards/:storedAs/leaves/:index` returns
  `{ index, bytes, proof }`; it is a read of one chunk, never the whole shard.

## Tests

Five tests cover: a clean sample with the bound, a withheld shard that fails without
retry, a forged chunk that fails the proof, the hypergeometric arithmetic, and a real
holder serving a leaf over HTTP.

## Non-goals

- No full-file download or reconstruction in the sampler.
- No private information retrieval.
- No new erasure code or placement policy.
- No claim that DAS makes a media file permanent; retention is the holder schedule's
  job.
