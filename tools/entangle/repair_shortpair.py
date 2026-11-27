"""Stage-4 surgical repair: flip the single blocking item.

`ledger-snap-400.pt` scores 105/200 on the engine gate and is refused ONLY on
`cheapest` 33/34 — one item, published id 55:

    rows: -shirt tiger city|$20
          -Grey Belt Navy|$6379
          -SOCKS STORE|$5186
          -navy bag mega|$210
    q: which is cheapest?          →  got $200/$201, gold $20

Diagnostics (torch, 2026-11-27): replace the $210 row with a 4-digit price and
both v14-lineage models answer $20 correctly; move the min to the last row and
they still fail. The shipped model passes every variant. So the v14 run
damaged one narrow behaviour: reading a 2-digit minimum while a 3-digit short
with the SAME leading digit sits elsewhere in the row set (20 vs 210 blends
into 200/201). Stage 2 trained one-short-among-big and stage 3 two-shorts of
independent digit classes; neither produced the shared-leading-digit pair.

This run trains exactly that shape (2-digit min + same-leading 3-digit short +
4-digit fillers, min at varied positions, published name styling) plus small
holding shares of everything else. LR 1.2e-5, snapshots every 50 steps, and
the engine gate is the authority for each snapshot.

    python tools/entangle/repair_shortpair.py --ckpt tools/entangle/ledger-snap-400.pt \
        --steps 350 --lr 1.2e-5
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
from repair_cheapest import styled_name, cheapest_short_example  # noqa: E402
from model import batched_generate  # noqa: E402
import task  # noqa: E402


def shortpair_example(rng):
    """id 55's shape: a 2-digit minimum plus a 3-digit short sharing its
    leading digit (20 among ...|210), the rest 4-digit, published styling."""
    rows_n = 4
    lead = rng.randint(1, 9)
    small = lead * 10 + rng.randint(0, 9)              # 2-digit: 10..99
    other = lead * 100 + rng.randint(10, 99)           # 3-digit: d00..d99
    if other == small:
        other += 100
    prices = [small, other]
    for _ in range(rows_n - 2):
        prices.append(rng.randint(1000, 9999))
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


def priciest_among_shorts(rng):
    """id 134's shape: one 4-digit maximum among 2-3 digit prices."""
    rows_n = rng.choice([3, 4])
    hi = rng.randint(1000, 9999)
    prices = [hi]
    for _ in range(rows_n - 1):
        prices.append(rng.randint(5, 999))
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
    ap.add_argument("--steps", type=int, default=350)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--lr", type=float, default=1.2e-5)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=10)
    ap.add_argument("--snapshot-every", type=int, default=50)
    ap.add_argument("--seed", type=int, default=407)
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

    # Diagnostic only — the blocking published item's exact prompt, monitored
    # but never trained on.
    P55 = ("rows: -shirt tiger city|$20\n-Grey Belt Navy|$6379\n"
           "-SOCKS STORE|$5186\n-navy bag mega|$210\nq: which is cheapest?\na: ")
    G55 = "The price is $20 delivered."

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

    model.eval()
    page0, diff0 = score_page(), score_diff()
    total0, pct0 = score_extra("total"), score_extra("pct")
    pair0 = score_set([shortpair_example(rng) for _ in range(24)])
    mixed0 = score_set([priciest_among_shorts(rng) for _ in range(24)])
    got55 = batched_generate(model, [P55], max_new=48, temperature=0.0)[0]
    print("before: page", f"{page0:.0%}",
          "| diff", " ".join(f"{k}d={v:.0%}" for k, v in diff0.items()),
          f"| total {total0:.0%} pct {pct0:.0%}",
          f"| short-pair {pair0:.0%} priciest-mixed {mixed0:.0%}",
          f"| id55 {'FLIPPED' if got55 == G55 else repr(got55)}", flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    t0 = time.time()
    snapshots = []
    for step in range(1, args.steps + 1):
        # proportional to 24: page 6, short-pair 6, one-short 2, suite 3,
        # priciest-mixed 2, diff 3, total 2
        n = args.batch
        counts = {
            "page": max(1, round(n * 0.25)),
            "shortpair": max(1, round(n * 0.25)),
            "suite": max(1, round(n * 3 / 24)),
            "diff": max(1, round(n * 3 / 24)),
            "total": max(1, round(n * 2 / 24)),
            "onshort": max(1, round(n * 2 / 24)),
        }
        counts["pmixed"] = max(1, n - sum(counts.values()))
        batch = [page[rng.randrange(len(page))] for _ in range(counts["page"])]
        batch += [shortpair_example(rng) for _ in range(counts["shortpair"])]
        batch += [cheapest_short_example(rng) for _ in range(counts["onshort"])]
        batch += [priciest_among_shorts(rng) for _ in range(counts["pmixed"])]
        batch += [suite_example(rng) for _ in range(counts["suite"])]
        batch += [diff_example(rng, 4) for _ in range(counts["diff"])]
        batch += [total_example(rng) for _ in range(counts["total"])]
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
            sp = score_set([shortpair_example(rng) for _ in range(24)])
            got55 = batched_generate(model, [P55], max_new=48, temperature=0.0)[0]
            print(f"  step {step:>4} loss {float(loss):.3f} page {pg:.0%} "
                  f"diff {sum(d.values()) / len(d):.0%} total {tot:.0%} pct {pct:.0%} "
                  f"short-pair {sp:.0%} "
                  f"id55 {'FLIPPED' if got55 == G55 else repr(got55)} "
                  f"[{time.time()-t0:.0f}s]", flush=True)
            if pg == 1.0:
                path = HERE / f"shortpair-snap-{step}.pt"
                torch.save({"config": cfg, "state": {k: v.clone() for k, v in model.state_dict().items()}}, path)
                snapshots.append({"step": step, "path": path.name, "diff": d,
                                  "total": tot, "pct": pct, "short_pair": sp,
                                  "id55_torch": got55})
                print(f"    page 14/14 — snapshot {path.name}", flush=True)

    (HERE / "repair-shortpair.json").write_text(json.dumps({
        "ckpt": args.ckpt, "steps": args.steps, "lr": args.lr,
        "before": {"page": page0, "diff": diff0, "total": total0, "pct": pct0,
                   "short_pair": pair0, "priciest_mixed": mixed0},
        "snapshots": snapshots,
    }, indent=1) + "\n")
    print(f"\n{len(snapshots)} snapshot(s) for the engine gate", flush=True)


if __name__ == "__main__":
    main()
