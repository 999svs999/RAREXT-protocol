# Negative results: cross-slice Huffman and degree-10 Legendre

**Status:** published negative result
**Measurement:** `bench/storage/RESULTS.json`, SHA-256
`bfb10a6d1bd4d7f5c45e96a1d35ea1a127e55e3616b0879692e7b6a9db9623e3`
**Code:** `9d3eae3` (learned and parametric runners), corpus digest
`c769fecf9daccee32bff693772feae3edb2a908f3d7445578ecaff8bce476efe`
**Date:** 2026-10-23

## Abstract

Two representation directions were measured on the fixed RAREXT storage corpus. The
adaptive order-1 Huffman model compresses its own text and source slices exactly, but
the same model trained on `source.js` and evaluated on `text.txt` expands the file to
0.64x (14.15 MiB total for 9.00 MiB input). A degree-10 tensor-product Legendre fit
stores 36 MiB of photos in 16.7 KiB (2212.70x), but reconstructs them at 19.79 dB PSNR
with 98.84% of channel bytes differing and no residual. Neither result supports a storage
claim. They are published because the research rule is to show the failed direction,
not to relabel it as a bounded success.

## Rules used

- Total cost is `stored + decoder`, counted once. The learned model's 64.3 KiB table
  and the parametric model's 16.7 KiB coefficient payload are decoder artifacts, so
  they are inside the total.
- A row is `exact` only when reconstructed bytes hash to the committed reference.
  Otherwise it is `bounded` or `generative`, and the row reports the difference.
- The corpus is fixed and hash-locked; the slice is not chosen after seeing a result.
- A bounded row's ratio is not compared to an exact row's ratio as if they were the
  same claim.

## Experiment 1: the learned model does not transfer

The codec is an order-1 static Huffman model: 256 contexts, 256 symbols, a 65,793-byte
length table, Laplace smoothing, canonical codes. "Adaptive" means the model is trained
on the same file it encodes; "held out" means it is trained on `source.js` and evaluated
on `text.txt`.

| Measurement | Input | Stored | Decoder | Total | Ratio | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| text, adaptive | 9.00 MiB | 3.69 MiB | 64.3 KiB | 3.76 MiB | 2.40x | exact |
| source, adaptive | 10.00 MiB | 3.25 MiB | 64.3 KiB | 3.31 MiB | 3.02x | exact |
| text, held out from source | 9.00 MiB | 14.08 MiB | 64.3 KiB | 14.15 MiB | 0.64x | exact |

The held-out stream is 14.08 MiB, 56% larger than the 9.00 MiB input, and total cost is
1.57x the input. The 64.3 KiB model is not the cause; the context table learned from
JavaScript source assigns long codes to English text transitions it rarely saw. The
adaptive rows are real exact wins, but they are not evidence of generalization: the
model is part of the artifact and must be stored for every adaptive file.

**What would change this result:** train one shared model on a representative,
license-clean text corpus, evaluate on held-out text and code, count the shared decoder
once, and beat zstd's measured 1.47x on those slices. A larger model that only wins on
its own training file does not count.

## Experiment 2: the parametric fit has the ratio but not the fidelity

Each photo is fitted with a tensor-product Legendre basis of degree 10, 66 coefficients
per channel, sampled on a 16-pixel stride, with no residual. The coefficient JSON
(16.7 KiB for four photos) is both the stored artifact and the decoder, counted once;
stored bytes are zero.

| Input | Stored | Decoder | Total | Ratio | PSNR | Differing channel bytes | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 36.00 MiB | 0 B | 16.7 KiB | 16.7 KiB | 2212.70x | 19.79 dB | 98.84% | bounded |

The ratio is enormous because the representation throws away almost all image
information. 19.79 dB with 98.84% of channel bytes differing is not a useful
reconstruction for a media archive, and the lack of a residual means the error is
irreducible at this degree. Calling this "compression" would be dressing up a lossy
approximation as storage.

**What would change this result:** a local or hierarchical representation (higher
degree alone will not fix texture), a residual layer with its bytes counted, and a
rate-distortion comparison at a stated fidelity threshold, including decoder cost.
Until then the row stays bounded and excluded from storage claims.

## Why these are negative results, not failures to report

The research gate in [`docs/STORAGE-FRONTIER.md`](../../docs/STORAGE-FRONTIER.md) says a
direction that cannot fill its row honestly gets published as a negative result. Both
directions did produce measurements, and both fail the acceptance criteria:

- cross-slice learned coding expands rather than compresses;
- parametric fitting achieves ratio only by discarding fidelity.

Hiding either would make the successful adaptive rows look like a general codec. They
are not. The benchmark table keeps the labels, and this note records the interpretation.

## Threats to validity

- One deterministic corpus, one machine (Intel i5-8257U). Absolute times and ratios will
  vary; the direction of the two failures is the claim, not the third decimal.
- The Huffman model is order-1 only. A larger learned model may transfer; this experiment
  does not rule that out.
- PSNR is a byte-error metric, not a perceptual one. A perceptual metric could rank the
  Legendre fit differently, but 19.79 dB and 98.84% differing bytes leave little room.
- The parametric model has no residual and a fixed degree. That is the tested design,
  not every possible implicit representation.
- Decoder sizes are artifact sizes; runtime/library code is not included for classical
  baselines, which is a known asymmetry documented in the benchmark README.

## Reproduction

```bash
npm run bench:storage
# writes bench/storage/RESULTS.md and RESULTS.json
```

The corpus is generated from the committed seed and checked against
`bench/storage/corpus.lock.json`. The runner code is in
[`learned.mjs`](learned.mjs); the accounting and verdicts are in [`run.mjs`](run.mjs).
