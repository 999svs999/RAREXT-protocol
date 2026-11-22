"""Dense vs MPO-factored GGUF through RAREXT's engine: answers, bytes, speed.

Run:  python3 tools/entangle/compare_answers.py
"""

import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "agents/self-evolve"))
import task  # noqa: E402


def run(path, prompts):
    pf = HERE / "_compare-prompts.json"
    pf.write_text(json.dumps([{"prompt": p} for p in prompts]))
    t0 = time.time()
    r = subprocess.run(["node", str(REPO / "models/live-host-lm/engine_check.mjs"),
                        str(path), str(pf)], capture_output=True, text=True, timeout=7200)
    took = time.time() - t0
    got = [l.split("got  ", 1)[1].split("   (", 1)[0]
           for l in r.stdout.splitlines() if l.strip().startswith("got  ")]
    return got, took, r.stdout


def main():
    sets = task.eval_sets(4242)
    prompts = [p for samples in sets.values() for p, _ in samples]
    dense = HERE / "entangled-dense.gguf"
    fac = HERE / "entangled-factored.gguf"
    print(f"{len(prompts)} held-out prompts, greedy decode, same engine\n")
    res = {}
    for label, path in (("dense", dense), ("factored", fac)):
        got, took, _ = run(path, prompts)
        res[label] = got
        print(f"  {label:8s} {path.stat().st_size:>10,} bytes  {len(got):>3d} answers  "
              f"{took:>6.1f}s  {took/len(got)*1000:>5.0f} ms/prompt  "
              f"{took/len(prompts)/27*1000:.0f} ms/token")
    same = sum(1 for a, b in zip(res["dense"], res["factored"]) if a == b)
    diffs = [(prompts[i], res["dense"][i], res["factored"][i])
             for i in range(min(len(res["dense"]), len(res["factored"])))
             if res["dense"][i] != res["factored"][i]]
    print(f"\n  identical answers {same}/{len(prompts)} ({100*same/len(prompts):.2f}%)")
    for p, a, b in diffs[:6]:
        print(f"    {p.splitlines()[-2]}\n      dense {a!r}\n      fact  {b!r}")
    print(f"\n  bytes  {fac.stat().st_size/dense.stat().st_size:.1%} of dense")
    (HERE / "compare.json").write_text(json.dumps({
        "prompts": len(prompts), "identical": same, "diffs": len(diffs),
        "dense_bytes": dense.stat().st_size, "factored_bytes": fac.stat().st_size,
    }, indent=1))


if __name__ == "__main__":
    main()
