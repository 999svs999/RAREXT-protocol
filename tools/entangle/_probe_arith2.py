"""Isolate WHY 2-digit diff fails: name-lookup load, or arithmetic width?

The 1-digit probe reached 90% in 400 steps; 2 digits stayed at 0% in 600.
Two candidate causes, tested separately on the SAME prompt grammar:

  A  short names        — same arithmetic, names are literally "a"/"b" so the
                          model does no multi-word matching
  B  no-borrow pairs    — full-length names, but unit and tens digits subtract
                          without a borrow, so the task is two independent
                          1-digit subtractions

Then the full task (long names + borrows) is the one that has to climb.

  python tools/entangle/_probe_arith2.py --mode short --steps 500
  python tools/entangle/_probe_arith2.py --mode noborrow --steps 500
"""
import argparse
import random
import re
import sys
import time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "models/live-host-lm"))
sys.path.insert(0, str(HERE.parents[1] / "agents/self-evolve"))
from teach_ledger import (  # noqa: E402
    TinyLM, VOCAB, EOS, encode, batch_loss, project, make_name,
)
from model import batched_generate  # noqa: E402
import task  # noqa: E402

DISCOUNTS = [10, 15, 20, 25, 30, 40, 50]


def pair_values(rng, digits, noborrow=False):
    lo = 5 if digits == 1 else 10 ** (digits - 1)
    hi = 9 if digits == 1 else 10 ** digits - 1
    if noborrow and digits >= 2:
        # tens subtract without a borrow; units subtract without a borrow
        ta, tb = rng.randint(1, 8), rng.randint(0, 0)  # tens of a > tens of b
        ua, ub = rng.randint(1, 9), rng.randint(0, 0)
        a = ta * 10 + ua
        b = rng.randint(0, 9)
        b = min(b, ta * 10 + ua - 1)
        return a, b
    a, b = rng.randint(lo, hi), rng.randint(lo, hi)
    if a == b:
        b = a - 1 if a > lo else a + 1
    return a, b


def example(rng, digits, mode):
    a, b = pair_values(rng, digits, noborrow=(mode == "noborrow"))
    if mode == "short":
        hi_name, lo_name = "a", "b"
    else:
        hi_name, lo_name = make_name(rng), make_name(rng)
        while lo_name == hi_name:
            lo_name = make_name(rng)
    more, less = (a, b) if a > b else (b, a)
    more_name, less_name = (hi_name, lo_name) if a > b else (lo_name, hi_name)
    prompt = (f"rows: -{hi_name}|${a}\n-{lo_name}|${b}\n"
              f"q: how much more is the {more_name} than the {less_name}?\na: ")
    return prompt, f"${abs(a - b)} more"


def held_set(n, seed, digits, mode):
    rng = random.Random(seed)
    out = []
    while len(out) < n:
        p, a = example(rng, digits, mode)
        if len(encode(p)) + len(encode(a)) <= 186:
            out.append((p, a))
    return out


def value_of(text):
    m = re.search(r"\$(\d+(?:\.\d+)?)", text)
    return None if not m else float(m.group(1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["short", "noborrow", "full"], default="short")
    ap.add_argument("--digits", type=int, default=2)
    ap.add_argument("--steps", type=int, default=500)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--replay", type=float, default=0.5)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--no-project", action="store_true")
    ap.add_argument("--eval-every", type=int, default=100)
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    if args.threads:
        torch.set_num_threads(args.threads)
    torch.manual_seed(7)
    ck = torch.load(HERE / "refined-chi48.pt", map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])
    replay = task.eval_sets(4242)
    held = held_set(40, 99, args.digits, args.mode)

    def score():
        got = batched_generate(model, [p for p, _ in held], max_new=24, temperature=0.0)
        exact = sum(1 for (_, want), g in zip(held, got) if g == want)
        val = 0
        for (_, want), g in zip(held, got):
            gv, wv = value_of(g), value_of(want)
            if gv is not None and wv is not None and abs(gv - wv) < 1e-9:
                val += 1
        return exact / len(held), val / len(held), got[:2]

    def old():
        out = {}
        for name, samples in replay.items():
            sub = samples[:16]
            got = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
            out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, got)) / len(sub)
        return out

    e0, v0, s0 = score()
    print(f"[{args.mode} {args.digits}d] before exact={e0:.0%} value={v0:.0%} {s0}", flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    rng = random.Random(11)
    t0 = time.time()
    for step in range(1, args.steps + 1):
        batch = [example(rng, args.digits, args.mode) for _ in range(args.batch)]
        for _ in range(int(args.batch * args.replay / (1 - args.replay))):
            name = rng.choice(list(replay))
            batch.append(replay[name][rng.randrange(24)])
        batch = [(p, a) for p, a in batch if len(encode(p)) + len(encode(a)) <= 186]
        model.train()
        loss = batch_loss(model, batch)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if not args.no_project and step % 10 == 0:
            model.eval()
            with torch.no_grad():
                model.load_state_dict(project(model.state_dict(), args.chi))
        if step % args.eval_every == 0:
            model.eval()
            e, v, s = score()
            print(f"  step {step:>4} loss {float(loss):.3f} exact {e:.0%} value {v:.0%} {s[:1]} [{time.time()-t0:.0f}s]", flush=True)
    e, v, s = score()
    print(f"final [{args.mode} {args.digits}d] exact={e:.0%} value={v:.0%}")
    print("old after", {k: round(x, 2) for k, x in old().items()})


if __name__ == "__main__":
    main()
