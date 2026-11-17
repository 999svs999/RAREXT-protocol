"""Rollout machinery: batched sampling from the agent model, all in torch.

Left-padding + a key-padding mask is mathematically identical to per-prompt
generation for RoPE models (attention scores depend only on position
*differences*), so one batched forward pass can unroll k samples for P prompts
at once — which is what makes hundreds of RL rollouts per minute possible on a
CPU. Verified against the RAREXT engine in evolve.py before any promotion.
"""

import sys
from pathlib import Path

import torch

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / ".." / ".." / "models" / "live-host-lm"))
from train import EOS, VOCAB, TinyLM, encode  # noqa: E402


def load_agent(checkpoint_path: str) -> TinyLM:
    ck = torch.load(checkpoint_path, map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])
    model.eval()
    return model


@torch.no_grad()
def batched_generate(model: TinyLM, prompts: list[str], max_new: int = 40,
                     temperature: float = 0.9, generator: torch.Generator | None = None):
    """One sampled continuation per prompt (call k times for k samples)."""
    enc = [encode(p) for p in prompts]
    width = max(len(e) for e in enc)
    pad = width - min(len(e) for e in enc) if len(enc) > 1 else 0
    b = len(enc)
    ids = torch.full((b, width), EOS, dtype=torch.long)
    pad_mask = torch.zeros((b, width), dtype=torch.bool)  # True at PAD keys
    for i, e in enumerate(enc):
        p = width - len(e)
        ids[i, p:] = torch.tensor(e)
        pad_mask[i, :p] = True

    finished = torch.zeros(b, dtype=torch.bool)
    for _ in range(max_new):
        logits = model(ids, pad_mask=pad_mask)  # (b, t, V)
        nxt_logits = logits[:, -1]
        if temperature <= 0:
            nxt = nxt_logits.argmax(-1, keepdim=True)
        else:
            probs = torch.softmax(nxt_logits / temperature, -1)
            nxt = torch.multinomial(probs, 1, generator=generator)  # (b, 1)
        nxt = torch.where(finished[:, None], torch.full_like(nxt, EOS), nxt)
        ids = torch.cat([ids, nxt], dim=1)
        pad_mask = torch.cat([pad_mask, torch.zeros((b, 1), dtype=torch.bool)], dim=1)
        finished = finished | (nxt[:, 0] == EOS)
        if bool(finished.all()):
            break

    outs = []
    for i in range(b):
        row = ids[i, width:].tolist()
        if EOS in row:
            row = row[: row.index(EOS)]
        outs.append(bytes(row).decode("utf-8", "replace"))
    return outs


def answer_logprobs(model: TinyLM, prompts: list[str], answers: list[str]):
    """Sum of log-probs the policy puts on each answer given its prompt.

    Returns (per-token logprobs tensor for the answer region, answer lengths).
    This is the on-policy part of the REINFORCE update.
    """
    enc = [encode(p) + encode(a) for p, a in zip(prompts, answers)]
    plens = [len(encode(p)) for p in prompts]
    width = max(len(e) for e in enc)
    b = len(enc)
    ids = torch.full((b, width), EOS, dtype=torch.long)
    pad_mask = torch.zeros((b, width), dtype=torch.bool)
    for i, e in enumerate(enc):
        p = width - len(e)
        ids[i, p:] = torch.tensor(e)
        pad_mask[i, :p] = True
    logits = model(ids, pad_mask=pad_mask)  # (b, t, V)
    logprobs = torch.log_softmax(logits[:, :-1].float(), -1)
    tgt = ids[:, 1:]
    picked = logprobs.gather(-1, tgt[:, :, None]).squeeze(-1)  # (b, t-1)

    sums = []
    for i, e in enumerate(enc):
        a0 = plens[i] - 1 + (width - len(e))  # first answer position in tgt coords
        a1 = len(e) - 1 + (width - len(e))
        sums.append(picked[i, a0:a1].sum())
    return torch.stack(sums), picked  # (per-sequence sums, per-token logprobs)


def rollout(model, task_prompts, k, temperature=0.9, seed=None):
    """k sampled continuations per prompt, all in ONE batch (each prompt is
    replicated k times), so P prompts x k samples cost one unrolled forward
    pass chain instead of k of them. Returns [(prompt, answer)] length P*k."""
    gen = None
    if seed is not None:
        gen = torch.Generator().manual_seed(seed)
    repeated = [p for p in task_prompts for _ in range(k)]
    outs = batched_generate(model, repeated, temperature=temperature, generator=gen)
    return list(zip(repeated, outs))
