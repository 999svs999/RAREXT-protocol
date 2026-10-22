# Running a registry

A registry is a set of files and a process. This page covers the files: what to back
up, how to restore it, and what happens when a snapshot is older or newer than the
build you are running. The wire protocol is in [`APP-PROTOCOL.md`](APP-PROTOCOL.md);
the storage contract is in [`STORAGE-ECONOMY.md`](STORAGE-ECONOMY.md).

## Data on disk

By default the API writes to `.data/`. `RAREXT_DATA` moves the store file
(`RAREXT_DATA=none` keeps it in memory, which is only useful for tests).

| Path | What it is | If lost |
| --- | --- | --- |
| `.data/rarext.json` | Publications, profiles, identities, anchors, identity links, revocations, the credit ledger | The registry loses its index and reputation. Anchors on chain still commit to the publications, but the registry cannot serve them. |
| `.data/placements/` | Signed placement records: blob hash, shard map, steward key | The registry forgets where shard bytes live. The records are also published over `/v1/placements`, so a steward or a reader may still hold a copy. |
| `.data/verifier-operators/` | Self-signed verifier operator registrations | The registry cannot check operator attestations until it sees the records again. The operator's key is in the record, so re-registration is cheap. |
| Holder directories | Shard bytes (`RAREXT_HOLDER_DIR` per holder) | Data loss for that holder. Erasure coding and repair cover a lost holder only if the placement is current and a spare exists. |

Shard directories are not inside `.data/` unless you put them there. Back them up
separately, or treat them as replaceable: the registry can repair a missing shard from
any `k` survivors when a spare holder is configured. A backup of `.data/` alone restores
the map, not the bytes.

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

Snapshot version 1 is current; there are no migrations yet. Adding one means adding an
entry to `snapshotMigrations` in `apps/api/src/migrations.ts` with `from`, `to`
(`from + 1`), a description, and a pure function from the old snapshot to the new one.
An older snapshot without a full chain to the current version is refused.

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
