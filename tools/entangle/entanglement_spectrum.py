"""The model's entanglement spectrum.

Every weight matrix W ∈ R^{m×n} has a Schmidt decomposition W = U·diag(s)·Vᵀ.
The normalized squares s_i² are exactly an entanglement spectrum, and the
number of terms kept is the bond dimension χ. This script measures, for the
promoted RAREXT model, how much of each matrix's weight lives in its first χ
Schmidt terms — i.e. how entangled the trained function actually is.

Run:  python3 tools/entangle/entanglement_spectrum.py [checkpoint.pt]
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[2]
DEFAULT = REPO / "agents/self-evolve/generations/gen-000.pt"


def participation_ratio(s):
    """(Σs²)² / Σs⁴ — the effective number of Schmidt terms carrying weight."""
    p = s ** 2
    p = p / p.sum()
    return float((p.sum() ** 2) / (p ** 2).sum())


def entropy_bits(s):
    p = s ** 2
    p = p / p.sum()
    p = p[p > 0]
    return float(-(p * np.log2(p)).sum())


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    ck = torch.load(path, map_location="cpu")
    cfg = ck["config"]
    state = ck["state"]
    print(f"checkpoint {path.relative_to(REPO)}")
    print(f"  config {cfg}")
    total = sum(v.numel() for v in state.values())
    print(f"  parameters {total:,}\n")

    chi_list = [4, 8, 16, 32, 64, 128, 256, 512]
    rows = []
    print(f"{'matrix':30s} {'shape':>12s} {'rank':>5s} {'PR':>7s} {'H(bits)':>8s} "
          f"{'χ@99%':>6s} {'χ@99.9%':>8s}")
    for name, w in state.items():
        if w.dim() != 2:
            continue
        s = np.linalg.svd(w.numpy().astype(np.float64), compute_uv=False)
        e = s ** 2
        e = e / e.sum()
        cum = np.cumsum(e)
        chi99 = int(np.searchsorted(cum, 0.99) + 1)
        chi999 = int(np.searchsorted(cum, 0.999) + 1)
        rows.append({
            "name": name, "shape": list(w.shape), "rank": int((s > 1e-12).sum()),
            "pr": participation_ratio(s), "entropy_bits": entropy_bits(s),
            "chi99": chi99, "chi999": chi999, "sv": s.tolist(),
            "energy": e.tolist(),
        })
        print(f"{name:30s} {str(tuple(w.shape)):>12s} {int((s>1e-12).sum()):>5d} "
              f"{participation_ratio(s):>7.1f} {entropy_bits(s):>8.2f} "
              f"{chi99:>6d} {chi999:>8d}")

    # ---- aggregate: rebuild every matrix at bond dimension χ ----------
    print("\nrebuild from the spectrum at bond dimension χ")
    print(f"{'χ':>5s} {'params kept':>13s} {'of dense':>9s} {'Frob weight':>12s} "
          f"{'min per-matrix':>14s}")
    sweep = {}
    for chi in chi_list:
        kept = 0
        num = 0.0
        den = 0.0
        worst = 1.0
        for r in rows:
            s = np.array(r["sv"])
            r_eff = min(chi, len(s))
            kept += r_eff * (r["shape"][0] + r["shape"][1])
            num += float((s[:r_eff] ** 2).sum())
            den += float((s ** 2).sum())
            worst = min(worst, float((s[:r_eff] ** 2).sum() / (s ** 2).sum()))
        sweep[chi] = {"params": kept, "weight": num / den, "worst": worst}
        print(f"{chi:>5d} {kept:>13,} {kept/total:>8.1%} {num/den:>11.4%} "
              f"{worst:>13.4%}")

    print("\nreading: a low `χ@99%` means the matrix is nearly separable — its")
    print("function survives a small bond dimension. `Frob weight` is how much of")
    print("the whole model's squared weight the truncated rebuild retains.")

    out = REPO / "tools/entangle/spectrum.json"
    out.write_text(json.dumps({
        "checkpoint": str(path), "config": cfg, "parameters": total,
        "matrices": [{k: v for k, v in r.items() if k != "sv"} for r in rows],
        "sweep": sweep,
    }, indent=1))
    print(f"\nwrote {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
