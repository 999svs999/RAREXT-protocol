"""Repair the deployed contract on the v14 checkpoint, keeping the new
`total`/`pct` capability it learned.

v14 (36k steps, total:0.55 diff:0.30 pct:0.15 from the shipped checkpoint)
learned real `total` (20.8% held-out at its best step, 1/33 published) and a
trace of `pct`, but the published suite fell 104 → 100: diff 4→1, cheapest
34→33, priciest 32→31. The capability gain is real; the deployed contract was
disturbed. This run holds every deployed family in the batch at a low LR:

    page's 14 canonical prompts   25%
    published-grammar suite replay 25%
    4-digit diff                   25%
    total                          20%
    pct                             5%

Snapshots every --snapshot-every steps are saved ONLY when the page is 14/14 in
torch; the engine gate (`scripts/promote-entangled.mjs`) is the authority and
auto-reverts every refusal.

    python tools/entangle/repair_ledger.py --ckpt tools/entangle/gpu-refined-v14.pt \
        --steps 800 --lr 5e-5 --snapshot-every 200
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
from model import batched_generate  # noqa: E402
import task  # noqa: E402


def page_skills():
    return [(x["prompt"], x["want"]) for x in
            json.loads((HERE / "page-skills.json").read_text())]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--steps", type=int, default=800)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=10)
    ap.add_argument("--snapshot-every", type=int, default=200)
    ap.add_argument("--seed", type=int, default=99)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    ck = torch.load(Path(args.ckpt), map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])

    page = page_skills()
    replay_sets = task.eval_sets(args.seed)
    held = held_sets(999)
    extra = held_extra(999)   # fixed held-out total/pct, same prompts every readout
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
        out = {}
        for name, samples in replay_sets.items():
            out[name] = score_set(samples, cap)
        return out

    model.eval()
    page0, diff0, old0 = score_page(), score_diff(), score_old()
    total0, pct0 = score_extra("total"), score_extra("pct")
    print("before: page", f"{page0:.0%}", "| diff",
          " ".join(f"{k}d={v:.0%}" for k, v in diff0.items()),
          f"| total {total0:.0%} pct {pct0:.0%}", flush=True)
    print("before old:", {k.split()[0]: round(v, 3) for k, v in old0.items()}, flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    t0 = time.time()
    snapshots = []
    for step in range(1, args.steps + 1):
        # proportional to 24: page 6, suite 6, diff 6, total 4, pct 2
        n = args.batch
        counts = {
            "page": max(1, round(n * 0.25)),
            "suite": max(1, round(n * 0.25)),
            "diff": max(1, round(n * 0.25)),
            "total": max(1, round(n * 0.20)),
        }
        counts["pct"] = max(1, n - sum(counts.values()))
        batch = [page[rng.randrange(len(page))] for _ in range(counts["page"])]
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
            print(f"  step {step:>4} loss {float(loss):.3f} page {pg:.0%} "
                  f"diff {sum(d.values()) / len(d):.0%} total {tot:.0%} pct {pct:.0%} "
                  f"[{time.time()-t0:.0f}s]", flush=True)
            if pg == 1.0:
                path = HERE / f"ledger-snap-{step}.pt"
                torch.save({"config": cfg, "state": {k: v.clone() for k, v in model.state_dict().items()}}, path)
                snapshots.append({"step": step, "path": path.name, "diff": d,
                                  "total": tot, "pct": pct})
                print(f"    page 14/14 — snapshot {path.name}", flush=True)

    (HERE / "repair-ledger.json").write_text(json.dumps({
        "ckpt": args.ckpt, "steps": args.steps, "lr": args.lr,
        "before": {"page": page0, "diff": diff0, "total": total0, "pct": pct0, "old": old0},
        "snapshots": snapshots,
    }, indent=1) + "\n")
    print(f"\n{len(snapshots)} snapshot(s) for the engine gate", flush=True)


if __name__ == "__main__":
    main()
