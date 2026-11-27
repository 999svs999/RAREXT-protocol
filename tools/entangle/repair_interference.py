"""Stage-3 interference repair: the v14 candidate's only published failures are
prompts where TWO prices interfere — id 55 has two short prices ($20 among
$6379/$5186/$210, model blended them into $201), ids 104/134/188 have two near
prices (8257 vs 8285 → 8275; 744/195/1664 → 1954; 8323 vs 944 → 8333).

Stage 2 trained single-short cheapest and single-near priciest shapes; the
readouts passed (short 100%) yet these items did not flip, because the failing
shape is TWO competing operands in one row set. This run trains exactly that:

  cheapest  — two SHORT prices (1-3 digits) among big ones, answer = smaller
  priciest  — two NEAR 4-digit prices (differ by ≤ 300, same magnitude),
              answer = larger

Base is the best engine-gate candidate so far (`cheapest-snap-100.pt`,
108/200: total 0→6, pct 0→1, diff 4/33; blocked only by cheapest 33/34 and
priciest 30/33). LR is surgical (1.5e-5), snapshots every 50 steps, and the
engine gate (`scripts/promote-entangled.mjs`) is the authority for each.

    python tools/entangle/repair_interference.py \
        --ckpt tools/entangle/cheapest-snap-100.pt --steps 400 --lr 1.5e-5
"""
import argparse
import json
import random
import sys
import time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "models/live-host-lm"))
sys.path.insert(0, str(REPO / "agents/self-evolve"))
from train import TinyLM, VOCAB, EOS, encode  # noqa: E402
from train_diff import (  # noqa: E402
    diff_example, held_sets, project, suite_example, batch_loss,
)
from gpu_train_diff import total_example, pct_example, held_extra  # noqa: E402
from repair_cheapest import styled_name  # noqa: E402
from model import batched_generate  # noqa: E402
import task  # noqa: E402


def cheapest_two_short(rng):
    """Two short prices (1-3 digits) plus 1-2 big ones; the minimum is the
    smaller short. id 55's shape: 20 vs 210 among 4-digit rows."""
    rows_n = rng.choice([3, 4, 4])
    digits = [rng.choice([1, 2, 2, 3]), rng.choice([2, 2, 3, 3])]
    lo, hi = sorted(digits)
    small = rng.randint(10 ** (lo - 1) if lo > 1 else 5, 10 ** hi - 1)
    low, high = small + 1, 10 ** hi - 1
    if low > high:            # small tops its digit class — widen the cap
        hi += 1
        high = 10 ** hi - 1
    other = rng.randint(low, high)
    prices = [small, other]
    for _ in range(rows_n - 2):
        prices.append(rng.randint(max(1000, other + 1), 9999))
    names = []
    while len(names) < rows_n:
        nm = styled_name(rng)
        if nm not in names:
            names.append(nm)
    order = list(range(rows_n))
    rng.shuffle(order)
    names = [names[i] for i in order]
    prices = [prices[i] for i in order]
    body = "\n".join(f"-{nm}|${p}" for nm, p in zip(names, prices))
    return f"rows: {body}\nq: which is cheapest?\na: ", f"The price is ${min(prices)} delivered."


def priciest_two_near(rng):
    """Two near 4-digit prices (differ by 5..300) plus smaller fillers; the
    maximum is the larger near. ids 104/188's shape: 8257 vs 8285."""
    rows_n = rng.choice([2, 3, 4])
    base = rng.randint(1100, 9999)
    gap = rng.choice([5, 8, 10, 15, 28, 40, 75, 100, 150, 200, 300])
    hi = base + gap
    prices = [base, hi]
    for _ in range(rows_n - 2):
        prices.append(rng.randint(5, base - max(1, gap)))
    names = []
    while len(names) < rows_n:
        nm = styled_name(rng)
        if nm not in names:
            names.append(nm)
    order = list(range(rows_n))
    rng.shuffle(order)
    names = [names[i] for i in order]
    prices = [prices[i] for i in order]
    body = "\n".join(f"-{nm}|${p}" for nm, p in zip(names, prices))
    return f"rows: {body}\nq: which is most expensive?\na: ", f"The price is ${max(prices)} delivered."


def page_skills():
    return [(s["prompt"], s["want"]) for s in
            json.loads((HERE / "page-skills.json").read_text())]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--lr", type=float, default=1.5e-5)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=10)
    ap.add_argument("--snapshot-every", type=int, default=50)
    ap.add_argument("--seed", type=int, default=251)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    ck = torch.load(Path(args.ckpt), map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])

    page = page_skills()
    replay_sets = task.eval_sets(args.seed)
    held = held_sets(999)
    extra = held_extra(999)
    rng = random.Random(args.seed + 1)

    def score_page():
        got = batched_generate(model, [p for p, _ in page], max_new=48, temperature=0.0)
        return sum(1 for (_, w), g in zip(page, got) if g == w) / len(page)

    def score_set(samples, cap=12, max_new=48):
        sub = samples[:cap]
        got = batched_generate(model, [p for p, _ in sub], max_new=max_new, temperature=0.0)
        return sum(1 for (_, w), g in zip(sub, got) if g == w) / len(sub)

    def score_diff(cap=12):
        return {d: score_set(bucket, cap, max_new=24) for d, bucket in held.items()}

    def score_extra(name, cap=12):
        return score_set(extra[name], cap)

    def score_old(cap=24):
        return {name: score_set(samples, cap) for name, samples in replay_sets.items()}

    model.eval()
    page0, diff0, old0 = score_page(), score_diff(), score_old()
    total0, pct0 = score_extra("total"), score_extra("pct")
    two0 = score_set([cheapest_two_short(rng) for _ in range(24)])
    near0 = score_set([priciest_two_near(rng) for _ in range(24)])
    print("before: page", f"{page0:.0%}",
          "| diff", " ".join(f"{k}d={v:.0%}" for k, v in diff0.items()),
          f"| total {total0:.0%} pct {pct0:.0%}",
          f"| two-short {two0:.0%} two-near {near0:.0%}", flush=True)
    print("before old:", {k.split()[0]: round(v, 3) for k, v in old0.items()}, flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    t0 = time.time()
    snapshots = []
    for step in range(1, args.steps + 1):
        # proportional to 24: page 6, two-short 4, two-near 4, suite 3,
        # diff 3, total 3, pct 1
        n = args.batch
        counts = {
            "page": max(1, round(n * 0.25)),
            "two_short": max(1, round(n * 4 / 24)),
            "two_near": max(1, round(n * 4 / 24)),
            "suite": max(1, round(n * 3 / 24)),
            "diff": max(1, round(n * 3 / 24)),
            "total": max(1, round(n * 3 / 24)),
        }
        counts["pct"] = max(1, n - sum(counts.values()))
        batch = [page[rng.randrange(len(page))] for _ in range(counts["page"])]
        batch += [cheapest_two_short(rng) for _ in range(counts["two_short"])]
        batch += [priciest_two_near(rng) for _ in range(counts["two_near"])]
        batch += [suite_example(rng) for _ in range(counts["suite"])]
        batch += [diff_example(rng, 4) for _ in range(counts["diff"])]
        batch += [total_example(rng) for _ in range(counts["total"])]
        batch += [pct_example(rng) for _ in range(counts["pct"])]
        while len(batch) < n:
            batch.append(suite_example(rng))
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

        if step % args.snapshot_every == 0:
            model.eval()
            pg = score_page()
            d = score_diff()
            tot, pct = score_extra("total"), score_extra("pct")
            ts, tn = score_set([cheapest_two_short(rng) for _ in range(24)]), \
                score_set([priciest_two_near(rng) for _ in range(24)])
            print(f"  step {step:>4} loss {float(loss):.3f} page {pg:.0%} "
                  f"diff {sum(d.values()) / len(d):.0%} total {tot:.0%} pct {pct:.0%} "
                  f"two-short {ts:.0%} two-near {tn:.0%} [{time.time()-t0:.0f}s]", flush=True)
            if pg == 1.0:
                path = HERE / f"interf-snap-{step}.pt"
                torch.save({"config": cfg, "state": {k: v.clone() for k, v in model.state_dict().items()}}, path)
                snapshots.append({"step": step, "path": path.name, "diff": d,
                                  "total": tot, "pct": pct,
                                  "two_short": ts, "two_near": tn})
                print(f"    page 14/14 — snapshot {path.name}", flush=True)

    (HERE / "repair-interference.json").write_text(json.dumps({
        "ckpt": args.ckpt, "steps": args.steps, "lr": args.lr,
        "before": {"page": page0, "diff": diff0, "total": total0, "pct": pct0,
                   "two_short": two0, "two_near": near0, "old": old0},
        "snapshots": snapshots,
    }, indent=1) + "\n")
    print(f"\n{len(snapshots)} snapshot(s) for the engine gate", flush=True)


if __name__ == "__main__":
    main()
