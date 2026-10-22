# RFC 0009: Representation kinds and the verifier contract

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Depends on:** RFC 0003 (verifiable claims), RFC 0007 (trust model),
  [`docs/STORAGE-FRONTIER.md`](../docs/STORAGE-FRONTIER.md)
- **Implementation:** none yet; this RFC defines the envelope, the verifier
  contract, and the acceptance criterion for the research track.

## Summary

Today every RAREXT claim is exact: the verifier recomputes the artifact and compares
hashes. That is the property that makes a browser and a server agree, and it is also the
property that forbids most of the storage research the project wants to do. A lossy
codec, a neural representation, or a generative model can be smaller, but its output is
not the reference bytes.

This RFC adds a **representation kind** to the signed artifact:

| Kind | The claim | What a verifier checks |
| --- | --- | --- |
| `exact` | The reconstructed bytes equal the committed reference. | Byte equality (hash of the decoded result). |
| `bounded` | The reconstruction is within a named metric bound of the reference. | The metric, computed by a named and versioned implementation, against the committed reference. |
| `generative` | The output came from a committed model and seed. | Provenance: model digest, seed, decoder digest, output digest. Never equality, never a quality claim. |

A publication with no representation record is `exact`. That keeps every existing
envelope valid. `bounded` and `generative` are opt-in, must be declared by the app's
semantics, and must be labelled as such everywhere a reader sees the result.

## Why this is a protocol change

The verifier contract currently returns `correct: boolean`. For a lossy or generative
representation that boolean hides the only thing the reader needs to know: *what was
compared?* A verifier that says `correct: true` after checking PSNR and a verifier that
says `correct: true` after comparing hashes are not making the same claim.

So the result carries the kind, the reference, the observed metric, and the decoder or
model it used. The registry never upgrades a bounded or generative result to `exact`.
"Verifiable" keeps meaning one thing per row, and the row says which thing.

## Envelope

`artifact.representation` is optional:

```json
{
  "kind": "bounded",
  "reference": {
    "digest": "<sha256 of the reference bytes>",
    "mediaType": "image/png",
    "bytes": 48213
  },
  "decoder": {
    "digest": "<sha256 of the decoder artifact>",
    "url": "ipfs://…",
    "bytes": 7340032
  },
  "metric": {
    "name": "psnr",
    "version": 1,
    "bound": 38.0,
    "direction": "min"
  }
}
```

Rules:

1. `kind` is `exact`, `bounded`, or `generative`. An unknown kind is rejected.
2. `exact` requires `reference.digest` and forbids `metric`. `decoder` may be present;
   if it is, its digest and bytes are part of the recorded cost.
3. `bounded` requires `reference.digest`, `decoder.digest`, and `metric`. The metric
   name and version identify the exact computation; an implementation that changes its
   metric must bump `version`.
4. `generative` requires `decoder.digest`, `model.digest`, and `seed`, and forbids
   `metric`. It may carry a reference, but the reference does not make the claim exact.
5. `decoder.bytes` is required and counted in the stored-cost comparison. A decoder with
   zero bytes is not free; it is a shared assumption the protocol already made (for
   example a system codec), and the record must say so explicitly with
   `"decoder": { "shared": true }` instead of pretending the bytes are zero.
6. The representation record is inside the signed artifact. Changing a bound, metric
   version, decoder digest, or seed changes the artifact hash and requires a new
   publication.

The storage benchmark already labels rows `exact`, `bounded`, or `generative` and counts
decoder bytes for learned methods. This envelope is the protocol form of that label.

## Verifier contract

The HTTP verifier receives the artifact and challenge as it does today. Its response
grows one optional block:

```json
{
  "correct": true,
  "score": 1000,
  "proof": {},
  "manifest": {
    "algorithm": "av1-decode",
    "rulesHash": "<sha256>",
    "representation": {
      "kind": "bounded",
      "referenceDigest": "<sha256>",
      "observedDigest": "<sha256>",
      "exact": false,
      "metric": { "name": "psnr", "version": 1, "value": 39.4 },
      "decoderDigest": "<sha256>",
      "modelDigest": null,
      "seed": null
    }
  }
}
```

Requirements:

- `kind` must equal the envelope's kind. A verifier cannot return `exact` for a
  `bounded` envelope.
- `exact` is `true` only when the verifier compared decoded bytes to the reference
  digest and they matched. For every other outcome it is `false`.
- `referenceDigest` must equal the envelope reference. `observedDigest` is the digest of
  what the verifier actually produced.
- `metric.value` is the measured value. The registry checks `direction` and `bound`; a
  verifier cannot declare its own pass.
- A `generative` result carries the model digest and seed it used, and no metric.
- `manifest.rulesHash` and the verifier hash still bind the implementation, so a verifier
  cannot change its metric implementation without changing its identity.

For `POST /v1/verify`, the response's `recomputed` block is replaced by
`representation` with the same fields. The top-level `valid` keeps its current meaning:
the verifier's mechanical check passed under the named semantics. `representation.exact`
answers the separate question of whether the bytes matched.

## Semantics declaration

A challenge's semantic record gains an optional `representationKinds` array:

```json
{
  "id": "media/photo-archive",
  "representationKinds": ["exact", "bounded"]
}
```

- Absent means `["exact"]`. Apps cannot silently accept a lossy claim.
- An artifact whose kind is not listed is rejected with 422 before verification.
- A challenge that permits `bounded` must name the metric, version, direction, and bound
  in its semantics. The bound is part of the challenge, not the artifact; an author
  cannot choose a weaker bound than the challenge allows.
- `generative` should be rare. It answers "did this model produce this output from this
  seed?", not "is this a good photo?".

## Display and discovery

- Feed, build, and leaderboard rows show a badge: `exact`, `bounded 39.4 dB (min 38)`,
  or `generative`. The label comes from the attestation, not from the artifact's claim.
- The leaderboard sorts bounded and generative entries in their own view. Mixing a
  PSNR-scored image with a byte-exact circuit in one ranking compares unlike claims.
- `GET /v1/artifacts/:id` returns the representation record and the attestation's
  observed metric, so a reader can recompute the metric independently.
- A capability-protected artifact is labelled too; access control does not change what
  was verified.

## Compatibility

- Existing envelopes have no representation record and load as `exact`. No snapshot
  migration is needed.
- Existing verifiers return no representation block. The registry accepts that only for
  `exact`; a `bounded` or `generative` artifact is rejected unless the verifier returns
  the block.
- A challenge that declares `representationKinds` without the metric fields is rejected
  at app registration.
- Changing the result shape is a protocol-visible change; it should ship with a version
  bump to the verifier contract, not as an interpretation of the old one.

## Threat model

| Attempt | Result |
| --- | --- |
| Verifier returns `exact: true` without comparing bytes | Rejected: the block is required for non-exact kinds and `exact` must agree with the envelope. |
| Author weakens the bound | Bound comes from the challenge semantics; the artifact cannot override it. |
| Verifier uses a different decoder than the committed digest | `decoderDigest` is checked against the envelope and is inside the signed manifest. |
| Verifier reports a metric it did not compute | The metric name/version and verifier hash are public; a reader can rerun the same implementation. This is still a trust decision in the verifier, as in RFC 0007. |
| Cherry-picked frames or crops | The challenge defines the sampling; a bounded claim must state the population it measured. A per-frame metric is not a per-file claim. |
| Generative output sold as a reconstruction | Kind is `generative`, `exact` is false, and the UI says so. The claim is provenance only. |
| Decoder bytes omitted from cost | Required field; learned methods need `bytes > 0`. Shared system decoders must be declared, not counted as zero. |

No kind makes a bad artifact good. `bounded` says "within this metric"; `generative`
says "this model produced it". Neither is a statement about usefulness, safety, or
ownership.

## Acceptance criterion for the research track

The RFC is implemented for a representation only when:

1. the benchmark has a row for it with `decoderBytes` counted and the exact/bounded/
   generative label produced by byte or metric comparison, not by hand;
2. the verifier returns the block above and the registry rejects a mismatched kind;
3. a reader can rerun the metric from public bytes and get the same value;
4. the feed and leaderboard label it as non-exact.

Until then it stays a research measurement in [`bench/storage`](../bench/storage/README.md),
not a protocol claim.

## Non-goals

- No claim that compression is free, or that a smaller file is a better representation.
- No generative quality score.
- No change to `exact` semantics for existing artifacts.
- No metric registry beyond a small, versioned set (`psnr`, `ssim`, `hamming`, and
  explicitly named app metrics). A custom metric must ship its implementation and hash.
