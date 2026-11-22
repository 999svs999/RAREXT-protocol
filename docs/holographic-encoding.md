# Holographic encoding for RAREXT — measured

Companion to [quantum-entanglement-rebuild.md](quantum-entanglement-rebuild.md).
That page measured the **model axis** (bond dimension χ of the MPO rebuild);
this page measures the **memory axis** the objective calls *holographic
encoding and scaling in another dimension*: Holographic Reduced
Representations (Plate 1995/2003), the FHRR variant — vectors of D unit
phasors where **binding is elementwise complex multiplication**, a whole table
is the **sum** of its bindings, and recall multiplies by the conjugate cue and
cleans up against a vocabulary. In the Fourier domain this is exactly Plate's
circular convolution, without the O(D²) cost.

Everything below is computed by `tools/holographic/hrr.py`
(results in `tools/holographic/hrr-results.json`); every table is the output
of that run. Cleanup is tested against **1000 random distractors** — a
one-item vocabulary would make 100% trivial.

## 1. Binding fidelity (exactness of the algebra)

unbind(bind(a,b), a) = b exactly in FHRR; with 1000 distractors in the
cleanup space, retrieval is 100% at every D from 64 to 4096, mean similarity
1.0000. The algebra loses nothing; all losses come from superposition and
noise, measured next.

## 2. Capacity scales with D — the "another dimension", measured

K (item→price) pairs stored in **one vector**; every pair queried; cleanup
over targets + 1000 distractors:

| D | K=1 | K=5 | K=10 | K=25 | K=50 | K=100 | K=200 |
|---|---|---|---|---|---|---|---|
| 256 | 100% | 100% | 100% | 89% | 49% | 14% | 5% |
| 1024 | 100% | 100% | 100% | 100% | 100% | 88% | 49% |
| 4096 | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

Read the 100% frontier: K=10 at D=256, K=50 at D=1024, K=200 at D=4096 —
**quadrupling D quadrupled the capacity at perfect accuracy** (measured, three
points on the line). The failure mode is graceful, not a cliff: at D=1024,
K=200 still retrieves 49% — every query is partially right, and the noise
floor falls slowly.

## 3. Noise robustness (D=1024)

Corrupting up to **50% of the cue's phasors** still retrieves the bound item
100% of the time (1000 distractors). The information is distributed across the
whole vector — there is no single byte that matters, which is what
"holographic" means here.

## 4. Composition is not free (measured honestly)

Composing item vectors from a small word vocabulary (an item = the product of
its words' phasors; 60 words standing in for K=25 items per batch, D=2048):

- atomic item vectors: **100.0%** retrieval
- compositional item vectors: **69.3%**

FHRR binding is commutative, so word-order information is lost and reused
words collide; the compositional encoding trades retrieval accuracy for
vocabulary compression. That trade is now a measured number, not a hope.

## 5. The RAREXT price task — the two axes, in bytes

| D | K (pairs) | accuracy | memory | bytes/pair |
|---|---|---|---|---|
| 1024 | 10 | 75.3% | 16 KiB | 1,638 |
| 1024 | 200 | 22.1% | 16 KiB | 82 |
| 4096 | 10 | 80.3% | 64 KiB | 6,554 |
| 4096 | 200 | 49.5% | 64 KiB | 328 |
| 16384 | 200 | 49.8% | 256 KiB | 1,311 |

(Compositional items — the honest, harder version. With atomic item vectors
the same D=4096, K=200 table is 100%, experiment 2.)

Put beside the trained model:

| | holographic memory | trained χ=48 MPO model |
|---|---|---|
| what it stores | exact (item→price) lookups | the *skill*: read any `rows:` block, compare, answer |
| training | **none** — encode is O(K) multiplications | 6,000+ steps of supervised + RL training |
| cost at webpage scale | 16–256 KiB, a handful of vector ops per query | 4,673,760 bytes, ~442 ms/answer in-engine |
| generalizes to novel phrasings | **no** — the cue must match a bound item | **yes** — that is what training bought |
| capacity axis | D (measured: ~linear at fixed accuracy) | χ (measured in the entanglement doc) |

## Verdict

- **The claim is real and measured**: structured data can live in a single
  vector whose size does not grow with the number of stored pairs, whose
  capacity scales ~linearly with the dimension D, and which tolerates 50% cue
  corruption. Storage for a 200-pair table: 64–256 KiB — literally the cost of
  a webpage asset, with decode cost of one vector multiply + one dot product
  per query (microseconds in a tab).
- **It is a memory axis, not a mind**: holographic encoding does exact
  key→value lookup; it does not generalize to novel phrasings, and composing
  items from words costs accuracy (69.3% measured). The trained MPO model
  generalizes and stays the reasoning engine; holographic memory is the cheap,
  instant, training-free companion for tabular knowledge.
- **No quantum claim**: "holographic" here is Plate's algebra on phasor
  vectors. The connection to the entanglement work is structural, not
  mystical — both distribute information across a high-dimensional space with
  a measured capacity law (χ for the model, D for the memory), and both are
  now measured in this repository.

## Reproduce

```bash
python3 tools/holographic/hrr.py        # ~3 min, all five tables
```
