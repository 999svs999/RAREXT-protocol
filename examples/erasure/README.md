# Erasure coding example

A 1 MiB file, encoded `4+2`, stored as blobs, one shard deleted, rebuilt from the
remaining five. It uses the shipped `encodeBytes`/`decodeBytes` and `BlobStore`; there
is no example-only codec.

```bash
node --experimental-strip-types examples/erasure/main.ts
```

Node 22.18+ can strip the types; no build step or extra dependency is needed. The
example creates a temporary directory and removes it on exit.

Expected shape:

```
payload: 1,048,576 bytes
encoded with k=4, m=2: 6 shards
  shard 0: 262,144 bytes  sha256=...
  ...
stored shard bytes: 1,572,864 (1.50x the payload, 50% overhead)
deleted shard 2 (...); 5 remain in the store
rebuilt 1,048,576 bytes; digest matches ...
OK: any k of n shards reconstructed the payload after one was deleted.
```

The ratio is the durability cost: six shards of 256 KiB for a 1 MiB payload. It survives
the loss of any one shard; the code tolerates up to `m` lost shards. This example does
not place shards on independent holders or challenge them over time — those are in
[`docs/STORAGE-ECONOMY.md`](../../docs/STORAGE-ECONOMY.md) and
[RFC 0005](../../rfcs/0005-durable-placements.md).
