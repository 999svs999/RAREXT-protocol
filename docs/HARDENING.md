# Storage hardening and known limits

This page records what the storage stack does under failure, what the tests actually
inject, and what is still not handled. It is deliberately narrower than “production
ready”: the stack is pre-alpha, and a limit that is written down here is a limit we
will not quietly claim away.

The failure tests are in
[`apps/api/test/storage-hardening.test.ts`](../apps/api/test/storage-hardening.test.ts),
[`apps/api/test/durability-repair-fault.test.ts`](../apps/api/test/durability-repair-fault.test.ts),
the streamed cases in
[`apps/api/test/erasure-stream-http.test.ts`](../apps/api/test/erasure-stream-http.test.ts)
and [`apps/api/test/erasure-stream.test.ts`](../apps/api/test/erasure-stream.test.ts),
and the codec/store cases in
[`apps/api/test/erasure-storage.test.ts`](../apps/api/test/erasure-storage.test.ts),
[`apps/api/test/persistence.test.ts`](../apps/api/test/persistence.test.ts), and
[`apps/api/test/merkle.test.ts`](../apps/api/test/merkle.test.ts).
The GB-scale measurement is in [`bench/repair`](../bench/repair/README.md).

## What was injected

| Failure | What happens | What the tests assert |
| --- | --- | --- |
| Repair write fails part-way (full spare/disk, simulated `ENOSPC`) | Writes are staged first. A rejected spare is skipped for the next free spare; the placement and witnesses are updated only after **all** repairs are written. The call throws only when no target accepts a shard. | A two-loss repair fails on the second write when every remaining target rejects it, the serialized placement is byte-identical, audit stays `under-replicated`, and a retry with healthy holders fills both shards. |
| Process crash after a shard hit the holder | The signed placement still names the old holder. The new shard is an orphan: content-addressed, valid, and not referenced. A retry is idempotent because `put` is content-addressed. | Crash after the first write, reopen the signed record from `PlacementRegistry`, adopt it into a new ledger, challenge, repair, reconstruct, and reach `ok`. |
| Corrupt/tampered shard | Holder `get` is hash-checked by `BlobStore`; a challenge is bound to a nonce and a Merkle leaf; repair tries survivors until it has `k` readable shards and `decodeBytes` verifies each digest. | A tampered shard produces `bad-proof`; a corrupt survivor selected by repair fails the digest and does not move the placement. Repair from honest holders still succeeds. |
| Streamed reconstruction shard set | Exactly `k` files are selected. Every selected file must match its signed size, SHA-256, and leaf count before output is opened; the full payload digest is checked before rename. | `k - 1` rejects `need <k> shard files, have <n>` with no output; a short/oversized file rejects `shard <i> file is ... expected ...`; an in-place edit rejects `shard <i> bytes do not match their recorded digest`; a truncated or corrupt file never reaches the destination. |
| Copied or relabelled shard | Shard identity is index-bound; a copy with a recomputed self-digest is still fed through the codec and checked against the signed payload digest. | Two shards with byte-identical contents are only accepted when reconstruction yields the signed payload; a relabelled copy fails `the reconstructed payload does not match its digest`. `decodeBytes` also rejects duplicate indices. |
| Merkle proof does not match | The proof must match the stored root, leaf index, and full path. | `verifyProof` returns `false` for a wrong root, wrong index, truncated proof, or reordered siblings; `verifyChallengeResponse` records `bad-proof` and the shard is not marked live. |
| Rebuilt streamed shard | Repair checks survivor file sizes, decodes chunk by chunk, then compares the rebuilt shard's size, SHA-256, leaf count, and Merkle root with the signed placement. | A mismatch rejects before upload; the temporary rebuilt file is removed, the placement is not moved, and a retry can use honest survivors. |
| Holder churn, two simultaneous losses | Repair reconstructs from `k` readable survivors, writes `m` shards, and places each on a holder not currently used by the blob. | Two losses fill two spares, all six holder ids stay distinct, the payload reconstructs; after removing another holder and adding a newcomer, a third repair still reconstructs. |
| Survivor drops after the presence probe | A survivor that passed `has` then throws on `get` is skipped and the next survivor is read. A corrupt shard is still decoded and fails closed. | `durability-repair-fault.test.ts` makes the first survivor throw once; repair reads another, fills the loss, and reconstructs. Too few readable survivors rejects with the unreadable indices and writes nothing. |
| Replacement spare rejects the write | A spare that answers `5xx`/`507` to `put`/`putFile` is marked unusable for this repair; the next free spare is tried. | The fault test fails the first spare, repairs onto the second, and checks the payload. Streamed repair has the same test in `erasure-stream-http.test.ts`. If every spare rejects, repair aborts with `repair write failed for shard <i>: no spare holder accepted it`. |
| Placement forgotten/replaced or repair lease expires mid-repair | The repair holds an in-memory lease tied to the placement object (`RAREXT_REPAIR_LEASE_MS`, default 30 min) and re-checks it before every read, spare probe, staged write, and commit. | Forgetting the placement mid-read aborts with `the placement is no longer current`; advancing past the lease aborts with `the repair lease expired`; in both cases no commit occurs and the placement is unchanged. |
| Repair storm | Consecutive failed repairs for one blob back off in the scheduler: 60s initial, doubled per failure, capped at 6h (`RAREXT_REPAIR_BACKOFF_MS` / `RAREXT_REPAIR_MAX_BACKOFF_MS`). | The scheduler test forces a failure, observes `repairDeferred` on the next runs, then a retry at the backoff deadline; a clean audit clears the failure count. |
| A source holder is gone when repair starts | A holder whose `has` throws is treated as degraded even if it is still configured. | The fault test makes a configured survivor unreachable; repair marks it degraded, rebuilds it from the remaining `k`, and moves it to a spare. |
| Disk full while writing a blob | A blob is written to a unique temp name and renamed; the index is written to a temp name and renamed. If the index write fails, a newly created blob is removed and its in-memory record rolled back. Temp files are removed in `finally`. | A read-only blob directory refuses the write and leaves no temp file or blob; a forced index-write failure leaves no orphan blob and a restart sees the original set. |
| Restart | Signed placement records are the map; the ledger rebuilds witnesses from a record. Witness freshness is not persisted, so a restarted node treats every shard as unchallenged until the next challenge. | The crash/restart test reloads the registry, adopts the record, re-challenges, repairs, and reports `ok` only after the challenge. |
| Audit verification clock is not a number | The freshness window is a set of numeric comparisons, and `NaN` fails all of them, so an unusable clock did not narrow the window — it removed it. The clock is now validated exactly as the window is. | Measured before the fix: `now: NaN` accepted an attestation a millisecond past its window. `audit-attestation.test.ts` now asserts `NaN`, `Infinity` and `-Infinity` all refuse an expired audit, and that a non-positive `windowMs` is refused. |
| Concurrent anchoring of one batch | The pending set was read before the adapter await and committed after it, so two overlapping calls both anchored. An in-flight attempt per store is now reused, so overlapping callers share one anchor and make one adapter submission. | Measured before the fix: two anchors, the same root, the same publications in each. `anchors.test.ts` forces the interleaving with a slow rail (the shape of a real network adapter) and asserts one anchor, shared, with one submission. |
| Fields beside a signed audit | The signature covers the fields the verifier reads. A field added beside them is neither signed nor surfaced, so no consumer may treat it as attested. | Pinned explicitly: adding or rewriting an unsigned field changes no verdict, while editing a field the verifier reads (`timestamp`) invalidates the signature. |

## Swept and found already guarded

A sweep for store-shaped methods whose body has no runtime type check produced four
candidates, and all four are gated before they store anything — so the honest result
for that sweep is *no defect found*. It is recorded here because the next pass should
start from it rather than repeat it:

| Method | What gates it | Sweep result |
| --- | --- | --- |
| `VerifierOperatorRegistry.register` | `verifyOperator` — kind, version, signature type, name (present, non-blank, ≤80), public key, algorithm, `keyId` = digest of the key, apps (non-empty, unique, string members), url (http(s) or null), `createdAt` ISO, then the signature | guarded; every branch now pinned by name |
| `PlacementRegistry.put` | `verifyPlacement` — kind, version, signature type, sequence (non-negative integer), backwards links, steward key id and key agreement, steward algorithm, `placementProblem`, `createdAt` ISO, then the signature | guarded; every branch now pinned by name |
| `RarextStore.addPublication` | route-level validation before the call | guarded |
| `DurabilityLedger.put` | the holder protocol, which passes bytes it has already checked | guarded |

What the sweep *did* change: the two gates above decide who is paid for verifier work
and what repair reads, and each had four test cases. The operator gate now pins the 17
named refusals it can return and the placement gate 16, each with a positive control so
the suite cannot pass by refusing everything indiscriminately. The placement gate
delegates the placement body itself to `placementProblem`, whose own branch set is wider
than these cases enumerate — the three delegated entry points are pinned here, and the
rest are exercised through it rather than claimed as covered.
`verifyOperator` and `verifyPlacement` also produce a `digest` — the placement gate
asserts it is `null` on every refusal, so a refused record cannot be handed back as a
valid chain link.

## Guarantees by path

| Path | Guarantees | Does not guarantee |
| --- | --- | --- |
| `BlobStore.get` | Re-hashes the file on every read and returns `null` for a truncated, missing, or altered file. Startup adopts only files whose bytes match their 64-hex name. | No repair, quarantine, `fsync`, or protection from a writer that changes the file after the read. |
| Holder raw read (`httpHolder.getFile`) | Hashes the streamed response against `storedAs`; a truncated, partial, altered, timed-out, or 401/403 body throws and the caller skips that holder. A 15 s socket-idle timeout bounds a silent peer and a 120 s total read deadline bounds a trickle. | One attempt per holder per retrieval, so parity is the retry budget; no retry of the same holder, and no proof that the holder kept the bytes rather than producing them now. |
| Multi-holder streamed retrieval | Up to four shards download at once; any `k` hash-verified shards decode. A slow but correct holder is awaited, while a dead one occupies one slot for at most its timeout. | A failed retrieval below `k` writes no output. Retries and concurrency are per process; there is no cross-process read lease. |
| `decodeBytes` | Requires at least `k` distinct shards, one code/parameter set, equal shard sizes, an index-bound digest per shard, and a final payload digest. | It trusts the caller-supplied parameters and payload digest; it does not verify a placement signature or prove the digest came from the publisher. |
| `decodeShardsToFile` | Checks each selected file against the signed size, SHA-256, and leaf count; verifies the full payload digest; writes through a temp file and renames only on success. | It does not rebuild the shard Merkle root, does not check unselected shards, reads selected shards twice, and leaves a `.tmp` sibling if the process crashes. No `fsync`/power-loss guarantee. |
| `reencodeStreamedShard` | Checks survivor sizes, verifies chunk digests during decode, and compares the rebuilt shard's size, SHA-256, leaf count, and Merkle root with the signed placement before upload. | It does not hash every survivor file up front; a same-sized corrupt survivor is caught by a chunk digest or the rebuilt-shard check, not before work starts. No `fsync` guarantee for the staged file. |
| `verifyProof` / `verifyChallengeResponse` | Binds the proof to the stored root, leaf index, exact proof path, nonce, and request leaf. A mismatch returns `false`/`bad-proof`. | Possession, not retrievability; a holder can keep leaves and discard bytes. Unselected or unchallenged shards are not proven. |
| Agent SDK keyfile + signing boundary (`packages/agent-sdk/src/index.ts`; `agent-sdk.test.ts`) | A keyfile round-trips with its identity intact, and the README's modes hold: 0600 on the file, 0700 on its directory (POSIX). A second write refuses (`EEXIST`) rather than clobbering an existing key, and the original bytes are untouched. Every malformed shape is refused with a message naming the problem: non-JSON, an array, a foreign kind, a future version, an out-of-shape handle, a missing private key, a mismatched keyId — and the public/private PAIRING is validated, so a file cannot advertise one identity while signing as another. A signature verifies over its own canonical bytes and fails over a modified payload or a flipped signature bit. Handles outside the documented 1-32 lowercase shape are refused at creation. | The secret's strength is the caller's; the keyfile's protection is file modes plus the filesystem, not encryption at rest. Revocation is a registry-side concern. |
| Sealed tier (`apps/api/src/sealed-encryption.ts`; `sealed-path.test.ts`) | AES-256-GCM with an HKDF-SHA256 key derived per payload from a fresh 16-byte salt. A round trip is byte-exact; a ciphertext or auth-tag tampered by one bit is refused (`authentication failed`), never partially returned; a wrong secret is refused; malformed or wrongly sized `iv`/`salt`/`authTag` are named in the refusal before any crypto runs (an empty ciphertext is valid base64 and is refused by authentication instead); metadata a placement records is bound to its ciphertext (a swapped pair is refused); the same plaintext encrypted twice shares no salt, iv, or ciphertext; and the recorded metadata plus committed ciphertext carry no plaintext, so a mirror holds bytes it cannot read. | Ciphertext length equals plaintext length — the sealed tier hides content, not size. The secret's strength is the caller's; the keyring's rotation and revocation behaviour is covered by the end-to-end sealed-path test, not here. |
| Multi-holder placement gate (`DurabilityLedger.place`/`placeStreamed` + `httpHolder`; `gate-multiholder.test.ts`, `non-loopback-holder.test.ts`) | With exactly `k + m` holders, placement either places every shard — each digest-verified when read back — or refuses loudly: a holder answering 5xx (e.g. `507` quota) fails the placement rather than letting it proceed with fewer shards, and a holder answering with something that is not a valid shard name is refused at placement. A surviving-holder set is probed before repair, spares that reject a write are skipped, a repair that loses its lease or whose placement is forgotten mid-read refuses to commit, and failed repairs back off instead of storming. A non-loopback holder streams byte-exact, enforces its token, and retrieves correctly. | The returned `storedAs` is a LOCATOR, not a proof: equality with the shard digest is deliberately not asserted at placement (a holder names the file by its own digest of the bytes it received), so integrity is enforced when the bytes are read back against that name. Losing more than `m` holders makes the blob unrecoverable — loudly at retrieval, never silently. |
| External MCP agent storage path (`apps/mcp/src/storage.ts` → blob routes, holders; `mcp-storage-agent.test.ts`, 10 cases) | A put is either stored exactly — digest-verified on retrieval, surviving a holder restart — or loudly refused. Quota is checked before the stream is consumed (`507` on JSON and raw paths; a refused put stores nothing). A lying `content-length` is refused loudly and never parsed as a fragment or misparsed as the next request. Corrupted shard bytes are caught by the digest check, never silently returned. A challenge after GC answers a clean `404` and the ledger records the shard not-live, never a stale proof. Concurrent identical puts converge to one stored object. A revoked identity is refused a put. Malformed tool arguments do not crash the MCP server. | The truncated-body `400` is not always deliverable: a client whose FIN races the response sees a connection reset — the contract is loud refusal, not a specific status. Byte quota is per holder process, not cross-holder atomic. Revocation gates new puts; already-stored bytes are not retroactively evicted. |

## GB-scale

`npm run bench:repair -- --bytes 1073741824 --losses 2` encodes 1 GiB as `4 + 2`,
loses two shards, reads exactly four survivors, rebuilds both, and verifies the payload
and both shard digests.

Last measurement (2026-10-25): read `1.000 GiB`, write `0.500 GiB`, total `1.500 GiB`
(`1.500x`), matching the MDS floor `1 + m/k`; 121.7 s on the reference laptop, with an
earlier run of the same command at 127 s — run-to-run variance of a few percent, so the
number to trust is the ratio, which is exact, not the seconds. The harness writes
`bench/repair/RESULTS.json` with `exact: true` and `totalRatio: 1.5`, and
`scripts/claim-check.mjs` verifies this paragraph against that file. One-loss runs hit
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
warm-up was 170.7 MiB and live heap was about 10.5 MiB. Re-run on 2026-10-26
(600 s, `bench/storage/soak-2026-10-26.log`): 5,991 puts (100%), 5,991 retrievals
(100%), 148 repairs (100%) with 148 re-audits passing, 22 kills, 2 transient put
retries; peak client RSS 196.0 MiB (median 180.3) with a 22.8 MiB live heap, peak
holder RSS 91.8 MiB. Across three runs the completion rate is 100% every time and
the RSS band is 196-249 MiB — the invariant to trust is the completion rate. The earlier 611 s run completed
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
  write. Repair tries another free spare; if every candidate rejects, it aborts before
  committing the placement, but bytes already staged on other holders remain as orphans.
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
  that is neither challenged nor selected in a repair can sit unnoticed. Unselected
  shards are not hashed by streamed decode; corruption there does not block a decode
  that has `k` good chosen shards.
- `repair` reads survivors until it has `k` readable shards. A holder that errors or
  returns nothing is skipped; a corrupt shard that was actually read still fails the
  digest loudly rather than being routed around. That is a deliberate fail-closed choice,
  not automatic corruption recovery.
- Streamed decode hashes selected shard files against the signed digests before
  decoding, so it reads them twice: once to verify, once to reconstruct. Peak memory
  is still the chunk size, but retrieval I/O is higher. The 1 GiB repair measurement
  predates the rebuilt-shard root check and was not rerun; do not quote it as the cost
  of the current path without re-running `npm run bench:repair`.
- The preflight hash and the decode are separate reads. A file rewritten between them
  is caught by the final payload hash, the temp output is discarded, and the
  destination is not replaced. There is still no `fsync`/power-loss guarantee for the
  rename.
- Challenges are **proof of possession**, not proof of retrievability. A holder that
  keeps the Merkle leaves and discards the shard bytes can still answer until it is
  asked for the bytes. The storage frontier lists that as open.
- There is no automatic quarantine or eviction of a bad holder; it is marked missing in
  the witness and the operator decides.

## Restart and scheduling limits

- `DurabilityLedger` is in-memory. It is rebuilt from signed placement records, and
  witnesses are reset. No recent challenge means `unverified`, not `ok`.
- The scheduler is per-process state and does not survive a restart; the next node
  starts a fresh schedule and a fresh repair backoff map. It records runs, including
  `repairDeferred` and `repairErrors`, but does not alert anyone yet.
- A placement is updated in place by repair and returned to the caller. Persisting the
  new sequence is the caller's responsibility (`signPlacement` + `PlacementRegistry.put`);
  a crash before that leaves the prior signed map authoritative.
- Repair does not verify a holder's identity beyond the placement record and holder id.
  An operator that swaps a directory behind the same id is outside this threat model.

## What a resident accepts from strangers

The storage stack above is bounded by design. The same question applies to
everything a resident READS: a seed, a list, an announcement document, an MCP
argument are all written by someone else, and each one can cost a resident work.
These are the bounds, with what is still not handled beside them — the point of
this page.

| Boundary | What holds | What is still not handled |
| --- | --- | --- |
| Registry walk fan-out (`MAX_REGISTRIES_PER_LIST`, 64) | A list naming more registries is walked to 64 and the truncation is **reported** in the result and to the per-registry observer. A hostile list costs 64 seed fetches, not N. | A list may still name 64 slow registries; the walk is sequential, so it is bounded in requests but not in wall-clock time. |
| Announcement documents (`MAX_ANNOUNCEMENT_DOCUMENTS`, 64, per fold) | The fold fetches at most 64 documents across all its seeds and reports the drop through the event stream, because a silently truncated pool reads as a complete one. | The cap is per fold, so repeated folds each pay it; a cache (RFC 0019 question 5) is what makes that cheap, and it is the caller's to configure. |
| URLs a document names (`canFetchRegistryUrl` in core) | http/https only, and no loopback, private, link-local, CGNAT or unspecified address — unless the document's own location is local (a local tree) or the caller passes `allowPrivateHosts`. Both the API and the SDK apply it through the same core functions. | It is a **literal-address policy**: a hostname that RESOLVES inward is not caught, because there is no DNS here. Redirects are followed ONLY through the policy — each hop is resolved against the current URL and re-checked, and a chain longer than two is refused — so a public URL cannot 302 its way to a private one while a registry that legitimately moved still works. |
| The SDK's own inputs (`packages/agent-sdk/src/validate.ts`) | A finite seed, a non-negative integer step count within `MAX_GENERATIVE_STEPS`, and a reconstruction of at most `MAX_BOUNDED_LENGTH` finite numbers. Refusals, never clamps: a signed record with a nonsense field is worthless to whoever reads it. | Nothing here judges whether a model or a reconstruction is any GOOD — only that a claim about it is well-formed and replayable. |
| The MCP argument boundary (`apps/mcp/src/attest-local.ts`) | A `seed` arriving as the string `"7"`, a fractional `steps`, or `values` that are not finite numbers are refused BY NAME. Silently ignoring one would run a different run than the caller asked for and report it as theirs. | It bounds shape, not size: an MCP client can still request a 64-document walk like anyone else. The caps above are the caps. |

## What would change these limits

- A local-reconstruction or regenerating code would lower the repair floor, at the cost
  of storage overhead and a new RFC.
- A distributed repair lock would coordinate multiple API processes; today repair
  coalescing, the repair lease, and backoff are per process.
- An orphan-shard garbage collector and a corrupt-index repair command would make
  crash recovery operationally complete.
- A retrievability proof, not just possession, needs a new challenge format and is a
  research result, not a test.

Until those exist, the honest claim is: the placement is staged and signed, corruption
is detected on the paths that read it, a restart recovers from the signed map, and the
known gaps above are the known gaps.
