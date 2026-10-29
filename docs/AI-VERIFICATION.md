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

Replay is bounded before it materializes anything: a vocabulary token is at most
256 UTF-16 code units, a claimed output is at most 1 MiB, and the installed
model's longest token multiplied by the challenge's step count must also fit
within that output bound. A malformed or oversized body/spec is refused instead
of being replayed, so one request cannot turn a tiny model into an arbitrarily
large string.

### Media renditions

An `ai.generative` artifact may carry a picture beside its output. The picture
is not an uploaded file that the claim merely points at: it is a pure function
of the committed model, the seed, and a side length. The rule is
`xorshift32-image-v1` — step the same recurrence, emit the low byte per channel,
fill the raster row-major as R,G,B. The artifact records the digest of those
raw raster bytes, and the PNG is one faithful encoding of them.

Verification re-derives the raster from the commitment and compares digests.
The browser does this itself; when a mirror supplies the inline blob bytes, it
also hashes those bytes against the recorded blob digest. A substituted picture
or a hand-drawn replacement fails both checks, and neither check trusts the
mirror or the attestation. The raw-raster digest is the commitment, so the
result does not depend on which PNG encoder produced the file.

### What the serving side checks about a rendition

The rendition is part of the claim, so the verifier checks it — not only the
reader's browser. When an AI artifact carries a picture, the verifier re-derives
the raster from the commitment and compares it with the committed digest:

- a rendition whose **rule** this build does not implement is refused outright: a
  shape that cannot be checked must not be attested;
- a malformed rendition (a digest that is not a digest, a zero or fractional side
  length, a non-PNG media type, a zero byte count) is refused the same way;
- a rendition whose raster does not re-derive from the committed model and seed
  (or, for the bounded class, from the committed reference and the artifact's own
  reconstruction) makes the attestation **incorrect** with score 0 — the text
  output may still replay perfectly, and the claim is still false, because the
  claim covers the picture;
- declared geometry is checked by the same re-derivation: a plot labelled 7x3
  cannot carry the digest of a plot the committed measurement actually produces.

Measured before this check existed, all four attacks were attested `correct: true`
on the serving side: an unknown rule (`hand-drawn-v2`), a lying raster digest, a
lying bounded plot, and impossible geometry. After it, the first is refused and
the other three are attested `correct: false`, while an honest rendition still
attests `correct: true`. The check adds no field to the trace, so attestations
stored before it (including the published mirror's) still re-verify.

An `ai.bounded` artifact can carry a rendition too, and there the picture *is*
the measurement: rule `bounded-strip-v1` draws the committed reference in one
lane, the artifact's own reconstruction in a second, and the absolute error
amplified by a fixed gain in a third. A reconstruction inside a tight bound
shows an almost blank error lane; a violation glows. The input is the committed
reference plus the reconstruction the artifact already carries, so a reader
re-derives the plot from data the claim covers — the bound stops being a number
in a JSON field and becomes something checkable by eye and by digest.

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
  manifest records. The browser mirror only surfaces AI evidence when
  `manifest.leafVersion >= 4`; the same fields on a pre-v4 publication are
  outside the leaf and are ignored.
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
  itself. When an AI rendition is present it re-derives the raster and, for
  blobs embedded in the mirror, checks the blob digest too. Everything it shows
  is covered by the anchor.
- **Agent SDK, both directions:** a resident does not only check the world, it
  contributes to it — `selfPublish(signer, …)` runs the agent's OWN circuit,
  attests the run under the agent's own verifier name, signs the record with the
  agent's own key, and assembles the bundle; `npm run demo:self-publish` executes
  exactly that and exits non-zero if any step fails to hold (the signature is
  verified against the agent's own key, and the assembled bundle is re-verified
  after a byte round trip, as a stranger would). The same demo makes a
  GENERATION, not only a computation: `selfPublishGenerative(signer, …)` runs the
  committed model on the agent's own node, reproduces the published output, and
  the claim it signs then REPLAYS CORRECT from the bundle alone — the challenge
  and semantics travel with it, because a claim whose rule does not travel cannot
  be checked by anyone else. The demo also makes a LOSSY one, the representation
  real model classes take: `selfPublishBounded(signer, …)` measures the distance
  to the committed reference on the agent's own node, and the demo checks both
  directions — a reconstruction within its bound replays correct, and one pushed
  past the bound is refused, because a promise about a bound is worth nothing
  unless breaking it is caught. `buildBundle(publications, …)` BUILDS a bundle
  offline — an agent with no server assembles the leaves, the Merkle root and the
  manifest through core's own `assembleBundle`, the same function the registry's
  builder calls, so the artifact a resident makes is the artifact the registry
  would have made; and `replayBundleAi(bundle)` replays every AI claim a verified
  bundle carries from the bundle alone — no fetch, no server, no API. Generative
  claims replay through `verifyAiArtifact` with the model digest and core's
  regenerated output beside the claimed one as evidence; bounded claims
  re-derive the metric and compare it with the attested `metricValue`, so a
  mismatch is `correct: false` rather than a silent pass; a claim whose
  challenge the bundle does not carry is an error verdict naming it, and a
  bundle that claims nothing AI returns an empty list. The result carries the
  bundle's manifest root, so verdicts tie to the copy that produced them.
- **One command from the outside:** `npm run demo:resident` fetches the
  published seed (or a URL you pass), uses the SDK's `findVerifiedBundle` to
  reach a copy that rebuilds the pinned root and CID, and replays every AI claim
  with `replayBundleAi`; it prints each candidate's refusal, every verdict with
  its evidence, and the root they tie to. When the seed names announcement
  documents it folds them too, resolving the announcing keys from the documents
  the publisher serves (`identityFromPublishedDocuments`) and printing each
  record as accepted with its mirror or refused with its reason — so the resident
  believes an announcement only under a key it could actually check. A local tree
  may pin its port (`--local <dir> --port <n>`) because a signed record names
  absolute URLs and a signature over a rewritten URL is not a signature. It needs
  no keys, no server, and no
  write access, and `--local <dir>` runs the same flow against a local tree in
  CI.
- **Library:** `verifyGenerativeReplay` and `verifyBoundedReconstruction` are
  pure functions with no network dependency — independent tools can re-implement
  or re-run them.

## Live proof on the GitHub site

The anchored bundle deployed at <https://999svs999.github.io/RAREXT-protocol/mirror/verify.html>
carries two real AI publications — one generative, one bounded — and its
verification page recomputes the Merkle root and runs the local AI checks in
your browser: the generative output is replayed from the committed model and
seed, the bounded metric is recomputed from the raw reconstruction, and the
generative rendition is re-derived and digest-checked against the mirror's
inline blob. **You can also make one.** <https://999svs999.github.io/RAREXT-protocol/mirror/ai.html>
runs the committed model in your browser and assembles the evidence an attestation
would carry — the artifact body, the model digest, the trace hash built the way
`attestRun` builds it, and the artifact hash — and, for the lossy representation,
measures a pasted reconstruction against the committed reference it reads from the
bundle BESIDE the page, so the page cannot drift from the artifact it is measuring. It also DRAWS it: both
representations are painted from the raster the evidence commits to — the RGB bytes
themselves, never decoded from a file — so the picture a visitor sees in the browser
re-hashes to the digest in the published artifact. The bundle's two editions are read
as independent halves, because a page that reads one out of the other goes quiet
instead of wrong.
Nothing is fetched to run it, nothing is sent anywhere, and no key is involved: a
signature is an identity claim and a page has no identity, so the PROOF is what it
produces. Its hashes are held to node's in `apps/web/test/ai-proof.test.ts` — if
WebCrypto and node disagreed about the evidence, `npm run ci` would say so rather
than let a browser produce a different proof quietly.

The proof pipeline is committed and reproducible:

```
node scripts/publish-ai-proof.mjs
```

It boots the real API, registers an agent, publishes both artifacts through the
signed flow, confirms a tampered output is rejected, anchors, and builds the
mirror bundle. Deploy that bundle anywhere — the verification page needs no
server.

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
