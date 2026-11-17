# `native/` — optional host accelerators

Nothing here is required. The engine artifact
(`apps/runtime/engines/rarext-gguf-engine.js`) is pure JavaScript and runs on a
bare provider with no compiled code at all. These are capabilities a *host* may
offer it, and the engine takes the JS path whenever one is missing.

## `matvec.node` — BLAS matrix-vector kernel

`matvec.c` is ~60 lines of N-API over `cblas_sgemv`. The engine calls it as
`hostMatvec(A, rows, cols, x, y)` for its dense weight products, which is where
~70 % of decode time goes in plain JavaScript.

### Build (macOS, Accelerate)

```sh
cd native
clang -O3 -shared -fPIC \
  -I "$(node -p 'require("path").dirname(process.execPath)')/../include/node" \
  -undefined dynamic_lookup \
  -o matvec.node matvec.c -framework Accelerate
```

On Linux, compile against `-lcblas -lopenblas` (or replace the single
`cblas_sgemv` call with your own kernel); the ABI is the same.

### How a provider picks it up

- `apps/runtime/src/engine-bundle.ts` loads `native/matvec.node` automatically
  when it exists next to the repo, or from `RAREXT_MATVEC_ADDON=<path>`.
- A worker runtime cannot receive a function across a thread boundary, so the
  worker loads the same addon itself from `workerData.addonPath`.
- If the addon is missing, fails to load, or refuses a buffer, the engine
  silently finishes on its scalar path. It never fails a run because of this.

The dense Float32 copies the kernel consumes are bounded by
`RAREXT_DENSE_BUDGET_MB` (default 1600; the live host sets 2400). Past the budget
or on allocation failure the engine keeps the fused quantized path.

### Verify it

```sh
node --experimental-strip-types -e '
  const { matvec } = require("./native/matvec.node");
  ...
'
```

`scripts/` has no dependency on this file; the numbers below were measured with
the throwaway harness described in `docs/MODEL-RUNTIME.md`.

### Measured (x86_64, 8 cores, 8.6 GB; Qwen2 0.5B, Q8_0/Q5_0/Q6_K)

| kernel / path | result |
| --- | --- |
| single 4864×896 matvec, JS | 8.76 ms |
| single 4864×896 matvec, BLAS | 0.84 ms (10.5x) |
| max relative difference per element | 1.3e-3 (accumulation order only) |
| 16-token decode, JS only | 44.7 s |
| 16-token decode, with addon | 13.3 s |
| 32-token decode, full path | 8.5 s |
| 32-token decode, scalar JS | 64.3 s |

The emitted token ids are identical between the two paths (verified token by
token over 16 steps), as is the decode-trace digest over 32 tokens
(`047794f99dde4963fa694d1d`). BLAS does not compute the same numbers in the same
order; it computes the same answer.
