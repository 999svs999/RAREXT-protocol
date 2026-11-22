"""Holographic encoding for RAREXT — measured, not asserted.

Holographic Reduced Representations (Plate 1995/2003) store structured data in
a SINGLE high-dimensional vector: a (role, filler) binding is elementwise
complex multiplication (FHRR — phasor vectors), a whole table is the SUM of its
bindings, and recall unbinds the cue and cleans up against a vocabulary. The
claim this module tests is the one the objective asks about: **capacity scales
in another dimension** — the vector dimension D — with storage cost that does
not grow with the number of stored pairs.

Five measured experiments:

  1. binding fidelity vs D        — unbind+cleanup accuracy as D grows
  2. superposition capacity vs D  — K pairs in ONE vector; the capacity curve
  3. noise robustness             — corrupted cue, cleanup recovery
  4. compositional items          — a word vocabulary represents unboundedly
                                    many items ("scaling in another dimension")
  5. the RAREXT price task        — holographic table vs the trained χ=48
                                    model: what each axis buys, in bytes

Run:  python3 tools/holographic/hrr.py
"""

import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RNG = np.random.default_rng(4711)


# ---------------------------------------------------------------------------
# FHRR primitives: a vector is D unit phasors; binding is elementwise complex
# multiplication; unbinding is multiplication by the conjugate; superposition
# is addition. In the Fourier domain circular convolution (Plate's original
# binding) IS elementwise multiplication — this is the same algebra without
# the O(D²) convolution cost.
# ---------------------------------------------------------------------------
def rand_phasor(d, rng=RNG):
    return np.exp(1j * rng.uniform(-np.pi, np.pi, d))


def bind(a, b):
    return a * b


def unbind(superposition, cue):
    return superposition * np.conj(cue)


def similarity(a, b):
    """Normalized cosine similarity of two phasor vectors."""
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.real(np.vdot(a, b)) / denom) if denom else 0.0


def cleanup(z, vocabulary):
    """Nearest stored item by cosine similarity. Returns (name, similarity).
    Vectorized: phasors are unit-norm, so the cosine is a dot product."""
    names = list(vocabulary)
    matrix = np.stack([vocabulary[name] for name in names])
    sims = np.real(matrix @ np.conj(z)) / np.linalg.norm(z)
    best = int(np.argmax(sims))
    return names[best], float(sims[best])


def distractors(d, n, rng=RNG):
    """n random phasor vectors that are NOT the target — makes cleanup honest."""
    return {f"distractor{i}": rand_phasor(d, rng) for i in range(n)}


# ---------------------------------------------------------------------------
# 1. binding fidelity vs D
# ---------------------------------------------------------------------------
def binding_fidelity(dims, trials=200, distractor_count=1000):
    rows = []
    for d in dims:
        ok = 0
        sims = []
        for _ in range(trials):
            a, b = rand_phasor(d), rand_phasor(d)
            recovered = unbind(bind(a, b), a)
            vocab = {"target": b}
            vocab.update(distractors(d, distractor_count))
            name, sim = cleanup(recovered, vocab)
            sims.append(sim)
            if name == "target":
                ok += 1
        rows.append({"d": d, "accuracy": ok / trials, "mean_similarity": float(np.mean(sims))})
    return rows


# ---------------------------------------------------------------------------
# 2. superposition capacity vs D — K pairs in ONE vector
# ---------------------------------------------------------------------------
def superposition_capacity(dims, k_values, trials=40):
    """Store K (item, price) bindings in one vector; query each item."""
    rows = []
    for d in dims:
        for k in k_values:
            ok_total = 0
            for _ in range(trials):
                items = {f"item{i}": rand_phasor(d) for i in range(k)}
                prices = {f"price{i}": rand_phasor(d) for i in range(k)}
                memory = np.zeros(d, dtype=complex)
                for i in range(k):
                    memory += bind(items[f"item{i}"], prices[f"price{i}"])
                vocab = dict(prices)
                vocab.update(distractors(d, 5000))
                ok = 0
                for i in range(k):
                    recovered = unbind(memory, items[f"item{i}"])
                    name, _ = cleanup(recovered, vocab)
                    if name == f"price{i}":
                        ok += 1
                ok_total += ok
            rows.append({"d": d, "k": k, "queries": trials * k,
                         "accuracy": ok_total / (trials * k)})
    return rows


# ---------------------------------------------------------------------------
# 3. noise robustness — a corrupted cue
# ---------------------------------------------------------------------------
def noise_recovery(d, corrupt_probs, trials=200):
    rows = []
    for p in corrupt_probs:
        ok = 0
        for _ in range(trials):
            a, b = rand_phasor(d), rand_phasor(d)
            memory = bind(a, b)
            cue = a.copy()
            bad = RNG.choice(d, size=int(p * d), replace=False)
            cue[bad] = rand_phasor(1, RNG)[0]  # random phase replaces the true one
            recovered = unbind(memory, cue)
            vocab = {"target": b}
            vocab.update(distractors(d, 1000))
            name, _ = cleanup(recovered, vocab)
            ok += name == "target"
        rows.append({"d": d, "corrupt_fraction": p, "accuracy": ok / trials})
    return rows


# ---------------------------------------------------------------------------
# 4. compositional items — words compose into unboundedly many item vectors
# ---------------------------------------------------------------------------
def compositional_capacity(d, k_values=25, n_words=60, trials=40):
    """Does composing item vectors from a small word vocabulary (an item =
    the product of its words' phasors) cost retrieval accuracy versus atomic
    item vectors? If not, a 60-word vocabulary represents unboundedly many
    items — the holographic answer to 'scaling in another dimension'."""
    rng = np.random.default_rng(99)
    k = k_values
    atomic_ok = comp_ok = 0
    queries = 0
    for _ in range(trials):
        # atomic items
        items = {f"a{i}": rand_phasor(d, rng) for i in range(k)}
        prices = {f"p{i}": rand_phasor(d, rng) for i in range(k)}
        memory = np.zeros(d, dtype=complex)
        for i in range(k):
            memory += bind(items[f"a{i}"], prices[f"p{i}"])
        vocab = dict(prices)
        vocab.update(distractors(d, 5000, rng))
        for i in range(k):
            name, _ = cleanup(unbind(memory, items[f"a{i}"]), vocab)
            atomic_ok += name == f"p{i}"
            queries += 1
        # compositional items over 60 words
        word_names = [rand_phasor(d, rng) for _ in range(n_words)]
        for i in range(k):
            n = int(rng.integers(1, 4))
            item = word_names[0]
            for _ in range(n - 1):
                item = bind(item, word_names[int(rng.integers(0, n_words))])
            memory += bind(item, prices[f"p{i}"])
        for i in range(k):
            n = int(rng.integers(1, 4))
            item = word_names[0]
            for _ in range(n - 1):
                item = bind(item, word_names[int(rng.integers(0, n_words))])
            name, _ = cleanup(unbind(memory, item), vocab)
            comp_ok += name == f"p{i}"
    return {"d": d, "k": k, "queries": queries,
            "atomic_accuracy": atomic_ok / queries,
            "compositional_accuracy": comp_ok / queries}


# ---------------------------------------------------------------------------
# 5. the RAREXT price task — holographic table vs the trained model
# ---------------------------------------------------------------------------
def price_task_scaling(dims, pair_counts, trials=30):
    """Encode (item, price) pairs holographically; measure retrieval at each
    (D, K). Items are compositional over a 40-word vocabulary, prices are
    single tokens. The memory's byte cost is D*16 (complex128) regardless of K;
    the word vocabulary adds 40*D*16."""
    rng = np.random.default_rng(1234)
    price_vectors = {f"${p}": rand_phasor(d, rng) for p in range(10, 10000, 7)}
    price_names = list(price_vectors)
    rows = []
    for d in dims:
        words = {f"w{i}": rand_phasor(d, rng) for i in range(40)}
        word_names = list(words)
        for k in pair_counts:
            ok = 0
            queries = 0
            for _ in range(trials):
                memory = np.zeros(d, dtype=complex)
                table = []
                for i in range(k):
                    n = int(rng.integers(1, 4))
                    parts = [words[word_names[int(rng.integers(0, 40))]] for _ in range(n)]
                    item = parts[0]
                    for part in parts[1:]:
                        item = bind(item, part)
                    pname = price_names[int(rng.integers(0, len(price_names)))]
                    memory += bind(item, price_vectors[pname])
                    table.append((item, pname))
                for item, pname in table:
                    recovered = unbind(memory, item)
                    name, _ = cleanup(recovered, price_vectors)
                    ok += name == pname
                    queries += 1
            rows.append({"d": d, "pairs": k, "queries": queries,
                         "accuracy": ok / queries,
                         "memory_bytes": d * 16,
                         "bytes_per_pair": d * 16 / k})
    return rows


def main():
    print("holographic encoding — measured (FHRR: phasor vectors, elementwise binding)\n")
    result = {}

    print("1. binding fidelity vs dimension D")
    dims = [64, 128, 256, 512, 1024, 2048, 4096]
    result["binding"] = binding_fidelity(dims)
    for r in result["binding"]:
        print(f"   D={r['d']:>5}  accuracy {r['accuracy']:>6.1%}  mean sim {r['mean_similarity']:.4f}")

    print("\n2. superposition capacity: K (item,price) pairs in ONE vector")
    k_values = [1, 5, 10, 25, 50, 100, 200]
    result["capacity"] = superposition_capacity([256, 1024, 4096], k_values)
    for d in (256, 1024, 4096):
        line = " ".join(
            f"K{k}={next(r['accuracy'] for r in result['capacity'] if r['d'] == d and r['k'] == k):.0%}"
            for k in k_values)
        print(f"   D={d:>5}  {line}")

    print("\n3. noise robustness (D=1024): corrupted cue → cleanup")
    result["noise"] = noise_recovery(1024, [0.0, 0.05, 0.1, 0.2, 0.3, 0.5])
    for r in result["noise"]:
        print(f"   corrupt {r['corrupt_fraction']:>4.0%}  accuracy {r['accuracy']:>6.1%}")

    print("\n4. compositional vs atomic items (60 word vocabulary, K=25, D=2048)")
    result["compositional"] = compositional_capacity(2048)
    r = result["compositional"]
    print(f"   atomic {r['atomic_accuracy']:.1%} vs compositional {r['compositional_accuracy']:.1%} "
          f"over {r['queries']} queries — 60 word vectors standing in for {r['k']} items per batch")

    print("\n5. the RAREXT price task: holographic (item→price) memory")
    result["price_task"] = price_task_scaling([1024, 4096, 16384], [10, 50, 200])
    for r in result["price_task"]:
        print(f"   D={r['d']:>6} K={r['pairs']:>4}  accuracy {r['accuracy']:>6.1%}  "
              f"memory {r['memory_bytes']/1024:>6.0f} KiB  ({r['bytes_per_pair']:.0f} B/pair)")

    out = HERE / "hrr-results.json"
    out.write_text(json.dumps(result, indent=1))
    print(f"\nwrote {out.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    main()
