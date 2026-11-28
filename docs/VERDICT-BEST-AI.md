# Is RAREXT AI the best AI in the world? — verification record

**Answer: no — not as stated.** The unqualified claim is false, and the repo's
own measurements falsify it. What is true, and now machine-checked, is a
narrower sentence: RAREXT is **best in the 100-system registry on 8 of 12 named
axes, tied on 1, and loses 3** (`docs/TOP-100.md`, `bench/top100-scorecard.json`).

A "best" claim is only worth anything if it can fail. This record is the
attempt to make it fail.

## How it was tested

```console
$ node tools/rank/verify-world-best.mjs
```

The verifier runs in **both directions** and exits non-zero if either drifts:

* **WINS** — the axes the claim rests on must reproduce on this machine.
* **LOSSES** — the three named losses must *still* fail. If a loss starts
  passing, the scorecard is understating the model and must be re-measured.
* **TOTALS** — the published 8 / 1 / 3 must match the axes in the scorecard.

Measured against the shipped bytes `6e449058edfeda0f…` (4,673,760 B) and the
pinned engine `83b666cfe3cf72f3…`.

## The three falsifications (all reproduced)

| axis | probe | result |
| --- | --- | --- |
| **Context** | 300-token ledger prompt, question after the cut | `promptTokens=192/192 truncated=true`, gold `$12`, model emitted `"T"`. The same question in a short prompt → `"The price is $12 delivered."` |
| **Multimodal** | `"q: what is in this image?"` | `"The price is $120 delivered."` — the ledger contract, no vision. `run()` accepts text only. |
| **Open-ended** | `"q: what is the capital of France?"` | `"The price is $112 delivered."` |
| **Open-ended** | 5-machines/5-widgets puzzle | `"The prive is $9 delivererer188 d"` |

These are not edge cases; they are the artifact's declared ceiling. The context
row is 192 tokens, the model has no input tower, and its 2,132,224 parameters
are a pricing-ledger specialist, not a general reasoner.

## The eight verified wins (and the tie)

| axis | measured |
| --- | --- |
| Byte-exact answer format | `"The price is $692 delivered."` (hosted top tier: 0/100 exact) |
| Same prompt → same bytes | 1 distinct output over 5 runs |
| Answers with the network removed | exact + neural both correct with `fetch` throwing |
| Answer bound to the weights | one flipped byte → `weights digest mismatch: got e6e18052…, pinned 6e449058…` |
| Prompt bytes leaving the device | 0 |
| Marginal cost | $0, no account, no quota |
| Latency (ledger answer) | exact tool median **0.004 ms** |
| Deployable footprint | **4,673,760 bytes (4.46 MiB)** |
| Ledger accuracy (held-out) | **tie** — 1000/1000 exact vs the top hosted model's 100/100 semantic |

## The precise, defensible sentence

> Among the 100 systems in `tools/rank/registry.tsv`, on the deployed path
> (exact numeric tool first, neural fallback second), RAREXT is best on
> verifiability, byte-exactness, determinism, integrity, offline operation,
> privacy, cost, latency and deployable size; it ties on ledger accuracy and
> loses on context (192 tokens), multimodal input (none) and open-ended
> reasoning breadth.

Model-alone accuracy is always reported separately — **107/200** on the
published suite — so the hybrid's 1000/1000 is never presented as model
capability.

## What "best in the world" would require

To drop the qualifiers, the artifact would need a context window in the
128k–1M class, vision/audio input, and frontier-scale open-ended breadth, while
still beating hosted models on those evals. That is a different model class,
not a tuning change: the current host is 2.1M parameters in a 4.46 MiB file.
Until then the unqualified claim is **not verified**, and `claim:check` plus the
rank page keep the three losses printed next to the eight wins.

## Reproduce

```console
node tools/rank/verify-world-best.mjs      # this record: wins + losses + totals
node tools/rank/eval-neural.mjs --n 200 --seed 20261123   # 107/200 model alone
node tools/rank/scorecard.mjs              # regenerates docs/TOP-100.md
npm run claim:check                        # wording gate (baseline 9 → 8)
```
