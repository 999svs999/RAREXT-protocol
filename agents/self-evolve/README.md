# The self-evolving agent

An agent that makes itself better on a fixed loop, forever:

```
ROLLOUT   sample k answers per prompt from the current policy (batched,
          left-padded — proven token-identical to per-prompt generation)
REWARD    score every rollout with computed checkers (task.py) — code, not a
          judge model, so the reward cannot be talked into a yes
UPDATE    REINFORCE with per-prompt baseline + self-imitation of the best
          verified rollout (best-of-k; partial credit counts)
EVALUATE  held-out sets per skill, same checkers, greedy decode (the mode is
          what serving reads)
VERIFY    the candidate GGUF must reproduce the trainer's answers through the
          REAL RAREXT engine (models/live-host-lm/engine_check.mjs) before it
          may serve
PROMOTE   only if the deployed skill holds and a new skill improves without
          any skill regressing: atomic swap into the serving path + ledger
          entry. Otherwise revert and keep training.
```

`evolve.py --generations 0` runs the loop with no endpoint. Every generation —
promoted or reverted — is a line in `generations/generations.jsonl` with scores,
digests and wall time, so "self-evolving" is an inspectable ledger, not a claim.

## Where NVIDIA is in the loop

NVIDIA's free NIM tier (`integrate.api.nvidia.com`, key from the operator env)
is the **teacher**: `teacher.py` asks `nvidia/nemotron-3-ultra-550b-a55b` (the
flagship; `nvidia/nemotron-3.5-lightning-30b-a3b` takes over on repeated
failures — measured, not assumed) to PROPOSE demonstrations of a skill the
policy cannot bootstrap by exploration alone. Nothing a model says enters
training until `task.reward()` accepts it — the teacher proposes, code disposes.
`teacher-seeds.json` records which model labeled every accepted example.

383 demonstrations were accepted this way (212 ultra-550B, 88 lightning-30B in
the current file; 80 more in `teacher-seeds-v1.json`).

## The lesson in the ledger (v1 → v2 → v3)

**v1 — new surface form from teacher seeds.** 300 checker-verified NVIDIA
demonstrations taught "The cheapest is $X (item)." Sampling found the new form
~30% of the time, but the policy's greedy mode never left the deployed template
— a 1.3M-byte model memorises demonstrations without generalising a template
switch, and serving reads the mode. The gate refused every generation.

**v2 — shared template, pure RL.** Comparison answers reused the deployed
template ("The price is $X delivered."), so the only skill left to learn was
WHICH row's price to copy. Two generations promoted (S1 0→38%, S2 0→38%
greedy), then three more plateaued exactly there: REINFORCE, self-imitation and
DAgger corrections moved the SAMPLED policy (rollout exact up to 81%) but never
the argmax — the mode stayed "copy row 1". The comparison circuit did not exist
in the policy, and gradient nudges could not build it.

**v3 — the base learns the circuit; the loop owns it.** `train_v2.py` trains a
fresh base on all three skills as supervised gold from step 1 (gold answers are
computed by the same checker that gates promotion), with one inductive choice
that makes comparison learnable at 1.3M parameters: every row in an example
shares a digit length, so min/max is a fixed-length lexicographic comparison
rather than digit-aligned reasoning over mixed lengths. Result, held-out,
greedy: **S0 100%, S1 98.8%, S2 97.5%** in 6000 steps (~2 h). The RL loop then
resumed ON TOP of this base (`--base base-v2.pt --fresh`): rollouts sample at
0.35 — near the serving regime — and the first promoted generation holds
S0 100% / S1 100% / S2 98% with 100% engine faithfulness. Rollouts at the
ceiling score mean reward 1.000 with DAgger finding zero fixes; the loop keeps
running to hold that line and catch regressions.

Division of labor, stated plainly: supervised training builds circuits; the
relentless RL loop polishes, hardens, verifies through the real engine, and
ratchets the serving path forward — refusing anything that would trade a
deployed skill for a new one.

## Files

```
task.py      skills, prompt shapes, computed rewards, held-out sets
teacher.py   NVIDIA NIM client: propose -> normalize -> verify -> record
model.py     batched left-padded generation + answer log-probs (grad-enabled)
evolve.py    the loop: bootcamp (when seeds are usable), RL, eval, gate, ledger
generations/ gen-NNN.pt/.gguf checkpoints + generations.jsonl
```

## Run

```bash
python3.11 evolve.py --generations 0 --iters 200   # relentless
python3.11 teacher.py 150                          # harvest more seeds
```
