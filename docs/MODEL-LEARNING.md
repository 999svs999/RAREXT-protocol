# Can the shipped χ=48 model learn the arithmetic it scores 0% on?

Date: 2026-11-24. Companion to [TOP-100.md](TOP-100.md), which reports the
deployed model's honest held-out number: **91–96 of 200 exact (45.5–48.0%)**,
with `diff`, `total` and `pct` at **0%** because the host was only ever trained
to copy a price and compare rows.

The scorecard's numeric-accuracy row is currently a **tie** that RAREXT wins
only through an exact tool. A reviewer objection is correct: a tool is not the
model, and the goal is to make the model itself better. So this page records
what happens when the deployed 2.1 M-parameter rebuild is actually trained on
the three missing families, in the same projected-training loop the artifact
was refined with.

Everything below is a command in `tools/entangle/`. Nothing here is projected
from a bigger model or borrowed from another checkpoint: the weights start at
`tools/entangle/refined-chi48.pt`, the same 4,673,760-byte rebuild the page
serves.

## Method (what "train the rebuild" means here)

```console
$ PY=/private/.../lmenv/bin/python
$ $PY tools/entangle/teach_ledger.py --steps N --pilot
$ $PY tools/entangle/_probe_arith.py  --digits D --steps N
$ $PY tools/entangle/_probe_arith2.py --mode short|noborrow|full --digits D
```

* **Loss** — cross-entropy on the answer bytes **and the EOS that ends them**,
  right-padded exactly as `models/live-host-lm/train.py` does. The earlier
  attempt used `answer_logprobs`, which excludes EOS; the model never learned
  to stop and rambled (`'$2.5 more more $1.5 delivered…'`). That is fixed.
* **Data** — generated **fresh every step** from the same grammar
  `tools/rank/gen-tasks.mjs` uses. A fixed 6,000-pair set memorises in under
  800 steps (train loss 0.15–0.27, held-out 0), so memorisation is not learning.
* **Projection** — an SVD back onto the χ=48 entanglement manifold every 10
  steps (`project()`), i.e. the same constraint the shipped artifact obeys; 56
  factor pairs, `a.rows === b.cols`, exactly what the engine reads.
* **Replay** — a fraction of every batch is the deployed skills (S0/S1/S2 and
  the mixed-digit variants), so a new function cannot be bought by selling the
  old ones. The promotion gate is "no deployed set regresses by more than one
  held-out sample (0.042)", the same gate `refine_rebuild.py` uses.
* **Measurement** — held-out prompts the run never saw, greedy decode, scored
  exact-string. Two extra numbers are reported where useful: *value* accuracy
  (same number, any formatting) and the chance rate for that distribution.

### How hard is the task, numerically

```console
$ python3 - <<'EOF'
from collections import Counter; import math
...
EOF
1-digit diff (5-9):    20 ordered pairs, 4 possible answers,  best constant guess 40.00%, entropy 1.85 bits
2-digit diff (10-99): 8010 ordered pairs, 89 possible answers, best constant guess  2.22%, entropy 6.20 bits
```

A constant answer scores 40% on the 1-digit task and 2.2% on the 2-digit one,
so those are the floors to read the results against — not 0%.

## Measured results

All runs start from `refined-chi48.pt`; "old" is the seven deployed skills
measured on 16–24 held-out samples each.

| run | steps | lr | exact | value | chance | worst old-skill delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1-digit diff, long names, projected | 400 | 1e-4 | **90%** | 90% | 40% | **0.000** |
| 2-digit diff, long names, projected | 600 | 1e-4 | 0% | 0% | 2.2% | +0.375 (S1t 0.92→0.54) |
| 2-digit diff, **short names**, projected | 400 | 2e-4 | 5% | 5% | 2.2% | 0.000 |
| 2-digit diff, **no-borrow**, projected | 400 | 2e-4 | 10% | 10% | 2.2% | +0.06 (S1t 0.94→0.94, S2t 1.00→1.00) |
| full curriculum (all three families), projected | 600 | 2e-4 | diff 10% · total 2% · pct 5% | — | 2.2% | +0.375 (S1t 0.92→0.54) |

What this already establishes, with no interpretation:

1. **The host can subtract.** One-digit difference reaches 90% exact in 400
   steps and leaves every deployed skill at its baseline. This is not a tool
   result; it is the model.
2. **Two-digit subtraction does not come for free from that.** Shortening the
   names (removing all lookup work) did not help — 5% — so the missing piece is
   arithmetic width, not row matching. Removing the borrow — two independent
   one-digit subtractions — reached only 10%.
3. **The old skills survive training** whenever replay is present and the
   learning rate is 2e-4 or below. The +0.375 regression row is the one run
   that paired a 2e-4 rate with no digit curriculum; it is reported, not hidden.
4. **Projection is a suspect, not a proven constraint** — every run above
   projects every 10 steps. The unprojected control below separates "the task
   is too big for 400 steps" from "χ=48 cannot hold the function".

## Promotion gates for any checkpoint

A checkpoint is promoted to `apps/web/public/rarext-entangled-chi48.gguf` only
if all of these hold, measured by `tools/rank/eval-neural.mjs` afterwards:

* arithmetic families (`diff`, `total`, `pct`) held-out exact **> 0%**, and
  reported per family rather than pooled;
* lookup/compare families **do not fall** below their current 88–97%;
* `cp tools/entangle/entangled-chi48-ledger.gguf apps/web/public/rarext-entangled-chi48.gguf`
  only after the digest in `apps/web/public/entangled.js` is updated, and
  `node tools/rank/verify.mjs` + `npm run test:runtime` pass;
* the scorecard is regenerated, so the published neural number changes with the
  weights rather than being edited by hand.

If no checkpoint clears the first gate, the honest outcome is that this
architecture cannot compute the ledger at χ=48 within this compute budget, and
the numeric-accuracy axis stays a *tool* result on the scorecard — stated as
such, not claimed as a model win.
