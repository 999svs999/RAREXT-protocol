"""The teacher: NVIDIA's hosted Nemotron models, through the free NIM API.

Role in the loop: PROPOSE new training examples for a skill the current agent
cannot do yet. The teacher's output is never trusted — every demonstration is
normalized and scored by task.reward(), and only reward==1.0 examples are kept
as seeds. (checker is code; the model that grades is not the model that grades
itself.)

Teacher selection is measured, not assumed: the flagship
`nvidia/nemotron-3-ultra-550b-a55b` labels a batch; if it is slow or errors,
`nvidia/nemotron-3.5-lightning-30b-a3b` (MoE, 3B active — the fastest Nemotron
in the free tier) takes over. Which model labeled what is recorded in the seed
file, so the lineage of every training example is inspectable.
"""

import json
import os
import time
import urllib.request

from task import comp_example, reward

NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
PRIMARY = "nvidia/nemotron-3-ultra-550b-a55b"
FALLBACK = "nvidia/nemotron-3.5-lightning-30b-a3b"

_INSTRUCTION = """Item/price rows (exactly as they will appear):
{prompt}

Write ONLY the answer line, in exactly this format: {format}
No other text, no markdown."""


def _chat(key: str, model: str, prompt: str, max_tokens: int = 900):
    body = json.dumps(
        {"model": model, "messages": [{"role": "user", "content": prompt}],
         "max_tokens": max_tokens, "temperature": 0.2, "stream": False}
    ).encode()
    req = urllib.request.Request(
        NIM_URL, data=body,
        headers={"content-type": "application/json", "authorization": "Bearer " + key},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    msg = d["choices"][0]["message"]
    usage = d.get("usage", {})
    return msg.get("content") or "", usage.get("completion_tokens", 0), time.time() - t0


def label_example(key: str, prompt: str, answer_format: str, model: str):
    out, tokens, dt = _chat(key, model, _INSTRUCTION.format(prompt=prompt, format=answer_format))
    line = out.strip().splitlines()[0].strip().strip("`") if out.strip() else ""
    # Canonical form ends with a period; the teacher tends to drop it.
    if line and not line.endswith("."):
        line += "."
    return line, tokens, dt


def harvest_seeds(count_per_kind: int = 40, out_path: str = "teacher-seeds.json"):
    key = os.environ.get("NVIDIA_API_KEY", "")
    if not key:
        raise SystemExit("NVIDIA_API_KEY not set — the teacher cannot run")

    rng = __import__("random").Random(20261117)
    seeds = []
    stats = {}
    for kind in ("cheapest", "priciest"):
        made = 0
        attempts = 0
        while made < count_per_kind and attempts < count_per_kind * 3:
            attempts += 1
            prompt, want = comp_example(rng, kind)
            model = PRIMARY if stats.get(PRIMARY, {"fail": 0})["fail"] < 2 else FALLBACK
            try:
                line, tokens, dt = label_example(key, prompt, COMP_FORMAT[kind], model)
            except Exception as e:
                stats.setdefault(model, {"ok": 0, "fail": 0})
                stats[model]["fail"] += 1
                print(f"  teacher {model} error: {e}", flush=True)
                continue
            stats.setdefault(model, {"ok": 0, "fail": 0})
            r = reward(prompt, line)
            stats[model]["ok"] += 1
            if r == 1.0:
                seeds.append({
                    "skill": kind, "prompt": prompt, "answer": line,
                    "teacher": model, "label_ms": round(dt * 1000),
                    "label_tokens": tokens,
                })
                made += 1
            status = "keep" if r == 1.0 else f"reject r={r:.1f}"
            print(f"  [{kind} {made}/{count_per_kind}] {model.split('/')[-1]} "
                  f"{dt:.1f}s {tokens}t -> {status}", flush=True)

    payload = {
        "teacher_models": stats,
        "accepted": len(seeds),
        "seeds": seeds,
    }
    with open(out_path, "w") as fh:
        json.dump(payload, fh, indent=1)
    print(f"\nkept {len(seeds)} verified demonstrations -> {out_path}")
    for m, s in stats.items():
        print(f"  {m}: {s['ok']} ok / {s['fail']} failed calls")
    return payload


COMP_FORMAT = {
    "cheapest": "The cheapest is $<price> (<item>).",
    "priciest": "The most expensive is $<price> (<item>).",
}


if __name__ == "__main__":
    import sys

    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    harvest_seeds(n)
