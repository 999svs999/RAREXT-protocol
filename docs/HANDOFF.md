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

## State that is SHIPPED and live (verified 2026-11-26)

| artifact | value | verify |
| --- | --- | --- |
| deployed weights | `8cbd6f5acb6f30dc1ca77782e01461cfddbe034a4a9f58bcd2482f091f880825` | `curl -s https://999svs999.github.io/RAREXT-protocol/mirror/rarext-entangled-chi48.gguf \| shasum -a 256` |
| page pin | same digest, in served `entangled.js` | `curl -s …/mirror/entangled.js \| grep -o '"[0-9a-f]\{64\}"'` |
| published neural score | **104/200** — lookup 34/34, cheapest 34/34, priciest 32/33, **diff 4/33**, total 0/33, pct 0/33 | `node tools/rank/eval-neural.mjs --n 200 --seed 20261123` |
| live head-to-head | 24/24 exact vs `agnes-3.0-pro` 0/24, semantic 24/24 both; model alone 12/24 | `node tools/rank/eval-head-to-head.mjs --n 24 --seed 20261127` |
| scorecard | 8 won / 1 tied / 3 lost | `curl -s …/mirror/rank.json \| python3 -m json.tool \| head -40` |
| gates | `test:runtime` 197/197 · `claim:check` 8 mismatches (baseline 9) · `tools/rank/verify.mjs` PASS | `npm run test:runtime && npm run claim:check && node tools/rank/verify.mjs` |
| demo | eight phases, ALL PHASES PASS (re-scores the shipped bytes on every run) | `node scripts/demo-rarext-ai.mjs` |

The 104/200 is a **model-only** improvement (same 2,132,224-parameter χ=48
rebuild). It came from GPU run v13 (30k steps, batch 64, replay finally drawn
from the published grammar) plus a 400-step page-anchored repair; the promotion
gate is now per-family, so a candidate cannot buy diff by selling lookup. Full
record and every refused candidate: `docs/MODEL-LEARNING.md`.

## The next lever (v14 in flight)

v14 (total:0.55 diff:0.30 pct:0.15) genuinely taught total/pct — held-out
total 0→7.5%, pct 0→2.5% — but the published suite fell 104→100 and **33
engine-gated repair candidates across 5 campaigns all failed the per-family
floor**: every state that gains total loses ≥1 `cheapest` item after export
(mixed digit-length interference: `$20` vs `$210` → `$200`/`$201`; torch and
engine fail identically). Full record: `docs/MODEL-LEARNING.md`. v15 (running
2026-11-27) is the untested design: protective replay 0.40 DURING the run
(`total:0.30 diff:0.25 pct:0.05`). If v15 fails the gate too, total/pct at
χ=48 is a capacity wall — like context 192 — and the user must either fund a
bigger model or confirm the axis-scoped definition of "best". Do not retry
post-hoc low-LR repair or gentle local training; both are measured negatives.

* **Diff is nonzero but weak**: 4/33 published (held-out by width after v13:
  1d 100% · 2d 100% · 3d 92% · 4d 50%, then the repair moved the deployed
  published number to 4/33). More steps or a curriculum that holds width-4
  longer is the lever; always re-run `tools/rank/eval-neural.mjs`, then
  `scripts/promote-entangled.mjs`.
* **Total and pct have never been trained** — 0/33 each. They are the largest
  remaining numeric families.
* **Context extension is a measured negative** — 10k GPU steps produced 0% at
  every ledger depth; do not retry it without a new decomposition.
* Restoring the handoff after any change: `node tools/rank/scorecard.mjs` then
  `node tools/rank/verify.mjs`; never edit `docs/TOP-100.md` by hand.

Promotion rule (do not weaken it): **the published 200-task number must not
regress, no family may regress, and the page's 14 canonical prompts must stay
14/14.** The gate runs all three checks itself and restores every file
byte-for-byte on failure.

## Resources already set up for you

| resource | where | notes |
| --- | --- | --- |
| Kaggle | dataset `svs168/rarext-entangle-train` (all trainer code + starting checkpoint), kernels `svs168/rarext-gpu-diff`, `svs168/rarext-gpu-ctx` | CLI authenticated via `~/.kaggle/access_token` (user `svs168`); 2 concurrent GPU sessions max; kernel failures are visible in the downloaded log — ALWAYS read it, five bugs were root-caused that way |
| Colab | `tools/entangle/colab-gpu-diff.ipynb` | needs a human click (no gcloud creds on the box) |
| local python | `/private/var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/opencode/lmenv/bin/python` (torch 2.2.2) | `~/.local/bin/python3.11` has NO torch |
| hosted evals | `tools/rank/eval-hosted.mjs` (`agnes-3.0-pro` 100/100 semantic, 0/100 exact), `tools/rank/eval-head-to-head.mjs` (fresh tasks, all three answer paths), `tools/rank/eval-gemini.mjs` (rate-limited) | keys in `~/.hermes/.env` |

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
* **Inlined code changes `__file__`**: `HERE` becomes `/kaggle/src`, so
  `page_skills()` silently returned `[]` in v13 — the 14 canonical prompts
  were *not* anchored during that run, which is why its raw checkpoint flipped
  S2t and needed a repair. The lookup now searches `sys.path` and the log
  prints `page anchor: 14 prompt(s)`; treat any other number as a failed run.
  The same trap applies to any future dataset-relative file read.
* **Smoke-test the exact kernel code path locally before pushing** — three
  GPU sessions were lost to errors a 3-step CPU run would have caught
  (`suite_example` referencing an unimported `WORDS`; a missing module; a
  device mismatch). `gpu_train_diff.py --steps 3 --device cpu` runs the whole
  path in under a minute.
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
* The curated mirror list lives in BOTH publishers — `scripts/publish-proof.mjs`
  (the one the claim gate parses) and `scripts/publish-futuristic-proof.mjs`
  (`mirrorFiles`). A file missing from either is wiped from `/mirror/` on the
  next ship (this is how rank.html/rank.json went 404 once — fixed, keep it
  fixed; `head-to-head.json` was added to both).
* `deploy-site.mjs` refuses a dirty tree; ships auto-commit site artifacts.
* The published suite grammar is `tools/rank/gen-tasks.mjs` — change nothing
  there without regenerating every scorecard number.

## Where the honesty boundaries are

Diff is now 4/33 model-alone; total and pct are still 0/33 (4-digit wall) and
have never been trained at all. Multimodal and open-ended
reasoning are not closable at 2.1M parameters — say so; the scorecard already
does. The remaining user decision: whether "best" stays axis-scoped or an
accepted composite. Until the user answers, keep both truths on one page.
