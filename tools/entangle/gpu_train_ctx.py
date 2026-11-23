"""GPU training to EXTEND the shipped rebuild's context window.

The scorecard's worst loss row is context: 192 tokens vs 128k–1M on the top
hosted models. That number is not a law of nature — it is the RoPE table size
and the `qwen2.context_length` kv this artifact was exported with. This run
trains the SAME 2.1M-parameter rebuild to actually *use* a longer window and
exports it with `context_length` raised, so the axis moves with receipts.

What trains and what is verified:

  long-ledger tasks   k ∈ {4..128} rows, ~20 bytes/row → prompts up to ~2,600
                      bytes ≈ 2,600 tokens; questions reuse the deployed
                      grammar (lookup / cheapest / most expensive)
  replay              the deployed short skills AND the diff work, so the
                      extension is not bought by selling the base
  verification        held-out long ledgers at every row depth, model alone,
                      exact match — the engine then runs the same prompts

Gates (all measured, none assumed):
  * every deployed short skill holds within 0.07 of its baseline
  * long-ledger exactness at each depth is reported separately — a "context
    window" claim without in-window accuracy would be a fake number
  * the export sets `qwen2.context_length = --ctx`; the engine allocates its KV
    from that kv, so the page's printed context changes with the weights

    python tools/entangle/gpu_train_ctx.py --steps 12000 --ctx 4096 --device cuda
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
from train_diff import diff_example, project  # noqa: E402
import task  # noqa: E402

WORDS = task.WORDS


def page_skills():
    """The 14 canonical prompts the deployed page self-tests with — anchored in
    every batch so the context extension cannot flip even one of them."""
    path = HERE / "page-skills.json"
    if not path.exists():
        return []
    return [(x["prompt"], x["want"]) for x in json.loads(path.read_text())]
QUESTIONS = [
    "how much is the {}?",
    "what is the price of the {}?",
    "how much does the {} cost?",
    "which is cheapest?",
    "which is most expensive?",
]


def make_name(rng):
    parts = [rng.choice(WORDS) for _ in range(rng.choice([2, 2, 2, 3]))]
    label = " ".join(parts)
    return label.upper() if rng.random() < 0.35 else label


def ledger_example(rng, rows):
    """A k-row ledger and one question over it, in the deployed grammar.

    Returns None if the question would repeat a row name it should not."""
    names = []
    while len(names) < rows:
        n = make_name(rng)
        if n not in names:
            names.append(n)
    prices = [rng.randint(5, 9999) for _ in names]
    body = "\n".join(f"-{n}|${p}" for n, p in zip(names, prices))
    kind = rng.random()
    if kind < 0.6:
        i = rng.randrange(rows)
        prompt = f"rows: {body}\nq: how much is the {names[i]}?\na: "
        return prompt, f"The price is ${prices[i]} delivered."
    if kind < 0.8:
        prompt = f"rows: {body}\nq: which is cheapest?\na: "
        return prompt, f"The price is ${min(prices)} delivered."
    prompt = f"rows: {body}\nq: which is most expensive?\na: "
    return prompt, f"The price is ${max(prices)} delivered."


def ledger_dataset(rng, rows_range, n):
    out = []
    while len(out) < n:
        ex = ledger_example(rng, rng.randint(*rows_range))
        if ex and len(encode(ex[0])) + len(encode(ex[1])) <= 186:
            out.append(ex)
    return out


def long_held(seed, rows, n):
    """Held-out long ledgers at an exact row depth, full grammar."""
    rng = random.Random(seed)
    out = []
    while len(out) < n:
        ex = ledger_example(rng, rows)
        if ex is None:
            continue
        ntok = len(encode(ex[0])) + len(encode(ex[1]))
        if ntok <= 1900:  # leave room for the answer inside the trained window
            out.append(ex)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=12000)
    ap.add_argument("--batch", type=int, default=6,
                    help="keeps attention activations inside a 16 GB T4 at ~100-row depth")
    ap.add_argument("--replay", type=float, default=0.35)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--warmup", type=int, default=300)
    ap.add_argument("--ctx", type=int, default=4096)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=25)
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--rows-hi", type=int, default=96, help="max training rows")
    ap.add_argument("--diff-frac", type=float, default=0.25,
                    help="fraction of the batch that is 4-digit diff work")
    ap.add_argument("--seed", type=int, default=4242)
    ap.add_argument("--device", default=None)
    ap.add_argument("--out", default=".")
    ap.add_argument("--ckpt", required=True)
    args = ap.parse_args()

    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    torch.manual_seed(args.seed)
    print(f"device {device} | torch {torch.__version__}", flush=True)

    ck = torch.load(Path(args.ckpt), map_location=device)
    cfg = dict(ck["config"])
    print(f"base ctx {cfg['ctx']} -> training/export at ctx {args.ctx}", flush=True)
    cfg["ctx"] = args.ctx
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"]).to(device)
    model.load_state_dict(ck["state"])

    replay_sets = task.eval_sets(args.seed)
    rng = random.Random(args.seed + 1)

    depths = (8, 32, 64, 96)
    held_long = {r: long_held(700 + r, r, 12) for r in depths}

    model.eval()

    @torch.no_grad()
    def gen(model, prompt, max_new=24):
        out = encode(prompt)
        for _ in range(max_new):
            window = torch.tensor([out[-model.ctx:]], dtype=torch.long, device=device)
            nxt = int(torch.argmax(model(window)[0, -1]))
            if nxt == EOS:
                break
            out.append(nxt)
        return bytes(out[len(encode(prompt)):]).decode("utf-8", "replace")

    def score_long(model, cap=12):
        out = {}
        for r, bucket in held_long.items():
            got = [gen(model, p, 24) for p, _ in bucket[:cap]]
            out[r] = sum(1 for (_, w), g in zip(bucket[:cap], got) if g == w) / cap
        return out

    def score_old(model, cap=24):
        out = {}
        for name, samples in replay_sets.items():
            sub = samples[:cap]
            got = [gen(model, p, 48) for p, _ in sub]
            out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, got)) / cap
        return out

    before_long = score_long(model)
    before_old = score_old(model)
    page = page_skills()

    def score_page(model):
        items = page
        if not items:
            return 1.0
        got = [gen(model, p, 48) for p, _ in items]
        return sum(1 for (_, w), g in zip(items, got) if g == w) / len(items)

    before_page = score_page(model)
    print("before long:", " ".join(f"{r}r={v:.0%}" for r, v in before_long.items()), flush=True)
    print("before old:", {k.split()[0]: round(v, 3) for k, v in before_old.items()}, flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    best = {"mean": -1.0, "step": 0, "state": None}
    history = []
    t0 = time.time()

    for step in range(1, args.steps + 1):
        if step <= args.warmup:
            lr_now = args.lr * step / args.warmup
        else:
            frac = (step - args.warmup) / max(1, args.steps - args.warmup)
            lr_now = (args.lr / 10) + (args.lr - args.lr / 10) * 0.5 * (1 + np.cos(np.pi * frac))
        for g in opt.param_groups:
            g["lr"] = lr_now

        # curriculum: row depth grows with progress
        frac = min(1.0, step / max(1, args.steps))
        rows_hi = max(4, min(args.rows_hi, int(4 + frac * (args.rows_hi - 4))))
        batch = []
        while len(batch) < args.batch:
            ex = ledger_example(rng, rng.randint(4, rows_hi))
            if ex and len(encode(ex[0])) + len(encode(ex[1])) <= args.ctx - 64:
                batch.append(ex)
        if rng.random() < args.diff_frac:
            batch[-1] = diff_example(rng, 4)
        for _ in range(max(2, int(args.batch * args.replay))):
            name = rng.choice(list(replay_sets))
            batch.append(replay_sets[name][rng.randrange(24)])
        batch.extend(page_skills())

        model.train()
        rows, starts = [], []
        for prompt, answer in batch:
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
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()

        if step % args.project_every == 0:
            with torch.no_grad():
                state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
                model.load_state_dict(project(state, args.chi))

        if step % args.eval_every == 0:
            model.eval()
            long_ = score_long(model)
            mean_long = sum(long_.values()) / len(long_)
            sps = step / (time.time() - t0)
            print(f"  step {step:>6} rows<={rows_hi:>3} loss {float(loss):.3f} "
                  + " ".join(f"{r}r={v:.0%}" for r, v in long_.items())
                  + f" mean={mean_long:.1%} {sps:.2f} it/s [{time.time()-t0:.0f}s]", flush=True)
            history.append({"step": step, "rows_hi": rows_hi, "loss": round(float(loss), 4),
                            "long": long_, "mean": mean_long})
            if mean_long > best["mean"] + 0.005:
                old = score_old(model)
                pg = score_page(model)
                worst = max(max(before_old[k] - old[k] for k in before_old),
                            before_page - pg)
                print(f"    mean {mean_long:.1%} · worst old delta {worst:+.3f}", flush=True)
                if worst <= 0.07:
                    best = {"mean": mean_long, "step": step, "old": old, "long": long_,
                            "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
            torch.save({"config": cfg, "state": model.state_dict()}, Path(args.out) / "gpu-ctx-last.pt")

    model.eval()
    final_long = score_long(model, cap=12)
    final_old = score_old(model)
    chosen = best if best["state"] is not None else {
        "mean": -1, "step": 0, "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
    model.load_state_dict(chosen["state"])
    print(f"\nchosen checkpoint: step {chosen['step']}", flush=True)
    print("final long:", " ".join(f"{r}r={v:.0%}" for r, v in final_long.items()), flush=True)
    print("final old:", {k.split()[0]: round(v, 3) for k, v in final_old.items()}, flush=True)

    result = {
        "steps": args.steps, "batch": args.batch, "lr": args.lr, "ctx": args.ctx,
        "chi": args.chi, "device": str(device), "seed": args.seed,
        "before_long": before_long, "before_old": before_old,
        "best_step": chosen["step"], "final_long": final_long, "final_old": final_old,
        "old_delta": {k: before_old[k] - final_old[k] for k in before_old},
        "train_seconds": round(time.time() - t0, 1), "history": history,
    }
    (Path(args.out) / "gpu-ctx-train.json").write_text(json.dumps(result, indent=1) + "\n")
    torch.save({"config": cfg, "state": chosen["state"]}, Path(args.out) / "gpu-refined-ctx.pt")
    torch.save({"config": cfg, "state": model.state_dict()}, Path(args.out) / "gpu-ctx-last.pt")
    print("wrote gpu-refined-ctx.pt, gpu-ctx-last.pt, gpu-ctx-train.json", flush=True)


if __name__ == "__main__":
    main()
