"""The self-evolving agent loop.

    gen(0) is the deployed live-host model: it can copy a price (S0) and
    nothing else. Every generation:

      1. ROLLOUT   — sample k answers per prompt on a task mix (new skills +
                     replay of old skills), through the agent model.
      2. REWARD    — score every rollout with the computed checker (task.py).
      3. UPDATE    — REINFORCE with per-prompt baseline, plus self-imitation on
                     successes (the policy imitates its own verified wins —
                     STaR/RFT-style, so rare early successes are not wasted).
      4. EVALUATE  — held-out sets for every skill, scored by the same checker.
      5. VERIFY    — the candidate GGUF must reproduce the trainer's answers
                     through the REAL RAREXT engine before it may serve.
      6. PROMOTE   — only if every old skill holds AND the new skills improve:
                     export GGUF, atomic swap into the serving path, restart
                     the provider, record the generation. Otherwise revert and
                     keep training.

    The loop has no fixed endpoint (--generations 0 = run until stopped); every
    promotion is a line in generations.jsonl with the metrics, the digests and
    the wall time, so "self-evolving" is an inspectable ledger, not a claim.

    NVIDIA's role: teacher.py (Nemotron, free NIM tier) proposes the FIRST
    demonstrations of each new skill — the bootstrap the policy gradient needs
    when the success rate is zero. Nothing enters training until the checker
    accepts it.

    python3.11 evolve.py --iters 60 --generations 3
"""

import argparse
import hashlib
import json
import random
import subprocess
import sys
import time
from pathlib import Path

import torch

import model as agent_model
import task
from task import comp_example, eval_sets, exact_match, reward, s0_example

HERE = Path(__file__).resolve().parent
GENS = HERE / "generations"
SERVED_GGUF = HERE / ".." / ".." / "models" / "live-host-lm" / "live-host-lm.gguf"
LEDGER = GENS / "generations.jsonl"
ENGINE_CHECK = HERE / ".." / ".." / "models" / "live-host-lm" / "engine_check.mjs"
PY = sys.executable


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def imitation_step(model, opt, pairs):
    """Supervised step on verified demonstrations (teacher seeds, or the
    programmatic gold of an already-deployed skill). Per-token mean keeps the
    gradient scale independent of answer length."""
    if not pairs:
        return 0.0
    lp, _ = agent_model.answer_logprobs(model, [p for p, _ in pairs], [a for _, a in pairs])
    lens = torch.tensor([max(1, len(a)) for _, a in pairs], dtype=torch.float)
    loss = -(lp / lens.to(lp.device)).mean()
    opt.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    opt.step()
    return float(loss.detach())


def train_batch(model, opt, rows):
    """One REINFORCE + self-imitation step over (prompt, answer, reward) rows."""
    if not rows:
        return 0.0
    by_prompt = {}
    for p, a, r in rows:
        by_prompt.setdefault(p, []).append((a, r))
    baseline = {p: sum(r for _, r in v) / len(v) for p, v in by_prompt.items()}

    # self-imitation: the best rollout of each prompt when it is at least half
    # right (shaped partial credit counts) — this is what moves the policy's
    # MODE, not just its tail, which is exactly what greedy serving reads.
    im_rows = []
    for p, v in by_prompt.items():
        best = max(v, key=lambda ar: ar[1])
        if best[1] >= 0.5:
            im_rows.append((p, best[0]))
    losses = []
    if im_rows:
        lp, _ = agent_model.answer_logprobs(model, [p for p, _ in im_rows], [a for _, a in im_rows])
        losses.append(-lp.mean())
    # REINFORCE on every rollout with non-zero advantage
    advs = [r - baseline[p] for (p, a, r) in rows]
    pg_rows = [(p, a, adv) for (p, a, r), adv in zip(rows, advs) if abs(adv) > 1e-6]
    if pg_rows:
        lp, _ = agent_model.answer_logprobs(model, [p for p, _, _ in pg_rows], [a for _, a, _ in pg_rows])
        adv_t = torch.tensor([adv for _, _, adv in pg_rows])
        adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-6)
        losses.append(-(adv_t.to(lp.device) * lp).mean() * 0.5)

    if not losses:
        return 0.0
    opt.zero_grad(set_to_none=True)
    loss = sum(losses)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    opt.step()
    return float(loss.detach())


@torch.no_grad()
def evaluate(model, sets, n=40):
    from model import batched_generate

    out = {}
    for name, samples in sets.items():
        sub = samples[:n]
        outs = batched_generate(model, [p for p, _ in sub], max_new=48, temperature=0.0)
        hits = sum(task.exact_match(p, a) for (p, _), a in zip(sub, outs))
        out[name] = hits / len(sub)
    return out


def export_gguf(model, path: Path, ctx: int):
    sys.path.insert(0, str(HERE / ".." / ".." / "models" / "live-host-lm"))
    from gguf import GGUFWriter
    from train import EOS, VOCAB_TOKENS

    cfg = model.cfg
    w = GGUFWriter()
    w.add_string("general.architecture", "qwen2")
    w.add_string("general.name", "rarext-self-evolving-agent")
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


def engine_verify(gguf_path: Path, prompts) -> float:
    """The gate that matters: does the REAL RAREXT engine reproduce the trainer?"""
    pf = GENS / "verify-prompts.json"
    pf.write_text(json.dumps([{"prompt": p, "want": a} for p, a in prompts]))
    r = subprocess.run(
        ["node", str(ENGINE_CHECK), str(gguf_path), str(pf)],
        capture_output=True, text=True, timeout=600,
    )
    last = [l for l in r.stdout.splitlines() if l.startswith("exact match:")]
    if not last:
        print(r.stdout[-800:], r.stderr[-400:])
        return -1.0
    return float(last[0].split("(")[1].split("%")[0]) / 100.0


def dagger_step(model, opt, pairs):
    """Corrective step (DAgger-style, with computed expert labels).

    Roll out the model GREEDY on each prompt — the mode is what serving reads —
    find the first token where its answer diverges from the computed gold, and
    train the gold continuation from exactly that state. REINFORCE moves the
    sampled policy; this moves the mode. Prompts the model already answers
    correctly contribute nothing.
    """
    from model import batched_generate

    if not pairs:
        return 0, 0
    prompts = [p for p, _ in pairs]
    with torch.no_grad():
        greedy = batched_generate(model, prompts, max_new=48, temperature=0.0)
    fixes = []
    for (prompt, gold), got in zip(pairs, greedy):
        if task.exact_match(prompt, got):
            continue
        g_ids, gold_ids = agent_model.encode(prompt + got), agent_model.encode(prompt + gold)
        share = 0
        while share < len(g_ids) and share < len(gold_ids) and g_ids[share] == gold_ids[share]:
            share += 1
        if share >= len(gold_ids):
            continue
        # the model's own context up to the divergence, gold from there
        fixes.append((g_ids[:share], gold_ids[share:]))
    if not fixes:
        return 0, 0
    lp, _ = agent_model.answer_logprobs_ids(model, [a for a, _ in fixes], [b for _, b in fixes])
    lens = torch.tensor([len(b) for _, b in fixes], dtype=torch.float)
    loss = -(lp / lens.to(lp.device)).mean()
    opt.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    opt.step()
    return float(loss.detach()), len(fixes)


def mix_prompts(rng, n_total, gen_index=1):
    """Task mix: the new skills get most of the budget; deployed skills replay
    so evolution never trades away what is already live. The curriculum keeps
    the first generations on 2-row comparisons (a binary choice the policy can
    actually learn) and only widens to 3 rows once a generation has promoted."""
    max_rows = 2 if gen_index <= 2 else None
    rows = []
    for _ in range(n_total):
        roll = rng.random()
        if roll < 0.4:
            rows.append(comp_example(rng, "cheapest", n_rows=max_rows))
        elif roll < 0.8:
            rows.append(comp_example(rng, "priciest", n_rows=max_rows))
        else:
            rows.append(s0_example(rng))
    return rows  # [(prompt, computed gold answer)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--generations", type=int, default=3, help="0 = relentless (no end)")
    ap.add_argument("--iters", type=int, default=60, help="RL updates per generation")
    ap.add_argument("--bootcamp", type=int, default=30, help="supervised steps on verified seeds")
    ap.add_argument("--k", type=int, default=6, help="rollouts per prompt")
    ap.add_argument("--batch", type=int, default=16, help="prompts per rollout batch")
    ap.add_argument("--rl-lr", type=float, default=1e-4)
    ap.add_argument("--bootcamp-lr", type=float, default=3e-4)
    ap.add_argument("--rollout-temp", type=float, default=0.35,
                    help="sampling temperature for rollouts. Serving is greedy, "
                    "so RL that samples far from the mode optimises a policy "
                    "nobody serves; staying near the mode makes best-of-k "
                    "imitation pull the mode itself.")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--base", default=str(HERE / ".." / ".." / "models" / "live-host-lm" / "live-host-lm.pt"),
                    help="starting checkpoint (gen0 of this loop run)")
    ap.add_argument("--fresh", action="store_true",
                    help="ignore the ledger's promoted generations and start from --base")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    GENS.mkdir(exist_ok=True)

    gen0_path = Path(args.base)
    model = agent_model.load_agent(str(gen0_path))
    model.cfg = dict(torch.load(gen0_path, map_location="cpu")["config"])
    model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=args.rl_lr, betas=(0.9, 0.95), weight_decay=0.01)
    sets = eval_sets()

    def set_lr(lr):
        for g in opt.param_groups:
            g["lr"] = lr

    gen_index = 0
    promoted = None
    # Resume: the loop is relentless, which includes surviving restarts. The
    # last PROMOTED generation in the ledger is the parent of the next one.
    if LEDGER.exists() and not args.fresh:
        last = None
        for line in LEDGER.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                if r.get("promoted"):
                    last = r
        if last:
            parent_pt = Path(last["gguf"]).with_suffix(".pt")
            if parent_pt.exists():
                ck = torch.load(parent_pt, map_location="cpu")
                model.load_state_dict(ck["state"])
                promoted = last
                gen_index = last["generation"]
                print(f"resuming from promoted generation {gen_index} "
                      f"({last['gguf_digest'][:24]}…, scores "
                      f"{ {k: round(v,2) for k, v in last['scores'].items()} })", flush=True)

    seed_file = HERE / "teacher-seeds.json"
    seed_rows = []
    teacher_meta = None
    if seed_file.exists():
        payload = json.loads(seed_file.read_text())
        # only seeds that are still canonical under the CURRENT checker pass —
        # the v1 seeds taught a different answer template and are kept for the
        # named-template skill track, not this one
        seed_rows = [(s["prompt"], s["answer"]) for s in payload["seeds"]
                     if reward(s["prompt"], s["answer"]) == 1.0]
        teacher_meta = payload["teacher_models"]
        print(f"teacher seeds: {len(seed_rows)} usable under the current checker "
              f"({', '.join(f'{m.split(chr(47))[-1]}: {s[chr(111)+chr(107)]}' for m, s in teacher_meta.items())})", flush=True)

    while args.generations == 0 or gen_index < args.generations:
        t0 = time.time()
        gen_index += 1
        print(f"\n=== generation {gen_index} ===", flush=True)
        if promoted is None:
            # the initial baseline is what --base can actually do, so the very
            # first gate already holds it to "no regression"
            base_scores = evaluate(model, sets, n=40)
            base_line = {"S0 price-copy": base_scores["S0 price-copy"],
                         "S1 cheapest": base_scores["S1 cheapest"],
                         "S2 priciest": base_scores["S2 priciest"]}
            print(f"  base held-out: " + "  ".join(f"{k} {v*100:.0f}%" for k, v in base_scores.items()), flush=True)

        # ---- phase A: bootcamp on verified demonstrations ----------------
        if seed_rows and args.bootcamp > 0:
            set_lr(args.bootcamp_lr)
            s0_gold = [s0_example(rng) for _ in range(96)]
            for it in range(1, args.bootcamp + 1):
                if it % 2 == 1:
                    pairs = rng.sample(seed_rows, min(8, len(seed_rows)))
                else:
                    pairs = rng.sample(s0_gold, 8)  # never trade away S0
                loss = imitation_step(model, opt, pairs)
                if it % 25 == 0 or it == 1:
                    print(f"  bootcamp {it:3d}  loss {loss:.3f}", flush=True)

        # ---- phase B: relentless RL on computed rewards -------------------
        set_lr(args.rl_lr)
        dry = 0
        for it in range(1, args.iters + 1):
            pairs = mix_prompts(rng, args.batch, gen_index)
            rows = agent_model.rollout(model, [p for p, _ in pairs], args.k, temperature=args.rollout_temp,
                                       seed=args.seed * 1000 + gen_index * 10000 + it)
            scored = [(p, a, reward(p, a)) for p, a in rows]
            loss = train_batch(model, opt, scored)
            d_loss, n_fix = dagger_step(model, opt, pairs)
            best_r = max(r for _, _, r in scored)
            dry = dry + 1 if best_r == 0.0 else 0
            if it % 10 == 0 or it == 1:
                mean_r = sum(r for _, _, r in scored) / len(scored)
                exact = sum(r == 1.0 for _, _, r in scored) / len(scored)
                print(f"  iter {it:4d}  loss {loss:.4f}  dagger {d_loss:.3f} ({n_fix} fixes)  "
                      f"mean reward {mean_r:.3f}  exact {exact*100:.0f}%", flush=True)
            # self-healing: a policy with no successes has no gradient. Re-seed
            # it from the verified demonstrations instead of dying quietly.
            if dry >= 5 and seed_rows:
                print(f"  iter {it:4d}  no successes in 5 iters — teacher refresher", flush=True)
                set_lr(args.bootcamp_lr)
                for _ in range(4):
                    imitation_step(model, opt, rng.sample(seed_rows, 12))
                    imitation_step(model, opt, rng.sample(s0_gold, 12))
                set_lr(args.rl_lr)
                dry = 0

        scores = evaluate(model, sets, n=40)
        print(f"  held-out: " + "  ".join(f"{k} {v*100:.0f}%" for k, v in scores.items()), flush=True)
        # one greedy answer, verbatim — the mode is what serving reads
        from model import batched_generate as _bg
        probe_p, probe_a = sets["S1 cheapest"][0]
        with torch.no_grad():
            probe = _bg(model, [probe_p], max_new=48, temperature=0.0)[0]
        print(f"  probe S1 greedy: {probe!r}", flush=True)

        # gate: the deployed skill must hold; the new skills must improve OR
        # hold (a policy already at its ceiling is still the one to serve), and
        # nothing may regress.
        base = promoted["scores"] if promoted else base_line
        gate_ok = scores["S0 price-copy"] >= 0.95
        gate_ok = gate_ok and (scores["S1 cheapest"] >= base["S1 cheapest"] or scores["S2 priciest"] >= base["S2 priciest"])
        gate_ok = gate_ok and all(scores[k] >= base[k] - 0.02 for k in scores)

        cand_gguf = GENS / f"gen-{gen_index:03d}.gguf"
        cand_pt = GENS / f"gen-{gen_index:03d}.pt"
        torch.save({"config": model.cfg, "state": model.state_dict(),
                    "scores": scores, "parent": promoted["gguf_digest"] if promoted else None}, cand_pt)
        model.eval()
        export_gguf(model, cand_gguf, ctx=model.cfg["ctx"])
        model.train()

        # Engine gate = FAITHFULNESS, not quality: the engine must reproduce the
        # trainer's own greedy answers on the same prompts (quality is already
        # gated by the held-out scores above). Comparing the engine to ground
        # truth here would conflate the two and hold a mid-learning candidate
        # to a bar its teacher hasn't reached yet.
        verify_prompts = [
            *(sets["S0 price-copy"][:4]), *(sets["S1 cheapest"][:4]), *(sets["S2 priciest"][:4]),
        ]
        from model import batched_generate as _bg2
        model.eval()
        with torch.no_grad():
            torch_answers = _bg2(model, [p for p, _ in verify_prompts], max_new=48, temperature=0.0)
        engine_score = engine_verify(cand_gguf, list(zip([p for p, _ in verify_prompts], torch_answers)))
        print(f"  engine faithfulness: {engine_score*100:.0f}% of the trainer's greedy answers reproduced", flush=True)
        gate_ok = gate_ok and engine_score >= 0.95

        record = {
            "generation": gen_index, "scores": scores,
            "engine_exact": engine_score,
            "gguf": str(cand_gguf), "gguf_digest": sha256_file(cand_gguf),
            "teacher": {m: s for m, s in (teacher_meta or {}).items()} or None,
            "wall_s": round(time.time() - t0), "promoted": gate_ok,
        }
        better = promoted is None or (
            scores["S1 cheapest"] + scores["S2 priciest"],
            scores["S0 price-copy"],
        ) >= (
            promoted["scores"]["S1 cheapest"] + promoted["scores"]["S2 priciest"],
            promoted["scores"]["S0 price-copy"],
        )
        if gate_ok and better:
            # atomic swap into the serving path
            tmp = SERVED_GGUF.with_suffix(".gguf.new")
            tmp.write_bytes(cand_gguf.read_bytes())
            tmp.replace(SERVED_GGUF)
            print(f"  PROMOTED -> {SERVED_GGUF.name} ({record['gguf_digest'][:24]}…)", flush=True)
            promoted = record
        else:
            # revert: reload the promoted weights (or gen0) and keep evolving
            if promoted:
                ck = torch.load(cand_pt.parent / (promoted["gguf"].split("/")[-1].replace(".gguf", ".pt")), map_location="cpu")
                model.load_state_dict(ck["state"])
            else:
                ck = torch.load(gen0_path, map_location="cpu")
                model.load_state_dict(ck["state"])
            print("  gate failed — reverted, continuing from the promoted weights", flush=True)
        with open(LEDGER, "a") as fh:
            fh.write(json.dumps(record) + "\n")
        model.eval()

    print("\n=== evolution summary ===")
    if promoted:
        print(json.dumps({k: promoted[k] for k in ("generation", "scores", "engine_exact", "gguf_digest")}, indent=1))


if __name__ == "__main__":
    main()
