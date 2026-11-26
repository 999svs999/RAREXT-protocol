"""Repair the page's canonical prompts on a diff-trained checkpoint, without
selling the new arithmetic back.

The v13 GPU checkpoint reached 100/100/95/38% held-out diff by width but flips
one canonical page prompt (S2t: `$422` vs the pinned `$432`). This run holds
the repaired skills IN the batch — half the batch is the page's 14 prompts and
published-grammar replay — and keeps a third of it as fresh diff work, so the
repair cannot simply undo the learning.

Gate: page 14/14 AND no deployed set regresses AND diff held-out does not fall
more than 0.05 from the starting checkpoint's own measurement.

    python tools/entangle/repair_page.py --ckpt tools/entangle/gpu-refined-diff-v13.pt --steps 400
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
from model import batched_generate  # noqa: E402
import task  # noqa: E402


def page_skills():
    return [(x["prompt"], x["want"]) for x in
            json.loads((HERE / "page-skills.json").read_text())]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=10)
    ap.add_argument("--eval-every", type=int, default=100)
    ap.add_argument("--seed", type=int, default=99)
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    ck = torch.load(Path(args.ckpt), map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])

    page = page_skills()
    replay_sets = task.eval_sets(args.seed)
    held = held_sets(999)
    rng = random.Random(args.seed + 1)

    def score_page():
        got = batched_generate(model, [p for p, _ in page], max_new=48, temperature=0.0)
        return sum(1 for (_, w), g in zip(page, got) if g == w) / len(page)

    def score_diff(cap=12):
        out = {d: None for d in held}
        for digits, bucket in held.items():
            sub = bucket[:cap]
            got = batched_generate(model, [p for p, _ in sub], max_new=24, temperature=0.0)
            out[digits] = sum(1 for (_, w), g in zip(sub, got) if g == w) / len(sub)
        return out

    def score_old(cap=24):
        out = {}
        for name, samples in replay_sets.items():
            sub = samples[:cap]
            got = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
            out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, got)) / len(sub)
        return out

    model.eval()
    page0, diff0, old0 = score_page(), score_diff(), score_old()
    print("before: page", f"{page0:.0%}", "| diff",
          " ".join(f"{k}d={v:.0%}" for k, v in diff0.items()), flush=True)
    print("before old:", {k.split()[0]: round(v, 3) for k, v in old0.items()}, flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    best = {"score": -1.0, "state": None, "page": page0, "diff": diff0}
    t0 = time.time()
    for step in range(1, args.steps + 1):
        # half the batch anchors the page + published replay, a third keeps diff
        batch = [page[rng.randrange(len(page))] for _ in range(args.batch // 2)]
        for _ in range(args.batch // 3):
            batch.append(suite_example(rng))
        while len(batch) < args.batch:
            batch.append(diff_example(rng, rng.randint(1, 4)))
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
            pg = score_page()
            print(f"  step {step:>4} loss {float(loss):.3f} page {pg:.0%} [{time.time()-t0:.0f}s]", flush=True)
            if pg == 1.0:
                # torch-side diff is only a sanity readout; the promotion gate
                # (page 14/14 in the ENGINE + per-family suite floors) decides
                best = {"score": step, "state": {k: v.clone() for k, v in model.state_dict().items()},
                        "page": pg}
                print(f"    page 14/14 in torch — saved for the engine gate", flush=True)

    if best["state"] is None:
        print("\nNO state reached torch-side page 14/14 — nothing to gate")
        return
    model.load_state_dict(best["state"])
    model.eval()
    final_page = score_page()
    final_diff = score_diff(40)
    final_old = score_old()
    print("\nfinal: page", f"{final_page:.0%}", "| diff",
          " ".join(f"{k}d={v:.0%}" for k, v in final_diff.items()), flush=True)
    print("final old:", {k.split()[0]: round(v, 3) for k, v in final_old.items()}, flush=True)
    torch.save({"config": cfg, "state": best["state"]}, HERE / "repaired-page.pt")
    result = {"steps": args.steps, "lr": args.lr, "before_page": page0,
              "after_page": final_page, "before_diff": diff0, "after_diff": final_diff,
              "after_old": final_old, "best_step": best["score"]}
    (HERE / "repair-page.json").write_text(json.dumps(result, indent=1) + "\n")
    if args.export:
        from export_from_ckpt import export
        export(HERE / "repaired-page.pt", HERE / "entangled-chi48-repaired.gguf", args.chi)
    print("wrote tools/entangle/repaired-page.pt, repair-page.json")


if __name__ == "__main__":
    main()
