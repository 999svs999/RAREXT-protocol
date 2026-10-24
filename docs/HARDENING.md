# Storage hardening and known limits

This page records what the storage stack does under failure, what the tests actually
inject, and what is still not handled. It is deliberately narrower than “production
ready”: the stack is pre-alpha, and a limit that is written down here is a limit we
will not quietly claim away.

The failure tests are in
[`apps/api/test/storage-hardening.test.ts`](../apps/api/test/storage-hardening.test.ts).
The GB-scale measurement is in [`bench/repair`](../bench/repair/README.md).

## What was injected

| Failure | What happens | What the tests assert |
| --- | --- | --- |
| Repair write fails part-way (full spare/disk, simulated `ENOSPC`) | Writes are staged first. The placement and witnesses are updated only after **all** repairs are written. The call throws. | A two-loss repair fails on the second write, the serialized placement is byte-identical, audit stays `under-replicated`, and a retry with healthy holders fills both shards. |
| Process crash after a shard hit the holder | The signed placement still names the old holder. The new shard is an orphan: content-addressed, valid, and not referenced. A retry is idempotent because `put` is content-addressed. | Crash after the first write, reopen the signed record from `PlacementRegistry`, adopt it into a new ledger, challenge, repair, reconstruct, and reach `ok`. |
| Corrupt/tampered shard | Holder `get` is hash-checked by `BlobStore`; a challenge is bound to a nonce and a Merkle leaf; repair reads exactly `k` survivors and `decodeBytes` verifies each shard digest. | A tampered shard produces `bad-proof`; a corrupt survivor selected by repair fails the digest and does not move the placement. Repair from honest holders still succeeds. |
| Holder churn, two simultaneous losses | Repair reconstructs from exactly `k` survivors, writes `m` shards, and places each on a holder not currently used by the blob. | Two losses fill two spares, all six holder ids stay distinct, the payload reconstructs; after removing another holder and adding a newcomer, a third repair still reconstructs. |
| Disk full while writing a blob | A blob is written to a unique temp name and renamed; the index is written to a temp name and renamed. If the index write fails, a newly created blob is removed and its in-memory record rolled back. Temp files are removed in `finally`. | A read-only blob directory refuses the write and leaves no temp file or blob; a forced index-write failure leaves no orphan blob and a restart sees the original set. |
| Restart | Signed placement records are the map; the ledger rebuilds witnesses from a record. Witness freshness is not persisted, so a restarted node treats every shard as unchallenged until the next challenge. | The crash/restart test reloads the registry, adopts the record, re-challenges, repairs, and reports `ok` only after the challenge. |

## GB-scale

`npm run bench:repair -- --bytes 1073741824 --losses 2` encodes 1 GiB as `4 + 2`,
loses two shards, reads exactly four survivors, rebuilds both, and verifies the payload
and both shard digests.

Last measurement: read `1.000 GiB`, write `0.500 GiB`, total `1.500 GiB` (`1.500x`),
matching the MDS floor `1 + m/k`; 127 s on the reference laptop. One-loss runs hit
`1.250x`. The earlier `>512 MB` shard-digest bug (hex encoding a whole shard) is fixed
by streaming large shards into SHA-256 with a distinct domain, and the 1 GiB run
exercises that path.

The in-memory placement path (`place`/`repair`) still passes whole shards through
memory, and `encodeBytes` holds the payload, blocks, and shards at once; the MCP put
path caps input at `RAREXT_STORAGE_MAX_BYTES` (8 MiB by default). Holders still keep a
whole-shard JSON endpoint for small shards, with a 32 MiB request-body limit.

For large payloads, `apps/api/src/erasure-stream.ts` encodes fixed-size chunks to shard
files, and holders accept raw `PUT`/`GET` of those files. `DurabilityLedger.placeStreamed`
and `retrieveStreamed` use that transport, so a 1 GiB blob moves without either side
buffering it whole. Measured at 1 GiB and 4+2 on the reference laptop: client peak
242 MiB (249 MiB in the first run) and holder peak 94 MiB (the 64 MiB run peaked at 250 MiB
client, 236 MiB holder). The old whole-shard JSON
path needed a 676 MiB client peak for 64 MiB and cannot store 1 GiB at all, because a
256 MiB shard becomes 341 MiB of base64 JSON against the 32 MiB cap. See
`bench/storage/RESULTS.md` and the public [`STORAGE.md`](STORAGE.md) summary.

Streamed repair rebuilds each degraded shard independently: it downloads k survivor
files, regenerates one shard per chunk from k blocks, and uploads only that shard through
raw PUT. Peak memory follows the chunk size, not the payload size. `npm run net` proves
this end to end (signed placement, fresh registry load, kill, repair, re-audit, exact
retrieval at 8 MiB). A retry-enabled 10-minute local chaos run (604 s) completed 5,910
puts (100%), 5,910 retrievals (100%), 145 repairs (100%), and 145 post-repair
re-audits (100%) with 23 random holder kills and restarts; median client RSS after
warm-up was 170.7 MiB and live heap was about 10.5 MiB. The earlier 611 s run completed
143 repairs at 99.9% puts, which motivated the retry change. Repair throughput at 100 GiB
and concurrent repairs are unmeasured.

## Disk-full and crash limits

- **No `fsync`/power-loss guarantee.** Writes are atomic against process crash via
  temp-and-rename, not against a power cut or a lying disk cache. The index and blob
  are two files, so a crash between them can still leave a blob file that the index
  does not describe; the loader discovers it by hash, but its retention metadata is
  lost.
- **Index corruption falls back to scanning.** `BlobStore.load` skips a corrupt index
  and recovers blob records from self-verifying filenames. Bytes survive; tier,
  retention, and sealed flags may not. There is no repair command for a corrupt index.
- **Single writer per directory.** `BlobStore` index updates are atomic against a
  process crash, not against two processes writing the same directory at once. A
  multi-writer setup needs a lock or a real database; the current tests are
  single-process.
- **No quota or free-space guard.** A full disk surfaces as an error from the holder
  write. Repair aborts before committing the placement, but bytes already staged on
  other holders remain as orphans.
- **No cross-holder transaction.** Staging prevents a half-committed *placement*, not
  orphan bytes. Scheduled GC (`RAREXT_GC_INTERVAL_MS`, dry run by default) and the
  holder scan reclaim unreferenced shards, but the grace period and single-node
  reference view remain operator concerns; see
  [`OPERATIONS.md`](OPERATIONS.md#automatic-garbage-collection).
- **A crash between the last staged write and the signed record** leaves all repaired
  shards unreferenced. The next repair writes them again; content addressing makes that
  safe, not free.

## Corruption and proof limits

- A shard is checked when it is read, challenged, or used in repair. A corrupt shard
  that is neither challenged nor selected in a repair can sit unnoticed.
- `repair` reads exactly `k` survivors. If one of those is corrupt, the repair fails
  loudly rather than reading more shards to route around it. That is a deliberate
  fail-closed choice, not automatic recovery.
- Challenges are **proof of possession**, not proof of retrievability. A holder that
  keeps the Merkle leaves and discards the shard bytes can still answer until it is
  asked for the bytes. The storage frontier lists that as open.
- There is no automatic quarantine or eviction of a bad holder; it is marked missing in
  the witness and the operator decides.

## Restart and scheduling limits

- `DurabilityLedger` is in-memory. It is rebuilt from signed placement records, and
  witnesses are reset. No recent challenge means `unverified`, not `ok`.
- The scheduler is per-process state and does not survive a restart; the next node
  starts a fresh schedule. It records runs but does not alert anyone yet.
- A placement is updated in place by repair and returned to the caller. Persisting the
  new sequence is the caller's responsibility (`signPlacement` + `PlacementRegistry.put`);
  a crash before that leaves the prior signed map authoritative.
- Repair does not verify a holder's identity beyond the placement record and holder id.
  An operator that swaps a directory behind the same id is outside this threat model.

## What would change these limits

- A local-reconstruction or regenerating code would lower the repair floor, at the cost
  of storage overhead and a new RFC.
- A concurrent repair scheduler with backoff would make repairs under many failures
  less serial; today repair is one placement at a time.
- An orphan-shard garbage collector and a corrupt-index repair command would make
  crash recovery operationally complete.
- A retrievability proof, not just possession, needs a new challenge format and is a
  research result, not a test.

Until those exist, the honest claim is: the placement is staged and signed, corruption
is detected on the paths that read it, a restart recovers from the signed map, and the
known gaps above are the known gaps.
