# The storage frontier

This is a research agenda, not a claim. It exists because the next question —
*can we store digital information in a fundamentally smaller representation?* — is
the one most likely to be answered dishonestly, and we would rather write down the
boundary before we start than discover it in a launch post.

Read [`PRIOR-ART.md`](PRIOR-ART.md) first. That document says what is already
built. This one says what might be built, what cannot be, and how we will know the
difference.

## The bound we cannot cross

Three results are not engineering problems.

**Shannon (1948).** For a source with entropy `H`, no lossless code averages fewer
than `H` bits per symbol. Compression approaches the entropy; it does not go below
it. A codec is a *shared model*: the decoder's size is part of the cost, and the
decoder is data you must also store and agree on.

**Kolmogorov.** The shortest program that outputs a string is not computable in
general, and for a random string the shortest program is essentially the string
itself. "Everything is a short equation" is true only for data with structure.

**Holevo (1973).** `n` qubits carry at most `n` classical bits of accessible
information. The `2^n` amplitudes are a computational resource, not a readout
channel. Quantum memory is not a bigger disk.

None of these forbid progress. They forbid *free* progress: every representation
buys size with one of three currencies — structure, fidelity, or reconstruction
cost.

## The three legitimate trades

| Trade | What you give up | Where it works |
| --- | --- | --- |
| **Structure** (procedural, parametric) | Generality. Only content a model can describe compactly. | Torus knots, terrain, synthetic scenes, generated art, circuits, code |
| **Fidelity** (lossy, rate–distortion) | Exact bytes. You choose a quality and a metric. | Photos, video, audio, point clouds, 3D |
| **Reconstruction cost** (compute for storage) | Time and energy at read. | Procedural worlds, generative reconstruction, seeded simulation |

Erasure coding is a fourth, different thing: it does not compress at all. It buys
*durability per byte* — `n/k` overhead instead of `m` full copies — and it is the
only one of these that is already implemented (`apps/api/src/erasure.ts`).

## What "the data is the equation" actually means

An implicit neural representation stores a small network whose weights reconstruct
an image or volume. That is a real and useful result: for some 3D and volumetric
data it beats classical formats by an order of magnitude at equal perceptual
quality. But note what the equation is:

- the **weights are data**, and they must be stored, replicated, and verified;
- the **architecture is a shared decoder**, which is a protocol-level artifact;
- the reconstruction is **lossy**, so "the image" is now a tolerance, not a byte
  string.

Generative reconstruction goes further: a diffusion model can produce a *plausible*
image from a short description. It cannot produce *the* image. For a protocol whose
entire value is that a stranger can recompute the exact claim, that distinction is
the whole ballgame.

## The consequence for this protocol

Our verification model assumes exact determinism: the same bytes in, the same
attestation out, in a browser and on a server. A lossy or generative representation
breaks that assumption, and pretending otherwise would quietly turn "verifiable"
into "vibes".

So any representation work has to arrive with a **proof kind** and a stated
tolerance:

- `exact` — the current model. Recompute and compare hashes.
- `bounded` — reconstruct and check a declared metric bound (PSNR, SSIM, Hamming
  distance) against a committed reference digest. The verifier checks the bound,
  not equality.
- `generative` — a claim about a *distribution*, not an artifact. The verifier can
  check that the output came from the committed model and seed, and must not claim
  more.

That is a protocol change, not a codec change. [RFC 0009](../rfcs/0009-representation-kinds.md)
now defines the envelope, the verifier block, and the acceptance criterion; the claim kind
already exists in the semantics layer, and the representation kind sits beside it.

## The research programme

Ordered by expected value per unit of work, with falsifiable acceptance criteria.

### 1. A benchmark harness before any codec (now)

A fixed, public corpus — photos, video, audio, text, source code, 3D — and a
harness that reports, for each method: bytes stored, reconstruction error, verify
cost, decode time, and whether the result is exactly reproducible. No method is
interesting until it is measured against `x265`, `AV1`, `zstd`, and the
erasure-coded baseline on the same corpus.

**Acceptance:** the harness runs in CI on a 100 MB corpus and publishes a table.
**Falsifies:** any claim that cannot fill in the table.

**Implemented:** [`bench/storage`](../bench/storage/README.md). The deterministic,
hash-locked default corpus is 99.96 MiB across video, photos, audio, text, source,
and a point cloud; runners cover x265, AV1, zstd, and the shipped 4+2 erasure path.
A full run takes about 66 seconds on the reference laptop. The table is
[`RESULTS.md`](../bench/storage/RESULTS.md). It records exactness by comparing
decoded bytes to the committed reference digest — never by asking the codec — and
requires a learned codec to count its decoder in the stored cost. Classical decoders
are the system's and are not yet counted; that is stated with the table.

### 2. Erasure-coded durability at scale (near)

Place shards across independent holders, challenge retention on a schedule, publish
the replica count. Measure repair bandwidth: when one shard is lost, how many bytes
must move to restore `n`?

**Acceptance:** a 1 GB blob survives losing up to `m` holders, is rebuilt from any
`k`, and reports its true replica count; repair traffic is measured as read + write
and is at least the MDS floor `S(1 + m/k)`. The old `< 1/k` total target is
impossible for this layout and was amended in issue #4; beating the floor needs a
different code.
**Falsifies:** "the network has it" when it has one copy.

### 3. Neural and parametric compression with an exactness contract (mid)

Implement one learned codec and one implicit representation behind the same
interface, and measure them against classical codecs at equal quality. Report the
decoder size, because the decoder is part of the storage cost.

**Acceptance:** a published rate–distortion curve that beats the classical baseline
by a stated margin on at least one modality, with the decoder included in the
accounting.
**Falsifies:** "a video in a QR code" — the curve will show the floor.

### 4. Data availability sampling for media (mid)

Light clients sample shards to check availability without downloading the blob.
This is the piece that makes "anyone can verify" true for large files without
"everyone stores everything".

**Acceptance:** a client that holds no shards can detect a withheld shard with
probability ≥ 1 − 2⁻³² while downloading a bounded fraction of the blob.
**Falsifies:** availability claims that require trusting a node.

### 5. Proofs about data we never reveal (long)

The agent-native direction: prove a property of a media object — unmodified,
licensed, not a banned hash, produced by a given model — without publishing the
bytes. This is where zero-knowledge work meets content addressing, and it is the
most defensible long-term differentiator.

**Acceptance:** a verifier checks a property of a 10 MB object in seconds, with the
object never leaving the holder.
**Falsifies:** the assumption that verification requires publishing.

## What we will not claim

- That storage becomes free. It does not; the cost moves to a device, a
  replicator, or an endowment, and the protocol must say which.
- That one user is durability. One holder is one copy, and one copy is a backup
  that has not failed yet.
- That a hash can reconstruct its input, or that a qubit is a bigger disk.
- That a lossy reconstruction is the same artifact. It is a new artifact with a
  stated distance from the original; the protocol will name it as such.

## The honest one-liner

**Compression trades bytes for structure, fidelity, or compute. Erasure coding
trades bytes for durability. Verification is what keeps both honest — and it only
works if the claim says which trade it made.**

That sentence is the research programme. Everything else is a benchmark.
