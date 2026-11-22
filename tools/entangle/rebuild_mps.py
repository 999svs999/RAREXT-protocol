"""Rebuild the promoted RAREXT model from its entanglement spectrum.

Each 2-D weight W = U·diag(s)·Vᵀ is rebuilt as W_χ = U_χ·diag(s_χ)·V_χᵀ: the
same matrix, reconstructed from its first χ Schmidt terms. χ is the
entanglement budget (the bond dimension of an MPS/MPO with the same content).

Three rebuild policies are measured:
  uniform χ      — every matrix gets the same bond dimension
  energy 99.0%   — per-matrix adaptive bond dimension
  energy 99.9%   — per-matrix adaptive bond dimension, tighter

For each, this reports the deployed skill set (greedy exact match, the same
held-out sets the evolution gate uses) and a smooth function-fidelity number:
mean per-token KL(original ‖ rebuild) on held-out prompts. A model is only a
real rebuild of RAREXT AI if it still answers the room's questions.

Run:  python3 tools/entangle/rebuild_mps.py
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "models/live-host-lm"))
sys.path.insert(0, str(REPO / "agents/self-evolve"))

from train import TinyLM, encode, VOCAB, VOCAB_TOKENS, EOS  # noqa: E402
from gguf import GGUFWriter  # noqa: E402
import task  # noqa: E402
from model import batched_generate  # noqa: E402

CKPT = REPO / "agents/self-evolve/generations/gen-000.pt"
ENGINE_CHECK = REPO / "models/live-host-lm/engine_check.mjs"


def build_model(state, cfg):
    m = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    m.load_state_dict(state)
    m.eval()
    return m


def rebuilt_state(state, chi=None, energy=None):
    """SVD-truncate every 2-D weight. Returns (new_state, kept_weight, params)."""
    out = {}
    num = den = 0.0
    params = 0
    for name, w in state.items():
        if w.dim() != 2:
            out[name] = w.clone()
            params += w.numel()
            continue
        a = w.numpy().astype(np.float64)
        u, s, vt = np.linalg.svd(a, full_matrices=False)
        if energy is not None:
            e = np.cumsum(s ** 2) / (s ** 2).sum()
            r = int(np.searchsorted(e, energy) + 1)
        else:
            r = min(chi, len(s))
        w2 = (u[:, :r] * s[:r]) @ vt[:r]
        out[name] = torch.from_numpy(w2.astype(np.float32))
        num += float((s[:r] ** 2).sum())
        den += float((s ** 2).sum())
        params += r * (a.shape[0] + a.shape[1])  # factored (MPS) storage
    return out, num / den, params


@torch.no_grad()
def kl_fidelity(teacher, student, prompts, batch=32):
    """Mean per-token KL(teacher ‖ student) over next-token distributions,
    teacher-forced on the full prompt string. Lower = closer function."""
    total, n = 0.0, 0
    for i in range(0, len(prompts), batch):
        chunk = prompts[i:i + batch]
        width = max(len(encode(p)) for p in chunk)
        ids = torch.full((len(chunk), width), EOS, dtype=torch.long)
        mask = torch.zeros((len(chunk), width), dtype=torch.bool)
        for j, p in enumerate(chunk):
            e = encode(p)
            pad = width - len(e)
            ids[j, pad:] = torch.tensor(e)
            mask[j, :pad] = True
        lt = teacher(ids, pad_mask=mask)[:, :-1]
        ls = student(ids, pad_mask=mask)[:, :-1]
        # ignore pad positions
        keep = ~mask[:, :-1]
        pt = F.log_softmax(lt, -1)
        ps = F.log_softmax(ls, -1)
        kl = (pt.exp() * (pt - ps)).sum(-1)
        total += float(kl[keep].sum())
        n += int(keep.sum())
    return total / n


def score(model, sets, n=40):
    out = {}
    for name, samples in sets.items():
        sub = samples[:n]
        outs = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
        out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, outs)) / len(sub)
    return out


def export_gguf(model, path, cfg, ctx):
    w = GGUFWriter()
    w.add_string("general.architecture", "qwen2")
    w.add_string("general.name", "rarext-entanglement-rebuild")
    w.add_uint32("qwen2.context_length", ctx)
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
    sd = {k: v.detach().float().numpy() for k, v in model.state_dict().items()}
    w.add_tensor("token_embd.weight", sd["emb.weight"])
    w.add_tensor("output_norm.weight", sd["norm.weight"])
    for i in range(cfg["layers"]):
        p, n = f"blocks.{i}.", f"blk.{i}."
        for src, dst in [
            ("attn_norm.weight", "attn_norm.weight"), ("q.weight", "attn_q.weight"),
            ("k.weight", "attn_k.weight"), ("v.weight", "attn_v.weight"),
            ("o.weight", "attn_output.weight"), ("ffn_norm.weight", "ffn_norm.weight"),
            ("gate.weight", "ffn_gate.weight"), ("up.weight", "ffn_up.weight"),
            ("down.weight", "ffn_down.weight"),
        ]:
            w.add_tensor(n + dst, sd[p + src])
    w.write(str(path))


def engine_check(gguf_path, prompts):
    pf = HERE / "_verify-prompts.json"
    pf.write_text(json.dumps([{"prompt": p, "want": a} for p, a in prompts]))
    r = subprocess.run(["node", str(ENGINE_CHECK), str(gguf_path), str(pf)],
                       capture_output=True, text=True, timeout=900)
    ok = sum(1 for line in r.stdout.splitlines() if line.startswith("ok  "))
    miss = sum(1 for line in r.stdout.splitlines() if line.startswith("MISS"))
    total = ok + miss
    return (ok / total if total else 0.0), r.stdout


def main():
    ck = torch.load(CKPT, map_location="cpu")
    cfg = ck["config"]
    state = ck["state"]
    full = build_model(state, cfg)
    sets = task.eval_sets()
    eval_prompts = [p for name, s in sets.items() for p, _ in s[:40]]

    t0 = time.time()
    base_scores = score(full, sets)
    base_kl = 0.0
    print(f"original model: {sum(v.numel() for v in state.values()):,} params")
    print("  " + "  ".join(f"{k.split()[0]} {v:.2f}" for k, v in base_scores.items())
          + f"   [{time.time()-t0:.1f}s]\n")

    policies = [("χ=8", 8, None), ("χ=16", 16, None), ("χ=24", 24, None),
                ("χ=32", 32, None), ("χ=48", 48, None), ("χ=64", 64, None),
                ("energy 99.0%", None, 0.990), ("energy 99.9%", None, 0.999)]
    results = []
    print(f"{'rebuild':>14s} {'params':>9s} {'Frob':>7s} {'KL':>9s} "
          f"{'mean':>6s} {'min':>5s}  per-skill")
    for label, chi, energy in policies:
        t0 = time.time()
        st, kept, params = rebuilt_state(state, chi=chi, energy=energy)
        m = build_model(st, cfg)
        s = score(m, sets)
        kl = kl_fidelity(full, m, eval_prompts)
        mean = sum(s.values()) / len(s)
        lo = min(s.values())
        results.append({"label": label, "chi": chi, "energy": energy,
                        "params": params, "frob": kept, "kl": kl,
                        "scores": s, "mean": mean, "min": lo,
                        "wall_s": round(time.time() - t0, 1)})
        print(f"{label:>14s} {params:>9,} {kept:>6.1%} {kl:>9.2e} "
              f"{mean:>6.3f} {lo:>5.2f}  "
              + " ".join(f"{k.split()[0]} {v:.2f}" for k, v in s.items())
              + f"   [{time.time()-t0:.1f}s]")

    # The rebuild is accepted if it holds the deployed skills within 0.02 and
    # its mean does not fall below the original's.
    base_mean = sum(base_scores.values()) / len(base_scores)
    accepted = [r for r in results
                if all(base_scores[k] - v <= 0.02 for k, v in r["scores"].items())
                and r["mean"] >= base_mean]
    best = min(accepted, key=lambda r: r["params"]) if accepted else None
    print(f"\naccepted rebuilds (no skill −0.02, mean ≥ {base_mean:.3f}): "
          f"{[r['label'] for r in accepted] or 'none'}")
    if best:
        print(f"smallest accepted: {best['label']} — {best['params']:,} factored params "
              f"({best['params']/sum(v.numel() for v in state.values()):.1%} of dense), "
              f"KL {best['kl']:.2e}")

    # Export the smallest accepted rebuild and prove it serves through the engine.
    if best:
        st, _, _ = rebuilt_state(state, chi=best["chi"], energy=best["energy"])
        m = build_model(st, cfg)
        name = "entangled-" + (f"chi{best['chi']}" if best["chi"] else
                               f"e{int(best['energy']*1000)}") + ".gguf"
        out = HERE / name
        export_gguf(m, out, cfg, cfg["ctx"])
        # one prompt per skill, straight through RAREXT's own engine
        probe = []
        for skill, samples in sets.items():
            p, a = samples[0]
            got = batched_generate(m, [p], max_new=48, temperature=0.0)[0]
            probe.append((p, got))
        ex, text = engine_check(out, probe)
        print(f"\nexported {out.relative_to(REPO)} ({out.stat().st_size:,} bytes)")
        print(f"engine faithfulness: {ex:.2%} of the rebuild's greedy answers reproduced")
        print("\n".join("  " + l for l in text.splitlines() if l.startswith(("ok", "MISS", "exact"))))
        results_best = {"label": best["label"], "gguf": str(out),
                        "engine_exact": ex, "bytes": out.stat().st_size}
    else:
        results_best = None

    (HERE / "rebuild.json").write_text(json.dumps({
        "checkpoint": str(CKPT), "original": base_scores,
        "results": results, "accepted": [r["label"] for r in accepted],
        "best": results_best,
    }, indent=1))
    print(f"\nwrote {(HERE / 'rebuild.json').relative_to(REPO)}")


if __name__ == "__main__":
    main()
