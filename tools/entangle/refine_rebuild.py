"""Refine a low-bond-dimension rebuild with DMRG-style projected training.

A truncated SVD rebuild is a projection of the weights onto the manifold of
matrices with bond dimension χ. Plain truncation loses a little of the
function. The fix is the same loop tensor-network algorithms use: take a
gradient step, then project back onto the manifold. Repeated, it finds the
best function *inside* the low-entanglement manifold instead of the closest
weights to the dense one.

Evaluation uses two independent held-out seeds (4242 and 777) so a single
sample cannot decide a gate. Acceptance is unchanged from the evolution loop:
no deployed skill may fall more than 0.02 below the dense model.

Run:  python3 tools/entangle/refine_rebuild.py
"""

import json
import random
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "models/live-host-lm"))
sys.path.insert(0, str(REPO / "agents/self-evolve"))

from train import TinyLM, VOCAB, VOCAB_TOKENS, EOS  # noqa: E402
from gguf import GGUFWriter  # noqa: E402
import task  # noqa: E402
from model import batched_generate  # noqa: E402
from evolve import mix_prompts  # noqa: E402

CKPT = REPO / "agents/self-evolve/generations/gen-000.pt"
ENGINE_CHECK = REPO / "models/live-host-lm/engine_check.mjs"
SEEDS = (4242, 777)


def build(state, cfg):
    m = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    m.load_state_dict(state)
    m.eval()
    return m


def projected(state, chi):
    """SVD-truncate every 2-D weight to bond dimension χ (dense form)."""
    out = {}
    for name, w in state.items():
        if w.dim() != 2:
            out[name] = w.clone()
            continue
        a = w.detach().numpy().astype(np.float64)
        u, s, vt = np.linalg.svd(a, full_matrices=False)
        r = min(chi, len(s))
        out[name] = torch.from_numpy(((u[:, :r] * s[:r]) @ vt[:r]).astype(np.float32))
    return out


def num_params(state):
    return sum(v.numel() for v in state.values())


def projected_refine(state, cfg, chi, steps=320, seed=1234, report_every=160,
                     base=None):
    """Gradient step, then SVD projection back onto the χ-manifold, repeated.

    This is the tensor-network training loop (TEBD/DMRG in miniature): the
    optimiser is only allowed to move *within* the space of bond-dimension-χ
    matrices, because every step ends with the projection."""
    from model import answer_logprobs

    m = build(projected(state, chi), cfg)
    opt = torch.optim.AdamW(m.parameters(), lr=2e-4, betas=(0.9, 0.95),
                            weight_decay=0.01)
    rng = random.Random(seed + chi)
    for it in range(1, steps + 1):
        pairs = mix_prompts(rng, 24, gen_index=1)
        lp, _ = answer_logprobs(m, [p for p, _ in pairs], [a for _, a in pairs])
        lens = torch.tensor([max(1, len(a)) for _, a in pairs], dtype=torch.float)
        loss = -(lp / lens).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)
        opt.step()
        m.eval()
        with torch.no_grad():
            sd = m.state_dict()
            for name, w in list(sd.items()):
                if w.dim() != 2:
                    continue
                a = w.detach().numpy().astype(np.float64)
                u, sv, vt = np.linalg.svd(a, full_matrices=False)
                r = min(chi, len(sv))
                sd[name].copy_(torch.from_numpy(
                    ((u[:, :r] * sv[:r]) @ vt[:r]).astype(np.float32)))
        if report_every and it % report_every == 0 and base is not None:
            s = score_all(m)
            mn, _ = margin(s, base)
            line = {k.split("@")[0]: v for k, v in s.items() if k.endswith("@4242")}
            print(f"  χ={chi} step {it:3d}  loss {float(loss):.4f}  max drop {mn:+.3f}  "
                  + " ".join(f"{k.split()[0]} {v:.2f}" for k, v in line.items()), flush=True)
    return m


def factored_params(state, chi):
    total = 0
    for w in state.values():
        if w.dim() == 2:
            r = min(chi, min(w.shape))
            total += r * sum(w.shape[:2])
        else:
            total += w.numel()
    return total


@torch.no_grad()
def score_all(model):
    """Full held-out sets on both seeds."""
    out = {}
    for seed in SEEDS:
        sets = task.eval_sets(seed)
        for name, samples in sets.items():
            outs = batched_generate(model, [p for p, _ in samples], max_new=48, temperature=0.0)
            hits = sum(task.exact_match(p, a) for (p, _), a in zip(samples, outs))
            out[f"{name}@{seed}"] = hits / len(samples)
    return out


def margin(scores, base):
    """Largest per-skill DROP from the dense model (positive = regression).

    Note the sign: `base - rebuilt` is positive when the rebuild is worse, so
    the gate is `max(drop) <= 0.02`, not a minimum. Getting this backwards
    accepts everything, which is what the first version of this script did.
    """
    drops = {k: base[k] - v for k, v in scores.items()}
    return max(drops.values()), drops


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
    return (ok / (ok + miss) if ok + miss else 0.0), r.stdout


def main():
    ck = torch.load(CKPT, map_location="cpu")
    cfg, state = ck["config"], ck["state"]
    dense = build(state, cfg)
    dense_params = sum(v.numel() for v in state.values())

    t0 = time.time()
    base = score_all(dense)
    print(f"dense model {dense_params:,} params — evaluated on {len(SEEDS)} held-out seeds "
          f"({time.time()-t0:.0f}s)")
    for seed in SEEDS:
        s = {k.split("@")[0]: v for k, v in base.items() if k.endswith(f"@{seed}")}
        print(f"  seed {seed}: " + " ".join(f"{k.split()[0]} {v:.2f}" for k, v in s.items()))

    # ---- 1. plain truncation at several bond dimensions ------------------
    print("\nplain SVD rebuild (bond dimension χ):")
    print(f"  {'χ':>4s} {'factored':>10s} {'vs dense':>9s} {'max drop':>9s}  scores (seed 4242)")
    sweep = []
    for chi in (32, 40, 48, 56, 64):
        st = projected(state, chi)
        m = build(st, cfg)
        s = score_all(m)
        mn, _ = margin(s, base)
        p = factored_params(st, chi)
        sweep.append({"chi": chi, "params": p, "scores": s, "max_drop": mn})
        line = {k.split("@")[0]: v for k, v in s.items() if k.endswith("@4242")}
        print(f"  {chi:>4d} {p:>10,} {p/dense_params:>8.1%} {mn:>+9.3f}  "
              + " ".join(f"{k.split()[0]} {v:.2f}" for k, v in line.items()))

    # ---- 2. DMRG-style projected refinement ------------------------------
    print("\nprojected refinement (gradient step → SVD projection back to χ):")
    refined = []
    for chi in (32, 48, 56):
        t0 = time.time()
        m = projected_refine(state, cfg, chi, base=base)
        st = {k: v.clone() for k, v in m.state_dict().items()}
        s = score_all(build(st, cfg))
        mn, _ = margin(s, base)
        refined.append({"chi": chi, "params": factored_params(st, chi), "scores": s,
                        "max_drop": mn, "wall_s": round(time.time() - t0),
                        "state": st})
        print(f"  χ={chi} final: max drop {mn:+.3f}  "
              f"{'ACCEPTED' if mn <= 0.02 else 'rejected'}\n", flush=True)

    # ---- 3. export the smallest accepted rebuild -------------------------
    ok = [r for r in refined if r["max_drop"] <= 0.02]
    best = min(ok, key=lambda r: r["params"]) if ok else None
    best_rec = None
    if best:
        chi = best["chi"]
        m = build(best["state"], cfg)
        out = HERE / f"entangled-refined-chi{chi}.gguf"
        export_gguf(m, out, cfg, cfg["ctx"])
        sets = task.eval_sets(4242)
        probe = []
        for skill, samples in sets.items():
            p, _ = samples[0]
            probe.append((p, batched_generate(m, [p], max_new=48, temperature=0.0)[0]))
        ex, text = engine_check(out, probe)
        print(f"exported {out.relative_to(REPO)} ({out.stat().st_size:,} bytes)")
        print(f"engine faithfulness {ex:.2%} of the rebuild's greedy answers\n")
        print("\n".join("  " + l for l in text.splitlines() if l.startswith(("ok", "MISS", "exact"))))
        best_rec = {"chi": chi, "gguf": str(out), "engine_exact": ex,
                    "bytes": out.stat().st_size, "params": best["params"]}
    else:
        print("no refined rebuild held every skill within 0.02 on both seeds")

    (HERE / "refine.json").write_text(json.dumps({
        "dense_params": dense_params, "base": base, "seeds": list(SEEDS),
        "sweep": sweep,
        "refined": [{k: v for k, v in r.items() if k != "state"} for r in refined],
        "best": best_rec,
    }, indent=1))
    print(f"\nwrote {(HERE / 'refine.json').relative_to(REPO)}")


if __name__ == "__main__":
    main()
