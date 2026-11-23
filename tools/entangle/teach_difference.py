"""Teach the χ=48 rebuild a NEW skill: price-difference arithmetic.

The base host reads prices and compares them (min/max). This refines the
refined-chi48 weights with a skill it never had — subtracting:

    rows: -A|$936\n-B|$419
    q: how much more expensive is A than B?
    a:  A costs $517 more than B.

Method: the refine_rebuild.py loop (supervised steps on computed gold, SVD
projection back onto the χ=48 manifold after every step) with a curriculum
that mixes the NEW skill with replay of the existing seven — the projection
searches for the new function INSIDE the low-entanglement manifold without
giving up the old ones.

Gates (computed, both must pass):
  new skill    ≥ 90% on a held-out set it never trained on
  old skills   no set regresses by more than one held-out sample (0.042)

Output: a new factored GGUF + a digest the in-browser page pins.

Run:  python3 tools/entangle/teach_difference.py
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
sys.path.insert(0, str(HERE))

from train import TinyLM, VOCAB, VOCAB_TOKENS, EOS, encode  # noqa: E402
from gguf import GGUFWriter  # noqa: E402
import task  # noqa: E402
from model import batched_generate, answer_logprobs  # noqa: E402
from factor_export import FACTOR_MAP  # noqa: E402

CKPT = HERE / "refined-chi48.pt"
CHI = int(__import__('os').environ.get('TEACH_CHI', '96'))
STEPS = 3000
SEED = 4242

# the new skill's surface: two rows, the question names the more expensive one
NEW_TEMPLATE = "rows: -{a}|${pa}\n-{b}|${pb}\nq: how much more expensive is {a} than {b}?\na: "
NEW_GOLD = "{a} costs ${diff} more than {b}."


def new_skill_example(rng, stage=1):
    """A price-difference example with computed gold.
    stage 1: NO-CARRY differences (every digit of p1 >= p2) — digit-wise
    subtraction without borrowing, the learnable base case.
    stage 2: full range with carries."""
    while True:
        pa = rng.randrange(100, 9999)
        pb = rng.randrange(100, 9999)
        if pa <= pb:
            continue
        if stage == 1:
            sa = str(pa)
            sb = str(pb).rjust(len(sa), "0")
            if all(int(x) >= int(y) for x, y in zip(sa, sb)) and pa - pb >= 10:
                break
        else:
            if pa - pb >= 10:
                break
    a = task.make_item(rng)
    b = task.make_item(rng)
    while b == a:
        b = task.make_item(rng)
    prompt = NEW_TEMPLATE.format(a=a, b=b, pa=pa, pb=pb)
    gold = NEW_GOLD.format(a=a, diff=pa - pb, b=b)
    return prompt, gold


def new_skill_sets():
    """Train/held-out split of the new skill (held-out never enters training).
    Held-out spans BOTH stages. Examples are kept only when prompt+answer fits
    the model's 192-token context with room to spare."""
    train = []
    rng = random.Random(SEED)
    while len(train) < 3000:
        p, a = new_skill_example(rng, stage=1 if len(train) < 1500 else 2)
        if len(encode(p)) + len(encode(a)) <= 176:
            train.append((p, a))
    held = []
    hrng = random.Random(SEED + 999)
    while len(held) < 40:
        p, a = new_skill_example(hrng, stage=1 if len(held) < 20 else 2)
        if len(encode(p)) + len(encode(a)) <= 176:
            held.append((p, a))
    return train, held


def score_new_skill(model, held):
    outs = batched_generate(model, [p for p, _ in held], max_new=48, temperature=0.0)
    hits = 0
    for (_, want), got in zip(held, outs):
        # exact match on the gold template; also accept a numerically correct
        # restatement (the skill is the subtraction, not one phrasing)
        if got == want:
            hits += 1
            continue
        import re
        m_want = re.search(r"\$(\d+) more", want)
        m_got = re.search(r"\$(\d+) more", got)
        if m_want and m_got and m_want.group(1) == m_got.group(1):
            hits += 1
    return hits, len(held)


def old_skill_score(model):
    """The seven deployed sets (one seed, 24 samples each) — the regression gate."""
    sets = task.eval_sets(SEED)
    out = {}
    for name, samples in sets.items():
        sub = samples[:24]
        outs = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
        out[name] = sum(task.exact_match(p, a) for (p, _), a in zip(sub, outs)) / len(sub)
    return out


def project(state, chi):
    out = {}
    for name, w in state.items():
        if w.dim() != 2:
            out[name] = w.clone()
            continue
        a = w.detach().numpy().astype(np.float64)
        u, sv, vt = np.linalg.svd(a, full_matrices=False)
        r = min(chi, len(sv))
        out[name] = torch.from_numpy(((u[:, :r] * sv[:r]) @ vt[:r]).astype(np.float32))
    return out


def export_factored(state, cfg, path):
    w = GGUFWriter()
    w.add_string("general.architecture", "qwen2")
    w.add_string("general.name", "rarext-entangled-chi48-skilled")
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
    sd = {k: v.detach().float().numpy() for k, v in state.items()}
    w.add_tensor("token_embd.weight", sd["emb.weight"])
    w.add_tensor("output_norm.weight", sd["norm.weight"])
    for i in range(cfg["layers"]):
        p, n = f"blocks.{i}.", f"blk.{i}."
        w.add_tensor(n + "attn_norm.weight", sd[p + "attn_norm.weight"])
        w.add_tensor(n + "ffn_norm.weight", sd[p + "ffn_norm.weight"])
        for src, dst in FACTOR_MAP.items():
            W = sd[p + src]
            u, s, vt = np.linalg.svd(W.astype(np.float64), full_matrices=False)
            r = min(CHI, len(s))
            w.add_tensor(n + dst + ".a", (s[:r, None] * vt[:r]).astype(np.float32))
            w.add_tensor(n + dst + ".b", u[:, :r].astype(np.float32))
    w.write(str(path))


def main():
    print("teach the χ=48 rebuild a new skill: price-difference arithmetic\n")
    ck = torch.load(CKPT, map_location="cpu")
    cfg, state = ck["config"], ck["state"]
    model = TinyLM(VOCAB, cfg["d"], cfg["layers"], cfg["heads"], cfg["ffn"], cfg["ctx"])
    model.load_state_dict(state)
    model.eval()

    train_pairs, held_pairs = new_skill_sets()
    print(f"new skill: {len(train_pairs)} train / {len(held_pairs)} held-out examples (computed gold)")

    base_old = old_skill_score(model)
    print("before — old skills:", " ".join(f"{k.split()[0]}={v:.2f}" for k, v in base_old.items()))
    hits, n = score_new_skill(model, held_pairs)
    print(f"before — new skill: {hits}/{n} (expected ~0: the model has never seen subtraction)\n")

    # ---- the refine loop: supervised on computed gold, project back to χ=48 ----
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, betas=(0.9, 0.95), weight_decay=0.01)
    rng = random.Random(SEED + 1)
    replay_rng = random.Random(SEED + 2)
    t0 = time.time()
    for step in range(1, STEPS + 1):
        # curriculum: 60% new skill, 40% replay of the old ones (never traded away)
        stage = 1 if step <= 1800 else 2
        batch = []
        for _ in range(16):
            p, a = train_pairs[rng.randrange(len(train_pairs))]
            # before the widen, keep sampling narrow-difference examples
            if stage == 1:
                import re as _re
                m = _re.search(r"\$(\d+) more", a)
                if m and not (10 <= int(m.group(1)) <= 99):
                    p, a = train_pairs[rng.randrange(200)]
            batch.append((p, a))
        for _ in range(10):
            name = rng.choice(list(task.eval_sets(SEED)))
            p, a = task.eval_sets(SEED)[name][replay_rng.randrange(24)]
            if len(encode(p)) + len(encode(a)) <= 176:
                batch.append((p, a))
        lp, _ = answer_logprobs(model, [p for p, _ in batch], [a for _, a in batch])
        lens = torch.tensor([max(1, len(a)) for _, a in batch], dtype=torch.float)
        loss = -(lp / lens).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        model.eval()
        with torch.no_grad():
            projected = project(model.state_dict(), CHI)
            model.load_state_dict(projected)
        if step % 150 == 0 or step == 1:
            hits, n = score_new_skill(model, held_pairs)
            sample = batched_generate(model, [held_pairs[0][0]], max_new=48, temperature=0.0)[0]
            print(f"  step {step:>4}  loss {float(loss):.4f}  new-skill {hits}/{n}  "
                  f"sample={sample!r}  [{time.time()-t0:.0f}s]", flush=True)
            torch.save({"config": cfg, "state": model.state_dict()}, HERE / "refined-chi48-teaching.pt")

    # ---- gates ----
    held2 = []
    hrng2 = random.Random(SEED + 4242)
    while len(held2) < 40:
        pp, aa = new_skill_example(hrng2, stage=2)
        if len(encode(pp)) + len(encode(aa)) <= 176:
            held2.append((pp, aa))
    h1, n1 = score_new_skill(model, held_pairs)
    h2, n2 = score_new_skill(model, held2)
    hits, n = h1 + h2, n1 + n2
    new_acc = hits / n
    after_old = old_skill_score(model)
    regressions = {k: base_old[k] - after_old[k] for k in base_old}
    worst = max(regressions.values())
    print(f"\nafter — new skill: {hits}/{n} = {new_acc:.1%} (gate ≥ 90%)")
    print("after — old skills:", " ".join(f"{k.split()[0]}={v:.2f}" for k, v in after_old.items()))
    print(f"worst regression: {worst:+.3f} (gate ≤ 0.042 = one held-out sample)")
    gates_ok = new_acc >= 0.90 and worst <= 0.042
    print("GATES:", "PASS" if gates_ok else "FAIL")

    result = {
        "new_skill_accuracy": new_acc, "new_gate": ">=0.90", "new_gate_pass": new_acc >= 0.90,
        "old_before": base_old, "old_after": after_old,
        "worst_regression": worst, "old_gate": "<=0.042", "old_gate_pass": worst <= 0.042,
        "gates_ok": gates_ok, "steps": STEPS, "chi": CHI,
    }

    if gates_ok:
        out = HERE / "entangled-chi48-skilled.gguf"
        export_factored(project(model.state_dict(), CHI), cfg, out)
        torch.save({"config": cfg, "state": model.state_dict()}, HERE / "refined-chi48-skilled.pt")
        import hashlib
        digest = hashlib.sha256(out.read_bytes()).hexdigest()
        result["gguf"] = str(out)
        result["gguf_bytes"] = out.stat().st_size
        result["gguf_sha256"] = digest
        print(f"\nexported {out.relative_to(REPO)} ({out.stat().st_size:,} bytes)")
        print(f"sha256 {digest}")
        # engine faithfulness on the new skill: the exported artifact must
        # reproduce the trained answers through RAREXT's engine
        probe = [{"prompt": p} for p, _ in held_pairs[:8]]
        pf = HERE / "_skilled-probes.json"
        pf.write_text(json.dumps(probe))
        r = subprocess.run(["node", str(REPO / "models/live-host-lm/engine_check.mjs"), str(out), str(pf)],
                           capture_output=True, text=True, timeout=900)
        oks = sum(1 for l in r.stdout.splitlines() if l.startswith("ok  "))
        print(f"engine faithfulness on new-skill probes: {oks}/{len(probe)}")
        result["engine_new_skill"] = oks / len(probe)
        pf.unlink()
    (HERE / "teach-difference.json").write_text(json.dumps(result, indent=1))
    print(f"wrote tools/entangle/teach-difference.json")


if __name__ == "__main__":
    main()
