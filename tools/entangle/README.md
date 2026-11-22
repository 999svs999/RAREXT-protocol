# tools/entangle — rebuilding RAREXT AI from its entanglement spectrum

Read `docs/quantum-entanglement-rebuild.md` first. Short version:

**Entanglement is a correlation resource, not a computer.** `bell_demo.py`
measures CHSH = 2√2 (real correlations) and Bob's marginal at exactly 0.5 for
every axis Alice might choose (no signalling). A quantum effect cannot carry
the model's weights or speed up its decode, so "use entanglement to rebuild"
can only mean what tensor-network theory means by it: **rebuild the model from
its Schmidt decomposition**, with bond dimension χ as the entanglement budget.

## Reproduce

```bash
PY=python3.11                     # torch 2.2.x + numpy<2
$PY tools/entangle/bell_demo.py                  # what entanglement can/can't do
$PY tools/entangle/entanglement_spectrum.py      # spectra of the served checkpoint
$PY tools/entangle/rebuild_mps.py                # plain truncation vs KL/skills
$PY tools/entangle/refine_rebuild.py             # projected (DMRG-style) refinement
$PY tools/entangle/parity.py --chi 48            # 5 seeds, export, engine check
$PY tools/entangle/factor_export.py --chi 48     # dense + MPO GGUF from one state
$PY tools/entangle/compare_answers.py            # 280 prompts, both artifacts
$PY tools/entangle/verify_engine_skills.py tools/entangle/entangled-factored.gguf
```

`parity.py` takes ~15 min on 8 CPU cores; `compare_answers.py` ~5 min.

## Results (measured, not estimated)

| what | number |
|---|---|
| CHSH / no-signalling | 2.828427125 / max &#124;marginal−0.5&#124; = 1.11e-16 |
| χ for 99% of squared weight, per matrix | 16–117 (dense dim 128) |
| rebuild at χ=48, 5 held-out seeds | 1174/1200 vs dense 1176/1200 |
| both hard 3-row sets (120 samples each) | S1t 109/120 = 109/120, S2t 116/120 = 116/120 |
| factored GGUF | 4,673,760 B vs 8,537,568 B (54.7%) |
| decode | 442 ms vs 644 ms per answer; 16 vs 24 ms/token |
| answers through `rarext-gguf-engine.js` | identical 280/280 |

The rebuilt, factored artifact is `entangled-factored.gguf`; its trainable
weights are `refined-chi48.pt`. The engine serves it with no new format: a
`X.a` / `X.b` tensor pair replaces `X.weight`, and the dense path is unchanged
when no pair is present (`apps/runtime/test/web4.test.ts` holds both).

It is **not** promoted to serving: the evolution gate's 0.02 tolerance is
finer than one sample in a 24-sample set (0.042), so the gate refuses it. The
artifact and the engine capability ship; promotion is an operator decision.

Scratch files (`_*.json`, regenerable dense exports) are git-ignored.
