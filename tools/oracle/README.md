# An independent implementation, for checking the engine

The engine cannot be its own witness. `apps/runtime/src/reference-forward.ts` is
independent code, but it shares an author and, as it turned out, shares a
blind spot: the two agreed on a prompt both got wrong relative to nothing else
either could see.

This directory holds a third implementation, written from the architecture and
the ggml quantisation formats rather than from the engine:

| File | What it is |
| --- | --- |
| `dump-weights.mjs` | Dumps the **engine's own** dequantized weights to raw float32, so the oracle tests the *math* with dequantization held constant. |
| `dequant-check.py` | Parses the GGUF from the raw bytes and implements Q4_0/Q5_0/Q8_0/Q4_K/Q6_K/F32 from the ggml definitions, then compares against the dump. Tests the *dequantization*. |
| `forward.py` | A vectorized NumPy Qwen2 forward pass — RMSNorm, RoPE (NeoX half-split), GQA, causal softmax, SwiGLU — over those weights. Tests the *forward pass*. |

## Use

```sh
node tools/oracle/dump-weights.mjs ~/.ollama/models/blobs/sha256-<blob>   # ~2 GB into /tmp/npw
python3 tools/oracle/dequant-check.py ~/.ollama/models/blobs/sha256-<blob>
python3 tools/oracle/forward.py 151644,872,198,785,6722,315,9625,374,151645,198,151644,77091,198
```

## What it established

- **Dequantization is bit-exact.** `max|engine − numpy| = 0.000000e+00` on Q5_0,
  Q6_K, Q8_0, and F32 rows. The ggml formats were reimplemented from their
  block layouts, not copied from the engine.
- **The forward pass agrees with the engine** on the first generated token for a
  13-token, a 30-token, and a 34-token chat-templated prompt (ids 785, 40, 9707).
- **The engine/tokenizer split is clean**: the oracle is *given* token ids. An
  id-level disagreement is therefore a tokenizer finding, separate from a
  forward-pass finding, and the two can no longer be confused for each other.

`dequant-check.py` and `forward.py` hardcode `/tmp/npw` as the weight directory;
that is the one piece of configuration, deliberately, so the dump and its
consumers cannot drift apart.
