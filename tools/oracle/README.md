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

- **Dequantization is bit-exact — but read the correction.** The first version of
  this check reported `max|engine − numpy| = 0.000000e+00` on every type, and it
  was wrong in a way worth keeping: both sides shared one mis-index in the Q6_K
  layout (each half consumes 64 `ql` bytes and 32 `qh` bytes; both used 32 for
  both), so they agreed on the same wrong bytes. The arbiter that caught it was
  **llama.cpp's own dequantizer** (`llama-quantize --allow-requantize in.gguf
  out.gguf F32`), compared tensor by tensor. After the fix, every type this model
  uses is `0.000e+00` against llama.cpp as well as against this script.
- **The forward pass agrees with llama.cpp**, not only with itself: PPL **5.912**
  against **5.940** on the same 155 tokens, and the same argmax on 13-, 30- and
  34-token chat templates (59604 `"Paris"`, 785 `"The"`, 785 `"The"`).
- **The engine/tokenizer split is clean**: the oracle is *given* token ids. An
  id-level disagreement is therefore a tokenizer finding, separate from a
  forward-pass finding, and the two can no longer be confused for each other.

**Hours of debugging that were spent on a shared misreading are the argument for
this directory's next step, not its refutation.** An implementation written from
the same understanding is not an independent check. When the two agree, ask what
they would both have to get wrong to agree.

`dequant-check.py` and `forward.py` hardcode `/tmp/npw` as the weight directory;
that is the one piece of configuration, deliberately, so the dump and its
consumers cannot drift apart.
