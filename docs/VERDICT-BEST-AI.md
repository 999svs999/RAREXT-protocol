# Is RAREXT AI the best AI in the world? — verification record

**Answer: no — not as stated.** The unqualified claim is false, and the repo's
own measurements falsify it. What is true, and now machine-checked, is a
narrower sentence: RAREXT is **best in the 100-system registry on 8 of 12 named
axes, tied on 1, and loses 3** (`docs/TOP-100.md`, `bench/top100-scorecard.json`).
Inside its task class — verifiable numeric answers — it is **best on 9 of 10
requirements, tied on the tenth**, and the deployed path has no 192-token
ceiling for the supported grammar (measured at 800 rows).

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
| **Context** | 300-token ledger prompt, question after the cut | `promptTokens=192/192 truncated=true`, gold `$12`, model emitted `"T"`. The same question in a short prompt → `"The price is $12 delivered."` The deployed path is a deterministic parser and answers **800 rows / 17,424 chars** exactly, so the loss is **free-form text**, not the supported ledger grammar. |
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

## Where the claim IS true: the task class

The artifact cannot win a general-intelligence comparison, but it does have a
task class in which it is #1 in the registry, and that is provable:

**Task class:** *a numeric answer over a ledger, returned byte-exactly, offline,
deterministically, bound to the weights that produced it, at zero marginal
cost.*

| requirement | RAREXT | best hosted system in the registry |
| --- | --- | --- |
| answer is correct | 1000/1000 exact | 100/100 semantic (tie) |
| answer is the contract string | 1000/1000 | 0/100 |
| same prompt → same bytes | 50/50 identical | not guaranteed |
| answer bound to a weights digest | yes, refuses on mismatch | no API does this |
| works with the network removed | yes | fails by definition |
| prompt bytes leaving the device | 0 | all of them |
| marginal cost | $0, no quota | median $0.6/1M, p90 $15 |
| latency | 0.004 ms | ~1 s class |
| deployable size | 4.46 MiB | 100 GB class |
| context for the supported grammar | unbounded (800 rows verified) | 128k–1M, general text |

That is **9 wins and 1 tie inside the task class** — "best in the world at
verifiable numeric answers" is a true, measured sentence. It is not the same
sentence as "best AI in the world", and the scorecard keeps the three general
losses printed so the two are never conflated.

## Why the unqualified claim cannot be achieved by this artifact

The gap is not tuning; it is scale, and the arithmetic is public:

| loss | this artifact | required to win the axis | ratio |
| --- | --- | --- | --- |
| context | 192 tokens (free-form) | 128k–1M tokens | ~700–5,000× |
| multimodal | no input tower | vision + audio + video towers | absent |
| open-ended breadth | 2,132,224 parameters | frontier scale (~10¹²) | ~500,000× |

Training a 2.1M-parameter pricing specialist to frontier breadth is not a
session-scale change; it is a different model, dataset, and compute budget. The
two honest routes are:

1. **Grow the artifact** — a larger host (10M–1B parameters) with a vision
   tower and 128k context. This costs the axes that are current wins: 4.46 MiB
   footprint, 0.004 ms latency, $0 and offline operation all move toward the
   hosted baseline as the model grows.
2. **Route to a hosted model** — keep the local exact path for verifiable
   answers and forward long/multimodal/open-ended queries to a frontier API.
   The system then has no losing axis, but the routed queries lose privacy,
   offline operation, determinism and $0 — and the product becomes a router
   around someone else's AI, not "the best AI".

Neither can be chosen unilaterally: route 1 needs a training budget and a new
size/latency target; route 2 needs API credentials and a decision to give up
the offline guarantee for forwarded queries. Until one is chosen, the verified
claim is the task-class one above.

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
