# AI verification on RAREXT

RAREXT verifies AI artifacts the same way it verifies everything else: by
recomputation, not by trust. What is new is *what* gets recomputed. Byte
equality — the right standard for a netlist or a shard — is the wrong standard
for a neural reconstruction regenerated on other hardware. The protocol
therefore gives every claim an explicit **representation kind**, and each kind
has its own definition of "correct".

This is the verification primitive of [web4](WEB4.md) applied to models: you do
not ask a platform whether an AI output is what its publisher says; you replay
or recompute it yourself, in a browser tab if that is all you have.

## The three representation kinds

| Kind | Question answered | How it is checked | Built-in verifier |
| --- | --- | --- | --- |
| `exact` | Are these the same bytes? | Hash equality against the committed digest. | every existing path (logic, storage) |
| `generative` | Does this output come from the committed model and seed? | Deterministic replay: regenerate from the digest-bound model + seed and compare. | `ai-generative` |
| `bounded` | Is this reconstruction within the promised distance of the reference? | Pure metric computation against the committed reference, checked against the committed bound. | `ai-bounded` |

The kind lives on the claim (`Claim.representation`), the attestation
(`Attestation.representation`), and the verification output. A claim without a
representation is an `exact` claim — nothing existing changes meaning.

## Generative: provenance by replay

An `ai.generative` artifact commits three things: a **model** (a deterministic
generator whose canonical-JSON hash is its identity — v1 ships the `xorshift32`
class with its shift params and output vocabulary), a **seed**, and the
**claimed output**. Verification ignores the claim and replays: the same model
digest and seed must regenerate exactly the claimed output. The attestation's
trace binds `modelDigest`, `seed`, `steps`, and the expected output, so the
evidence is recomputable by anyone, forever.

Changing any model parameter, any vocabulary entry, or the seed changes the
digest or the output and fails the replay. The attestation is about
*provenance* — that this output came from that model — not about the text
being good.

## Bounded: lossy reconstructions with a promise

Real model classes — quantized weights, compressed embeddings, neural codec
outputs — cannot be hash-compared across hardware. The `ai.bounded` path
replaces equality with a **metric promise**: the challenge spec commits a
reference vector (bound by its specHash, exactly like a logic spec commits a
truth table), a metric (`maxAbsError` — L∞, or `meanAbsError` — L1), and a
**bound**. The artifact carries the reconstruction. Verification is a pure
metric computation checked against the bound; the attestation records the
achieved `metricValue`, and the score is graded (perfect reconstruction 100,
at-bound 1, over-bound 0).

A length mismatch is an error, never a silent pass. Nobody can inflate a
metric's meaning after the fact: the metric, the reference, and the bound are
all committed before the artifact is verified.

## Where the evidence is committed

- **Claim / attestation** carry `representation`, and for bounded claims
  `metricName` and the achieved `metricValue`.
- **Publication leaf v4** embeds the representation and metric evidence in the
  Merkle leaf, so the anchor commits the AI claim itself: a mirror cannot strip
  a representation or inflate a metric without breaking the root. v2/v3 leaves
  keep their exact old shape, and old anchors verify at the leaf version their
  manifest records.
- **Semantics binding** still applies: the spec hash pins the challenge the
  meaning was written against, so the reference vector or replay target cannot
  change underneath a published claim.

## How to check a claim yourself

- **MCP:** `rarext_verify_ai` fetches the challenge from the registry and
  computes the verdict locally from the pure verifier math — the server's
  attestation is never trusted for the outcome. Returns the representation,
  the verdict, and the evidence (model digest, seed, steps; or metric name,
  value, and bound).
- **Browser mirror:** the mirror verifier reports per-publication AI evidence
  alongside the Merkle root check, and with a challenge index checks the bound
  itself. Everything it shows is covered by the anchor.
- **Library:** `verifyGenerativeReplay` and `verifyBoundedReconstruction` are
  pure functions with no network dependency — independent tools can re-implement
  or re-run them.

## Out of the box

A fresh node seeds two AI challenges alongside the logic tasks:

- `gen-starter` — replay the committed starter model for 32 steps.
- `bounded-starter` — reconstruct the committed reference within `maxAbsError` 4.

Both ship warm-up sample artifacts, and the generative sample's output is
computed by the same replay the verifier runs, so the seed cannot drift from
the model it demonstrates.

## Non-goals for v1

- No on-chain training, no gradient flow, no token streaming. RAREXT commits
  and verifies AI *artifacts and their provenance*; it does not execute models.
- The `xorshift32` replay class is deliberately tiny. Larger model classes
  enter through `bounded` (metric-thresholded reconstructions) or future
  generative classes with more expensive replay — the representation kind is
  the contract, the verifier is swappable.
- A `generative` semantics record with `claimKind: "generative"` is the planned
  next step for meaning-level licensing of AI claims.
