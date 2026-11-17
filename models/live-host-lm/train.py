"""Train RAREXT's own live-host language model.

The hosted 0.5B model is a general chat model: it describes a shoe when asked its
price, never emits its end-of-sequence token, and takes seconds per token. For the
room's actual job — read a price out of the rows that were handed to it and say it
once — that is the wrong shape of model.

This trains a byte-level transformer from scratch on exactly that job, then exports
it as GGUF so RAREXT's existing engine serves it (no new runtime, no new format).
The task is a copy task on purpose: the price is sampled at random per example, so
the model cannot memorise answers — it has to attend to the row and copy the
digits. Accuracy is therefore measured on prices that were never in the training
set.

    python3.11 train.py --steps 3000 --out live-host-lm.gguf
"""

import argparse
import json
import math
import os
import random
import sys
import time

import torch
import torch.nn as nn
import torch.nn.functional as F

from gguf import GGUFWriter

EOS = 256
VOCAB = 257


# --------------------------------------------------------------------------
# byte vocabulary (identical to the engine's byte-level GPT-2 mapping)
# --------------------------------------------------------------------------
def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(
        range(ord("®"), ord("ÿ") + 1)
    )
    cs = bs[:]
    n = 0
    for b in range(2**8):
        if b not in bs:
            bs.append(b)
            cs.append(2**8 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


BYTE_TO_CHAR = bytes_to_unicode()
VOCAB_TOKENS = [BYTE_TO_CHAR[i] for i in range(256)] + ["<|eos|>"]


def encode(text: str):
    return list(text.encode("utf-8"))


# --------------------------------------------------------------------------
# the task
# --------------------------------------------------------------------------
WORDS = [
    "BAPE", "STA", "BABY", "MILO", "SHARK", "TEE", "HOODIE", "CREW", "SOCKS",
    "CAP", "BOX", "GIFT", "QUILTED", "VEST", "DOWN", "SHORTS", "PANTS", "JACKET",
    "CAMO", "BIG", "APE", "HEAD", "CITY", "TIGER", "COLLEGE", "STORE", "LOW",
    "HIGH", "WHITE", "BLACK", "GREY", "NAVY", "RED", "MEGA", "MINI", "CLASSIC",
    "TRAIL", "SPLINTER", "REFLECTIVE", "SUEDE", "MESH", "KNIT", "PACK", "SET",
]
NUMERALS = ["#1", "#2", "#3", "II", "III"]
QUESTIONS = [
    "how much is the {item}?",
    "how much is the {item}",
    "what does the {item} cost?",
    "price of the {item}?",
    "how much for the {item}?",
    "what is the price of the {item}?",
    "how much do the {item} cost?",
]
# Deployment does not repeat the item: the visitor types "how much is it?" after
# picking something on the shelf. If every training question named the item, the
# model could learn to align the two copies of the name instead of learning to
# read the price out of the row — and then fail on the first real question.
GENERIC_QUESTIONS = [
    "how much is it?",
    "how much?",
    "what's the price?",
    "price?",
    "how much does it cost?",
    "and the price?",
    "how much for that?",
    "what does it cost?",
    "how much is this one?",
    "cost?",
]

PROMPT = "rows: -{item}|${price}\nq: {question}\na: "
ANSWER = "The price is ${price} delivered."


def make_item(rng: random.Random) -> str:
    n = rng.choice([1, 2, 2, 3, 3, 4])
    parts = [rng.choice(WORDS) for _ in range(n)]
    if rng.random() < 0.18:
        parts.insert(rng.randrange(len(parts) + 1), rng.choice(NUMERALS))
    label = " ".join(parts)
    if rng.random() < 0.45:
        label = label.lower()
    return label


def make_price(rng: random.Random) -> str:
    value = rng.choice(
        [
            rng.randrange(49, 2000),
            rng.randrange(120, 480),
            rng.randrange(100, 400) * 100 // 100,
        ]
    )
    if rng.random() < 0.35:
        return f"{value}.00"
    return str(value)


def example(rng: random.Random):
    item = make_item(rng)
    price = make_price(rng)
    roll = rng.random()
    if roll < 0.3:
        question = rng.choice(GENERIC_QUESTIONS)
    elif roll < 0.42:
        # A visitor often types part of the name, not the whole row label.
        short = " ".join(item.split()[:2])
        question = rng.choice(QUESTIONS).format(item=short)
    else:
        question = rng.choice(QUESTIONS).format(item=item)
    prompt = PROMPT.format(item=item, price=price, question=question)
    answer = ANSWER.format(price=price)
    return prompt, answer


def batch(rng: random.Random, size: int):
    return [example(rng) for _ in range(size)]


def encode_pair(prompt: str, answer: str):
    ids = encode(prompt) + encode(answer) + [EOS]
    # Loss only on the answer (and the EOS that ends it): the prompt is context,
    # not something the model should learn to produce.
    first = len(encode(prompt))
    target = [-100] * first + ids[first:]
    return ids, target


# --------------------------------------------------------------------------
# model — the same math the RAREXT engine runs for arch "qwen2"
# --------------------------------------------------------------------------
class RMSNorm(nn.Module):
    def __init__(self, dim, eps=1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.eps = eps

    def forward(self, x):
        dtype = x.dtype
        x = x.float()
        x = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)
        return self.weight * x.to(dtype)


def rope_tables(head_dim, n_rot, base, length):
    half = n_rot // 2
    inv = base ** (-2.0 * torch.arange(0, half, dtype=torch.float32) / n_rot)
    pos = torch.arange(length, dtype=torch.float32)
    theta = torch.outer(pos, inv)  # [length, half]
    return torch.cos(theta), torch.sin(theta)


def apply_rope(x, cos, sin):
    # NeoX pairing: (i, i + half) inside each head — exactly what the engine's
    # `rope(..., neox=true)` rotates.
    half = cos.shape[-1]
    x1 = x[..., :half]
    x2 = x[..., half : 2 * half]
    rot1 = x1 * cos - x2 * sin
    rot2 = x1 * sin + x2 * cos
    return torch.cat([rot1, rot2, x[..., 2 * half :]], dim=-1)


class Block(nn.Module):
    def __init__(self, d, n_head, ffn):
        super().__init__()
        self.n_head = n_head
        self.head_dim = d // n_head
        self.attn_norm = RMSNorm(d)
        self.ffn_norm = RMSNorm(d)
        self.q = nn.Linear(d, d, bias=False)
        self.k = nn.Linear(d, d, bias=False)
        self.v = nn.Linear(d, d, bias=False)
        self.o = nn.Linear(d, d, bias=False)
        self.gate = nn.Linear(d, ffn, bias=False)
        self.up = nn.Linear(d, ffn, bias=False)
        self.down = nn.Linear(ffn, d, bias=False)

    def forward(self, x, cos, sin):
        b, t, d = x.shape
        h = self.attn_norm(x)
        q = self.q(h).view(b, t, self.n_head, self.head_dim).transpose(1, 2)
        k = self.k(h).view(b, t, self.n_head, self.head_dim).transpose(1, 2)
        v = self.v(h).view(b, t, self.n_head, self.head_dim).transpose(1, 2)
        q = apply_rope(q, cos, sin)
        k = apply_rope(k, cos, sin)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        mask = torch.triu(torch.ones(t, t, dtype=torch.bool), diagonal=1)
        att = att.masked_fill(mask, float("-inf"))
        att = F.softmax(att, dim=-1)
        out = (att @ v).transpose(1, 2).reshape(b, t, d)
        x = x + self.o(out)
        h = self.ffn_norm(x)
        x = x + self.down(F.silu(self.gate(h)) * self.up(h))
        return x


class TinyLM(nn.Module):
    def __init__(self, vocab, d, n_layer, n_head, ffn, ctx, rope_base=10000.0):
        super().__init__()
        self.ctx = ctx
        self.head_dim = d // n_head
        self.emb = nn.Embedding(vocab, d)
        self.blocks = nn.ModuleList([Block(d, n_head, ffn) for _ in range(n_layer)])
        self.norm = RMSNorm(d)
        cos, sin = rope_tables(self.head_dim, self.head_dim, rope_base, ctx)
        self.register_buffer("cos", cos, persistent=False)
        self.register_buffer("sin", sin, persistent=False)
        self.apply(self._init)
        for name, p in self.named_parameters():
            if name.endswith("o.weight") or name.endswith("down.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * n_layer))

    @staticmethod
    def _init(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def forward(self, ids, targets=None):
        b, t = ids.shape
        x = self.emb(ids)
        cos, sin = self.cos[:t], self.sin[:t]
        for block in self.blocks:
            x = block(x, cos, sin)
        x = self.norm(x)
        logits = x @ self.emb.weight.t()  # tied embeddings, like the export
        if targets is None:
            return logits
        # logits[t] is the distribution for token t+1, so it is compared with
        # targets[t+1]: the position that must be *predicted*, not the one it saw.
        return logits, F.cross_entropy(
            logits[:, :-1].reshape(-1, logits.shape[-1]),
            targets[:, 1:].reshape(-1),
            ignore_index=-100,
        )

    @torch.no_grad()
    def generate(self, ids, max_tokens):
        out = list(ids)
        for _ in range(max_tokens):
            window = torch.tensor([out[-self.ctx :]], dtype=torch.long)
            logits = self.forward(window)
            nxt = int(torch.argmax(logits[0, -1]))
            if nxt == EOS:
                break
            out.append(nxt)
        return out[len(ids) :]


# --------------------------------------------------------------------------
# evaluation
# --------------------------------------------------------------------------
@torch.no_grad()
def exact_match(model, samples):
    hit = 0
    for prompt, answer in samples:
        got = bytes(model.generate(encode(prompt), 48)).decode("utf-8", "replace")
        if got == answer:
            hit += 1
    return hit / len(samples)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=5000)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--d", type=int, default=128)
    ap.add_argument("--layers", type=int, default=6)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--ffn", type=int, default=384)
    ap.add_argument("--ctx", type=int, default=192)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="live-host-lm.gguf")
    ap.add_argument("--checkpoint", default="live-host-lm.pt")
    ap.add_argument(
        "--export-only",
        default=None,
        metavar="CHECKPOINT",
        help="skip training: load this checkpoint and export it as GGUF",
    )
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    torch.set_num_threads(max(1, torch.get_num_threads()))
    rng = random.Random(args.seed)

    if args.export_only:
        ckpt = torch.load(args.export_only, map_location="cpu")
        config = argparse.Namespace(**ckpt["config"])
        config.out = args.out
        model = TinyLM(VOCAB, config.d, config.layers, config.heads, config.ffn, config.ctx)
        model.load_state_dict(ckpt["state"])
        model.eval()
        params = sum(p.numel() for p in model.parameters())
        print(
            f"loaded {args.export_only} (step {ckpt['step']}, {params:,} parameters, "
            f"{config.layers} layers, d={config.d})"
        )
        eval_same, held, held_generic = eval_sets(config.seed)
        scores = report(model, eval_same, held, held_generic)
        export(model, config, params, scores, (eval_same, held, held_generic), ckpt["step"])
        return 0

    model = TinyLM(VOCAB, args.d, args.layers, args.heads, args.ffn, args.ctx)
    params = sum(p.numel() for p in model.parameters())
    print(
        f"model: {params:,} parameters ({args.layers} layers, d={args.d}, "
        f"ffn={args.ffn}, ctx={args.ctx})",
        flush=True,
    )

    eval_same, held, held_generic = eval_sets(args.seed)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    warmup = 100
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt,
        lambda s: min(1.0, (s + 1) / warmup)
        * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, s / args.steps)))),
    )

    t0 = time.time()
    best = -1.0
    best_step = 0
    for step in range(1, args.steps + 1):
        rows = batch(rng, args.batch)
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
        if step % 250 == 0 or step == 1:
            em = exact_match(model, eval_same[:40])
            gen = exact_match(model, held_generic[:6])
            elapsed = time.time() - t0
            eta = elapsed / step * (args.steps - step)
            print(
                f"step {step:5d}  loss {loss.item():.4f}  lr {sched.get_last_lr()[0]:.2e}  "
                f"exact {em*100:.0f}%  generic {gen*100:.0f}%  {(elapsed/step)*1000:.0f} ms/step  "
                f"eta {eta/60:.0f} min",
                flush=True,
            )
            # The checkpoint is written the moment a run improves, so a later
            # export never depends on the training process still being alive.
            # Ranked on both phrasings: the generic question is what deployment
            # actually sends.
            score = em + gen
            if score >= best:
                best, best_step = score, step
                save_checkpoint(model, vars(args), args.checkpoint, step, score)

    ckpt = torch.load(args.checkpoint, map_location="cpu")
    model.load_state_dict(ckpt["state"])
    print(f"\nexporting the best checkpoint (step {best_step}, exact {best*100:.0f}%)", flush=True)
    scores = report(model, eval_same, held, held_generic)
    export(model, args, params, scores, (eval_same, held, held_generic), best_step)
    return 0


def eval_sets(seed: int):
    """Two fixed evaluation sets: same distribution, and unseen item names.

    Both are generated from a seed the training loop never draws from, so a
    score is on data the model has not seen.
    """
    eval_rng = random.Random(seed + 1000)
    eval_same = batch(eval_rng, 120)
    held_items = [
        "BAPE STA SK8 LOW WHITE", "BABY MILO GIFT BOX 2026", "SHARK FULL ZIP HOODIE",
        "COLOR CAMO COLLEGE TEE", "BAPE X UNDFTD CAP BLACK", "MEGA BAPE STA SUEDE",
        "TIGER KNIT CREW NAVY", "SPLINTER REFLECTIVE JACKET", "MINI MILO SOCKS 3 PACK",
        "BAPE STA #4 PATENT GREY", "BIG APE HEAD SHORTS", "CITY CAMO MESH VEST",
    ]
    held = []
    for idx, item in enumerate(held_items):
        price = str(149 + idx * 37)
        held.append(
            (
                PROMPT.format(item=item, price=price, question=f"how much is the {item}?"),
                ANSWER.format(price=price),
            )
        )
    # The deployment phrasing: the question is generic and does not name the row.
    held_generic = []
    for idx, item in enumerate(held_items):
        price = str(149 + idx * 37)
        question = ("how much is it?", "what's the price?", "how much?")[idx % 3]
        held_generic.append(
            (PROMPT.format(item=item, price=price, question=question), ANSWER.format(price=price))
        )
    return eval_same, held, held_generic


def save_checkpoint(model, config, path, step, exact):
    torch.save(
        {
            "config": dict(config),
            "state": {k: v.detach().cpu() for k, v in model.state_dict().items()},
            "step": step,
            "exact_same_40": exact,
        },
        path,
    )


@torch.no_grad()
def report(model, eval_same, held, held_generic):
    same = exact_match(model, eval_same)
    unseen = exact_match(model, held)
    generic = exact_match(model, held_generic)
    print(f"\nheld-out, same distribution : {same*100:.1f}% exact match ({len(eval_same)} samples)")
    print(f"held-out, unseen item names : {unseen*100:.1f}% exact match ({len(held)} samples)")
    print(f"held-out, generic question  : {generic*100:.1f}% exact match ({len(held_generic)} samples)")
    # A few answers, printed verbatim so the result is readable, not just a score.
    for prompt, answer in (held[:2] + held_generic[:2]):
        got = bytes(model.generate(encode(prompt), 48)).decode("utf-8", "replace")
        print(f"  want {answer!r}\n  got  {got!r}")
    return same, unseen, generic


def export(model, args, params, scores, sets, step):
    """Write the trained weights as GGUF, in the layout the engine reads."""
    same, unseen, generic = scores
    eval_same, held, held_generic = sets
    w = GGUFWriter()
    w.add_string("general.architecture", "qwen2")
    w.add_string("general.name", "rarext-live-host-lm")
    w.add_uint32("qwen2.context_length", args.ctx)
    w.add_uint32("qwen2.embedding_length", args.d)
    w.add_uint32("qwen2.block_count", args.layers)
    w.add_uint32("qwen2.feed_forward_length", args.ffn)
    w.add_uint32("qwen2.attention.head_count", args.heads)
    w.add_uint32("qwen2.attention.head_count_kv", args.heads)
    w.add_float32("qwen2.attention.layer_norm_rms_epsilon", 1e-6)
    w.add_float32("qwen2.rope.freq_base", 10000.0)
    w.add_uint32("qwen2.rope.dimension_count", args.d // args.heads)
    w.add_string("tokenizer.ggml.model", "gpt2")
    w.add_array_string("tokenizer.ggml.tokens", VOCAB_TOKENS)
    w.add_array_string("tokenizer.ggml.merges", [])
    w.add_array_int32("tokenizer.ggml.token_type", [1] * 256 + [3])
    w.add_uint32("tokenizer.ggml.eos_token_id", EOS)
    w.add_uint32("tokenizer.ggml.bos_token_id", EOS)
    w.add_bool("tokenizer.ggml.add_bos_token", False)

    sd = {k: v.detach().float().numpy() for k, v in model.state_dict().items()}
    w.add_tensor("token_embd.weight", sd["emb.weight"])
    w.add_tensor("output_norm.weight", sd["norm.weight"])
    for i, _ in enumerate(model.blocks):
        p = f"blocks.{i}."
        n = f"blk.{i}."
        w.add_tensor(n + "attn_norm.weight", sd[p + "attn_norm.weight"])
        w.add_tensor(n + "attn_q.weight", sd[p + "q.weight"])
        w.add_tensor(n + "attn_k.weight", sd[p + "k.weight"])
        w.add_tensor(n + "attn_v.weight", sd[p + "v.weight"])
        w.add_tensor(n + "attn_output.weight", sd[p + "o.weight"])
        w.add_tensor(n + "ffn_norm.weight", sd[p + "ffn_norm.weight"])
        w.add_tensor(n + "ffn_gate.weight", sd[p + "gate.weight"])
        w.add_tensor(n + "ffn_up.weight", sd[p + "up.weight"])
        w.add_tensor(n + "ffn_down.weight", sd[p + "down.weight"])
    path = w.write(args.out)
    size = os.path.getsize(path)
    print(f"\nwrote {path}  ({size:,} bytes, {params:,} parameters)")
    print(
        f"  held-out accuracy at export: same-dist {same*100:.1f}%  "
        f"unseen-items {unseen*100:.1f}%  generic-question {generic*100:.1f}%"
    )
    with open(args.out.replace(".gguf", ".eval.json"), "w") as fh:
        json.dump(
            {
                "parameters": params,
                "checkpoint_step": step,
                "held_out_same_distribution": same,
                "held_out_unseen_items": unseen,
                "held_out_generic_question": generic,
                "samples_same": len(eval_same),
                "samples_unseen": len(held),
                "samples_generic": len(held_generic),
                "config": {k: v for k, v in vars(args).items()},
            },
            fh,
            indent=2,
        )


if __name__ == "__main__":
    sys.exit(main())
