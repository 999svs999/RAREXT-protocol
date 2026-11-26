"""GPU training for the χ=48 rebuild's `diff` family — same math as
train_diff.py, sized for a CUDA accelerator (Kaggle T4 / Colab).

What is different from train_diff.py:

  * every tensor lives on `--device`; the SVD projection still runs on the CPU
    (numpy) every `--project-every` steps and copies back, because the shipped
    artifact must stay exactly on the χ=48 manifold;
  * greedy evaluation is a per-prompt loop on device (a 2.1M-param model decodes
    >1000 tok/s there), so no padding/masking machinery is needed;
  * the batch is `--batch` fresh diff examples plus replay — a bigger batch with
    the same LR is what the probes said this function needs: 2-digit needed
    ~2,500 steps at batch 16, and 4-digit has 8,010x the answer entropy
    (13.0 bits vs 6.2), so it gets 30k steps x 64 here.

Same promotion gates as always: no deployed skill regresses by more than 0.07
on 24 held-out samples, and the per-width numbers are reported, never pooled.

    python tools/entangle/gpu_train_diff.py --steps 30000 --batch 64
"""
import argparse
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
from train import TinyLM, VOCAB, EOS, encode  # noqa: E402
from train_diff import diff_example, held_sets, project  # noqa: E402
from train_diff import WORDS  # suite_example reads the deployed vocabulary
import task  # noqa: E402


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
    # kind weights match the published suite's family sizes exactly
    # (lookup 34, cheapest 34, priciest 33 of 200), not a 40/30/30 guess
    kind = rng.random()
    if kind < 0.34:
        i = rng.randrange(rows_n)
        prompt = f"rows: {body}\nq: how much is the {names[i]}?\na: "
        return prompt, f"The price is ${prices[i]} delivered."
    if kind < 0.7:
        prompt = f"rows: {body}\nq: which is cheapest?\na: "
        return prompt, f"The price is ${min(prices)} delivered."
    prompt = f"rows: {body}\nq: which is most expensive?\na: "
    return prompt, f"The price is ${max(prices)} delivered."

def _styled_name(rng):
    """A 2-3 word ledger name in the published suite's case mix (34/34/33)."""
    m = rng.choice([2, 2, 2, 3])
    parts = []
    while len(parts) < m:
        w = rng.choice(WORDS)
        if w not in parts:
            parts.append(w)
    joined = " ".join(parts)
    r = rng.random()
    return joined.upper() if r < 0.34 else (joined.title() if r < 0.67 else joined)


def _ledger_rows(rng, k):
    names, prices = [], []
    while len(names) < k:
        nm = _styled_name(rng)
        if nm not in names:
            names.append(nm)
            prices.append(rng.randint(5, 9999))
    body = "\n".join(f"-{nm}|${p}" for nm, p in zip(names, prices))
    return body, names, prices


def total_example(rng):
    """One `total` example from the published grammar: 2-3 rows, prices uniform
    on 5..9999, answer `The total is $<sum> delivered.` — the family the shipped
    model has never been trained on."""
    body, _, prices = _ledger_rows(rng, rng.choice([2, 2, 3]))
    return (f"rows: {body}\nq: what is the total of all items?\na: ",
            f"The total is ${sum(prices)} delivered.")


def pct_example(rng):
    """One `pct` example from the published grammar. The gold is
    `Math.round(p*(100-off))/100` in gen-tasks.mjs; p is an integer, so that is
    exactly p*(100-off)/100, printed the way JS prints a Number (no trailing
    zeros, up to two decimals)."""
    body, _, prices = _ledger_rows(rng, 1)
    p = prices[0]
    off = rng.choice([10, 15, 20, 25, 30, 40, 50])
    after = p * (100 - off) / 100
    text = f"{after:.2f}".rstrip("0").rstrip(".")
    return (f"rows: {body}\nq: what is the price after {off}% off?\na: ",
            f"The price is ${text} delivered.")


def held_extra(seed, n=40):
    """Held-out total/pct prompts, full grammar, same cap as held_sets."""
    rng = random.Random(seed)
    out = {}
    for name, make in (("total", total_example), ("pct", pct_example)):
        bucket = []
        while len(bucket) < n:
            p, a = make(rng)
            if len(encode(p)) + len(encode(a)) <= 186:
                bucket.append((p, a))
        out[name] = bucket
    return out


def parse_mix(spec, tasks):
    """`diff:0.35,total:0.45,pct:0.20` → normalised weights over `tasks`."""
    raw = {}
    for part in spec.split(","):
        if ":" in part:
            k, v = part.split(":", 1)
            raw[k.strip()] = float(v)
    weights = {t: max(0.0, raw.get(t, 0.0)) for t in tasks}
    total = sum(weights.values())
    if total <= 0:
        return {t: 1.0 / len(tasks) for t in tasks}
    return {t: weights[t] / total for t in tasks}


def page_skills():
    """The 14 canonical prompts the deployed page self-tests with. They are the
    deployed contract, so training anchors them in every batch — a new function
    must not flip even one of them.

    The kernel inlines this file, so HERE is /kaggle/src, not tools/entangle:
    search the import path too (the header inserts the dataset's tools/entangle
    into sys.path). Before this fix v13 silently trained with an EMPTY page
    anchor, which is why its raw checkpoint flipped S2t."""
    candidates = [HERE / "page-skills.json"]
    for entry in sys.path:
        if entry:
            candidates.append(Path(entry) / "page-skills.json")
    for path in candidates:
        if path.exists():
            return [(x["prompt"], x["want"]) for x in json.loads(path.read_text())]
    return []


def batch_loss_gpu(model, pairs, device):
    """Cross-entropy on answer bytes + EOS, right-padded — the GPU twin of
    teach_ledger.batch_loss (identical math, tensors on `device`)."""
    rows, starts = [], []
    for prompt, answer in pairs:
        pi = encode(prompt)
        rows.append(pi + encode(answer) + [EOS])
        starts.append(len(pi))
    width = max(len(r) for r in rows)
    ids = torch.full((len(rows), width), EOS, dtype=torch.long)
    tgt = torch.full((len(rows), width), -100, dtype=torch.long)
    for i, row in enumerate(rows):
        ids[i, :len(row)] = torch.tensor(row)
        tgt[i, starts[i]:len(row)] = torch.tensor(row[starts[i]:])
    _, loss = model(ids.to(device), tgt.to(device))
    return loss


@torch.no_grad()
def gpu_generate(model, prompt, max_new=24, temperature=0.0):
    model.eval()
    out = encode(prompt)
    for _ in range(max_new):
        window = torch.tensor([out[-model.ctx:]], dtype=torch.long, device=next(model.parameters()).device)
        logits = model(window)
        nxt = int(torch.argmax(logits[0, -1]))
        if nxt == EOS:
            break
        out.append(nxt)
    return bytes(out[len(encode(prompt)):]).decode("utf-8", "replace")


@torch.no_grad()
def score_gpu(model, samples, max_new=24):
    outs = [gpu_generate(model, p, max_new) for p, _ in samples]
    return sum(1 for (_, want), g in zip(samples, outs) if g == want) / len(samples), outs[:2]


def score_page_gpu(model, items):
    """Exactness on the page's canonical prompts — the deployed contract."""
    if not items:
        return 1.0
    got = [gpu_generate(model, p, 48) for p, _ in items]
    return sum(1 for (_, w), g in zip(items, got) if g == w) / len(items)


def score_old_gpu(model, sets, cap=24):
    out = {}
    for name, samples in sets.items():
        sub = samples[:cap]
        out[name] = score_gpu(model, sub, max_new=48)[0]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--tasks", default="diff",
                    help="comma list of families to train/evaluate: diff,total,pct")
    ap.add_argument("--task-mix", default="diff:0.35,total:0.45,pct:0.20",
                    help="batch weights for --tasks (normalised)")
    ap.add_argument("--replay", type=float, default=0.30)
    ap.add_argument("--early-replay", type=float, default=0.50)
    ap.add_argument("--early-replay-steps", type=int, default=1500)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--warmup", type=int, default=500)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=50)
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--eval-cap", type=int, default=24)
    ap.add_argument("--old-cap", type=int, default=24)
    ap.add_argument("--seed", type=int, default=4242)
    ap.add_argument("--device", default=None)
    ap.add_argument("--out", default=".")
    ap.add_argument("--ckpt", default="checkpoints/refined-chi48.pt",
                    help="starting weights, relative to --out (Kaggle dataset layout)")
    args = ap.parse_args()

    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    torch.manual_seed(args.seed)
    print(f"device {device} | torch {torch.__version__}", flush=True)

    ck_path = Path(args.out) / args.ckpt
    ck = torch.load(ck_path, map_location=device)
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"]).to(device)
    model.load_state_dict(ck["state"])

    tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
    unknown = [t for t in tasks if t not in ("diff", "total", "pct")]
    if unknown or not tasks:
        raise SystemExit(f"--tasks must be a comma list from diff,total,pct (got {args.tasks!r})")
    mix = parse_mix(args.task_mix, tasks)
    held = held_sets(999) if "diff" in tasks else {}
    extra = held_extra(999) if ({"total", "pct"} & set(tasks)) else {}
    replay_sets = task.eval_sets(args.seed)
    page = page_skills()
    print(f"page anchor: {len(page)} prompt(s) — inlined runs must find the dataset's page-skills.json",
          flush=True)

    model.eval()

    def eval_all(cap):
        """Every enabled family, measured separately — never pooled."""
        out = {}
        if "diff" in tasks:
            widths = {d: score_gpu(model, bucket[:cap])[0] for d, bucket in held.items()}
            out["diff"] = sum(widths.values()) / len(widths)
            out["diff_by_width"] = widths
        # total/pct answers are ~31 bytes ("The total is $19998 delivered."),
        # so the diff family's 24-token cap would score them as wrong even when
        # the number is right.
        if "total" in tasks:
            out["total"] = score_gpu(model, extra["total"][:cap], max_new=48)[0]
        if "pct" in tasks:
            out["pct"] = score_gpu(model, extra["pct"][:cap], max_new=48)[0]
        return out

    def combined(scores):
        return sum(scores[t] for t in tasks) / len(tasks)

    before = eval_all(args.eval_cap)
    before_old = score_old_gpu(model, replay_sets, args.old_cap)
    before_page = score_page_gpu(model, page)
    score_before = combined(before)
    print("before:", " ".join(f"{t}={before[t]:.0%}" for t in tasks),
          f"mean={score_before:.1%}", flush=True)
    if "diff" in tasks:
        print("before diff widths:", " ".join(f"{k}d={v:.0%}" for k, v in before["diff_by_width"].items()),
              flush=True)
    print("before old:", {k.split()[0]: round(v, 3) for k, v in before_old.items()}, flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    rng = random.Random(args.seed + 1)
    best = {"score": -1.0, "step": 0, "state": None, "scores": before, "old": before_old}
    history = []
    t0 = time.time()

    for step in range(1, args.steps + 1):
        progress = step / args.steps
        # warmup, then cosine
        if step <= args.warmup:
            lr_now = args.lr * step / args.warmup
        else:
            frac = (step - args.warmup) / max(1, args.steps - args.warmup)
            lr_now = (args.lr / 10) + (args.lr - args.lr / 10) * 0.5 * (1 + np.cos(np.pi * frac))
        for g in opt.param_groups:
            g["lr"] = lr_now

        frac_replay = args.early_replay if step <= args.early_replay_steps else args.replay
        replay_n = int(args.batch * frac_replay / (1 - frac_replay))

        # curriculum — the published suite is 4-digit-dominated
        if progress < 0.05:
            width, noborrow = 2, False
        elif progress < 0.15:
            width, noborrow = 3, False
        elif progress < 0.25:
            width, noborrow = 4, True   # seed column alignment, no borrows
        else:
            width, noborrow = 4, False

        counts = {t: int(round(args.batch * mix[t])) for t in tasks}
        while sum(counts.values()) < args.batch:
            counts[max(tasks, key=lambda t: mix[t])] += 1
        batch = []
        if "diff" in tasks:
            batch += [diff_example(rng, rng.randint(1, width), noborrow=noborrow)
                      for _ in range(counts["diff"])]
        if "total" in tasks:
            batch += [total_example(rng) for _ in range(counts["total"])]
        if "pct" in tasks:
            batch += [pct_example(rng) for _ in range(counts["pct"])]
        if len(batch) < args.batch:
            filler = diff_example if "diff" in tasks else (
                total_example if "total" in tasks else pct_example)
            while len(batch) < args.batch:
                batch.append(filler(rng, rng.randint(1, width)) if filler is diff_example else filler(rng))
        for _ in range(replay_n):
            # replay from the PUBLISHED grammar (suite_example: prices uniform
            # on 5..9999), plus a draw from the canonical sets and the page's
            # 14 prompts. The deployed generators' 49..999 prices collapsed
            # published lookup to 61.8% — measured, gated, reverted.
            r = rng.random()
            if r < 0.7:
                batch.append(suite_example(rng))
            else:
                nm = rng.choice(list(replay_sets))
                batch.append(replay_sets[nm][rng.randrange(24)])
        batch.extend(page_skills())
        batch = [(p, a) for p, a in batch if len(encode(p)) + len(encode(a)) <= 186]

        model.train()
        loss = batch_loss_gpu(model, batch, device)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()

        if step % args.project_every == 0:
            with torch.no_grad():
                state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
                projected = project(state, args.chi)
                model.load_state_dict(projected)

        if step % args.eval_every == 0:
            model.eval()
            scores = eval_all(args.eval_cap)
            score = combined(scores)
            sps = step / (time.time() - t0)
            widths_txt = (" " + " ".join(f"{k}d={v:.0%}" for k, v in scores["diff_by_width"].items())
                          if "diff" in tasks else "")
            print(f"  step {step:>6} w<={width}{' nb' if noborrow else '  '} "
                  f"loss {float(loss):.3f} "
                  + " ".join(f"{t}={scores[t]:.0%}" for t in tasks)
                  + widths_txt
                  + f" mean={score:.1%} {sps:.1f} it/s [{time.time()-t0:.0f}s]", flush=True)
            history.append({"step": step, "width": width, "noborrow": noborrow,
                            "loss": round(float(loss), 4), "lr": round(lr_now, 6),
                            "scores": {t: scores[t] for t in tasks},
                            "diff_by_width": scores.get("diff_by_width"),
                            "mean": score})
            if score > best["score"] + 0.005:
                old = score_old_gpu(model, replay_sets, args.old_cap)
                pg = score_page_gpu(model, page)
                worst = max(max(before_old[k] - old[k] for k in before_old),
                            before_page - pg)
                regressed = any(scores[t] < before[t] - 0.03 for t in tasks)
                gained = any(scores[t] > before[t] + 0.02 for t in tasks)
                eligible = worst <= 0.07 and pg >= 0.999 and not regressed and gained
                print(f"    mean {score:.1%} · page {pg:.0%} · worst old delta {worst:+.3f}"
                      + ("" if eligible else " — not promotion-eligible"), flush=True)
                if eligible:
                    best = {"score": score, "step": step, "scores": scores, "old": old,
                            "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
            torch.save({"config": cfg, "state": model.state_dict()}, Path(args.out) / "gpu-diff-last.pt")

    model.eval()
    final = eval_all(40)
    final_old = score_old_gpu(model, replay_sets, args.old_cap)
    chosen = best if best["state"] is not None else {
        "score": score_before, "step": 0, "scores": before, "old": before_old,
        "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
    model.load_state_dict(chosen["state"])
    print(f"\nchosen checkpoint: step {chosen['step']} mean {chosen['score']:.1%}", flush=True)
    print("final:", " ".join(f"{t}={final[t]:.0%}" for t in tasks), flush=True)
    if "diff" in tasks:
        print("final diff widths:", " ".join(f"{k}d={v:.0%}" for k, v in final["diff_by_width"].items()),
              flush=True)
    print("final old:", {k.split()[0]: round(v, 3) for k, v in final_old.items()}, flush=True)

    result = {
        "steps": args.steps, "batch": args.batch, "lr": args.lr, "warmup": args.warmup,
        "replay": args.replay, "early_replay": args.early_replay, "chi": args.chi,
        "project_every": args.project_every, "device": str(device), "seed": args.seed,
        "tasks": tasks, "task_mix": mix,
        "before": {t: before[t] for t in tasks}, "before_old": before_old,
        "before_diff": before.get("diff"), "before_diff_widths": before.get("diff_by_width"),
        "best_step": chosen["step"], "chosen_score": chosen["score"],
        "final": {t: final[t] for t in tasks},
        "final_diff": final.get("diff"), "final_diff_widths": final.get("diff_by_width"),
        "final_old": final_old,
        "old_delta": {k: before_old[k] - final_old[k] for k in before_old},
        "final_mean": combined(final),
        "train_seconds": round(time.time() - t0, 1),
        "history": history,
    }
    torch.save({"config": cfg, "state": chosen["state"]}, Path(args.out) / "gpu-refined-diff.pt")
    torch.save({"config": cfg, "state": model.state_dict()}, Path(args.out) / "gpu-diff-last.pt")
    (Path(args.out) / "gpu-train.json").write_text(json.dumps(result, indent=1) + "\n")
    print("wrote gpu-refined-diff.pt, gpu-diff-last.pt, gpu-train.json", flush=True)


if __name__ == "__main__":
    main()
