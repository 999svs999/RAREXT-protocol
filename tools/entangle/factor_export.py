"""Export a rebuilt model as an MPO-factored GGUF and compare it to the dense one.

Two artifacts from the same refined weights:
  entangled-dense.gguf     — the usual dense GGUF
  entangled-factored.gguf  — `X.a` (χ × in) and `X.b` (out × χ) instead of X.weight

Both are served by the same engine; the factored one is smaller and does two
small matmuls per linear layer instead of one large one. This script measures
bytes, decode wall time, and whether the two produce the same answers.

Run:  python3 tools/entangle/factor_export.py --chi 48
"""

import argparse
import json
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
# refine_rebuild is only needed by this file's own CLI; importing it at module
# level drags the whole rebuild pipeline into every consumer of FACTOR_MAP
# (which is what broke the Kaggle kernel's import chain).
def _cli_deps():
    from refine_rebuild import CKPT, build, projected_refine  # noqa: E402
    return CKPT, build, projected_refine

FACTOR_MAP = {
    "q.weight": "attn_q", "k.weight": "attn_k", "v.weight": "attn_v",
    "o.weight": "attn_output", "gate.weight": "ffn_gate",
    "up.weight": "ffn_up", "down.weight": "ffn_down",
}


def meta(w, cfg, name):
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


def export_factored(state, cfg, path, chi):
    w = GGUFWriter()
    meta(w, cfg, "rarext-entanglement-rebuild-factored")
    sd = {k: v.detach().float().numpy() for k, v in state.items()}
    w.add_tensor("token_embd.weight", sd["emb.weight"])
    w.add_tensor("output_norm.weight", sd["norm.weight"])
    kept = 0
    dense_params = 0
    for i in range(cfg["layers"]):
        p, n = f"blocks.{i}.", f"blk.{i}."
        w.add_tensor(n + "attn_norm.weight", sd[p + "attn_norm.weight"])
        w.add_tensor(n + "ffn_norm.weight", sd[p + "ffn_norm.weight"])
        for src, dst in FACTOR_MAP.items():
            W = sd[p + src]
            u, s, vt = np.linalg.svd(W.astype(np.float64), full_matrices=False)
            r = min(chi, len(s))
            # B = U[:, :r] (out × r); A = diag(s[:r])·Vᵀ[:r] (r × in)
            B = u[:, :r].astype(np.float32)
            A = (s[:r, None] * vt[:r]).astype(np.float32)
            w.add_tensor(n + dst + ".a", A)
            w.add_tensor(n + dst + ".b", B)
            kept += r * (W.shape[0] + W.shape[1])
            dense_params += W.shape[0] * W.shape[1]
    w.write(str(path))
    total = kept + sd["emb.weight"].size + sum(
        sd[f"blocks.{i}.{nm}"].size for i in range(cfg["layers"])
        for nm in ("attn_norm.weight", "ffn_norm.weight"))
    return total, dense_params


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chi", type=int, default=48)
    args = ap.parse_args()
    CKPT, build, projected_refine = _cli_deps()
    ck = torch.load(CKPT, map_location="cpu")
    cfg, state = ck["config"], ck["state"]

    print(f"refining χ={args.chi} …", flush=True)
    refined = projected_refine(state, cfg, args.chi, steps=320, report_every=0)
    rstate = {k: v.clone() for k, v in refined.state_dict().items()}
    torch.save({"config": cfg, "state": rstate}, HERE / f"refined-chi{args.chi}.pt")

    # dense reference with the same weights
    from refine_rebuild import export_gguf
    dense_path = HERE / "entangled-dense.gguf"
    export_gguf(build(rstate, cfg), dense_path, cfg, cfg["ctx"])

    fac_path = HERE / "entangled-factored.gguf"
    factored_params, dense_matrix_params = export_factored(rstate, cfg, fac_path, args.chi)

    dense_bytes = dense_path.stat().st_size
    fac_bytes = fac_path.stat().st_size
    print(f"dense    {dense_path.name:28s} {dense_bytes:>10,} bytes")
    print(f"factored {fac_path.name:28s} {fac_bytes:>10,} bytes  "
          f"({fac_bytes/dense_bytes:.1%} of dense)")
    print(f"matrix params: {factored_params:,} factored vs {dense_matrix_params:,} dense "
          f"({factored_params/dense_matrix_params:.1%})")

    # Same answers, same engine. Build all held-out prompts once.
    sets = task.eval_sets(4242)
    prompts = [(skill, p) for skill, samples in sets.items() for p, _ in samples]
    pf = HERE / "_compare-prompts.json"
    pf.write_text(json.dumps([{"prompt": p} for _, p in prompts]))

    print("\nrunning both through apps/runtime/engines/rarext-gguf-engine.js …", flush=True)
    out = {}
    for label, path in (("dense", dense_path), ("factored", fac_path)):
        t0 = time.time()
        import subprocess
        r = subprocess.run(["node", str(REPO / "models/live-host-lm/engine_check.mjs"),
                            str(path), str(pf)],
                           capture_output=True, text=True, timeout=7200)
        got = [l.split("got  ", 1)[1].split("   (", 1)[0] for l in r.stdout.splitlines()
               if l.strip().startswith("got  ")]
        out[label] = got
        took = time.time() - t0
        print(f"  {label:8s} {len(got)} prompts in {took:.1f}s "
              f"({took/len(got)*1000:.0f} ms/prompt)", flush=True)

    same = sum(1 for a, b in zip(out["dense"], out["factored"]) if a == b)
    print(f"\nidentical answers: {same}/{len(prompts)} ({100*same/len(prompts):.1f}%)")
    diffs = [(i, prompts[i][0], out["dense"][i], out["factored"][i])
             for i in range(len(prompts)) if out["dense"][i] != out["factored"][i]]
    for i, skill, a, b in diffs[:5]:
        print(f"  diff {skill}: dense {a} | factored {b}")

    (HERE / "factored.json").write_text(json.dumps({
        "chi": args.chi, "dense_bytes": dense_bytes, "factored_bytes": fac_bytes,
        "factored_matrix_params": factored_params,
        "dense_matrix_params": dense_matrix_params,
        "prompts": len(prompts), "identical": same, "diffs": len(diffs),
    }, indent=1))


if __name__ == "__main__":
    main()
