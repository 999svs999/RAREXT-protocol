# Running a registry

A registry is a set of files and a process. This page covers the files: what to back
up, how to restore it, and what happens when a snapshot is older or newer than the
build you are running. The wire protocol is in [`APP-PROTOCOL.md`](APP-PROTOCOL.md);
the storage contract is in [`STORAGE-ECONOMY.md`](STORAGE-ECONOMY.md).

## Storage hardening limits

The storage endpoints (`PUT`/`GET /v1/blobs`, the durability challenge, audit, and
repair paths) are bounded by construction, and the limits are measured by the
regression tests in `apps/api/test/storage-hardening.test.ts`:

| Check | Limit / behaviour | What happens at the limit |
| --- | --- | --- |
| Shard digest / root / storedAs | must be 64-char lowercase SHA-256 hex | `placementProblem` / `signPlacement` / `verifyPlacement` refuse the placement; a truncated or non-hex digest is never written |
| Blob size | `MAX_BLOB_BYTES` = 32 MiB per blob (`BlobStore`) | `store.put()` throws `blob is N bytes, above the 33554432 byte cap`; the JSON path is additionally capped by `MAX_BODY_BYTES` = 1 MiB |
| Custom blob cap | `new BlobStore(dir, { maxBytes })` | same rejection, cap is per-store |
| Chosen survivor holder missing | a survivor's holder is not in the caller's holder list | `repair()` rejects with `cannot repair: holder <id> for shard <i> is not configured` before any write; the placement is untouched |
| Fewer than k live shards | `survivors < dataShards` | `repair()` rejects with `cannot repair: only <n> of <k> data shards survive` before any write |
| Concurrent repair | two `repair()` calls for the same blob | the second caller joins the in-flight repair (`inFlightRepairs`) instead of writing the same shard twice |
| Duplicate challenge nonce | replayed nonce with a different binding | `verifyChallengeResponse` rejects (`bad-proof`); the holder also caps nonce length at `MAX_CHALLENGE_NONCE` (200) |

A failed or refused repair never moves the signed placement: the staging is
atomic, so a retry is idempotent and the holder store stays content-addressed.
Write access, request rate, total blob quota, and TLS are separate exposure
controls; see
[`OPERATOR.md`](OPERATOR.md#public-exposure-and-write-limits).

## Node blob-store garbage-collection limits

`POST /v1/storage/gc` collects blobs the caller does not reference. The body is
`{ referenced: [sha256, ...], gracePeriodMs?, dryRun? }`; `dryRun` defaults to
`true` and an explicit `referenced` array is required, so an unconfigured sweep
cannot delete anything. The API also runs this pass on a schedule with the
reference set computed from its own publications; see
[Automatic garbage collection](#automatic-garbage-collection). The
scan/candidate-save/delete section is synchronous, so two calls in one process
cannot interleave. Limits are measured by
`apps/api/test/storage-gc-fault.test.ts`:

| Fault | Behaviour at the limit |
| --- | --- |
| A blob is unreferenced | it becomes a candidate, not a deletion, and is only collected after `gracePeriodMs` (default 24h) |
| A blob with a live retention term | held even when unreferenced: `held` is reported and the blob is not a candidate; the commitment cannot be broken by cleanup. Once the term matures it is collectable |
| An unparseable `retentionUntil` | fail closed: `matured` is `false`, `opening` stays `null`, `remove` returns `false`, and GC counts the blob as `held`. A corrupt timestamp can delay collection but never release the opening or delete the bytes early |
| A referenced blob | never deleted, and its candidate entry is cleared |
| Interrupted write or index save | `*.tmp` leftovers are swept (`purgedTemp`); only 64-hex names are blobs, so a temp file is never one |
| Two GC passes from one process | the synchronous pass collects each orphan exactly once; the second pass sees no orphans and reports zero |
| A missing or malformed `referenced` list | `400 referenced must be an array of sha256 hashes`; nothing is scanned or deleted |
| A destructive pass (`dryRun:false`) from a non-loopback client with no API token | `403 destructive GC requires RAREXT_API_TOKEN or a loopback client`; nothing is scanned or deleted |

## External agent (MCP) storage limits

The external-agent path in `apps/mcp` drives the same holder, placement, and pin
services over HTTP, and its measured limits are pinned by the regression tests in
`apps/api/test/mcp-storage.test.ts` and `apps/api/test/mcp-storage-agent.test.ts`:

| Check | Limit / behaviour | What happens at the limit |
| --- | --- | --- |
| `rarext_storage_challenge` / `rarext_storage_audit` on an unknown blob | the blob has no signed placement | the verb rejects with `no placement for <hash>; pass the signed placement or put it first`; a bare read-only audit never contacts holders |
| `rarext_storage_pin` `root` field | when a root is claimed it must be a 64-char lowercase SHA-256 hex digest | `root must be a sha256 hex digest when provided`; a well-formed root with no placement is a broken link the operator must reconcile, not a hard error |
| `rarext_storage_pin` `cid` field | the claimed CID must match the bytes' computed CIDv1 | `cid does not match the content` |
| Pin response integrity | the pin service record must name the same CID and `pin:<cid>` reference | a corrupted or wrong-service response is refused with `pin service returned a record for a different cid` |
| A holder that drops mid-`put` | the holder answers 5xx on the shard upload | `rarext_storage_put` rejects with `holder <id> failed put: 500` and no placement is registered; a retry is safe |
| A holder that returns a wrong digest | the shard's bytes do not hash to its `storedAs` | `rarext_storage_get` records the shard as an error entry and reconstructs from the remaining shards; fewer than k usable shards rejects with `only <n> of <k> data shards are usable` |
| A holder token that is wrong or expired | the holder answers 401/403 to every challenge | the challenge records a `rejected` outcome per shard and `rarext_storage_challenge` rejects with `every holder rejected the challenge; check RAREXT_HOLDER_TOKEN` instead of silently reporting every shard lost |
| `rarext_storage_audit` with a holder not in the placement | the read-only audit sees a configured holder set that is a subset of the placement | the audit degrades to `under-replicated` (shards on the absent holder report not live) instead of failing; `challenge: true` routes through `rarext_storage_challenge` and still requires the full set |

## Holder process fault limits

The holder process stores shard bytes for other machines and answers nonce-bound
challenges. Its failure modes are bounded by the regression tests in
`apps/api/test/holder-fault.test.ts` and the token/quota tests in
`apps/api/test/quotas-limits.test.ts` and `holder-gc.test.ts`:

| Fault | Behaviour at the limit |
| --- | --- |
| Shard write on a read-only or full disk | a 5xx, not a 400: `ENOSPC` is `507 insufficient storage: disk full`; `EACCES`/`EPERM` is `500 holder directory is not writable`. A failed write is a holder problem, so a caller retries or repairs instead of resending bytes |
| Per-holder byte quota (`RAREXT_HOLDER_MAX_BYTES` / `maxBytes`) | both the JSON and raw upload paths answer `507 insufficient storage: byte quota exceeded` before any bytes are stored |
| A request naming a shard the holder does not have | a clean `404 unknown shard` on GET, HEAD, raw, leaves, and challenge |
| A challenge answered after the retention window closed (GC deleted the shard) | the holder no longer has the bytes, so the challenge answers `404 unknown shard`; the ledger records the shard as not live and repairs it |
| A corrupted or truncated shard on the holder disk | the challenge refuses to serve a proof over the wrong bytes: it re-hashes the on-disk file against the shard name and falls back to `404 unknown shard` instead of a valid-looking Merkle proof |
| A holder restart mid-challenge | shard bytes reload from disk, so the restarted holder still answers challenges; a holder that is not running surfaces a clean `fetch failed` / connection error to the caller, which the ledger records as a `holder-missing` outcome rather than hanging |

## Holder garbage-collection and orphan-cleanup limits

Holder GC is driven by `POST /v1/durability/gc` (or a direct
`POST /v1/holder/gc/scan`). The scan, delete, and candidate-save section is
synchronous on the holder's event loop, so two passes cannot interleave. These
limits are measured by the regression tests in
`apps/api/test/holder-gc-fault.test.ts`, `holder-gc.test.ts`,
`storage-gc-fault.test.ts`, and `storage-properties.test.ts`:

| Fault | Behaviour at the limit |
| --- | --- |
| GC runs against a blob that is still being read | the holder tracks an open-read count per shard and defers collection while it is non-zero: the pass reports `deferred`/`deferredShards`, deletes nothing for that shard, keeps its grace-period candidate entry, and the reader receives every byte. The shard is collected by a later pass once every reader closes. The count is per process; a second holder process on the same directory is unsupported |
| A crash leaves an orphaned shard directory or temp files | Regular `_upload.*.tmp`, `<hash>.*.tmp`, and `_index.json.*.tmp` files are swept at startup and by every GC pass (`purgedTemp`); a directory ending in `.tmp` is left alone. A temp file whose raw upload is still in flight is excluded in-process, so the writer's rename still succeeds. The store adopts only regular files whose bytes hash to their 64-hex name: a 64-hex directory is ignored at startup and never deleted, and a misnamed 64-hex file is neither adopted nor deleted. Re-hashing at startup streams through a 1 MiB buffer, so adopting an 8 GiB holder shard does not load it into the heap |
| GC meets a placement whose lease is still live | shards listed in the pass's `referenced` set are never deleted and any grace candidate is cleared, so a live placement keeps all of its shards; only unreferenced orphans are collected. A placement has no expiry field: it holds its shards until the ledger `forget`s it or evicts it (`maxPlacements`). A node blob's retention expiry does **not** release the holder copies |
| A destructive scan or a shard DELETE from a non-loopback client with no holder token | `403`; the holder keeps the shards |
| Two GC passes run concurrently | the synchronous scan/delete/save section serializes them: the second pass observes the first pass's deletions and reports zero, so an orphan is deleted exactly once, deletion counts never double-count, a live shard is not lost, and `_gc-candidates.json` stays valid. A raw upload may be in flight during the pass; its temp file is skipped and the upload commits normally. One holder process per data directory: two processes sharing a directory can race the candidate file |
| A retained blob's holds have all expired | before the term matures `BlobStore.remove` refuses to collect (returns `false`), so cleanup cannot break an anchored commitment. An unparseable `retentionUntil` is treated as still live (`matured: false`, opening `null`, GC `held`), so corrupt metadata fails closed. Once a parseable term matures the opening is released and the node's blob is ordinary garbage; the holder shards still follow the placement rule above |
| A collected shard is challenged from the leaf cache | GC and DELETE invalidate the cached leaves, and a cache hit re-checks the file's existence and size, so a shard that is gone cannot answer a challenge with a stale proof |

## Tournament and Trac task registry limits

The newest session-scoped endpoints are bounded by construction, and the limits are
measured by the regression tests in `apps/api/test/tournament.test.ts` and
`apps/api/test/tracregistry.test.ts`:

| Endpoint | Limit | What happens at the limit |
| --- | --- | --- |
| `POST /v1/tournaments` | up to `MAX_TOURNAMENT_PARTICIPANTS` (1024) participants | `400` naming the cap; round-robin table is O(n²) so the cap bounds the match count at ~524k |
| `POST /v1/tournaments` | duplicate `name` | `400`; the service refuses to replace a live bracket |
| `POST /v1/tournaments/.../results` | `matchId` must exist in the tournament's state | `400` for an unknown or not-yet-populated match |
| `POST /v1/tournaments/.../results` | `winnerParticipantId` / `loserParticipantId` must be the two participants of that match | `400`; the standings stay reachable only from real entries |
| `POST /v1/tournaments/.../results` | concurrent submissions of the same result | the check-and-write is synchronous, so the second write is refused with `already has a winner` / `already played`; a match records exactly once |
| `POST` body size (all endpoints) | `MAX_BODY_BYTES` = 1,000,000 bytes | oversized JSON is destroyed mid-stream; malformed JSON is a `400` (`invalid JSON body`), never a 500 |
| `GET /v1/tracregistry` and `GET /v1/tournaments` | read-only | repeated and concurrent reads return identical state; missing handles and unknown names are `404`, not errors |

The tournament and Trac task registries are in-memory and session-scoped: a
restart clears them, and there is no durable storage, signing, or external
service behind either endpoint. An operator who needs persistence must copy
`GET /v1/tournaments` before stopping the process.

## Data on disk

By default the API writes to `.data/`. `RAREXT_DATA` moves the store file
(`RAREXT_DATA=none` keeps it in memory, which is only useful for tests).

| Path | What it is | If lost |
| --- | --- | --- |
| `.data/rarext.json` | Publications, profiles, identities, key rotations and delegations, anchors, identity links, revocations, the credit ledger (snapshot v2) | The registry loses its index and reputation. Anchors on chain still commit to the publications, but the registry cannot serve them. |
| `.data/placements/` | Signed placement records: blob hash, shard map, steward key | The registry forgets where shard bytes live. The records are also published over `/v1/placements`, so a steward or a reader may still hold a copy. |
| `.data/verifier-operators/` | Self-signed verifier operator registrations | The registry cannot check operator attestations until it sees the records again. The operator's key is in the record, so re-registration is cheap. |
| Holder directories | Shard bytes (`RAREXT_HOLDER_DIR` per holder) | Data loss for that holder. Erasure coding and repair cover a lost holder only if the placement is current and a spare exists. |
| Pin directory | Pinned bundle bytes (`RAREXT_PIN_DIR`, default `.data/pins`) | The content adapter loses its locally pinned copy; the CID still names the bytes, but this host no longer serves them. |

Shard directories are not inside `.data/` unless you put them there. Back them up
separately, or treat them as replaceable: the registry can repair a missing shard from
any `k` survivors when a spare holder is configured. A backup of `.data/` alone restores
the map, not the bytes.

### Placement registry growth limits

`.data/placements/placements.json` holds every blob's signed history and is rewritten in
full on each accepted record. Per-blob history is capped at `MAX_PLACEMENT_HISTORY` (64)
records; the newest record and its verifiable suffix are kept, and the oldest records are
dropped. A retained window starts at a non-zero sequence and its first record links back
to a record that was dropped, which is still accepted on load. Measured by
`apps/api/test/placements-fault.test.ts`:

| Fault | Behaviour at the limit |
| --- | --- |
| History exceeds 64 records | the oldest are dropped on the next append; the head and the newest 64 stay |
| A reloaded history starts above sequence 0 | accepted when the retained suffix is contiguous and links backwards |
| The index write fails (`ENOSPC`, `EACCES`, ...) | `PUT /v1/placements` returns `507` and the in-memory head is rolled back, so it never serves a record the disk lacks |
| A crash before the index rename | the previous `placements.json` stays; a stale `placements.json.<uuid>.tmp` is ignored on load and never read as the index |
| The same head record is replayed | `200`, no second append; an older record no longer extends the head and gets `409` |

Total blob entries are not capped: each blob has its own bounded history, and dropping a
placement would forget where shard bytes live. The index therefore grows with the number
of blobs, not with the number of updates. `put` is synchronous, so appends in one process
serialize; run one registry writer per data directory.

## Pinning service

`npm run pin` starts the reference service on `127.0.0.1:9700` with
`RAREXT_PIN_DIR=.data/pins`. Point the API at it with
`RAREXT_PIN_URL=http://127.0.0.1:9700/v1/pins`. It verifies that every claimed CID
matches the bytes it receives, writes pins atomically, and stores no secrets. Set
`RAREXT_PIN_TOKEN` on the service and every client to require a bearer token. Back up
the pin directory with `.data/`; a pin is one replica, not a permanence guarantee.

### Pin garbage-collection limits

`POST /v1/pins/gc` reaps structural orphans and, when a `referenced` CID list is
supplied, unreferenced pins. `dryRun` defaults to `true`. `put`, `remove`, and
the GC pass are synchronous, so a read never races an unlink and two passes in
one process cannot interleave. Limits are measured by
`apps/api/test/pin-gc-fault.test.ts`:

| Fault | Behaviour at the limit |
| --- | --- |
| A crash leaves content without metadata | the `.bin` is an orphan: reported as `orphanContent` and removed after `gracePeriodMs` |
| A crash or manual delete leaves metadata without content | the `.json` is an orphan: reported as `orphanMetadata` and removed after the grace period |
| A corrupt content/metadata pair | the pin no longer verifies against its CID, so it is treated as an orphan and collected |
| A pin with `publicationIds` | a live hold: never collected when `referenced` omits it; counted as `held` |
| A pin the caller references | never deleted, and its candidate entry is cleared |
| A pin the caller does not reference | becomes a candidate and is collected only after the grace period |
| Interrupted write temp files | `*.tmp` leftovers are swept (`purgedTemp`); the sweep runs even in a dry run |
| Two GC passes from one process | the synchronous pass collects each orphan exactly once; the second reports zero |
| A malformed `referenced` list | `400 referenced must be an array of CIDs`; nothing is scanned or deleted |
| A destructive pass (`dryRun:false`) from a non-loopback client with no pin token | `403 destructive GC requires a pin token or a loopback client`; nothing is scanned or deleted |

`deleted` counts whole pins whose content and metadata were both removed. Structure
of a pin whose metadata or content alone was orphaned is reported through
`orphanContent`/`orphanMetadata`, not `deleted`.

### Automatic garbage collection

Both processes collect on a timer, so orphan bytes do not accumulate when nobody
calls the endpoints by hand. A pass never overlaps the previous one; a tick during
a pass is skipped and the next one is scheduled after it finishes. The reference
set is computed by the process that owns the records, not supplied by an
unauthenticated caller.

| Service | Env | Default | What a pass collects |
| --- | --- | --- | --- |
| API | `RAREXT_GC_INTERVAL_MS` | 24h (`0` disables) | holder shards from this node's placements, and node blobs unreferenced by any publication manifest |
| API | `RAREXT_GC_GRACE_MS` | 24h | how long a candidate must be seen before deletion |
| API | `RAREXT_GC_DRY_RUN` | `true` | set to `false` to delete; a dry run still records candidates and sweeps temps |
| Pinning service | `RAREXT_PIN_GC_INTERVAL_MS` | 24h (`0` disables) | structural pin orphans and corrupt pairs; pins with `publicationIds` are holds |
| Pinning service | `RAREXT_PIN_GC_GRACE_MS` | 24h | candidate age before deletion |
| Pinning service | `RAREXT_PIN_GC_DRY_RUN` | `true` | set to `false` to delete |

With the defaults a first pass records candidates and the second deletes
candidates older than 24h, so a mistaken reference set has a full grace period
before any byte is lost. The blob reference set is the union of every
`blobs[].hash` in every publication's artifact body; a blob uploaded but never
published, or one whose manifest was replaced, is a candidate. Shards are
referenced through `DurabilityLedger` placements. Only `artifact.body.blobs`
counts: a hash in a title, body text, or a draft does not protect bytes.

These passes are single-node: a second API with a different placement directory
can still see the first node's shards as unreferenced, so keep the grace period or
run GC from the API that owns the records. Node blobs are only collected by the
node that stores them. Nothing in the pass is a durable transaction; a crash
between the scan and the index save leaves the candidates file, which the next
pass re-reads. Measured by `apps/api/test/gc-schedule.test.ts`.

## Holder and pin tokens

`RAREXT_HOLDER_TOKEN` and `RAREXT_PIN_TOKEN` are shared bearer secrets, not identities.
They protect a holder or pin service from unauthenticated clients when it is reachable
by more than the local process; they do not encrypt traffic, scope access, or survive a
plain-HTTP observer. The holder CLI refuses to bind a non-loopback host without a token.
Terminate TLS at a reverse proxy and keep the token in the process environment or a
secret file, never in a command line.

To rotate, stop the service, change the token, restart, then update every API, holder
set, and MCP process. There is no overlap window, so a rolling rotation will produce
401s for clients still using the old token. The full threat model and the open findings
are in [`STORAGE-SECURITY.md`](STORAGE-SECURITY.md).

## Snapshots and migrations

`rarext.json` is a single versioned snapshot. On load the node:

1. parses the file;
2. refuses a snapshot whose `version` is newer than the running build
   (`snapshot version N is newer than this build supports (M); upgrade the node or
   restore an older backup`);
3. runs any registered migrations in order for an older version;
4. validates that `publications` is an array.

A corrupt or partially written file stops the process with `could not load …` instead
of starting from an empty store. That is deliberate: the first write after an empty
start would replace the only copy of the registry's history.

Snapshot version 2 is current. Version 1 is still readable: migration 1 → 2 adds empty
`rotations` and `delegations` arrays, so a store that never rotated a key loads unchanged.
Adding a migration means adding an entry to `snapshotMigrations` in
`apps/api/src/migrations.ts` with `from`, `to` (`from + 1`), a description, and a pure
function from the old snapshot to the new one. An older snapshot without a full chain to
the current version is refused. Take a verified backup before upgrading a node that holds
the only copy of a key history: retired keys are rebuilt from rotation records, not from
a separate archive.

## Game-native state migration

There is no appchain cutover. [RFC 0016](../rfcs/0016-appchain-evaluation.md)
defers the chain, and [RFC 0017](../rfcs/0017-game-native-state-migration.md)
defines a no-op preservation plan for the game state that exists today.

```bash
curl -fsS http://127.0.0.1:8787/v1/challenges > challenge-export.json
npm run plan:game-state -- --source .data/rarext.json \
  --challenges challenge-export.json \
  --out migration-plan.json --bundle migration-bundle.json
```

The plan is always `status: "deferred"` and `mode: "no-op"`; it reads the snapshot
and writes only the plan or bundle. The bundle copies every durable snapshot
record and extension field, plus the challenge export, but it is not a target
schema. The command refuses `--execute` and `--cutover`. Delete the artifacts and
keep the source registry if no target is approved.

Challenges are not in `rarext.json`, and sponsored challenges are in memory, so
export `/v1/challenges` before stopping the process. A real cutover is cold, with
no dual-write; the full preconditions, comparison steps, and rollback boundary are
in RFC 0017. The remaining gate is an accepted target schema for active builds,
challenges, reputation, and ratings.

## Backup

```bash
npm run backup:create -- --data .data --out backups/registry-$(date +%F).json.gz
npm run backup:verify -- --file backups/registry-2026-10-23.json.gz
npm run backup:restore -- --file backups/registry-2026-10-23.json.gz --data .data.restored
```

`create` walks every regular file under `--data`, skips `*.tmp` and symlinks, and writes
a gzipped JSON bundle. Each file records its relative path, size, SHA-256, and base64
content; the bundle records a SHA-256 over the sorted manifest.

`verify` recomputes every file digest and the manifest digest. It fails on a changed
byte, a changed size, a changed digest, a duplicate path, or a path that is absolute or
escapes the target (`..`, backslashes, drive letters).

`restore` verifies first, then writes atomically into a directory. It refuses a
non-empty target unless `--force` is passed, so a mistyped path cannot overwrite a live
registry. Restore into a fresh directory, inspect it, then swap it in while the node is
stopped.

`--exclude` takes one relative path or directory prefix, for example
`--exclude blobs` when a large shard directory lives under the data root and is backed
up by other means.

### Backup and restore fault limits

`restore` verifies the whole bundle before touching the target, stages every file as a
unique `*.tmp`, then renames them into place. A lock file makes a second restore into
the same target refuse rather than interleave. Limits are measured by
`apps/api/test/backup-fault.test.ts` and `backup.test.ts`:

| Fault | Behaviour at the limit |
| --- | --- |
| A truncated archive or bad gzip | `readBackup` throws; `verify` never sees a partial bundle |
| A version other than `BACKUP_VERSION` (1) | `verifyBackup` reports `backup.version must be 1`; `restoreBackup` throws before writing |
| A staged write fails midway | every staged temp is removed, the lock is released, and the target keeps only what was there before; no partial file is committed |
| A commit rename fails midway | remaining temps are removed and files created by this run are rolled back; files that already existed and were overwritten cannot be restored (that is the `--force` contract) |
| Two restores into one target | the second refuses with `restore already in progress`; a crashed restore leaves `.rarext-restore.lock`, which an operator removes once no restore is running |
| A symlinked directory inside the target | the destination's real parent must stay under the target root, so a restore cannot write through a symlink outside it |
| Two `writeBackup` calls to one path | each writes a unique temp and renames, so the archive is always one complete valid bundle and no temp is left |
| Restore target is a file | `restore target is not a directory` before any write |

## Restore procedure

1. Stop the node.
2. Restore into a new directory and run `backup:verify` on the bundle.
3. Point `RAREXT_DATA` at the restored `rarext.json` (or replace the old file) and
   `RAREXT_VERIFIER_OPERATORS_DIR` at the restored operator directory if it was moved.
4. Start the node and check `GET /v1/durability`: the schedule state should name the
   expected holders, and every blob should become `ok` after the first challenge if its
   holders still answer.
5. Run `POST /v1/durability/challenge` once rather than waiting for the interval.

A restore does not recreate shard bytes. If the holders are gone, the placement is only
a record of where the bytes used to be; erasure repair needs `k` surviving shards from
the configured holder set.

## Rotating backups

Keep more than one generation, off the machine that runs the registry. A backup on the
same disk is a copy, not a backup. Because the bundle is content-verified, an old copy
still restores; it just restores an older view of the registry and its anchors.
