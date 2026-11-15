#!/usr/bin/env python3
"""Qwen2 forward pass in vectorized NumPy, over the engine's own dequantized
weights. Fully independent of the JavaScript implementation: if the two
disagree, one of them is wrong and the disagreement has a location.

  python3 npref.py 151644,872,198,785,6722,315,9625,374,151645,198,151644,77091,198
"""
import json
import sys
import numpy as np

W = "/tmp/npw"
idx = json.load(open(f"{W}/index.json"))
KV = idx["kv"]
NL, NE = KV["block_count"], KV["embedding_length"]
NH, NKV = KV["head_count"], KV["head_count_kv"]
NF, EPS = KV["ffn_length"], KV["eps"]
BASE = KV["rope_base"]
HD = NE // NH
GROUP = NH // NKV
NROT = HD


def t(name):
    meta = idx["tensors"][name]
    return np.memmap(f"{W}/{name}.f32", dtype=np.float32, mode="r",
                     shape=(meta["rows"], meta["cols"]))


def rmsnorm(x, w):
    return (x / np.sqrt((x * x).mean(-1, keepdims=True) + EPS)) * w


def rope(x, pos):
    # NeoX half-split layout, one rotation per pair (i, i + NROT/2).
    seq = x.shape[0]
    half = NROT // 2
    i = np.arange(half, dtype=np.float32)
    theta = pos[:, None] * (BASE ** (-2.0 * i / NROT))[None, :]   # (seq, half)
    cos, sin = np.cos(theta), np.sin(theta)
    x = x.reshape(seq, -1, HD)
    a = x[..., :half]
    b = x[..., half:NROT]
    xr = x.copy()
    xr[..., :half] = a * cos[:, None, :] - b * sin[:, None, :]
    xr[..., half:NROT] = a * sin[:, None, :] + b * cos[:, None, :]
    return xr.reshape(seq, -1)


def forward(ids):
    seq = len(ids)
    emb = t("token_embd.weight")
    x = np.array(emb[ids], dtype=np.float32)          # (seq, NE)
    pos = np.arange(seq, dtype=np.float32)
    mask = np.triu(np.full((seq, seq), -np.inf, dtype=np.float32), 1)

    for layer in range(NL):
        p = f"blk.{layer}."
        h = rmsnorm(x, np.array(t(p + "attn_norm.weight")[0], dtype=np.float32))
        q = h @ np.array(t(p + "attn_q.weight"), dtype=np.float32).T
        k = h @ np.array(t(p + "attn_k.weight"), dtype=np.float32).T
        v = h @ np.array(t(p + "attn_v.weight"), dtype=np.float32).T
        q = q + np.array(t(p + "attn_q.bias")[0], dtype=np.float32)
        k = k + np.array(t(p + "attn_k.bias")[0], dtype=np.float32)
        v = v + np.array(t(p + "attn_v.bias")[0], dtype=np.float32)
        q = rope(q, pos)
        k = rope(k, pos)
        qh = q.reshape(seq, NH, HD)
        kh = np.repeat(k.reshape(seq, NKV, HD), GROUP, axis=1)
        vh = np.repeat(v.reshape(seq, NKV, HD), GROUP, axis=1)
        scores = np.einsum("qhd,khd->qhk", qh, kh) / np.sqrt(np.float32(HD)) + mask[:, None, :]
        probs = np.exp(scores - scores.max(-1, keepdims=True))
        probs = probs / probs.sum(-1, keepdims=True)
        attn = np.einsum("qhk,khd->qhd", probs, vh).reshape(seq, NE)
        x = x + attn @ np.array(t(p + "attn_output.weight"), dtype=np.float32).T

        h2 = rmsnorm(x, np.array(t(p + "ffn_norm.weight")[0], dtype=np.float32))
        gate = h2 @ np.array(t(p + "ffn_gate.weight"), dtype=np.float32).T
        up = h2 @ np.array(t(p + "ffn_up.weight"), dtype=np.float32).T
        act = (gate / (1.0 + np.exp(-gate))) * up
        x = x + act @ np.array(t(p + "ffn_down.weight"), dtype=np.float32).T

    final = rmsnorm(x[-1], np.array(t("output_norm.weight")[0], dtype=np.float32))
    logits = final @ np.array(emb, dtype=np.float32).T
    return logits


ids = [int(v) for v in sys.argv[1].split(",")]
logits = forward(ids)
order = np.argsort(-logits)[:8]
print(f"prompt ids ({len(ids)}): {ids}")
print("numpy top-8 (id, logit):")
for i in order:
    print(f"   {int(i):>7}  {logits[i]: .4f}")
print(f"ARGMAX {int(order[0])}")
