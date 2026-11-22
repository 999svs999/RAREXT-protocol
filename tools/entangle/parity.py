"""Parity test: is the low-entanglement rebuild statistically the same host?

One held-out sample in a 24-sample set is 4.2%, larger than the evolution
gate's 0.02 tolerance, so a single seed cannot distinguish "one unlucky
comparison" from "a lost skill". This evaluates the dense model and the
refined rebuild on five independent held-out seeds (120 samples on the hard
3-row sets) and reports Wilson 95% intervals plus the paired difference.

Run:  python3 tools/entangle/parity.py --chi 48
"""

import argparse
import json
import math
import sys
from pathlib import Path

import torch

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "models/live-host-lm"))
sys.path.insert(0, str(REPO / "agents/self-evolve"))

from train import TinyLM, VOCAB  # noqa: E402
import task  # noqa: E402
from model import batched_generate  # noqa: E402
from refine_rebuild import (  # noqa: E402
    CKPT, build, projected, projected_refine, export_gguf, engine_check,
)

SEEDS = [4242, 777, 1234, 2024, 31337]


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, max(0.0, c - h), min(1.0, c + h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--steps", type=int, default=320)
    args = ap.parse_args()

    ck = torch.load(CKPT, map_location="cpu")
    cfg, state = ck["config"], ck["state"]
    dense = build(state, cfg)

    print(f"refining χ={args.chi} ({args.steps} projected steps) …", flush=True)
    refined = projected_refine(state, cfg, args.chi, steps=args.steps, report_every=0)
    rstate = {k: v.clone() for k, v in refined.state_dict().items()}

    skills = list(task.eval_sets(SEEDS[0]).keys())
    counts = {s: {"dense": 0, "rebuild": 0, "n": 0} for s in skills}
    for seed in SEEDS:
        sets = task.eval_sets(seed)
        for skill in skills:
            samples = sets[skill]
            for label, model in (("dense", dense), ("rebuild", build(rstate, cfg))):
                outs = batched_generate(model, [p for p, _ in samples], max_new=48,
                                        temperature=0.0)
                hits = sum(task.exact_match(p, a) for (p, _), a in zip(samples, outs))
                counts[skill][label] += hits
            counts[skill]["n"] += len(samples)
        print(f"  seed {seed} done", flush=True)

    print(f"\nparity over {len(SEEDS)} held-out seeds ({counts['S0 price-copy']['n']} S0 "
          f"samples, {counts['S1t cheapest-3row-mixed']['n']} per hard set)\n")
    print(f"  {'skill':28s} {'dense':>12s} {'rebuild':>12s}   Δ (95% CI, paired)")
    worst = None
    for skill, c in counts.items():
        pd, lo_d, hi_d = wilson(c["dense"], c["n"])
        pr, lo_r, hi_r = wilson(c["rebuild"], c["n"])
        diff = pr - pd
        se = math.sqrt(max(pd * (1 - pd), 0) / c["n"] + max(pr * (1 - pr), 0) / c["n"])
        lo, hi = diff - 1.96 * se, diff + 1.96 * se
        print(f"  {skill:28s} {c['dense']:>3d}/{c['n']:<3d} {pd:>7.1%} "
              f"{c['rebuild']:>3d}/{c['n']:<3d} {pr:>7.1%}   {diff:+.3f} [{lo:+.3f}, {hi:+.3f}]")
        if worst is None or diff < worst[1]:
            worst = (skill, diff, lo, hi)
    print(f"\n  largest deficit: {worst[0]} {worst[1]:+.3f} "
          f"(95% CI {worst[2]:+.3f} … {worst[3]:+.3f})")
    print("  a CI that contains 0 means this test cannot distinguish the rebuild "
          "from the dense host.")

    out = HERE / f"entangled-parity-chi{args.chi}.gguf"
    export_gguf(build(rstate, cfg), out, cfg, cfg["ctx"])
    sets = task.eval_sets(SEEDS[0])
    probe = []
    for skill, samples in sets.items():
        for p, _ in samples[:3]:
            probe.append((p, batched_generate(build(rstate, cfg), [p], max_new=48,
                                              temperature=0.0)[0]))
    ex, text = engine_check(out, probe)
    print(f"\nexported {out.relative_to(REPO)} ({out.stat().st_size:,} bytes)")
    print(f"engine faithfulness {ex:.2%} over {len(probe)} prompts\n")
    print("\n".join("  " + l for l in text.splitlines()
                    if l.startswith(("MISS", "exact match"))))
    (HERE / f"parity-chi{args.chi}.json").write_text(json.dumps(
        {"chi": args.chi, "steps": args.steps, "seeds": SEEDS,
         "counts": counts, "engine_exact": ex}, indent=1))


if __name__ == "__main__":
    main()
