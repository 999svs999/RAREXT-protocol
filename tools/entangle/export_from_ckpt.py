"""Export a trained checkpoint to the shipped factored GGUF (χ=48).

Works for any source of the same state dict — the local run, the Kaggle
kernel's gpu-refined-diff.pt, or the Colab notebook's:

    python tools/entangle/export_from_ckpt.py --ckpt tools/entangle/gpu-refined-diff.pt

Prints the artifact path, size and sha256, which is what the promotion script
and the page pin.
"""
import argparse
import hashlib
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "models/live-host-lm"))
from train import VOCAB  # noqa: E402
from teach_ledger import export_factored  # noqa: E402
from train import TinyLM  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", default="tools/entangle/entangled-chi48-ledger-gpu.gguf")
    ap.add_argument("--chi", type=int, default=48)
    ap.add_argument("--name", default="rarext-entangled-chi48-ledger")
    args = ap.parse_args()

    ck_path = Path(args.ckpt) if Path(args.ckpt).is_absolute() else REPO / args.ckpt
    ck = torch.load(ck_path, map_location="cpu")
    cfg = ck["config"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(ck["state"])
    state = {k: v.float() for k, v in model.state_dict().items()}

    # the artifact must sit exactly on the chi=48 manifold — project once more
    from train_diff import project
    state = project(state, args.chi)

    out = REPO / args.out
    export_factored(state, cfg, out, args.chi, args.name)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"exported {out.relative_to(REPO)} — {out.stat().st_size:,} bytes")
    print(f"sha256 {digest}")


if __name__ == "__main__":
    main()
