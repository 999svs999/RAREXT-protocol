# Rebuilding RAREXT AI from its entanglement spectrum

## What was asked, and what physics allows

The request was to *use quantum entanglement to rebuild RAREXT AI*. The first
part of that has to be answered honestly before any code runs, because it is a
physics question with a settled answer:

**Entanglement cannot rebuild, accelerate, or transmit anything by itself.**
It is a correlation resource, not a wire and not a processor. This repo now
computes that claim instead of asserting it:

```bash
python3 tools/entangle/bell_demo.py
```

Measured output (singlet state |Ψ⁻>):

| property | measured | meaning |
|---|---|---|
| CHSH | `2.828427125` | the correlations are real and stronger than any local classical model (bound 2) |
| same-axis correlation E(θ,θ) | `-1.0` at every θ | perfect anticorrelation |
| Bob's marginal P(+1) for Alice's axis ∈ {0°,30°,45°,90°,137°} | `0.5` every time | Alice cannot signal Bob by choosing her axis |
| max &#124;marginal − 0.5&#124; | `1.11e-16` | no-signalling holds to machine precision |
| ½(P(+&#124;+) + P(+&#124;−)) | `0.5 ± 0` | the strong conditionals average away without a classical message |

So there is no "entanglement rebuild" in the sense of a quantum machine doing
the work: no quantum computer is in this path, and entanglement could not carry
the model's weights even if one were.

What *is* real — and is the only sense in which entanglement mathematics
rebuilds a neural network — is the **Schmidt decomposition**. Every weight
matrix `W ∈ R^{m×n}` has `W = U·diag(s)·Vᵀ`. The normalized `s²` are an
entanglement spectrum, and keeping the first χ terms is exactly the bond
dimension of a matrix-product operator (MPO). A transformer built from such
factors is a chain of MPOs. The rebuild below is that, measured end to end.

## Method

| file | what it does |
|---|---|
| `tools/entangle/bell_demo.py` | proves the correlation (CHSH 2√2) and the absence of signalling |
| `tools/entangle/entanglement_spectrum.py` | SVD of every weight matrix; rank, participation ratio, entropy, χ needed for 99% / 99.9% of squared weight |
| `tools/entangle/rebuild_mps.py` | rebuilds the model at uniform χ and at per-matrix energy thresholds; measures held-out skill exact match and per-token KL(original ‖ rebuild) |
| `tools/entangle/refine_rebuild.py` | **projected (DMRG-style) refinement**: gradient step → SVD projection back onto the χ-manifold, repeated |
| `tools/entangle/parity.py` | five held-out seeds, Wilson intervals, the non-inferiority decision, GGUF export, engine faithfulness |
| `tools/entangle/factor_export.py` | exports the same refined weights as a dense GGUF and as an MPO-factored GGUF |
| `tools/entangle/compare_answers.py` | decodes 280 held-out prompts through both artifacts and diffs answers, bytes, time |
| `tools/entangle/verify_engine_skills.py` | scores a GGUF per skill through RAREXT's own engine |

Nothing here is a new runtime or a new format: the output is a normal GGUF
served by `apps/runtime/engines/rarext-gguf-engine.js`.

## Measured: how entangled is the trained host?

`python3 tools/entangle/entanglement_spectrum.py` on the served checkpoint
(`gen-000.pt`, 2,132,224 params, 8 layers, d=128, ffn=512):

- No matrix is low-rank in the trivial sense: every 128-dim matrix has rank 128.
- But the **effective** number of Schmidt terms is far smaller. Participation
  ratio `(Σs²)²/Σs⁴` ranges from **1.2** (embedding) to **32.3** (one MLP up
  projection); the attention output projections are the most separable
  (`blocks.6.o` PR 7.2, `blocks.7.o` PR 6.1).
- χ needed for 99% of squared weight: **16–117** per matrix; for 99.9%:
  **42–127**.
- Adaptive per-matrix storage at 99.9% energy needs *more* parameters than the
  dense matrices (122.6%), so compression only exists at a fixed bond
  dimension below ≈64 — the trade is a real one, not free.

Full table and JSON: `tools/entangle/spectrum.json`.

## Measured: plain truncation is not enough

Held-out exact match (greedy decode — what serving reads), gate = no skill may
drop more than 0.02 below the dense model:

| χ | factored params | vs dense | max drop | S0 | S1 | S2 | S1m | S2m | S1t | S2t |
|---|---|---|---|---|---|---|---|---|---|---|
| dense | 2,132,224 | 100% | — | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 | 0.96 | 0.96 |
| 32 | 768,160 | 36.0% | +0.250 | 0.75 | 0.81 | 0.84 | 0.71 | 0.79 | 0.79 | 0.75 |
| 40 | 959,656 | 45.0% | +0.042 | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 | 0.96 | 0.92 |
| 48 | 1,151,152 | 54.0% | +0.042 | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 | 0.96 | 0.92 |
| 56 | 1,342,648 | 63.0% | +0.042 | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 | 0.96 | 0.92 |
| 64 | 1,534,144 | 72.0% | +0.042 | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 | 0.96 | 0.92 |

KL(original ‖ rebuild) falls from 3.77 (χ=8) to 4.86e-3 (χ=64).

The "0.042" is **one sample in a 24-sample held-out set** (23/24 → 22/24).
That is below the gate's resolution, which is why the next step exists.

## Measured: projected (DMRG-style) refinement

Gradient step on the computed gold, then project every matrix back onto the
rank-χ manifold. This searches *inside* the low-entanglement manifold instead
of merely truncating toward it:

| χ | factored params | vs dense | step 160 | step 320 |
|---|---|---|---|---|
| 32 | 768,160 | 36.0% | +0.083 | +0.042 |
| 48 | 1,151,152 | 54.0% | +0.042 | +0.042 |
| 56 | 1,342,648 | 63.0% | +0.042 | +0.042 |

At χ=48 refinement recovers S2t exactly (0.96) while S1t sits one sample low
(0.92). At χ=56 the pattern is identical. The strict two-seed gate still
refuses all three, because a 4.2% single-sample difference cannot pass a 2%
tolerance — the gate is finer than its own measurement.

## The honest gate, and the decision

A single sample in 24 will always produce ±0.042 noise. `parity.py` therefore
runs five independent held-out seeds and applies a **non-inferiority test**:
promote only if the 95% interval of the per-skill difference stays above −0.02.

Five held-out seeds, `tools/entangle/parity.py --chi 48`:

| skill | dense | rebuild | Δ (95% CI) |
|---|---|---|---|
| S0 price-copy | 400/400 (100%) | 400/400 (100%) | +0.000 |
| S1 cheapest | 159/160 (99.4%) | 159/160 (99.4%) | +0.000 |
| S2 priciest | 160/160 (100%) | 159/160 (99.4%) | −0.006 [−0.018, +0.006] |
| S1m cheapest-mixed | 115/120 (95.8%) | 114/120 (95.0%) | −0.008 [−0.061, +0.045] |
| S2m priciest-mixed | 117/120 (97.5%) | 117/120 (97.5%) | +0.000 |
| S1t cheapest-3row-mixed | 109/120 (90.8%) | 109/120 (90.8%) | +0.000 |
| S2t priciest-3row-mixed | 116/120 (96.7%) | 116/120 (96.7%) | +0.000 |
| S3 refusal | 0/200 | 0/200 | +0.000 |
| **all scored** | **1176/1200** | **1174/1200** | **−0.17%** |

The rebuild matches the dense host *exactly* on both hard 3-row sets over 120
samples each. Its only deficits are one sample in S2 and one in S1m. Every
point estimate is inside the 0.02 tolerance; the intervals are too wide to
*certify* 0.02 non-inferiority at this sample size — that is a limit of the
measurement, not of the model.

## Measured: serving the rebuild

An MPO is only a saving if the engine reads it. The engine now recognises a
`X.a` (χ × in) / `X.b` (out × χ) pair and serves it as `X.weight = b·a`
(additive path: a dense file has no such pairs, and the original path is
untouched). The same refined weights were exported both ways and decoded by
`apps/runtime/engines/rarext-gguf-engine.js` over all 280 held-out prompts of
seed 4242:

| artifact | bytes | vs dense | answer time | per token |
|---|---|---|---|---|
| `entangled-dense.gguf` | 8,537,568 | 100% | 644 ms/prompt | 24 ms |
| `entangled-factored.gguf` (χ=48) | 4,673,760 | **54.7%** | **442 ms/prompt** | **16 ms** |

- **identical answers: 280/280 (100.00%)** — not "close", the same strings.
- matrix parameters: 1,165,440 factored vs 2,097,152 dense (55.6%).
- the win is two small products instead of one large one: for a 128×128 map at
  χ=48 that is 12,288 multiply-adds instead of 16,384; for 512×128 it is 30,720
  instead of 65,536.

`web4.test.ts` gained a fixture-level test that builds a dense and a factored
twin of the same tiny model (A = W, B = I, so the decodes must be bit-identical)
and asserts token-identical output, placeholder shapes, and factor detection.

## Verdict

- **The rebuild is real.** RAREXT AI's function can be reconstructed from a
  bond dimension of 48 instead of 128: every deployed skill is preserved to
  within one held-out sample over 1,200 comparisons, and both hard 3-row sets
  match the dense host exactly (109/120 and 116/120).
- **The saving is real when the engine reads the factors**: 54.7% of the bytes,
  31% faster per prompt, 280/280 identical answers through RAREXT's own engine,
  with a regression test that holds the path token-identical.
- **It is not promoted to serving.** The evolution gate's rule is 0.02 on two
  seeds, and one sample in a 24-sample set is 0.042, so the gate refuses plain
  truncation and refinement alike. Serving a smaller model that the gate has
  not accepted would break the project's own discipline. The artifact and the
  engine capability are shipped; promotion would need the gate re-specified at
  a resolution coarser than its own measurement noise (e.g. 5 seeds, tol. 0.02
  on the pooled count), which is an operator decision.
- **What this is not**: a quantum computation. Entanglement supplies the
  representation (Schmidt/MPO), not the compute; `bell_demo.py` measures
  no-signalling to 1.1e-16, which is exactly why it cannot be one.

## Limits, stated plainly

- No quantum hardware is used, and none would help: the no-signalling result
  above is why entanglement cannot be a channel or a processor.
- This is an MPO-factorisation rebuild of each linear map, not a claim that the
  model's activations sit in a small-bond-dimension MPS.
- The reported entropy is of the matrix as a bipartite state (its Schmidt
  spectrum), not of the host's hidden states.
- S3 refusal reads 0% for every variant *including the dense host*, but the
  engine output shows why: the model emits the correct refusal
  (`"I only deal in prices here — ask me about a pi…"`) and is cut at the
  48-token evaluation cap (`finish=length`); the reference string is 65 bytes.
  The deployed route classifies price intent and refuses before calling the
  model, so this is an evaluation-harness limit, not a learned-price leak.
- Per-matrix adaptive thresholds do not compress; only a fixed χ below ≈64
  does.
