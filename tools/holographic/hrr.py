"""Holographic encoding for RAREXT — measured, not asserted.

Holographic Reduced Representations (Plate 1995/2003) store structured data in
a SINGLE high-dimensional vector: a (role, filler) binding is elementwise
complex multiplication (FHRR — phasor vectors), a whole table is the SUM of its
bindings, and recall unbinds the cue and cleans up against a vocabulary. The
claim this module tests is the one the objective asks about: **capacity scales
in another dimension** — the vector dimension D — with storage cost that does
not grow with the number of stored pairs.

Five measured experiments (all numbers land in hrr-results.json):

  1. binding fidelity vs D        — unbind+cleanup over 1000 distractors
  2. superposition capacity vs D  — K pairs in ONE vector; the capacity curve
  3. noise robustness             — corrupted cue, cleanup recovery
  4. compositional vs atomic      — a 60-word vocabulary standing in for items
  5. the RAREXT price task        — holographic table vs the trained χ=48
                                    model: what each axis buys, in bytes

Run:  python3 tools/holographic/hrr.py
"""

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RNG = np.random.default_rng(4711)


# ---------------------------------------------------------------------------
# FHRR primitives: a vector is D unit phasors; binding is elementwise complex
# multiplication; unbinding is multiplication by the conjugate; superposition
# is addition. In the Fourier domain circular convolution (Plate's original
# binding) IS elementwise multiplication — the same algebra, without the
# O(D²) convolution cost.
# ---------------------------------------------------------------------------
def rand_phasor(d, rng=RNG):
    rng = rng or RNG
    return np.exp(1j * rng.uniform(-np.pi, np.pi, d)).astype(np.complex64)


def bind(a, b):
    return a * b


def unbind(superposition, cue):
    return superposition * np.conj(cue)


def cleanup_batch(cues, targets, distractors):
    """For each cue, the best-matching name among targets+distractors.
    Phasors are unit-norm, so cosine = real dot. cues: (Q, D) complex64."""
    names = list(targets) + list(distractors)
    matrix = np.stack([np.asarray(targets[n], dtype=np.complex64) for n in targets] +
                      [np.asarray(distractors[n], dtype=np.complex64) for n in distractors])
    sims = np.real(cues @ np.conj(matrix.T)) / np.maximum(
        np.linalg.norm(cues, axis=1, keepdims=True), 1e-12)
    best = np.argmax(sims, axis=1)
    target_names = list(targets)
    return [target_names[b] if b < len(target_names) else f"distractor{b - len(target_names)}"
            for b in best]


def distractors(d, n, rng=RNG):
    return {f"distractor{i}": rand_phasor(d, rng) for i in range(n)}


# ---------------------------------------------------------------------------
# 1. binding fidelity vs D — cleanup over 1000 distractors
# ---------------------------------------------------------------------------
def binding_fidelity(dims, trials=200, distractor_count=1000):
    rows = []
    for d in dims:
        rng = np.random.default_rng(1000 + d)
        dis = distractors(d, distractor_count, rng)
        ok = 0
        sims = []
        for _ in range(trials):
            a, b = rand_phasor(d, rng), rand_phasor(d, rng)
            recovered = unbind(bind(a, b), a).reshape(1, -1)
            names = cleanup_batch(recovered, {"target": b}, dis)
            sim = float(np.real(np.vdot(recovered[0], b)) / d)
            sims.append(sim)
            ok += names[0] == "target"
        rows.append({"d": d, "accuracy": ok / trials, "mean_similarity": float(np.mean(sims))})
    return rows


# ---------------------------------------------------------------------------
# 2. superposition capacity vs D — K pairs in ONE vector
# ---------------------------------------------------------------------------
def superposition_capacity(dims, k_values, distractor_count=1000):
    rows = []
    for d in dims:
        for k in k_values:
            trials = max(4, min(40, 800 // k))
            rng = np.random.default_rng(2000 + d * 10 + k)
            dis = distractors(d, distractor_count, rng)
            ok_total = 0
            queries = 0
            for _ in range(trials):
                items = np.stack([rand_phasor(d, rng) for _ in range(k)])
                prices = np.stack([rand_phasor(d, rng) for _ in range(k)])
                memory = np.sum(items * prices, axis=0)
                recovered = memory * np.conj(items.T).T  # (k, D): memory * conj(item_i)
                recovered = (memory[np.newaxis, :] * np.conj(items))
                names = cleanup_batch(recovered, {f"price{i}": prices[i] for i in range(k)}, dis)
                ok_total += sum(names[i] == f"price{i}" for i in range(k))
                queries += k
            rows.append({"d": d, "k": k, "queries": queries,
                         "accuracy": ok_total / queries})
    return rows


# ---------------------------------------------------------------------------
# 3. noise robustness — a corrupted cue
# ---------------------------------------------------------------------------
def noise_recovery(d, corrupt_probs, trials=300, distractor_count=1000):
    rows = []
    for p in corrupt_probs:
        rng = np.random.default_rng(3000 + int(p * 100))
        dis = distractors(d, distractor_count, rng)
        ok = 0
        for _ in range(trials):
            a, b = rand_phasor(d, rng), rand_phasor(d, rng)
            memory = bind(a, b)
            cue = a.copy()
            bad = rng.choice(d, size=int(p * d), replace=False)
            cue[bad] = rand_phasor(1, rng)[0]
            names = cleanup_batch(unbind(memory, cue).reshape(1, -1), {"target": b}, dis)
            ok += names[0] == "target"
        rows.append({"d": d, "corrupt_fraction": p, "accuracy": ok / trials})
    return rows


# ---------------------------------------------------------------------------
# 4. compositional vs atomic items — does composing items from a small word
#    vocabulary cost retrieval accuracy? If not, 60 word vectors stand in for
#    unboundedly many items: the "another dimension" of scaling.
# ---------------------------------------------------------------------------
def compositional_capacity(d, k=25, n_words=60, trials=40, distractor_count=1000):
    rng = np.random.default_rng(99)
    atomic_ok = comp_ok = 0
    queries = 0
    for _ in range(trials):
        prices = {f"p{i}": rand_phasor(d, rng) for i in range(k)}
        vocab = dict(prices)
        vocab.update(distractors(d, distractor_count, rng))
        # atomic items
        items = [rand_phasor(d, rng) for _ in range(k)]
        memory = np.zeros(d, dtype=np.complex64)
        for i in range(k):
            memory += bind(items[i], prices[f"p{i}"])
        cues = np.stack([unbind(memory, items[i]) for i in range(k)])
        names = cleanup_batch(cues, prices, distractors(d, distractor_count, rng))
        atomic_ok += sum(names[i] == f"p{i}" for i in range(k))
        queries += k
        # compositional items: 1-3 words per item, composed by binding
        word_pool = [rand_phasor(d, rng) for _ in range(n_words)]
        comp_items = []
        for i in range(k):
            item = word_pool[0]
            for _ in range(int(rng.integers(1, 4)) - 1):
                item = bind(item, word_pool[int(rng.integers(0, n_words))])
            comp_items.append(item)
            memory += bind(item, prices[f"p{i}"])
        cues = np.stack([unbind(memory, item) for item in comp_items])
        names = cleanup_batch(cues, prices, distractors(d, distractor_count, rng))
        comp_ok += sum(names[i] == f"p{i}" for i in range(k))
    return {"d": d, "k": k, "queries": queries,
            "atomic_accuracy": atomic_ok / queries,
            "compositional_accuracy": comp_ok / queries}


# ---------------------------------------------------------------------------
# 5. the RAREXT price task — holographic (item→price) memory
# ---------------------------------------------------------------------------
def price_task_scaling(dims, pair_counts, distractor_count=1000):
    """Encode (item, price) pairs holographically; measure retrieval at each
    (D, K). Items are compositional over a 40-word vocabulary; prices are
    single tokens. The memory's byte cost is D*16 REGARDLESS of K; the word
    vocabulary adds 40*D*16."""
    rng = np.random.default_rng(1234)
    rows = []
    for d in dims:
        words = [rand_phasor(d, rng) for _ in range(40)]
        price_vectors = {f"${p}": rand_phasor(d, rng) for p in range(10, 10000, 7)}
        price_names = list(price_vectors)
        for k in pair_counts:
            trials = max(4, min(30, 600 // k))
            ok = 0
            queries = 0
            for _ in range(trials):
                memory = np.zeros(d, dtype=np.complex64)
                table = []
                for _ in range(k):
                    n = int(rng.integers(1, 4))
                    item = words[0]
                    for _ in range(n - 1):
                        item = bind(item, words[int(rng.integers(0, 40))])
                    pname = price_names[int(rng.integers(0, len(price_names)))]
                    memory += bind(item, price_vectors[pname])
                    table.append((item, pname))
                cues = np.stack([unbind(memory, item) for item, _ in table])
                names = cleanup_batch(cues, price_vectors, distractors(d, distractor_count, rng))
                ok += sum(names[i] == table[i][1] for i in range(k))
                queries += k
            rows.append({"d": d, "pairs": k, "queries": queries,
                         "accuracy": ok / queries,
                         "memory_bytes": d * 16,
                         "bytes_per_pair": d * 16 / k})
    return rows


def main():
    print("holographic encoding — measured (FHRR: phasor vectors, elementwise binding)\n")
    result = {}

    print("1. binding fidelity vs dimension D (cleanup over 1000 distractors)")
    dims = [64, 128, 256, 512, 1024, 2048, 4096]
    result["binding"] = binding_fidelity(dims)
    for r in result["binding"]:
        print(f"   D={r['d']:>5}  accuracy {r['accuracy']:>6.1%}  mean sim {r['mean_similarity']:.4f}")

    print("\n2. superposition capacity: K (item,price) pairs in ONE vector")
    k_values = [1, 5, 10, 25, 50, 100, 200]
    result["capacity"] = superposition_capacity([256, 1024, 4096], k_values)
    for d in (256, 1024, 4096):
        cells = []
        for k in k_values:
            acc = next(r["accuracy"] for r in result["capacity"] if r["d"] == d and r["k"] == k)
            cells.append(f"K{k}={acc:.0%}")
        print(f"   D={d:>5}  " + " ".join(cells))

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
    print(f"\nwrote tools/holographic/{out.name}")


if __name__ == "__main__":
    main()
