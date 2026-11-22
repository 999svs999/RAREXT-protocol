"""Serve the entanglement-spectrum rebuild from RAREXT web4 storage and measure it.

What this proves, in order:

  1. `bundle` shards BOTH the factored GGUF and the engine module into
     content-addressed RAREXT blobs. Nothing about the model is local anymore.
  2. The source model file is deleted (and the repo copy renamed away) BEFORE a
     provider starts. The provider has no path to the weights except RAREXT.
  3. The provider fetches every shard, verifies the committed digest, fetches
     the engine artifact, verifies it, loads it, and answers.
  4. Answers are scored against the same computed gold the evolution gate uses,
     while the provider's peak resident set is sampled.

Resident mode loads the 4.67 MB shards into memory. `--stream` writes the
verified bytes to the provider's state dir and reads rows on demand, which is
how the runtime bounds memory for models much larger than RAM. Both modes are
measured; the engine reports the streaming loader's peak in `residentBytes`.

Run:  python3 tools/entangle/web4_serve.py [--stream] [--max-tokens 96]
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "agents/self-evolve"))
import task  # noqa: E402

MODEL = HERE / "entangled-factored.gguf"
ENGINE = REPO / "apps/runtime/engines/rarext-gguf-engine.js"
MODEL_ID = "rarext-entangled-chi48"


def get(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def post(url, body, timeout=300):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode())
    return out, time.time() - t0


def rss_kb(pid):
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        return int(out) if out else 0
    except Exception:
        return 0


def wait_line(proc, pattern, timeout=180, sink=None, echo=False):
    """Read proc.stdout until `pattern` matches; keep every line in sink."""
    found = {}
    done = threading.Event()

    def reader():
        for line in proc.stdout:
            line = line.rstrip("\n")
            if sink is not None:
                sink.append(line)
            if echo:
                print(f"    | {line}", flush=True)
            m = re.search(pattern, line)
            if m and not found:
                found["match"] = m
                done.set()
        done.set()

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    if not done.wait(timeout):
        raise TimeoutError(f"no line matching {pattern!r} within {timeout}s")
    if "match" not in found:
        raise RuntimeError(f"process exited before matching {pattern!r}")
    return found["match"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stream", action="store_true", help="RAREXT_STREAM_WEIGHTS=1")
    ap.add_argument("--prompts", type=int, default=280)
    ap.add_argument("--max-tokens", type=int, default=96)
    ap.add_argument("--seed", type=int, default=4242)
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="rarext-web4-entangled-"))
    blobs = tmp / "blobs"
    provider_state = tmp / "provider"
    blobs.mkdir()
    provider_state.mkdir()
    source = tmp / "source-model.gguf"
    shutil.copyfile(MODEL, source)

    api = provider = None
    api_log, provider_log = [], []
    result = {"mode": "stream" if args.stream else "resident",
              "model_file": str(MODEL.relative_to(REPO)),
              "model_bytes": MODEL.stat().st_size}
    try:
        # ── 1. a RAREXT node that holds bytes ────────────────────────────────
        env = {**os.environ, "PORT": "0", "HOST": "127.0.0.1",
               "RAREXT_DATA": "none", "RAREXT_BLOB_DIR": str(blobs)}
        api = subprocess.Popen(["node", "apps/api/src/server.ts"], cwd=REPO, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, bufsize=1)
        base = wait_line(api, r"listening on (https?://\S+)", timeout=120, sink=api_log).group(1)
        base = base.rstrip("/")
        result["registry"] = base

        # ── 2. shard weights + engine into RAREXT ────────────────────────────
        bundle = subprocess.run([
            "node", "apps/runtime/src/cli.ts", "bundle",
            "--file", str(source),
            "--model", MODEL_ID,
            "--engine", "rarext",
            "--engine-module", str(ENGINE),
            "--engine-runtime", "gguf",
            "--engine-name", "rarext-gguf-engine",
            "--engine-version", "1",
            "--format", "gguf",
            "--quantization", "F32-mpo-chi48",
            "--family", "rarext-mpo",
            "--registry", base,
            "--out", str(tmp),
            "--chunk-bytes", str(512 * 1024),
            "--json",
        ], cwd=REPO, capture_output=True, text=True, timeout=600)
        if bundle.returncode != 0:
            raise RuntimeError(f"bundle failed: {bundle.stderr or bundle.stdout}")
        report = json.loads(bundle.stdout)
        manifest = report["bundle"]
        engine_bundle = report["engineBundle"]
        result["bundle"] = {
            "manifestHash": report["manifestHash"],
            "weightsDigest": manifest["model"]["weightsDigest"],
            "shards": len(manifest["shards"]),
            "totalBytes": manifest["totalBytes"],
            "engine": {
                "name": engine_bundle["name"],
                "runtime": engine_bundle["runtime"],
                "artifactDigest": engine_bundle["artifactDigest"],
                "shards": len(engine_bundle["shards"]),
                "bytes": engine_bundle.get("sourceBytes") or engine_bundle.get("totalBytes"),
            },
        }
        result["bundle"]["execution"] = manifest["execution"]
        listed = get(f"{base}/v1/blobs")
        result["registry_blobs"] = {"count": len(listed),
                                    "bytes": sum(int(r.get("bytes", 0)) for r in listed)}

        # ── 3. no local model: delete the file, move the repo copy away ──────
        source.unlink()
        hidden = HERE / "entangled-factored.gguf.served-away"
        MODEL.rename(hidden)
        result["source_deleted"] = not source.exists()
        result["repo_artifact_hidden"] = not MODEL.exists()

        # ── 4. provider fetches, verifies, and serves ────────────────────────
        penv = {**os.environ}
        if args.stream:
            penv["RAREXT_STREAM_WEIGHTS"] = "1"
        provider = subprocess.Popen([
            "node", "apps/runtime/src/cli.ts", "provider",
            "--bundle", str(tmp / "model-bundle.json"),
            "--registry", base,
            "--state", str(provider_state),
            "--port", "0",
            "--handle", "web4-entangled",
        ], cwd=REPO, env=penv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1)
        url = wait_line(provider, r"rarext provider serving .* on (https?://\S+)",
                        timeout=300, sink=provider_log, echo=True).group(1).rstrip("/")
        result["provider"] = url
        result["provider_log"] = provider_log
        time.sleep(1.0)  # let startup allocations settle before the baseline
        result["provider_rss_at_ready_bytes"] = rss_kb(provider.pid) * 1024
        result["registry_rss_bytes"] = rss_kb(api.pid) * 1024
        health = get(f"{url}/health")
        models = get(f"{url}/v1/models")
        result["health"] = health
        result["models"] = models

        # ── 5. score every held-out prompt through the provider ──────────────
        sets = task.eval_sets(args.seed)
        prompts = [(skill, p, a) for skill, rows in sets.items() for p, a in rows]
        prompts = prompts[: args.prompts]

        peak = {"rss": 0, "at": None}
        stop = threading.Event()

        peak_api = {"rss": 0}

        def sample():
            while not stop.wait(0.1):
                r = rss_kb(provider.pid)
                if r > peak["rss"]:
                    peak["rss"] = r
                    peak["at"] = time.time()
                r = rss_kb(api.pid)
                if r > peak_api["rss"]:
                    peak_api["rss"] = r

        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        # warmup (loads tokenizer tables, first forward)
        post(f"{url}/v1/completions",
             {"model": MODEL_ID, "prompt": prompts[0][1], "max_tokens": 8,
              "temperature": 0})
        baseline = rss_kb(provider.pid)

        rows, per_skill = [], {}
        t_all = time.time()
        for skill, prompt, want in prompts:
            out, seconds = post(f"{url}/v1/completions",
                                {"model": MODEL_ID, "prompt": prompt,
                                 "max_tokens": args.max_tokens, "temperature": 0})
            choice = out["choices"][0]
            text = choice["text"]
            usage = out.get("usage", {})
            ok = task.exact_match(prompt, text)
            rows.append({"skill": skill, "want": want, "got": text, "ok": ok,
                         "seconds": seconds,
                         "tokens": usage.get("completion_tokens"),
                         "finish": choice.get("finish_reason"),
                         "residentBytes": out.get("residentBytes")})
            s = per_skill.setdefault(skill, {"ok": 0, "n": 0})
            s["ok"] += int(ok)
            s["n"] += 1
        wall = time.time() - t_all
        stop.set()
        sampler.join(timeout=5)
        peak["rss"] = max(peak["rss"], rss_kb(provider.pid))

        tokens = sum(r["tokens"] or 0 for r in rows)
        ok = sum(int(r["ok"]) for r in rows)
        resident = sorted({r["residentBytes"] for r in rows if r["residentBytes"] is not None})
        result["answers"] = {
            "prompts": len(rows), "correct": ok,
            "accuracy": ok / len(rows),
            "per_skill": per_skill,
            "wall_s": wall,
            "ms_per_answer": wall / len(rows) * 1000,
            "tokens": tokens,
            "ms_per_token": wall / tokens * 1000 if tokens else None,
            "engine_residentBytes": resident,
            "misses": [{"skill": r["skill"], "got": r["got"], "want": r["want"],
                        "finish": r["finish"]} for r in rows if not r["ok"]][:8],
        }
        result["process"] = {
            "provider_peak_rss_bytes": peak["rss"] * 1024,
            "provider_rss_after_warmup_bytes": baseline * 1024,
            "provider_rss_at_ready_bytes": result.get("provider_rss_at_ready_bytes"),
            "registry_peak_rss_bytes": peak_api["rss"] * 1024,
            "model_bytes": MODEL.with_suffix(".gguf.served-away").stat().st_size,
        }
        # what the provider actually kept on disk
        kept = []
        for dirpath, _, files in os.walk(provider_state):
            for f in files:
                p = Path(dirpath) / f
                kept.append({"name": f, "bytes": p.stat().st_size})
        result["provider_state_files"] = kept
        result["blob_store"] = {"files": len(list(blobs.iterdir())),
                                "bytes": sum(p.stat().st_size for p in blobs.iterdir())}

        out_path = HERE / ("web4-serve-stream.json" if args.stream else "web4-serve.json")
        out_path.write_text(json.dumps(result, indent=1))

        print(f"registry      {base}")
        print(f"weights       {result['bundle']['shards']} RAREXT shards, "
              f"{result['bundle']['totalBytes']:,} bytes, {result['bundle']['weightsDigest'][:30]}…")
        print(f"engine        {engine_bundle['name']}@{engine_bundle['engineVersion']} "
              f"({engine_bundle['runtime']}), {len(engine_bundle['shards'])} shards, "
              f"{engine_bundle['artifactDigest'][:22]}…")
        print(f"source        deleted={result['source_deleted']} "
              f"repo copy hidden={result['repo_artifact_hidden']}")
        print(f"provider      {url}  health={health.get('bundle', '')[:16]}…")
        print(f"answers       {ok}/{len(rows)} exact ({100*ok/len(rows):.1f}%)  "
              f"{wall/len(rows)*1000:.0f} ms/answer  "
              f"{wall/tokens*1000 if tokens else 0:.1f} ms/token  "
              f"{tokens} tokens")
        print(f"memory        provider peak RSS {peak['rss']*1024/1e6:.1f} MB "
              f"(at ready {result.get('provider_rss_at_ready_bytes', 0)/1e6:.1f} MB, "
              f"after warmup {baseline*1024/1e6:.1f} MB); "
              f"registry (no model) peak {peak_api['rss']*1024/1e6:.1f} MB")
        print("              " + "  ".join(f"{k.split()[0]} {v['ok']}/{v['n']}"
                                          for k, v in per_skill.items()))
        if result["answers"]["misses"]:
            print("misses:")
            for m in result["answers"]["misses"]:
                print(f"  {m['skill']}: got {m['got']!r} want {m['want']!r} ({m['finish']})")
        print(f"wrote {out_path.relative_to(REPO)}")
    finally:
        hidden = HERE / "entangled-factored.gguf.served-away"
        if hidden.exists():
            hidden.rename(MODEL)
        for proc in (provider, api):
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
        if result.get("source_deleted"):
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
