"""The fourth base: more capacity, aimed at the last measured model edge.

The 1.3M-parameter base-v3 holds 3-row wide mixed-length comparison at
~80-83% held-out — its failures are digit-splices ($899 between $89 and
$999). Three focused RL generations held that line without lifting it, so
this base adds capacity (8 layers, ffn 512 — 2.14M parameters, +62%) and a
curriculum that gives the edge its own stage, instead of the 3% share the
generic mix gave it:

  steps 0-1500     same-length 2-row comparisons (the base circuit)
  steps 1500-3000  + 3-row same-length, + 2-row mixed-length
  steps 3000-6000  + wide 3-row mixed-length at a dedicated 30% share

S3 (the in-model refusal) keeps a small share: the route already refuses
deterministically, but if the extra capacity learns the first-token switch,
the loop can prove it.

    python3.11 train_v4.py --steps 6000 --out base-v4.pt
"""

import argparse
import random
import sys
import time
from pathlib import Path

import torch

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / ".." / ".." / "models" / "live-host-lm"))
from train import EOS, VOCAB, TinyLM  # noqa: E402
import task  # noqa: E402
from train_v2 import encode_pair, greedy_answer  # noqa: E402


def batch_rows(rng, size, step):
    """Curriculum: every stage keeps the previous skills in the mix."""
    stage = 0 if step < 1500 else (1 if step < 3000 else 2)
    rows = []
    for _ in range(size):
        roll = rng.random()
        if roll < 0.40:
            rows.append(task.s0_example(rng))
        elif roll < 0.58:
            rows.append(task.comp_example(rng, rng.choice(["cheapest", "priciest"]),
                                          n_rows=2 if stage == 0 else None,
                                          mixed=False))
        elif roll < 0.70:
            # stage 1+: mixed-length 2/3-row comparisons
            rows.append(task.comp_example(rng, rng.choice(["cheapest", "priciest"]),
                                          mixed=stage >= 1, n_rows=2 if stage == 0 else None))
        elif roll < 0.92 and stage >= 2:
            # the dedicated wide-3-row-mixed stage (the measured weak edge)
            rows.append(task._comp3_mixed(rng, rng.choice(["cheapest", "priciest"])))
        elif roll < 0.92:
            rows.append(task.comp_example(rng, rng.choice(["cheapest", "priciest"]), mixed=False))
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
    ap.add_argument("--layers", type=int, default=8)
    ap.add_argument("--d", type=int, default=128)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--ffn", type=int, default=512)
    ap.add_argument("--ctx", type=int, default=192)
    ap.add_argument("--seed", type=int, default=47)
    ap.add_argument("--out", default="base-v4.pt")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    model = TinyLM(VOCAB, args.d, args.layers, args.heads, args.ffn, args.ctx)
    params = sum(p.numel() for p in model.parameters())
    print(f"base-v4: {params:,} parameters ({args.layers} layers, d={args.d}, "
          f"ffn={args.ffn}, ctx={args.ctx})", flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    warmup = 100
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt,
        lambda s: min(1.0, (s + 1) / warmup)
        * (0.1 + 0.9 * 0.5 * (1 + torch.cos(torch.tensor(3.14159 * min(1.0, s / args.steps))))),
    )

    t0 = time.time()
    for step in range(1, args.steps + 1):
        rows = batch_rows(rng, args.batch, step)
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
