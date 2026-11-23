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
  This gate exists because of the same day's second lesson: the 4,500-step
  checkpoint passed every set gate *and* the 14 page prompts, and still scored
  **92/200 (46.0%)** vs the shipped 96/200 (48.0%) — `cheapest` fell
  94.1% → 85.3% — while `diff` stayed 0/33 because every published diff item
  has a 4-digit operand. Training was reverted by `git checkout`, and the
  replay was rebuilt: lookup/compare examples are now generated **fresh from
  the deployed trainers' own generators every step** (`task.s0_example`,
  `task.comp_example`), so the published distribution is anchored, not a fixed
  24-sample stand-in;
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
