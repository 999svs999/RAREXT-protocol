# HANDOFF — for any AI agent continuing this work

Updated: 2026-11-24. Read this file top to bottom before touching anything.
Every claim below is a command you can run; run them and compare output before
you trust them.

## The objective, and the two rules that bound every previous agent

Objective: **make RAREXT AI exceed all current top-100 AI.** Two rules the work
has kept, and you must keep too:

1. **No redefining "best".** The published scorecard (`docs/TOP-100.md`,
   live `/mirror/rank.json`) states 8 axes won / 1 tied / 3 lost — context
   (192 tokens), multimodal input, open-ended reasoning are named losses *on
   the same page as the wins*. Do not drop, reword or re-axis them. Either a
   loss axis closes by making the model better, or the user explicitly
   confirms the axis-scoped definition. The user has not confirmed it yet.
2. **Every claim needs a command.** If you cannot hand a reviewer a command
   whose output shows the thing, it does not go in a doc, a page, or a commit
   message.

## State that is SHIPPED and live (verified 2026-11-24)

| artifact | value | verify |
| --- | --- | --- |
| deployed weights | `c54a8a6811013b2961c3e49e28a842fe91de8a916e695545dec5ca4936df87c4` | `curl -s https://999svs999.github.io/RAREXT-protocol/mirror/rarext-entangled-chi48.gguf \| shasum -a 256` |
| page pin | same digest, in served `entangled.js` | `curl -s …/mirror/entangled.js \| grep -o '"[0-9a-f]\{64\}"'` |
| published neural score | **97/200** — lookup 34/34, cheapest 34/34, priciest 29/33, diff 0/33, total 0/33, pct 0/33 | `node tools/rank/eval-neural.mjs --n 200 --seed 20261123` |
| scorecard | 8 won / 1 tied / 3 lost | `curl -s …/mirror/rank.json \| python3 -m json.tool \| head -40` |
| gates | `test:runtime` 197/197 · `claim:check` 8 mismatches (baseline 9) · `tools/rank/verify.mjs` PASS | `npm run test:runtime && npm run claim:check && node tools/rank/verify.mjs` |
| demo | 40/40, ALL PHASES PASS | `node scripts/demo-rarext-ai.mjs` |

The 97/200 is a **model-only** improvement (replay alignment during projected
training; same 2,132,224-parameter χ=48 rebuild). The full measured record,
including four refused candidates (92, 82, 95, 83 of 200) and why each was
refused, is `docs/MODEL-LEARNING.md`.

## The one thing to continue FIRST: GPU run v7

Kaggle kernel `svs168/rarext-gpu-diff` **version 7** was pushed with the fixed
replay (published grammar, prices 5..9999) and 30,000 steps at batch 64. v6
(the same size run, stale replay) proved the width result:

```
held-out diff by width: 1d 100% · 2d 100% · 3d 95% · 4d 30%   (was 0/0/0/0)
```

v7 is expected to keep that *and* hold the published lookup/cheapest families
(v6's replay collapsed lookup to 61.8% — the promotion gate refused it, which
is correct behaviour). When it finishes:

```console
# 1. fetch the output (the log's stdout prints the full per-500-step curve)
export PATH="$PATH:/Users/r/Library/Python/3.14/bin"
kaggle kernels output svs168/rarext-gpu-diff -p /tmp/v7
# 2. export to the shipped artifact shape (χ=48, 56 factor pairs)
/private/var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/opencode/lmenv/bin/python \
  tools/entangle/export_from_ckpt.py --ckpt /tmp/v7/gpu-refined-diff.pt \
  --out tools/entangle/entangled-chi48-diff-gpu.gguf
# 3. the gate: installs, verifies 14/14 page skills, scores the published suite,
#    and REVERTS EVERYTHING unless the suite does not regress
node scripts/promote-entangled.mjs --candidate tools/entangle/entangled-chi48-diff-gpu.gguf
# 4. only if it says "promoted": regenerate + gate + ship
node tools/rank/scorecard.mjs && node tools/rank/verify.mjs
npm run test:runtime && npm run claim:check
node scripts/deploy-site.mjs && node scripts/ship-registry.mjs
```

Promotion rule (do not weaken it): **the published 200-task number must not
regress, and the page's 14 canonical prompts must stay 14/14.** The gate runs
both checks itself and restores every file byte-for-byte on failure. If diff
becomes nonzero while lookup holds, the scorecard's accuracy tie becomes a
model-level win on exactness — regenerate `docs/TOP-100.md` via
`node tools/rank/scorecard.mjs`, never by hand.

## Resources already set up for you

| resource | where | notes |
| --- | --- | --- |
| Kaggle | dataset `svs168/rarext-entangle-train` (all trainer code + starting checkpoint), kernels `svs168/rarext-gpu-diff`, `svs168/rarext-gpu-ctx` | CLI authenticated via `~/.kaggle/access_token` (user `svs168`); 2 concurrent GPU sessions max; kernel failures are visible in the downloaded log — ALWAYS read it, five bugs were root-caused that way |
| Colab | `tools/entangle/colab-gpu-diff.ipynb` | needs a human click (no gcloud creds on the box) |
| local python | `/private/var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/opencode/lmenv/bin/python` (torch 2.2.2) | `~/.local/bin/python3.11` has NO torch |
| hosted evals | `tools/rank/eval-hosted.mjs` (`agnes-3.0-pro` 100/100 semantic, 0/100 exact), `tools/rank/eval-gemini.mjs` (rate-limited) | keys in `~/.hermes/.env` |

## Measured negatives — do not quietly retry them

* **Context extension**: 10,000 GPU steps at batch 6 (ctx 4096, k-row ledgers up
  to 96 rows) → **0% held-out at every row depth**, old skills intact. Reading
  a row among many similar rows is a new attention skill; 10k steps do not
  teach it. A retry needs an order of magnitude more steps or a different
  task decomposition. The scorer is `tools/rank/eval-ctx.mjs`.
* **4-digit arithmetic at CPU scale**: 4,500–12,000 steps × batch 16 never
  exceeded 0% on width 4 (all published diff/total/pct items contain a 4-digit
  operand). The GPU run is the only demonstrated lever.
* **Replay distribution traps**: `task.make_price` samples 49..999, but the
  published suite samples 5..9999 — replaying the former collapsed published
  lookup to 61.8% (v4/GPU-v6). Replay MUST go through `suite_example()` in
  `tools/entangle/train_diff.py`.

## Hard-won mechanics (each cost a failed run)

* **Kaggle kernel code**: the current working form is a kernel script with the
  trainer INLINED and a header that globs for every import dir
  (`gpu_train_diff.py`, `train.py`, `task.py`, `model.py`, `teach_ledger.py`,
  `gguf.py`, `factor_export.py`, `refined-chi48.pt`) and aborts if any is
  missing. Trust nothing else: v7 never scheduled; v8/v9 mounted a stale
  dataset snapshot and silently reproduced v6 (trajectories byte-identical —
  compare logs, not statuses); v11 inlined the trainer but lost
  `models/live-host-lm` from `sys.path` because the inlined file derives REPO
  from `__file__`. Also: a code fix can be present as a *definition* and still
  never run — v6/v8/v9 defined `suite_example` while the loop still called the
  49..999 generators. Verify the CALL SITE, and verify a new run by comparing
  trajectory logs, never by the kernel's status field.
* **Kaggle dataset mounts can be stale**: a version still "being created" at
  session start mounts the previous snapshot. After bumping a dataset, wait
  for processing to finish before pushing/starting a kernel, and confirm what
  actually mounted (the v12 header prints each file it found).

* Answers must be trained with the EOS-aware `batch_loss` — `answer_logprobs`
  excludes EOS and the model rambles forever.
* Cold AdamW at 3e-4 wrecks the deployed skills in ~10 steps (normalised steps
  move every parameter ~lr); 300-step warmup + 50% early replay fixes it
  (worst old delta 0.000).
* `scripts/promote-entangled.mjs` is the only way weights ship. It refuses on:
  digest/56-factors/ctx mismatch, any of the 14 page prompts failing, or any
  published-suite regression — and it restores every file on refusal.
* The curated mirror list lives in `scripts/publish-futuristic-proof.mjs`
  (`mirrorFiles`); a file missing there is wiped from `/mirror/` on every ship
  (this is how rank.html/rank.json went 404 once — fixed, keep it fixed).
* `deploy-site.mjs` refuses a dirty tree; ships auto-commit site artifacts.
* The published suite grammar is `tools/rank/gen-tasks.mjs` — change nothing
  there without regenerating every scorecard number.

## Where the honesty boundaries are

Diff/total/pct on the published suite are still 0% model-alone (4-digit wall).
Total and pct have never been trained at all. Multimodal and open-ended
reasoning are not closable at 2.1M parameters — say so; the scorecard already
does. The remaining user decision: whether "best" stays axis-scoped or an
accepted composite. Until the user answers, keep both truths on one page.
