"""Score a rebuilt GGUF through RAREXT's own engine, per held-out skill.

This is the end-to-end proof: not the trainer's torch model, but the actual
artifact an operator would serve, decoded by `rarext-gguf-engine.js`, scored by
the same computed checker the evolution gate uses.

Run:  python3 tools/entangle/verify_engine_skills.py <model.gguf> [seed]
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "agents/self-evolve"))

import task  # noqa: E402

ENGINE_CHECK = REPO / "models/live-host-lm/engine_check.mjs"


def main():
    model = Path(sys.argv[1])
    if not model.is_absolute():
        model = (REPO / model).resolve()
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 4242
    sets = task.eval_sets(seed)

    print(f"model   {model.relative_to(REPO)}  ({model.stat().st_size:,} bytes)")
    print(f"engine  apps/runtime/engines/rarext-gguf-engine.js   seed {seed}\n")
    total_ok = total_n = 0
    rows = {}
    for skill, samples in sets.items():
        pf = HERE / "_verify-prompts.json"
        pf.write_text(json.dumps([{"prompt": p, "want": a} for p, a in samples]))
        r = subprocess.run(["node", str(ENGINE_CHECK), str(model), str(pf)],
                           capture_output=True, text=True, timeout=3600)
        ok = sum(1 for l in r.stdout.splitlines() if l.startswith("ok  "))
        miss = sum(1 for l in r.stdout.splitlines() if l.startswith("MISS"))
        n = ok + miss
        rows[skill] = {"ok": ok, "n": n, "pct": ok / n if n else 0.0}
        total_ok += ok
        total_n += n
        print(f"  {skill:28s} {ok:>3d}/{n:<3d}  {100*ok/n:5.1f}%")
        if miss:
            for line in r.stdout.splitlines():
                if line.startswith("MISS"):
                    idx = r.stdout.splitlines().index(line)
                    got = r.stdout.splitlines()[idx + 1:idx + 3]
                    print("     " + line.strip())
                    for g in got:
                        print("     " + g.strip())
    print(f"\n  {'ALL SKILLS':28s} {total_ok:>3d}/{total_n:<3d}  {100*total_ok/total_n:5.1f}%")
    (HERE / f"engine-skills-{seed}.json").write_text(json.dumps(
        {"model": str(model), "seed": seed, "rows": rows}, indent=1))


if __name__ == "__main__":
    main()
