# Storage, in one page

Status: pre-alpha. This is the public summary of what the storage stack runs, what was
measured, and what the measurements do not prove. The detailed contract is
[STORAGE-ECONOMY.md](STORAGE-ECONOMY.md); failure injection is
[HARDENING.md](HARDENING.md); attacks and open findings are
[STORAGE-SECURITY.md](STORAGE-SECURITY.md).

## What runs

A blob is content-addressed, erasure-coded as `k` data shards plus `m` parity shards,
and placed on distinct HTTP holders. Each placement is signed and reloadable. A holder
answers a fresh nonce-bound Merkle challenge for a chunk it claims to keep. `audit()`
reports `live` against the tier's required count, and `repair()` reads exactly `k`
survivors and writes a lost shard to a spare holder. Holders can also serve random 4 KiB
chunks with Merkle proofs for availability sampling.

The client can put and get over whole-shard JSON (small payloads) or raw streamed shard
files (large payloads). The streamed repair path rebuilds one shard at a time from
survivor files, so its memory follows the chunk size rather than the payload size.

## Measurements

All figures are from the reference laptop (Intel i5-8257U, 8 GB, Node 24), not a server
or a multi-machine cluster. Peak RSS is a process measurement, not a service-level
guarantee. Re-run the scripts before quoting a different machine.

| Evidence | Result | Scope |
| --- | --- | --- |
| 1 GiB file-backed encode/decode | **394.5 MiB peak RSS** in the first run; **392.6 MiB** in the latest rerun. The in-memory path peaked at 3242.8 MiB, so this is 8.3x lower. | Codec only, no HTTP or JSON framing. |
| 1 GiB streamed over HTTP | **249.1 MiB client peak** in the first run; **242.1 MiB** in the latest rerun. Holder peak 93.6 MiB. | 4+2 shards, raw PUT/GET, real holder child processes on loopback. |
| 604 s soak and chaos | **5,910/5,910 puts (100%)**, **5,910/5,910 retrievals (100%)**, 145/145 repairs, 145/145 post-repair re-audits, 23 holder kills/restarts. Median client RSS after warm-up 170.7 MiB; live JS heap ~10.5 MiB. | One machine, loopback holders, 64 KiB payloads, retry and zero-grace GC enabled. |
| Earlier 611 s soak | 5,507 puts (5,502 succeeded, **99.9%**), 5,507 retrievals (100%), **143 repairs**, 143/143 re-audits, 21 kills. | One machine, loopback holders. The 143-repair and 100%-retrieval figures are from this run; its puts were 99.9%, which motivated retry. Do not combine them into “100% puts with 143 repairs.” |
| Availability sampling | **44 samples** of 4 KiB (176 KiB) detect **10% withholding at 99%** confidence. 66 samples (264 KiB) detect it at 99.9%. | 36 MiB photo slice, 9,216 chunks; exact hypergeometric bound in [RFC 0010](../rfcs/0010-data-availability-sampling.md). |
| Repair bandwidth | 1 GiB with two losses: read 1.000 GiB, write 0.500 GiB, total 1.500x; one loss is 1.250x. 127 s. | 4+2 codec, local file path. |

The file-backed number and the streamed number measure different paths: the first is
encode/decode compute; the second includes holder HTTP and disk. The streamed run is
bounded by its 8 MiB chunk size, not by the 1 GiB payload.

## What the tests prove

- **Streamed repair is real.** `npm run net` signs and registers an 8 MiB streamed
  placement, reloads it from a fresh registry, audits, kills a holder, repairs the lost
  streamed shard (`read 8388608`, `wrote 4194304`), re-audits, and retrieves the payload
  byte-for-byte.
- **The MCP path is an external-client test.** `npm test` runs
  [`apps/api/test/mcp-storage-agent.test.ts`](../apps/api/test/mcp-storage-agent.test.ts),
  which starts six token-protected holders, the API, and a pin service, then drives put,
  get, challenge, audit, and pin through the real MCP stdio server.
- **The transport is not only loopback.**
  [`apps/api/test/non-loopback-holder.test.ts`](../apps/api/test/non-loopback-holder.test.ts)
  binds a holder process to a non-loopback IPv4 interface, places a shard on it from a
  separate client process, challenges it, audits it, retrieves it, and reconstructs the
  payload. It skips only when the machine has no non-loopback IPv4 interface.
- **Failure handling is tested.** Staged repairs, corrupt shards, crash/restart,
  disk-full, and simultaneous losses are covered in
  [`apps/api/test/storage-hardening.test.ts`](../apps/api/test/storage-hardening.test.ts).

## What is not proven

- **The sealed tier is opt-in and not audited.** Payloads are not encrypted by
  default. The sealed path uses HKDF-SHA256 + AES-256-GCM and now records key ids with
  client-side rotation/revocation, but the envelope has no key wrapping, AAD binding,
  per-tenant isolation, recovery, or independent review. Do not treat sealed mode as a
  confidentiality guarantee until those gaps are closed.
- **The soak is not a durability proof.** It is one machine, loopback, 64 KiB payloads,
  with holders restarted against the same directories. It says nothing about disks,
  power loss, TLS, clock skew, or multi-writer coordination. The 1 GiB run is one
  process pair, not independent operators.
- **Possession is not retrievability.** A holder that keeps the Merkle leaves and
  discards the bytes can still answer a challenge. Sampling is point-in-time and does
  not prove every byte is correct.
- **Not measured at 100 GiB.** Repair throughput at 100 GiB and concurrent repairs are
  unmeasured. The MCP put path still caps input at `RAREXT_STORAGE_MAX_BYTES` (8 MiB by
  default, 32 MiB hard cap); large payloads use the HTTP/raw path.
- **No fsync/power-loss guarantee, TLS, identity, or multi-writer lock.** Tokens are
  shared bearer secrets, not identities. Holders should sit behind TLS and a firewall;
  a non-loopback bind without a token is refused, but that is not transport security.
- **Ledger retention is opt-in.** `DurabilityLedger` keeps every placement by default.
  A long-lived client must set `maxPlacements` or call `forget()`; evicted placements
  can no longer be challenged or retrieved through that ledger.

## Reproduce

```bash
npm run bench:throughput       # 1 GiB file-backed vs in-memory
npm run bench:network          # 64 MiB whole-shard and 1 GiB raw streaming
npm run bench:soak -- --gc     # 10-minute churn run with forced-GC samples
node --test apps/api/test/non-loopback-holder.test.ts
```

See [`bench/storage/RESULTS.md`](../bench/storage/RESULTS.md) and
[`bench/storage/SOAK.md`](../bench/storage/SOAK.md) for the full tables, timestamps, and
caveats. A number that is not in the benchmark has no storage claim.

## Run it yourself

The [operator guide](OPERATOR.md) covers persistent holders, tokens, quotas, GC, and
remote machines. The short version for a holder on another host is in
[“Run a holder on another machine”](OPERATOR.md#run-a-holder-on-another-machine).
