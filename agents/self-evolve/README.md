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

## The lesson in the ledger (v1 → v2)

v1 taught a *new answer surface form* ("The cheapest is $X (item).") from 300
verified seeds. Sampling found the new form ~30% of the time, but the policy's
greedy mode never left the deployed template — a 1.3M-byte model memorises
demonstrations without generalising a template switch, and serving reads the
mode. The gate refused every generation; nothing was promoted (the refusal is
the system working).

v2 dissolves the conflict: comparison answers reuse the deployed template
("The price is $X delivered."), so the only thing left to learn is the actual
skill — WHICH row's price to copy (min or max, conditioned on the question).
The policy's own behaviour then provides reward from rollout #1, and a
curriculum (2-row comparisons first, 3 rows once a generation promotes) keeps
the choice learnable. The teacher's seeds remain banked for the named-template
skill track.

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
