"""The next base model: all three skills trained in from scratch.

Evidence from eight RL generations: policy-gradient methods (REINFORCE,
self-imitation, DAgger corrections) moved the SAMPLED policy but could not
build the price-comparison circuit the greedy mode needs — the mode stayed at
"copy row 1" (the base rate). Copying, by contrast, was learned to 100% from
scratch by plain supervised training. So the new base gets every skill as
supervised gold from step 1 (the answers are computed, not model-generated —
the same checker that gates promotion defines the gold), and the relentless RL
loop takes it from there to polish, harden, and extend.

Curriculum: 2-row comparisons first; 3-row examples join after step 2500.

    python3.11 train_v2.py --steps 6000 --out base-v2.pt
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


def batch_rows(rng, size, step, widen_at):
    rows = []
    for _ in range(size):
        roll = rng.random()
        if roll < 0.5:
            rows.append(task.s0_example(rng))
        elif roll < 0.75:
            rows.append(task.comp_example(rng, "cheapest", n_rows=None if step >= widen_at else 2))
        else:
            rows.append(task.comp_example(rng, "priciest", n_rows=None if step >= widen_at else 2))
    return rows


def encode_pair(prompt: str, answer: str):
    ids = encode(prompt) + encode(answer) + [EOS]
    first = len(encode(prompt))
    target = [-100] * first + ids[first:]
    return ids, target


@torch.no_grad()
def greedy_answer(model, prompt, max_new=48):
    ids = encode(prompt)
    for _ in range(max_new):
        logits = model(torch.tensor([ids[-model.ctx:]], dtype=torch.long))
        nxt = int(torch.argmax(logits[0, -1]))
        if nxt == EOS:
            break
        ids.append(nxt)
    return bytes(ids[len(encode(prompt)):]).decode("utf-8", "replace")


def evaluate(model, n=60):
    import torch as _t

    was_training = model.training
    model.eval()
    rng = random.Random(777)
    out = {}
    sets = {
        "S0": [task.s0_example(rng) for _ in range(n)],
        "S1": [task.comp_example(rng, "cheapest") for _ in range(n)],
        "S2": [task.comp_example(rng, "priciest") for _ in range(n)],
    }
    for name, samples in sets.items():
        hits = sum(task.reward(p, greedy_answer(model, p)) == 1.0 for p, _ in samples)
        out[name] = hits / len(samples)
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
    ap.add_argument("--widen-at", type=int, default=2500)
    ap.add_argument("--seed", type=int, default=23)
    ap.add_argument("--out", default="base-v2.pt")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    model = TinyLM(VOCAB, args.d, args.layers, args.heads, args.ffn, args.ctx)
    params = sum(p.numel() for p in model.parameters())
    print(f"base-v2: {params:,} parameters ({args.layers} layers, d={args.d}, ctx={args.ctx})", flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    warmup = 100
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt,
        lambda s: min(1.0, (s + 1) / warmup)
        * (0.1 + 0.9 * 0.5 * (1 + torch.cos(torch.tensor(3.14159 * min(1.0, s / args.steps))))),
    )

    t0 = time.time()
    for step in range(1, args.steps + 1):
        rows = batch_rows(rng, args.batch, step, args.widen_at)
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
            scores = evaluate(model, n=30)
            elapsed = time.time() - t0
            print(f"step {step:5d}  loss {loss.item():.4f}  "
                  + "  ".join(f"{k} {v*100:.0f}%" for k, v in scores.items())
                  + f"  eta {(elapsed/step)*(args.steps-step)/60:.0f} min", flush=True)

    scores = evaluate(model, n=80)
    print("final held-out:", {k: round(v, 3) for k, v in scores.items()}, flush=True)
    torch.save({"config": {
        "steps": args.steps, "batch": args.batch, "lr": args.lr, "d": args.d,
        "layers": args.layers, "heads": args.heads, "ffn": args.ffn,
        "ctx": args.ctx, "seed": args.seed,
    }, "state": model.state_dict(), "scores": scores}, args.out)
    print(f"wrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
