"""Partial-credit analysis of a trained checkpoint on held-out diff prompts.

Exact-match is deliberately unforgiving: `$6336 more` and `$6337 more` both
score zero. For 4-digit subtraction that hides whether the model learned any
column arithmetic, so this reports, on held-out prompts the checkpoint never
trained on:

    exact            byte-identical answer
    value            same number, any formatting
    rightmost-k      the k least-significant digits of the answer are correct
                     (k = 0..len) — a borrow algorithm shows up here first
    mean |error|     absolute difference between predicted and gold value
    constant-guess   accuracy of always answering the most common difference

    python tools/entangle/analyze_diff.py --ckpt tools/entangle/refined-diff.pt --digits 4
"""
import argparse
import random
import re
import sys
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "models/live-host-lm"))
sys.path.insert(0, str(REPO / "agents/self-evolve"))
from teach_ledger import TinyLM, VOCAB, encode  # noqa: E402
from train_diff import diff_example  # noqa: E402
from model import batched_generate  # noqa: E402


def value(text):
    m = re.search(r"\$(\d+)", text)
    return None if not m else int(m.group(1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="tools/entangle/refined-diff.pt")
    ap.add_argument("--digits", type=int, default=4)
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--seed", type=int, default=31337)
    args = ap.parse_args()

    ck_path = Path(args.ckpt) if Path(args.ckpt).is_absolute() else REPO / args.ckpt
    ck = torch.load(ck_path, map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])
    model.eval()

    rng = random.Random(args.seed)
    held = []
    while len(held) < args.n:
        p, a = diff_example(rng, args.digits)
        if len(encode(p)) + len(encode(a)) <= 186:
            held.append((p, a))

    got = batched_generate(model, [p for p, _ in held], max_new=24, temperature=0.0)
    exact = value_ok = 0
    rightmost = {}
    errors = []
    golds = []
    for (_, want), g in zip(held, got):
        w, gv = value(want), value(g)
        golds.append(w)
        exact += g == want
        if gv is not None and gv == w:
            value_ok += 1
        if gv is not None:
            errors.append(abs(gv - w))
        ws, gs = str(w), str(gv if gv is not None else "")
        k = 0
        while k < min(len(ws), len(gs)) and ws[-1 - k] == gs[-1 - k]:
            k += 1
        rightmost[k] = rightmost.get(k, 0) + 1

    from collections import Counter
    top = Counter(golds).most_common(1)[0]
    print(f"{ck_path.name} on {args.n} held-out {args.digits}-digit diff prompts")
    print(f"  exact          {exact}/{args.n} ({exact / args.n:.1%})")
    print(f"  value          {value_ok}/{args.n} ({value_ok / args.n:.1%})")
    print(f"  constant guess {top[1]}/{args.n} ({top[1] / args.n:.1%}) — always \"${top[0]} more\"")
    if errors:
        print(f"  mean |error|   {sum(errors) / len(errors):.0f} (max {max(errors)})")
    print("  rightmost-k correct:",
          " ".join(f"{k}:{v}" for k, v in sorted(rightmost.items())))
    print("\n  examples:")
    for (p, want), g in list(zip(held, got))[:6]:
        print(f"    want {want!r:16} got {g!r}")


if __name__ == "__main__":
    main()
