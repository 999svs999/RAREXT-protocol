# Repair bandwidth at 1 GB

The storage contract asks for a single-shard repair to move less than `1/k` of the
blob. This harness measures the real number instead of assuming it, and keeps the
negative result in view.

```bash
npm run bench:repair -- --bytes 1073741824
```

It builds a deterministic 1 GiB payload, encodes it with the shipped `4 + 2`
Reed-Solomon code, loses one shard, rebuilds it from four survivors, and verifies the
rebuilt shard and payload digests. The output and `RESULTS.json` record read, write, and
total bytes, measured by the shard lengths the code actually touches.

## Last result

| Payload | Code | Read | Write | Total | Target `< 1/k` | Digests |
| --- | --- | --- | --- | --- | --- | --- |
| 1.000 GiB | 4 + 2 | 1.000 GiB (1.000x) | 0.250 GiB (0.250x) | 1.250 GiB (1.250x) | 0.250x | match |

Run on 2026-10-23, Node 24.15.0; see `RESULTS.json` for the exact numbers and elapsed time.
Treat it as a measurement of this machine and this code, not a portable claim.

## Why the target cannot be met by this code

An MDS code is all-or-nothing: any `k` shards reconstruct the whole payload. To rebuild
one lost shard it is necessary to read `k` shards (the payload) and write one shard
(`1/k` of the payload), so the floor is `1 + 1/k`, here `1.25x`. No implementation of
this code can read less without another copy of the data.

Reaching `< 1/k` needs a different code or layout:

- **Local reconstruction codes** keep a local parity group, so one loss is repaired from
  a fraction of the shards at the cost of a higher storage overhead.
- **Sub-chunking** repairs only the chunk that held the lost bytes, at the cost of more
  Merkle roots and placement records.
- **Regenerating codes** trade read bandwidth against storage and compute; they are not a
  drop-in replacement for the current systematic layout.

The ledger also reads every surviving shard, not only `k`, which is why a scheduled repair
can cost up to `(k + m - 1)/k + 1/k` in the worst case. Reducing that to the MDS floor is
a separate optimization; changing the code is the only way to beat `1.250x`.

## What this does not claim

- One lost shard, not `m` losses. Multiple losses need more reads or a code with local
  groups; measure before quoting.
- Bytes moved inside one process, not network bytes. Holder transport adds framing,
  retries, and round trips.
- No claim that `1.250x` is cheap or acceptable for every blob. It is the measured cost
  of this layout.
