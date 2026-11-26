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

### What the published suite actually asks

```console
$ node tools/rank/gen-tasks.mjs --n 200 --seed 20261123 --json
diff digit-width patterns: {(4, 3): 8, (4, 4): 25}
total digit-width patterns: {(4, 4): 12, (4, 4, 4): 14, (4, 3): 4, ...}
pct   digit-width patterns: {(4,): 29, (3,): 4}
```

Prices are drawn uniformly from 5–9999, so **all 33 `diff` items contain a
4-digit operand**, as do 33/33 `total` and 29/33 `pct`. A model that has
learned only 1–3 digit subtraction therefore cannot move the published number
much:

| per-width diff accuracy | expected diff correct | model-alone on the 200-task suite |
| --- | ---: | ---: |
| 1d 90% · 2d 45% · 3d 15% · 4d 5% | 1.7 / 33 | 48.0% → **48.8%** |

That is the arithmetic honesty this page has to carry: the interesting learning
result (1-digit 90%, 2-digit 28%) is on a width the evaluator almost never
samples. Moving `eval-neural.mjs` requires 4-digit subtraction, which is where
the long run's 4d bucket is the number that matters.

## Measured results

All runs start from `refined-chi48.pt`; "old" is the seven deployed skills
measured on 16–24 held-out samples each.

| run | steps | lr | exact | value | chance | worst old-skill delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1-digit diff, long names, projected | 400 | 1e-4 | **90%** | 90% | 40% | **0.000** |
| 2-digit diff, long names, projected | 600 | 1e-4 | 0% | 0% | 2.2% | +0.375 (S1t 0.92→0.54) |
| 2-digit diff, **short names**, projected | 400 | 2e-4 | 5% | 5% | 2.2% | 0.000 |
| 2-digit diff, **no-borrow**, projected | 400 | 2e-4 | 10% | 10% | 2.2% | +0.06 |
| full curriculum (all three families), projected | 600 | 2e-4 | diff 10% · total 2% · pct 5% | — | 2.2% | +0.375 (S1t 0.92→0.54) |
| 2-digit diff, short names, **unprojected control** | 1000 | 3e-4 | **8%** | 8% | 2.2% | **0.000** |
| 2-digit diff, short names, **projected χ=48** | 2500 | 3e-4 | **28%** | 28% | 2.2% | **0.000** |
| real grammar (long names), 1–4 digit curriculum, 50% replay | 4500 | 2e-4 | **1d 100% · 2d 10% · 3d 2% · 4d 0%** | — | 2.2% / 1d 40% | **0.000 on all seven sets** |
| **Kaggle T4 GPU**, batch 64, 1–4 digit curriculum | **30000** | 3e-4 | **1d 100% · 2d 100% · 3d 95% · 4d 30%** | — | 2.2% / 1d 40% | **≤0.042 (one set improved)** |

The GPU run is the answer to the width question. At 5 it/s for 100 minutes —
one T4, a 2.1 M-parameter model — held-out difference arithmetic went from
0/0/0/0 to **100/100/95/30% by digit width**, with the deployed skills intact.
Two details matter for reading it honestly:

1. The learning curve is *not* smooth: 2-digit sat at 17% for 3,000 steps and
   then jumped to 92–100% around step 8,000; 3-digit followed the same shape
   ~6,000 steps later; 4-digit was still climbing (12% → 38% band) when the
   cosine schedule ended at 30,000. Longer runs should keep climbing.
2. That first GPU checkpoint was **refused by the promotion gate** all the
   same: it had been trained against the stale replay (the deployed
   generators' 49..999 prices), so published `lookup` collapsed to 61.8% even
   as `diff` scored its first-ever nonzero items (3/33). The gate measured the
   suite, reverted the install, and the run was relaunched against the
   suite-faithful replay — same hyperparameters, fixed data.

The 4,500-step run is the first checkpoint that *learns* and *keeps everything*:
one-digit difference goes 0% → 100% held-out with every deployed skill at its
baseline, and the export is a legal 56-factor-pair artifact. It was still
refused by the promotion gate — the next section — because "kept at 24 held-out
samples per set" is weaker than "kept on the page's own canonical prompts".

What this establishes, with no interpretation:

1. **The host can subtract.** One-digit difference reaches 90% exact in 400
   steps and leaves every deployed skill at its baseline. This is not a tool
   result; it is the model.
2. **Two-digit subtraction is learnable, but slowly.** With the χ=48
   projection on, held-out exactness climbs 12% → 18% → 22% → 30% and finishes
   at 28% after 2,500 steps (12.7× chance), loss falling 0.172 → 0.064.
3. **Projection is not the binding constraint.** The unprojected control at the
   same rate and step count did *worse* (8% at 1,000 steps vs 18% projected).
   So neither the MPO manifold nor the 4.6 MB footprint is what limits the
   number — it is step count and task width.
4. **Name lookup is not the constraint either.** Shortening the names (removing
   all multi-word matching) did not help at 400 steps (5%); removing the borrow
   reached only 10%. The missing piece is arithmetic width.
5. **Catastrophic forgetting is an artefact of the optimiser, not of training.**
   Ten AdamW steps at 3e-4 move *every* parameter by roughly the learning rate
   (Adam normalises the update), which drops the deployed skills to 0.38/0.00;
   replay then restores them (the 2,500-step run ends at 1.00 on all seven).
   A linear warmup removes the shock completely: after 30 warmup steps the
   worst old-skill delta is **0.000**, versus −0.812 cold. The χ=48 projection
   is innocent — the trained matrices stay at 0.99997 rank-48 energy.

## The compute used, and where it runs

The learning question above is a compute question: the probes say the function
is learnable but slow to reach on this machine (4 cores, 8 GiB, no usable
GPU), so the training runs wherever accelerator time exists.

| resource | what runs on it | status |
| --- | --- | --- |
| this Mac, 4 CPU cores | `tools/entangle/train_diff.py` — the *independent replication*: batch 16, 4,500 steps, identical curriculum and gates | `tools/entangle/train-diff.json` |
| **Kaggle** (T4/P100 GPU, 30 h/week quota) | kernel [`svs168/rarext-gpu-diff`](https://www.kaggle.com/code/svs168/rarext-gpu-diff) running `tools/entangle/gpu_train_diff.py` — batch 64, 30,000 steps, projection every 50, same replay and gates; code + starting checkpoint ship in dataset [`svs168/rarext-entangle-train`](https://www.kaggle.com/datasets/svs168/rarext-entangle-train) | CLI-authenticated; CPU probe kernel ran to `COMPLETE` in seconds, but **GPU sessions stay `QUEUED`** — Kaggle gates accelerators behind phone verification, which only the account owner can do |
| **Google Colab** | `tools/entangle/colab-gpu-diff.ipynb` — the same script, one **Run all** click; the notebook clones this repo, so the starting weights are the exact served bytes | needs one user click (see below) |

**Context-axis verdict so far, measured on the GPU.** The context-extension
kernel (`svs168/rarext-gpu-ctx`) ran **10,000 steps** at 2.3–4 it/s (≈72 min of
T4 time) before an OOM at rows ≤ 80, and held-out long-ledger exactness was
**0% at every depth (8, 32, 64, 96 rows) the whole way**, with the page's 14
prompts and every deployed set intact (+0.000). Reading a row out of many
similar rows is a *new attention skill*, not a longer table, and 10k steps ×
batch 6 does not teach it. The context row stays a loss — 192 tokens, honestly
measured — until someone funds a run an order of magnitude longer.
| hosted LLM APIs (Gemini, agnes) | *not used for training* — training gold is computed by code, and an LLM teacher's arithmetic is exactly the thing being measured | named refusal |

The remote runs are the *same loop* as the local one, not a different method:
fresh procedural examples, replay in every batch, SVD projection back onto the
χ=48 manifold, per-width held-out scoring, and the old-skill regression gate.
A returned checkpoint goes through `tools/entangle/export_from_ckpt.py` (which
projects once more, so the artifact is exactly on the manifold) and then
`scripts/promote-entangled.mjs`, which installs nothing unless the shipped
engine loads the bytes as 56 factor pairs at context 192 and the in-page skill
self-test is 14/14.

**Why Colab is a click, not a command.** Colab is a browser notebook product;
its headless path is Colab Enterprise, which needs `gcloud` credentials and a
GCP project — this machine has neither (`gcloud: absent`,
`GOOGLE_APPLICATION_CREDENTIALS: absent`; only `GOOGLE_API_KEY`, an LLM key,
exists). So the notebook is committed and ready: open
[colab-gpu-diff.ipynb](../tools/entangle/colab-gpu-diff.ipynb), set the runtime
to T4, press Run all, and hand back `gpu-refined-diff.pt` + `gpu-train.json`.
Kaggle is the same Google resource and *is* driven headlessly by the CLI, so it
carries the automated run.

## The GPU checkpoint that finally shipped, and the repair that made it legal

The suite-faithful GPU run (v13, 30,000 steps, batch 64) reached held-out diff
**100/100/92/50%** by width — but its checkpoint eroded the deployed skills
broadly (S0 0.75, S1t 0.75 on seed-99 sets; the page's S2t answered `$422` vs
the pinned `$432`), so the gate refused it. The fix that shipped is a
**targeted repair**, not a retrain:

* `tools/entangle/repair_page.py` — 400 steps at lr 5e-5 from the GPU
  checkpoint, batch = ½ page prompts + ⅓ published-grammar replay + remainder
  fresh diff, χ=48 projection every 10 steps;
* the promotion gate was tightened to **per-family floors** — a candidate may
  not buy one family by selling another (this is what made the trade visible:
  the repaired candidate *improved* priciest to 32/33 while adding diff).

Shipped: **104/200** (`8cbd6f5acb6f30dc…`) — lookup 34/34, cheapest 34/34,
priciest 32/33, **diff 4/33 (12.1%, first nonzero)**, total 0/33, pct 0/33.
Refused on the way: the raw v13 checkpoint (13/14 page) and a first repair
pass (its own diff guard tripped — both reverted by `git checkout`).

## What shipped

After four refused candidates (92, 82, 95, 83 of 200 — every one caught by the
gates and reverted), the first **model-only** promotion shipped on
2026-11-24, commit `eefce0e`, live weights digest `c54a8a6811013b29…`:

```console
$ node tools/rank/eval-neural.mjs --n 200 --seed 20261123
neural model alone — 97/200 exact (48.5%)
  lookup    34/34  100.0%   (was 97.1%)
  cheapest  34/34  100.0%   (was 94.1%)
  priciest  29/33   87.9%   (was 90.9%)
  diff       0/33    0.0%   (4-digit wall — the GPU run below is the lever)
```

The gain came from replay alignment, not from a bigger model: the same
2,132,224-parameter χ=48 rebuild, trained 4,500 steps on CPU against the
published grammar. `publish-futuristic-proof.mjs`'s curated mirror list was
also fixed to carry `rank.html`/`rank.json` — every previous ship had been
wiping them from `/mirror/`.

## Promotion gates for any checkpoint

The gate exists because "no regression on 24 held-out samples per set" is not
the same as "no regression on the page". Measured example, 2026-11-24: the
4,500-step checkpoint above passed every set gate (worst old delta **0.000**)
and was still refused by `scripts/promote-entangled.mjs` — the in-page skill
self-test came back **13/14**, with `S2t priciest of 3, mixed` answering
`$552 delivered.` where the page pins `$432 delivered.`. The installer restored
every file byte-for-byte and shipped nothing. The fix is not a weaker gate: the
page's 14 canonical prompts are now extracted verbatim into
`tools/entangle/page-skills.json`, **anchored in every training batch**, and
added to the eligibility check of all three trainers.

A checkpoint is promoted to `apps/web/public/rarext-entangled-chi48.gguf` only
if all of these hold, measured by `tools/rank/eval-neural.mjs` afterwards:

* the page's 14 canonical skill prompts answer **14/14** on the candidate
  (the gate that refused the 2026-11-24 checkpoint);
* the **published suite itself does not regress** — `eval-neural.mjs --n 200`
  runs inside `promote-entangled.mjs` and the install reverts on any drop.
  This gate has caught two bad checkpoints that every set-based gate passed:

  1. the 4,500-step run scored **92/200 (46.0%)** vs the shipped 96/200 —
     `cheapest` fell 94.1% → 85.3% — while `diff` stayed 0/33 (all published
     diff items have a 4-digit operand);
  2. the "procedural replay" fix scored **82/200 (41.0%)** — published `lookup`
     collapsed 97.1% → 58.8% — because the replay generators it drew from
     sample prices from **49..999** (`task.make_price`), never the published
     5..9999 range, so four hours of training slowly forgot how to read a
     4-digit price.

  The final replay fix is structural: `suite_example()` generates lookup /
  cheapest / priciest examples **from the published grammar itself**
  (`tools/rank/gen-tasks.mjs`: prices uniform on 5..9999, 2–3 word names with
  the same case styling), every step. Reverted by `git checkout` both times;
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
