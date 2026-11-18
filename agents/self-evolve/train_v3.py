"""The third base: every skill at once, including the two limits v2 had.

v2's documented limits, attacked here:
  - mixed digit-length comparison ("$86" vs "$994") — taught as a curriculum
    step after the same-length circuit is in (step --mixed-at);
  - non-price questions got prices anyway — S3 teaches the refusal, and the
    checker scores a price answered to a non-price question 0.0.

    python3.11 train_v3.py --steps 6000 --out base-v3.pt
"""

import argparse
import random
import sys
import time
from pathlib import Path

import torch

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / ".." / ".." / "models" / "live-host-lm"))
from train import EOS, VOCAB, TinyLM, encode  # noqa: E402
import task  # noqa: E402
from train_v2 import encode_pair, greedy_answer  # noqa: E402


def batch_rows(rng, size, step, mixed_at):
    rows = []
    for _ in range(size):
        roll = rng.random()
        if roll < 0.42:
            rows.append(task.s0_example(rng))
        elif roll < 0.60:
            rows.append(task.comp_example(rng, "cheapest", mixed=step >= mixed_at))
        elif roll < 0.78:
            rows.append(task.comp_example(rng, "priciest", mixed=step >= mixed_at))
        else:
            rows.append(task.s3_example(rng))
    return rows


def evaluate(model, n=50):
    was_training = model.training
    model.eval()
    rng = random.Random(4242)
    sets = task.eval_sets()
    out = {}
    for name, samples in sets.items():
        hits = sum(task.reward(p, greedy_answer(model, p)) == 1.0 for p, _ in samples[:n])
        out[name] = hits / min(n, len(samples))
    if was_training:
        model.train()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--layers", type=int, default=6)
    ap.add_argument("--d", type=int, default=128)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--ffn", type=int, default=384)
    ap.add_argument("--ctx", type=int, default=192)
    ap.add_argument("--mixed-at", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=31)
    ap.add_argument("--out", default="base-v3.pt")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    model = TinyLM(VOCAB, args.d, args.layers, args.heads, args.ffn, args.ctx)
    params = sum(p.numel() for p in model.parameters())
    print(f"base-v3: {params:,} parameters ({args.layers} layers, d={args.d}, ctx={args.ctx})", flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    warmup = 100
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt,
        lambda s: min(1.0, (s + 1) / warmup)
        * (0.1 + 0.9 * 0.5 * (1 + torch.cos(torch.tensor(3.14159 * min(1.0, s / args.steps))))),
    )

    t0 = time.time()
    for step in range(1, args.steps + 1):
        rows = batch_rows(rng, args.batch, step, args.mixed_at)
        pairs = [encode_pair(p, a) for p, a in rows]
        width = max(len(ids) for ids, _ in pairs)
        ids = torch.full((len(pairs), width), EOS, dtype=torch.long)
        targets = torch.full((len(pairs), width), -100, dtype=torch.long)
        for i, (row, tgt) in enumerate(pairs):
            ids[i, : len(row)] = torch.tensor(row)
            targets[i, : len(row)] = torch.tensor(tgt)
        logits, loss = model(ids, targets)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        if step % 500 == 0 or step == 1:
            scores = evaluate(model, n=25)
            elapsed = time.time() - t0
            print(f"step {step:5d}  loss {loss.item():.4f}  "
                  + "  ".join(f"{k.split()[0]} {v*100:.0f}%" for k, v in scores.items())
                  + f"  eta {(elapsed/step)*(args.steps-step)/60:.0f} min", flush=True)

    scores = evaluate(model, n=60)
    print("final held-out:", {k: round(v, 3) for k, v in scores.items()}, flush=True)
    torch.save({"config": {
        "steps": args.steps, "batch": args.batch, "lr": args.lr, "d": args.d,
        "layers": args.layers, "heads": args.heads, "ffn": args.ffn,
        "ctx": args.ctx, "seed": args.seed,
    }, "state": model.state_dict(), "scores": scores}, args.out)
    print(f"wrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
