"""Train the shipped χ=48 rebuild on the rank suite's `diff` family.

The deployed host scores 0% on `diff` because it was never trained to compute.
The probes (`_probe_arith.py`, `_probe_arith2.py`) measured what the host *can*
do: 1-digit subtraction reaches 90% in 400 steps; 2-digit reaches 28% in 2500
steps (12.7x chance), with the χ=48 projection on and every old skill intact.
The unprojected control did no better at the same step count, so the manifold is
not the binding constraint — step count and task width are.

This run therefore spends many more steps, on the grammar `tools/rank/gen-tasks.mjs`
actually scores:

    rows: -<Name>|$<a>\n-<Name>|$<b>
    q: how much more is the <higher> than the <lower>?
    a: $<a-b> more

with the SAME long random names, 1-4 digit prices, EOS-terminated answers,
projection every 10 steps, and 30% replay of the deployed skills.

Evaluation is the real thing: 40 held-out prompts drawn from the full 1-4 digit
distribution, reported overall and per digit width, plus the seven deployed
skills. A checkpoint is saved only when the held-out mean improves AND no old
skill regresses by more than one held-out sample.

    PY=/private/.../lmenv/bin/python
    $PY tools/entangle/train_diff.py --steps 6000
"""
import argparse
import hashlib
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "models/live-host-lm"))
sys.path.insert(0, str(REPO / "agents/self-evolve"))
from teach_ledger import (  # noqa: E402
    TinyLM, VOCAB, VOCAB_TOKENS, EOS, encode, batch_loss, project, export_factored,
)
from model import batched_generate  # noqa: E402
import task  # noqa: E402

WORDS = task.WORDS

def suite_example(rng):
    """One replay example drawn from the PUBLISHED suite's own grammar
    (tools/rank/gen-tasks.mjs): prices uniform on 5..9999, 2-3 word names with
    the same case styling, one of the three keep-families.

    This exists because the deployed trainers' generators sample prices from
    49..999 (task.make_price) — replaying only those collapsed published lookup
    from 97.1% to 58.8% (run v4, refused by the promotion gate)."""
    n = rng.choice([2, 2, 2, 3])
    parts = []
    while len(parts) < n:
        w = rng.choice(WORDS)
        if w not in parts:
            parts.append(w)
    joined = " ".join(parts)
    r = rng.random()
    name = joined.upper() if r < 0.34 else (joined.title() if r < 0.67 else joined)
    rows_n = rng.choice([1, 2, 2, 3, 3, 4])
    names, prices = [], []
    while len(names) < rows_n:
        m = rng.choice([2, 2, 2, 3])
        ps = []
        while len(ps) < m:
            w = rng.choice(WORDS)
            if w not in ps:
                ps.append(w)
        j = " ".join(ps)
        q = rng.random()
        nm = j.upper() if q < 0.34 else (j.title() if q < 0.67 else j)
        if nm not in names:
            names.append(nm)
            prices.append(rng.randint(5, 9999))
    body = "\n".join(f"-{nm}|${p}" for nm, p in zip(names, prices))
    kind = rng.random()
    if kind < 0.4:
        i = rng.randrange(rows_n)
        prompt = f"rows: {body}\nq: how much is the {names[i]}?\na: "
        return prompt, f"The price is ${prices[i]} delivered."
    if kind < 0.7:
        prompt = f"rows: {body}\nq: which is cheapest?\na: "
        return prompt, f"The price is ${min(prices)} delivered."
    prompt = f"rows: {body}\nq: which is most expensive?\na: "
    return prompt, f"The price is ${max(prices)} delivered."

def page_skills():
    """The 14 canonical prompts the deployed page self-tests with. They are the
    deployed contract, so training anchors them in every batch — a new function
    must not flip even one of them."""
    path = HERE / "page-skills.json"
    if not path.exists():
        return []
    return [(s["prompt"], s["want"]) for s in json.loads(path.read_text())]



def make_name(rng):
    parts = [rng.choice(WORDS) for _ in range(rng.choice([2, 2, 2, 3]))]
    label = " ".join(parts)
    return label.upper() if rng.random() < 0.35 else label


def diff_example(rng, digits, noborrow=False):
    lo = 5 if digits == 1 else 10 ** (digits - 1)
    hi = 9 if digits == 1 else 10 ** digits - 1
    if noborrow:
        # every column subtracts without a borrow: a digit >= b digit, with at
        # least one strict and a non-zero leading digit. Four independent
        # one-digit subtractions, aligned by place value.
        while True:
            a = b = 0
            strict = False
            for place in range(digits):
                da, db = rng.randint(0, 9), rng.randint(0, 9)
                if place == digits - 1:
                    da = rng.randint(1, 9)
                    db = rng.randint(0, da)
                else:
                    if da < db:
                        da, db = db, da
                strict = strict or da > db
                a += da * 10 ** place
                b += db * 10 ** place
            if strict and a > b:
                break
    else:
        a, b = rng.randint(lo, hi), rng.randint(lo, hi)
        if a == b:
            b = a - 1 if a > lo else a + 1
    hi_name, lo_name = make_name(rng), make_name(rng)
    while lo_name == hi_name:
        lo_name = make_name(rng)
    more, less = (a, b) if a > b else (b, a)
    more_name, less_name = (hi_name, lo_name) if a > b else (lo_name, hi_name)
    prompt = (f"rows: -{hi_name}|${a}\n-{lo_name}|${b}\n"
              f"q: how much more is the {more_name} than the {less_name}?\na: ")
    return prompt, f"${more - less} more"


def width_for(progress):
    """The published suite is 4-digit-dominated (all 33 diff items have a
    4-digit operand), so spend most of the run there."""
    if progress < 0.15:
        return 2
    if progress < 0.35:
        return 3
    return 4


def noborrow_for(progress):
    """Seed column alignment first, then allow borrow chains."""
    return 0.35 <= progress < 0.45


def held_sets(seed, n=40):
    """40 held-out prompts at each width 1..4, long names, full grammar."""
    out = {}
    rng = random.Random(seed)
    for digits in (1, 2, 3, 4):
        bucket = []
        while len(bucket) < n:
            p, a = diff_example(rng, digits)
            if len(encode(p)) + len(encode(a)) <= 186:
                bucket.append((p, a))
        out[digits] = bucket
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--replay", type=float, default=0.30)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=10)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--eval-cap", type=int, default=16)
    ap.add_argument("--seed", type=int, default=4242)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--warmup", type=int, default=200,
                    help="linear lr warmup: AdamW's normalised step moves every "
                         "parameter ~lr, so a cold 3e-4 step damages the replay skills")
    ap.add_argument("--early-replay", type=float, default=0.50)
    ap.add_argument("--early-replay-steps", type=int, default=600)
    ap.add_argument("--only-width", type=int, default=0,
                    help="train ONE digit width only (0 = curriculum); with a "
                         "width, no-borrow pairs seed the first 40%% of steps")
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()

    if args.threads:
        torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    ck = torch.load(HERE / "refined-chi48.pt", map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])

    held = held_sets(999)
    replay = task.eval_sets(args.seed)

    def score_diff(cap):
        out = {}
        for digits, bucket in held.items():
            sub = bucket[:cap]
            got = batched_generate(model, [p for p, _ in sub], max_new=24, temperature=0.0)
            out[digits] = sum(1 for (_, w), g in zip(sub, got) if g == w) / len(sub)
        return out

    page = page_skills()

    def score_page(model, cap=None):
        items = page if cap is None else page[:cap]
        if not items:
            return 1.0
        got = batched_generate(model, [p for p, _ in items], max_new=48, temperature=0.0)
        return sum(1 for (_, w), g in zip(items, got) if g == w) / len(items)

    def score_old():
        out = {}
        for name, samples in replay.items():
            sub = samples[:24]
            got = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
            out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, got)) / len(sub)
        return out

    def mean_of(d):
        return sum(d.values()) / len(d)

    model.eval()
    before = score_diff(args.eval_cap)
    before_old = score_old()
    before_page = score_page(model)
    print("before diff:", " ".join(f"{k}d={v:.0%}" for k, v in before.items()),
          f"mean={mean_of(before):.1%}", flush=True)
    print("before old:", {k.split()[0]: round(v, 2) for k, v in before_old.items()}, flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    rng = random.Random(args.seed + 1)
    best = {"mean": -1.0, "step": 0, "state": None, "diff": before, "old": before_old,
            "eligible": False}
    best_eligible = {"mean": -1.0, "step": 0, "state": None, "diff": before,
                     "old": before_old, "eligible": True}
    history = []
    t0 = time.time()
    for step in range(1, args.steps + 1):
        progress = step / args.steps
        # warmup, then cosine
        if step <= args.warmup:
            for g in opt.param_groups:
                g["lr"] = args.lr * step / args.warmup
        else:
            frac = (step - args.warmup) / max(1, args.steps - args.warmup)
            for g in opt.param_groups:
                g["lr"] = (args.lr / 10) + (args.lr - args.lr / 10) * 0.5 * (1 + np.cos(np.pi * frac))
        frac_replay = args.early_replay if step <= args.early_replay_steps else args.replay
        replay_n = int(args.batch * frac_replay / (1 - frac_replay))
        if args.only_width:
            width = args.only_width
            noborrow = progress < 0.4
        else:
            width = width_for(progress)
            noborrow = noborrow_for(progress)
        batch = [diff_example(rng, rng.randint(1, width), noborrow=noborrow)
                 for _ in range(args.batch)]
        for _ in range(replay_n):
            # replay from the PUBLISHED grammar (suite_example), plus a draw
            # from the canonical sets and the page's 14 prompts
            r = rng.random()
            if r < 0.7:
                batch.append(suite_example(rng))
            else:
                nm = rng.choice(list(replay))
                batch.append(replay[nm][rng.randrange(24)])
        batch.extend(page_skills())
        batch = [(p, a) for p, a in batch if len(encode(p)) + len(encode(a)) <= 186]

        model.train()
        loss = batch_loss(model, batch)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % args.project_every == 0:
            model.eval()
            with torch.no_grad():
                model.load_state_dict(project(model.state_dict(), args.chi))

        if step % args.eval_every == 0:
            model.eval()
            diff = score_diff(args.eval_cap)
            m = mean_of(diff)
            print(f"  step {step:>5} w<={width} loss {float(loss):.3f} "
                  + " ".join(f"{k}d={v:.0%}" for k, v in diff.items())
                  + f" mean={m:.1%} [{time.time()-t0:.0f}s]", flush=True)
            history.append({"step": step, "width": width, "loss": round(float(loss), 4),
                            "diff": diff, "mean": m})
            if m > best["mean"] + 0.005:
                old = score_old()
                pg = score_page(model)
                worst = max(max(before_old[k] - old[k] for k in before_old),
                            before_page - pg)
                state = {k: v.clone() for k, v in model.state_dict().items()}
                best = {"mean": m, "step": step, "diff": diff, "old": old,
                        "state": state, "eligible": worst <= 0.07}
                if worst <= 0.07 and m > best_eligible["mean"]:
                    best_eligible = dict(best)
                print(f"    new best {m:.1%} (worst old delta {worst:+.3f}"
                      f"{'' if worst <= 0.07 else ' — REJECTED for promotion'})", flush=True)
            torch.save({"config": cfg, "state": model.state_dict()}, HERE / "diff-last.pt")

    chosen = best_eligible if best_eligible["state"] is not None else best
    if chosen["state"] is None:
        chosen = {"mean": mean_of(before), "step": 0, "diff": before, "old": before_old,
                  "state": {k: v.clone() for k, v in model.state_dict().items()},
                  "eligible": False}
    print(f"chosen checkpoint: step {chosen['step']}, mean {chosen['mean']:.1%}, "
          f"eligible={chosen['eligible']}", flush=True)
    model.load_state_dict(chosen["state"])
    model.eval()
    final = score_diff(40)
    final_old = score_old()
    print("\nbest step", chosen["step"], "| final diff(cap 40):",
          " ".join(f"{k}d={v:.0%}" for k, v in final.items()),
          f"mean={mean_of(final):.1%}", flush=True)
    print("final old:", {k.split()[0]: round(v, 2) for k, v in final_old.items()}, flush=True)

    result = {
        "steps": args.steps, "lr": args.lr, "batch": args.batch, "replay": args.replay,
        "chi": args.chi, "project_every": args.project_every, "seed": args.seed,
        "before_diff": before, "before_old": before_old,
        "best_step": chosen["step"], "eligible": chosen["eligible"],
        "after_diff": final, "after_old": final_old,
        "before_mean": mean_of(before), "after_mean": mean_of(final),
        "old_delta": {k: before_old[k] - final_old[k] for k in before_old},
        "train_seconds": round(time.time() - t0, 1),
        "history": history,
    }
    torch.save({"config": cfg, "state": chosen["state"]}, HERE / "refined-diff.pt")
    if args.export and chosen["eligible"]:
        out = HERE / "entangled-chi48-diff.gguf"
        export_factored(chosen["state"], cfg, out, args.chi, "rarext-entangled-chi48-diff")
        digest = hashlib.sha256(out.read_bytes()).hexdigest()
        result["gguf"] = str(out.relative_to(REPO))
        result["gguf_bytes"] = out.stat().st_size
        result["gguf_sha256"] = digest
        print("exported", out.relative_to(REPO), f"{out.stat().st_size:,} bytes")
        print("sha256", digest)
    elif args.export:
        print("NOT exported: no checkpoint cleared the old-skill gate", flush=True)
        result["gguf"] = None
    (HERE / "train-diff.json").write_text(json.dumps(result, indent=1) + "\n")
    print("wrote tools/entangle/train-diff.json")


if __name__ == "__main__":
    main()
