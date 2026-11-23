"""Probe: can the χ=48 byte model learn 2-digit subtraction at all?

If it cannot learn the smallest instance, no curriculum will reach 4 digits and
the honest conclusion is architectural. If it can, the curriculum is the lever.

    python tools/entangle/_probe_arith.py --digits 2 --steps 600
"""
import argparse
import random
import sys
import time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from teach_ledger import (  # noqa: E402
    TinyLM, VOCAB, EOS, encode, batch_loss, project, make_name, diff_example, money,
)
import task  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--digits", type=int, default=2)
    ap.add_argument("--steps", type=int, default=600)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--replay", type=float, default=0.5)
    ap.add_argument("--chi", type=int, default=48)
    args = ap.parse_args()

    torch.manual_seed(7)
    ck = torch.load(HERE / "refined-chi48.pt", map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])

    def held_set(n=40, seed=99):
        rng = random.Random(seed)
        out = []
        while len(out) < n:
            p, a = diff_example(rng, args.digits)
            if len(encode(p)) + len(encode(a)) <= 186:
                out.append((p, a))
        return out

    held = held_set()
    replay = task.eval_sets(4242)

    def score():
        from model import batched_generate
        got = batched_generate(model, [p for p, _ in held], max_new=24, temperature=0.0)
        return sum(1 for (_, want), g in zip(held, got) if g == want) / len(held), got[:3]

    def old():
        from model import batched_generate
        out = {}
        for name, samples in replay.items():
            sub = samples[:16]
            got = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
            out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, got)) / len(sub)
        return out

    acc, samples = score()
    print(f"{args.digits}-digit diff — before {acc:.2%}  sample={samples[:2]}")
    print("old before", {k: round(v, 2) for k, v in old().items()}, flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    rng = random.Random(11)
    t0 = time.time()
    for step in range(1, args.steps + 1):
        batch = [diff_example(rng, args.digits) for _ in range(16)]
        for _ in range(int(16 * args.replay / (1 - args.replay))):
            name = rng.choice(list(replay))
            batch.append(replay[name][rng.randrange(24)])
        batch = [(p, a) for p, a in batch if len(encode(p)) + len(encode(a)) <= 186]
        model.train()
        loss = batch_loss(model, batch)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % 10 == 0:
            model.eval()
            with torch.no_grad():
                model.load_state_dict(project(model.state_dict(), args.chi))
        if step % 100 == 0:
            model.eval()
            acc, samples = score()
            print(f"  step {step:>4} loss {float(loss):.3f} acc {acc:.2%} sample={samples[:1]} [{time.time()-t0:.0f}s]", flush=True)
    acc, samples = score()
    print(f"final {args.digits}-digit diff {acc:.2%}")
    print("old after", {k: round(v, 2) for k, v in old().items()})


if __name__ == "__main__":
    main()
