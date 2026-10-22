# Repair bandwidth at 1 GB

The original storage contract asked for a single-shard repair to move less than `1/k`
of the blob. That is impossible for an MDS code, so the criterion is the floor, not a
target below it. This harness measures read, write, and total and checks the rebuilt
digests.

```bash
npm run bench:repair -- --bytes 1073741824 --losses 2
```

It builds a deterministic 1 GiB payload, encodes it with `4 + 2`, loses `m` shards,
rebuilds them from `k` survivors, and verifies every rebuilt shard and payload digest.
`RESULTS.json` records the bytes measured by the shard lengths the code actually
touches.

## Last results

| Payload | Code, losses | Read | Write | Total | MDS floor `1 + m/k` | Digests |
| --- | --- | --- | --- | --- | --- | --- |
| 1.000 GiB | 4 + 2, 1 | 1.000 GiB (1.000x) | 0.250 GiB (0.250x) | 1.250 GiB (1.250x) | 1.250x | match |
| 1.000 GiB | 4 + 2, 2 | 1.000 GiB (1.000x) | 0.500 GiB (0.500x) | 1.500 GiB (1.500x) | 1.500x | match |

The two-loss run took 127.0 s on 2026-10-23, Node 24.15.0; `RESULTS.json` holds that
record. Treat it as a measurement of this machine and this code, not a portable claim.

## Why the old target cannot be met by this code

An MDS code is all-or-nothing: any `k` shards reconstruct the whole payload. To rebuild
`m` lost shards it is necessary to read `k` shards (the payload) and write `m` shards
(`m/k` of the payload), so the floor is `1 + m/k`, here `1.25x` for one loss and `1.50x`
for two. No implementation of this code can read less without another copy of the data.

Reaching below that floor needs a different code or layout:

- **Local reconstruction codes** keep a local parity group, so one loss is repaired from
  a fraction of the shards at the cost of a higher storage overhead.
- **Sub-chunking** repairs only the chunk that held the lost bytes, at the cost of more
  Merkle roots and placement records.
- **Regenerating codes** trade read bandwidth against storage and compute; they are not a
  drop-in replacement for the current systematic layout.

The ledger now reads exactly `k` survivors, not all `n - m`, so it hits the floor above
instead of the previous `(k + m - 1)/k + 1/k`. Changing the code is the only way to beat
the floor.

## What this does not claim

- Two losses at most for `m = 2`; losing more than the parity count is refused.
- Bytes moved inside one process, not network bytes. Holder transport adds framing,
  retries, and round trips.
- No claim that `1.5x` is cheap or acceptable for every blob. It is the measured cost of
  this layout.
- No claim about untrusted holders, cross-holder atomicity, or crash recovery; those are
  covered in [`docs/HARDENING.md`](../../docs/HARDENING.md).
