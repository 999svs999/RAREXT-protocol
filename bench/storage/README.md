# Storage benchmark

The gate for the storage research track. A representation with no row here has no
claim. The harness measures the shipped erasure-coded path and the classical
baselines on one fixed corpus and writes a Markdown table plus JSON:

```bash
npm run bench:storage
# writes bench/storage/RESULTS.md and RESULTS.json
```

On the reference laptop (Intel i5-8257U, ffmpeg 8.1.1, zstd 1.5.7) a full run takes
about 85 seconds over a 99.96 MiB corpus, well inside the 15-minute budget. The
budget is enforced: the command exits non-zero if `--max-minutes` is exceeded.

### 1 GiB throughput and memory

```bash
npm run bench:throughput            # 1 GiB codec, 4+2, writes THROUGHPUT.md/JSON
npm run bench:network               # 64 MiB JSON vs 64 MiB/1 GiB raw HTTP, writes NETWORK.md/JSON
npm run bench:throughput -- --mb 256 --k 2 --m 1
```

This runs two measurements in separate processes at 1 GiB — the compute cost inside
a put and a get — and reports peak RSS from `process.resourceUsage().maxRSS`:

- in-memory `encodeBytes`/`decodeBytes`, the API used by the MCP put path (capped at
  8 MiB per call);
- streaming `encodeFileToShards`/`decodeShardsToFile`, which encodes 8 MiB chunks to
  shard files and decodes from only `k` of them.

It deliberately excludes HTTP and JSON framing: the holder endpoints base64-encode
whole bodies, so at this size the wire format, not the codec, dominates. The numbers
are written to `bench/storage/THROUGHPUT.md` and included as the "1 GiB throughput and
memory" section when `bench:storage` regenerates `RESULTS.md` (it reads
`THROUGHPUT.md` if present).

### HTTP holder path

`npm run bench:network` starts six holder child processes on loopback and measures the
whole-shard JSON path at 64 MiB (the largest payload that fits the 32 MiB body cap),
then the raw streaming path at 64 MiB and 1 GiB. It samples each holder's RSS with
`ps`, reports the client's `maxRSS`, and writes `NETWORK.md`/`NETWORK.json`; `RESULTS.md`
includes that section as well. Encode is excluded from the streaming rows because it is
a separate one-time cost, reported in the codec section.

## What is measured

| Column | Meaning |
| --- | --- |
| Input | Bytes of the corpus slice the method reconstructs |
| Stored | Bytes the method writes (all shards for erasure coding) |
| Decoder | Bytes of a decoder artifact that is part of the storage cost |
| Total | Stored + decoder |
| Ratio | Input / total; above 1 is compression, below 1 is expansion |
| Result | `exact` only when the decoded bytes hash to the committed reference; otherwise `bounded` or `generative` |
| Verify | Read the stored artifact(s) and recompute their SHA-256 |
| Decode | Reconstruct the reference bytes and hash them |

`verify` checks stored integrity, not decodability. That is deliberate: a protocol
can check a digest cheaply, while decode time is what a reader pays to use the bytes.
For erasure coding, verification hashes every shard; for video, it hashes the
encoded file.

For a non-exact row, the JSON also records the reconstructed digest, the fraction of
differing bytes, and byte PSNR where the slice is raster data. The Markdown table
shows `no — bounded` or `no — generative`. The classifier does not consult the
codec's marketing: it compares bytes. If a runner claims lossless and the digest
differs, the row is still `bounded` and the note says so.

## Corpus

The default corpus is generated from a committed seed and verified against
`corpus.lock.json`. It is public (this generator is the whole recipe), fixed
(regeneration produces the same SHA-256s), and needs no network:

| Slice | Modality | Approx. size |
| --- | --- | ---: |
| `video.y4m` | video, yuv420p, 480×270, 6 s | 33 MiB |
| `photos/*.ppm` | four still images, 2048×1536 | 36 MiB |
| `audio.wav` | stereo PCM, 30 s | 5.5 MiB |
| `text.txt` | generated prose | 9 MiB |
| `source.js` | generated source | 10 MiB |
| `scan.ply` | ASCII point cloud, 300k points | 6 MiB |

Total 99.96 MiB across nine files. Raw YUV is used for video so lossless codecs can
be compared against exact reference frames rather than against another encode.

To measure a downloaded public corpus, point at it:

```bash
npm run bench:storage -- --corpus /path/to/corpus --out /tmp/public-corpus.md
```

Every regular file under that directory is measured, sorted by path; a
`manifest.json` written by this harness is ignored. Record the corpus digest printed
in the table with any result you publish.

`--scale <n>` shrinks the generated corpus for quick checks (used by tests). The
lock only applies at scale 1. `--update-lock` rewrites the committed lock and should
be used only when a corpus change is intended.

## Methods

- **x265 lossless** — `libx265`, `preset ultrafast`, `lossless=1`.
- **x265 CRF 28** — lossy reference point, labelled `bounded`.
- **AV1 lossless** — `libsvtav1`, `preset 10`, `lossless=1`.
- **AV1 CRF 35** — lossy reference point, labelled `bounded`.
- **zstd -19** — one frame per corpus file, all files measured together.
- **erasure 4+2** — the shipped `encodeBytes`/`decodeBytes` path over the framed
  corpus, four data shards and two parity shards. It does not compress; its ratio is
  the durability cost (about 0.67x) paid for surviving two holder losses.
- **learned order-1 Huffman (adaptive)** — a static context model trained on the file
  it encodes, with the 256×256 code-length table written as the decoder and counted in
  full (65,793 bytes). Exact. This is an adaptive result: the model is stored, so it is
  not a claim that a model trained elsewhere generalizes.
- **learned order-1 Huffman (train source.js)** — the same model trained on `source.js`
  and evaluated on `text.txt` without seeing it. Exact, but 0.64x: the held-out
  cross-slice case expands. That is the negative result for this model.
- **parametric 2D Legendre degree 10** — each photo is fitted with a tensor-product
  Legendre polynomial (66 coefficients per channel). The coefficients are the entire
  stored artifact and the decoder, counted once. The row is bounded at about 19.8 dB
  PSNR with no residual: a very high ratio, and not useful fidelity. That is the
  negative result for this parametric direction.

If ffmpeg or one of its encoders is missing, those rows are marked `skipped` rather
than omitted. A skipped row is not a pass.

## Decoder accounting

A learned or parametric decoder is data the protocol must store and agree on, so its
size belongs in the storage cost. The harness requires every non-classical runner to
declare `decoderBytes > 0`, and `Total = Stored + Decoder`. The parametric runner sets
`Stored = 0` because its coefficients are both the artifact and the decoder; counting
them twice would double-charge the same bytes. Classical rows rely on the system
ffmpeg/zstd decoder and show `—`; measuring a pinned decoder build for those is future
work, not a claim that their decoder is free.

## Measured outcome and negative results

The 2026-10-23 run (`RESULTS.md`) gives both sides of the ledger:

- Adaptive order-1 Huffman compresses text and source to 2.40x and 3.02x including its
  model, beating zstd's 1.47x on those slices. It is exact.
- The same codec trained on `source.js` and evaluated on `text.txt` expands to 0.64x.
  The model does not generalize across the corpus's two text-ish slices; a deployable
  static model would need a much larger, representative decoder.
- The degree-10 Legendre fit stores 16.7 KiB for 36 MiB of photos (2212x) but only
  reaches 19.79 dB PSNR, with 98.84% of bytes differing. A smooth global polynomial
  cannot represent the corpus's texture. Per the research rule, that is a bounded row
  and a negative result, not a compression claim.

Neither negative result is hidden: the table and JSON carry the labels. The full
write-up, including what would overturn each result and its threats to validity, is in
[`NEGATIVE-RESULTS.md`](NEGATIVE-RESULTS.md).

## Adding a method

Add a runner in `bench/storage/methods.mjs`:

```js
{
  id: "my-codec",
  label: "my codec",
  kind: "classical",        // or "learned" / "parametric" / "generative"
  declaresExact: true,      // a claim the harness will test
  decoderBytes: null,       // required > 0 for non-classical; may be set on result
  async run({ root, manifest, work }) {
    return {
      slice: "all files",
      inputBytes, storedBytes,
      referenceDigest, reconstructedDigest,
      exact,                 // must be the result of comparing bytes
      errorRatio, psnr,
      verifyMs, decodeMs, encodeMs,
      notes,
    };
  },
}
```

Add it to `allRunners`. Then regenerate `RESULTS.md`; do not hand-edit the table.

## Reference result

See [RESULTS.md](RESULTS.md) for the last run, including the machine and codec
versions. Treat it as a measurement from that machine, not as a portable claim;
rerun before quoting.
