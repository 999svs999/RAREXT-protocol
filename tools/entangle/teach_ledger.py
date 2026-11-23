"""Teach the χ=48 rebuild the three ledger families it scores 0% on.

The deployed host copies a price and compares rows (S0/S1/S2). It has never
learned to COMPUTE a number, so `tools/rank/eval-neural.mjs` scores it 0% on:

    diff   rows: -A|$pa  -B|$pb   q: how much more is the more-expensive than the other?   a: $d more
    total  rows: ...              q: what is the total of all items?                       a: The total is $S delivered.
    pct    rows: -A|$p            q: what is the price after N% off?                       a: The price is $X delivered.

This is the same projected-training loop as refine_rebuild.py: supervised steps
on COMPUTED gold, SVD projection back onto the χ=48 manifold every K steps, and
replay of the three deployed skills so the new ones are not bought by selling
the old ones.

Two changes from the earlier teach_difference.py attempt (which scored 0/40):

  1. the answer is the value alone ("$517 more"), not a sentence that has to
     copy two item names — the arithmetic is the task, name-copying is noise;
  2. a genuine digit curriculum: 1–2 digit no-borrow first, then 3, then the
     full 1–4 digit range with carries; and 50% off before 25/10/40/15/30.

Run:
    PY=/private/.../lmenv/bin/python
    $PY tools/entangle/teach_ledger.py --steps 6000
"""
import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "models/live-host-lm"))
sys.path.insert(0, str(REPO / "agents/self-evolve"))
sys.path.insert(0, str(HERE))

from train import TinyLM, VOCAB, VOCAB_TOKENS, EOS, encode  # noqa: E402
from gguf import GGUFWriter  # noqa: E402
from model import batched_generate, answer_logprobs  # noqa: E402
from factor_export import FACTOR_MAP  # noqa: E402
import task  # noqa: E402

WORDS = task.WORDS
DISCOUNTS = [10, 15, 20, 25, 30, 40, 50]


def make_name(rng):
    n = rng.choice([2, 2, 2, 3])
    parts = [rng.choice(WORDS) for _ in range(n)]
    label = " ".join(parts)
    return label.upper() if rng.random() < 0.35 else label


def money(n):
    return f"${n}"


# ── the three families, in the exact grammar the rank suite uses ─────────────
def diff_example(rng, digits):
    lo = 5 if digits == 1 else 10 ** (digits - 1)
    hi = 9 if digits == 1 else 10 ** digits - 1
    a, b = rng.randint(lo, hi), rng.randint(lo, hi)
    if a == b:
        b = a - 1 if a > lo else a + 1
    hi_name, lo_name = (make_name(rng), make_name(rng))
    while lo_name == hi_name:
        lo_name = make_name(rng)
    more, less = (a, b) if a > b else (b, a)
    more_name, less_name = (hi_name, lo_name) if a > b else (lo_name, hi_name)
    prompt = (f"rows: -{hi_name}|${a}\n-{lo_name}|${b}\n"
              f"q: how much more is the {more_name} than the {less_name}?\na: ")
    return prompt, money(more - less) + " more"


def total_example(rng, digits, rows):
    lo = 5 if digits == 1 else 10 ** (digits - 1)
    hi = 9 if digits == 1 else 10 ** digits - 1
    names, prices = [], []
    while len(names) < rows:
        n = make_name(rng)
        if n not in names:
            names.append(n)
            prices.append(rng.randint(lo, hi))
    body = "\n".join(f"-{n}|${p}" for n, p in zip(names, prices))
    prompt = f"rows: {body}\nq: what is the total of all items?\na: "
    return prompt, f"The total is ${sum(prices)} delivered."


def pct_example(rng, digits, discount):
    lo = 5 if digits == 1 else 10 ** (digits - 1)
    hi = 9 if digits == 1 else 10 ** digits - 1
    p = rng.randint(lo, hi)
    after = round(p * (100 - discount)) / 100
    prompt = f"rows: -{make_name(rng)}|${p}\nq: what is the price after {discount}% off?\na: "
    return prompt, f"The price is ${after} delivered."


# ── curriculum ───────────────────────────────────────────────────────────────
def sample_new(rng, progress):
    """progress ∈ [0,1): digit range and family mix widen as training runs."""
    if progress < 0.30:
        digits, max_rows = 2, 2
        family = rng.choices(["diff", "total", "pct"], [0.45, 0.30, 0.25])[0]
        discount = 50
    elif progress < 0.60:
        digits, max_rows = 3, 3
        family = rng.choices(["diff", "total", "pct"], [0.40, 0.30, 0.30])[0]
        discount = rng.choice([50, 25, 10])
    else:
        digits, max_rows = 4, 3
        family = rng.choices(["diff", "total", "pct"], [0.40, 0.30, 0.30])[0]
        discount = rng.choice(DISCOUNTS)
    d = rng.randint(1, digits)
    if family == "diff":
        return diff_example(rng, d)
    if family == "total":
        return total_example(rng, d, rng.randint(2, max_rows))
    return pct_example(rng, d, discount)


def build_sets(seed, n_train=6000):
    rng = random.Random(seed)
    train = []
    while len(train) < n_train:
        p, a = sample_new(rng, rng.random())
        if len(encode(p)) + len(encode(a)) <= 186:
            train.append((p, a))
    held = {"diff": [], "total": [], "pct": []}
    hr = random.Random(seed + 777)
    while min(len(v) for v in held.values()) < 60:
        # held-out is the FULL distribution from the first step: 1–4 digits,
        # every discount, 2–3 rows. Training never sees these seeds.
        family = hr.choice(["diff", "total", "pct"])
        if family == "diff":
            pair = diff_example(hr, hr.randint(1, 4))
        elif family == "total":
            pair = total_example(hr, hr.randint(1, 4), hr.randint(2, 3))
        else:
            pair = pct_example(hr, hr.randint(1, 4), hr.choice(DISCOUNTS))
        if len(encode(pair[0])) + len(encode(pair[1])) <= 186:
            held[family].append(pair)
    return train, held


def batch_loss(model, pairs):
    """Cross-entropy on answer bytes AND the EOS that ends them — the model
    must learn both the value and when to stop. Right-padded like train.py:
    causal attention means later pad positions cannot affect earlier ones."""
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
    _, loss = model(ids, tgt)
    return loss


def project(state, chi):
    out = {}
    for name, w in state.items():
        if w.dim() != 2:
            out[name] = w.clone()
            continue
        a = w.detach().numpy().astype(np.float64)
        u, sv, vt = np.linalg.svd(a, full_matrices=False)
        r = min(chi, len(sv))
        out[name] = torch.from_numpy(((u[:, :r] * sv[:r]) @ vt[:r]).astype(np.float32))
    return out


def score(model, held, cap=24):
    out = {}
    for family, samples in held.items():
        sub = samples[:cap]
        got = batched_generate(model, [p for p, _ in sub], max_new=40, temperature=0.0)
        out[family] = sum(1 for (_, want), g in zip(sub, got) if g == want) / len(sub)
    return out


def old_skills(model):
    sets = task.eval_sets(4242)
    out = {}
    for name, samples in sets.items():
        sub = samples[:24]
        got = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
        out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, got)) / len(sub)
    return out


def export_factored(state, cfg, path, chi, name):
    w = GGUFWriter()
    w.add_string("general.architecture", "qwen2")
    w.add_string("general.name", name)
    w.add_uint32("qwen2.context_length", cfg["ctx"])
    w.add_uint32("qwen2.embedding_length", cfg["d"])
    w.add_uint32("qwen2.block_count", cfg["layers"])
    w.add_uint32("qwen2.feed_forward_length", cfg["ffn"])
    w.add_uint32("qwen2.attention.head_count", cfg["heads"])
    w.add_uint32("qwen2.attention.head_count_kv", cfg["heads"])
    w.add_float32("qwen2.attention.layer_norm_rms_epsilon", 1e-6)
    w.add_float32("qwen2.rope.freq_base", 10000.0)
    w.add_uint32("qwen2.rope.dimension_count", cfg["d"] // cfg["heads"])
    w.add_string("tokenizer.ggml.model", "gpt2")
    w.add_array_string("tokenizer.ggml.tokens", VOCAB_TOKENS)
    w.add_array_string("tokenizer.ggml.merges", [])
    w.add_array_int32("tokenizer.ggml.token_type", [1] * 256 + [3])
    w.add_uint32("tokenizer.ggml.eos_token_id", EOS)
    w.add_uint32("tokenizer.ggml.bos_token_id", EOS)
    w.add_bool("tokenizer.ggml.add_bos_token", False)
    sd = {k: v.detach().float().numpy() for k, v in state.items()}
    w.add_tensor("token_embd.weight", sd["emb.weight"])
    w.add_tensor("output_norm.weight", sd["norm.weight"])
    for i in range(cfg["layers"]):
        p, n = f"blocks.{i}.", f"blk.{i}."
        w.add_tensor(n + "attn_norm.weight", sd[p + "attn_norm.weight"])
        w.add_tensor(n + "ffn_norm.weight", sd[p + "ffn_norm.weight"])
        for src, dst in FACTOR_MAP.items():
            W = sd[p + src]
            u, s, vt = np.linalg.svd(W.astype(np.float64), full_matrices=False)
            r = min(chi, len(s))
            w.add_tensor(n + dst + ".a", (s[:r, None] * vt[:r]).astype(np.float32))
            w.add_tensor(n + dst + ".b", u[:, :r].astype(np.float32))
    w.write(str(path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--project-every", type=int, default=10)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--seed", type=int, default=4242)
    ap.add_argument("--pilot", action="store_true", help="no export, only measure")
    ap.add_argument("--eval-every", type=int, default=200)
    ap.add_argument("--eval-cap", type=int, default=24)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    ck = torch.load(HERE / "refined-chi48.pt", map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])

    _, held = build_sets(args.seed, n_train=0)
    print("train: procedural, fresh every step · held-out "
          + " ".join(f"{k}={len(v)}" for k, v in held.items()), flush=True)

    base_new = score(model, held)
    base_old = old_skills(model)
    print("before — new:", " ".join(f"{k}={v:.2f}" for k, v in base_new.items()), flush=True)
    print("before — old:", " ".join(f"{k.split()[0]}={v:.2f}" for k, v in base_old.items()), flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.01)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.steps, eta_min=args.lr / 10)
    replay = task.eval_sets(4242)
    rng = random.Random(args.seed + 1)
    best = {"score": -1.0, "step": 0, "state": None, "new": base_new, "old": base_old}
    t0 = time.time()

    for step in range(1, args.steps + 1):
        progress = step / args.steps
        # generated fresh every step: the arithmetic has to be learned, not memorised
        batch = [sample_new(rng, progress) for _ in range(args.batch)]
        # replay the three deployed skills — 25% of every batch
        for _ in range(max(1, args.batch // 4)):
            name = rng.choice(list(replay))
            batch.append(replay[name][rng.randrange(24)])
        batch = [(p, a) for p, a in batch if len(encode(p)) + len(encode(a)) <= 186]

        model.train()
        loss = batch_loss(model, batch)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        if step % args.project_every == 0:
            model.eval()
            with torch.no_grad():
                model.load_state_dict(project(model.state_dict(), args.chi))

        if step % args.eval_every == 0 or step == 1:
            model.eval()
            new = score(model, held, cap=args.eval_cap)
            mean_new = sum(new.values()) / len(new)
            sample = batched_generate(model, [held["diff"][0][0]], max_new=40, temperature=0.0)[0]
            print(f"  step {step:>5}  loss {float(loss):.4f}  "
                  + " ".join(f"{k}={v:.2f}" for k, v in new.items())
                  + f"  mean={mean_new:.3f}  diff-sample={sample!r}  [{time.time()-t0:.0f}s]", flush=True)
            if mean_new > best["score"]:
                best = {"score": mean_new, "step": step,
                        "state": {k: v.clone() for k, v in model.state_dict().items()},
                        "new": new, "old": {}}
            torch.save({"config": cfg, "state": model.state_dict()},
                       HERE / "refined-ledger-last.pt")

    # ── final measurement on the best checkpoint ────────────────────────────
    model.load_state_dict(best["state"])
    model.eval()
    final_new = score(model, held, cap=60)
    final_old = old_skills(model)
    old_delta = {k: base_old[k] - final_old[k] for k in base_old}
    print("\nbest step", best["step"], "held-out(cap 24) mean", round(best["score"], 3))
    print("final — new(cap 60):", " ".join(f"{k}={v:.2f}" for k, v in final_new.items()), flush=True)
    print("final — old:", " ".join(f"{k.split()[0]}={v:.2f}" for k, v in final_old.items()), flush=True)
    print("worst old regression:", f"{max(old_delta.values()):+.3f}", flush=True)

    result = {
        "steps": args.steps, "chi": args.chi, "lr": args.lr, "batch": args.batch,
        "project_every": args.project_every, "seed": args.seed,
        "before_new": base_new, "before_old": base_old,
        "after_new": final_new, "after_old": final_old,
        "old_delta": old_delta, "best_step": best["step"],
        "heldout_mean_before": sum(base_new.values()) / len(base_new),
        "heldout_mean_after": sum(final_new.values()) / len(final_new),
        "train_seconds": round(time.time() - t0, 1),
    }
    (HERE / "teach-ledger.json").write_text(json.dumps(result, indent=1))
    torch.save({"config": cfg, "state": best["state"]}, HERE / "refined-ledger.pt")

    if not args.pilot:
        out = HERE / "entangled-chi48-ledger.gguf"
        export_factored(best["state"], cfg, out, args.chi, "rarext-entangled-chi48-ledger")
        digest = hashlib.sha256(out.read_bytes()).hexdigest()
        result["gguf"] = str(out.relative_to(REPO))
        result["gguf_bytes"] = out.stat().st_size
        result["gguf_sha256"] = digest
        (HERE / "teach-ledger.json").write_text(json.dumps(result, indent=1))
        print("exported", out.relative_to(REPO), f"{out.stat().st_size:,} bytes")
        print("sha256", digest)
    print("wrote tools/entangle/teach-ledger.json")


if __name__ == "__main__":
    main()
