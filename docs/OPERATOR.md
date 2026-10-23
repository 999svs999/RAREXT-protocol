# Operator guide: storage network

This guide is for someone who wants to run the storage pieces rather than read the
design. It covers the local demo, a persistent multi-holder set, the API, the pin
service, a client, and the things that will bite you.

Status: holders, placement, challenge/audit, repair, GC, quotas, rate limits, token
rotation, and the sealed client path are implemented and tested on loopback. There is
no built-in TLS, no managed key service, no multi-writer coordination, and no
production-scale (100 GiB) run. Read [`STORAGE-SECURITY.md`](STORAGE-SECURITY.md) and
[`HARDENING.md`](HARDENING.md) before exposing anything.

## Prerequisites

- Node 22.18 or newer (the repo is tested on Node 24; it loads `.ts` directly).
- `npm install` in the repository root.
- Disk for each holder directory and for the API's `.data` directory.
- Ports are loopback by default. Holders bind `127.0.0.1:9600` unless configured.

## One command: `npm run net`

This starts three holders and a pin service on ephemeral loopback ports, stores a
64 KiB payload at `k=2, m=1`, challenges it, kills one holder, repairs onto a spare,
verifies the bytes, then removes the temporary directory:

```bash
npm run net
```

Real output from this checkout (ports and blob hash vary per run):

```
[RAREXT Net] Starting storage network in /var/folders/.../rarext-net-4LyQJQ...
[RAREXT Net] Holder 0 listening on http://127.0.0.1:52558
[RAREXT Net] Holder 1 listening on http://127.0.0.1:52559
[RAREXT Net] Holder 2 listening on http://127.0.0.1:52560
[RAREXT Net] Pin service listening on http://127.0.0.1:52561
[RAREXT Net] Storing 64 KiB test payload across holders (k=2, m=1)...
[RAREXT Net] Placed blob cbe46b56e9830971e82c50ee0efb732645f5463b3486f60574ea068380bcd460 across 3 shards.
[RAREXT Net] Running challenge and audit...
[RAREXT Net] Audit status: ok (live: 3/3)
[RAREXT Net] Simulating failure: shutting down Holder 1...
[RAREXT Net] Audit status after failure: under-replicated
[RAREXT Net] Provisioning spare Holder 3 and triggering repair...
[RAREXT Net] Repair complete. Filled 1 shard(s).
[RAREXT Net] Audit status after repair: ok
[RAREXT Net] Retrieving and verifying byte-exact payload reconstruction...
[RAREXT Net] SUCCESS: Decoded payload matches original byte-for-byte!
[RAREXT Net] Network stopped and cleaned up.
```

If you see `SUCCESS` and `Network stopped and cleaned up`, the code path works on your
machine. The demo is ephemeral; for a network that survives a terminal, use the
commands below.

## Run a persistent network

### 1. Three holders

Each holder needs a distinct id, port, and directory. They can share one token. Run
these in three terminals:

```bash
RAREXT_HOLDER_ID=holder-0 \
RAREXT_HOLDER_DIR=.data/holder-0 \
RAREXT_HOLDER_PORT=9600 \
RAREXT_HOLDER_TOKEN='replace-this-token' \
npm run holder
```

```bash
RAREXT_HOLDER_ID=holder-1 \
RAREXT_HOLDER_DIR=.data/holder-1 \
RAREXT_HOLDER_PORT=9601 \
RAREXT_HOLDER_TOKEN='replace-this-token' \
npm run holder
```

```bash
RAREXT_HOLDER_ID=holder-2 \
RAREXT_HOLDER_DIR=.data/holder-2 \
RAREXT_HOLDER_PORT=9602 \
RAREXT_HOLDER_TOKEN='replace-this-token' \
npm run holder
```

Optional holder limits:

| Variable | Meaning |
| --- | --- |
| `RAREXT_HOLDER_HOST` | Bind address, default `127.0.0.1`. |
| `RAREXT_HOLDER_TOKEN` | Bearer token, comma-separated for rotation. Required off loopback. |
| `RAREXT_HOLDER_MAX_BYTES` | Total stored bytes; over quota returns `507`. |
| `RAREXT_HOLDER_MAX_REQUESTS` | Requests per 60 s window; over limit returns `429`. |

A holder refuses to bind a non-loopback address without a token. That check is not a
substitute for TLS: bearer tokens over plain HTTP are visible to anyone on the path.

Check a holder (the token must match):

```bash
curl -s http://127.0.0.1:9600/v1/holder \
  -H "authorization: Bearer replace-this-token"
```

It returns the holder id, shard count, and stored bytes. Without a token it returns
`401 {"error":"unauthorized"}`.

### 2. API

The API is the placement registry and the client-facing surface. Point it at the same
holder ids and URLs, and give it the holder token so it can challenge and repair:

```bash
RAREXT_HOLDERS='holder-0=http://127.0.0.1:9600,holder-1=http://127.0.0.1:9601,holder-2=http://127.0.0.1:9602' \
RAREXT_HOLDER_TOKEN='replace-this-token' \
RAREXT_DATA=.data/rarext.json \
RAREXT_PLACEMENTS_DIR=.data/placements \
RAREXT_BLOB_DIR=.data/blobs \
npm run dev:api
```

`RAREXT_STORAGE_HOLDERS` is accepted as an alias for `RAREXT_HOLDERS`. The API listens
on `127.0.0.1:8787` by default (`PORT`, `HOST`). With holders configured it starts the
retention scheduler every 6 hours (`RAREXT_CHALLENGE_INTERVAL_MS`) and repairs
under-replicated placements automatically. It prints
`retention challenges every 21600s across 3 holder(s)` when that happens.

Signed placement records live in `RAREXT_PLACEMENTS_DIR`. On boot the API adopts them,
so restarts do not lose the referenced-shard set. Back that directory up with the
holder directories; shard files alone do not carry `k`, `m`, indices, or the original
digest.

### 3. Pin service (optional)

```bash
RAREXT_PIN_DIR=.data/pins \
RAREXT_PIN_PORT=9700 \
RAREXT_PIN_TOKEN='replace-this-pin-token' \
npm run pin
```

It binds `127.0.0.1:9700` and verifies that claimed CIDs match the bytes before
storing them. `GET /health` is unauthenticated; the rest needs the bearer token.

### 4. A client

Point the MCP server at the API, holders, and tokens:

```bash
RAREXT_API=http://127.0.0.1:8787 \
RAREXT_STORAGE_HOLDERS='holder-0=http://127.0.0.1:9600,holder-1=http://127.0.0.1:9601,holder-2=http://127.0.0.1:9602' \
RAREXT_HOLDER_TOKEN='replace-this-token' \
RAREXT_PIN_URL='http://127.0.0.1:9700/v1/pins' \
RAREXT_PIN_TOKEN='replace-this-pin-token' \
RAREXT_AGENT_KEY=~/.rarext/agent-key.json \
npm run dev:mcp
```

The storage tools are `rarext_storage_put`, `rarext_storage_get`,
`rarext_storage_challenge`, `rarext_storage_audit`, and `rarext_storage_pin`. A put
signs the placement with the agent key and registers it with the API; a get reads the
shards and digest-checks them.

For a one-shot local proof of the same path, run `npm run example:mcp-storage` or
`npm run example:sealed-storage`. Both create their own temporary holders and clean up.

Sealed puts encrypt client-side before encoding. Set `RAREXT_SEALED_SECRET` to at least
16 characters; without it, a `sealed:true` put fails rather than silently storing
plaintext. Losing that secret loses the data: there is no key wrapping, rotation, or
recovery path yet.

## Day-two operations

### Audit and repair

```bash
curl -s http://127.0.0.1:8787/v1/durability
curl -s -X POST http://127.0.0.1:8787/v1/durability/challenge \
  -H 'content-type: application/json' -d '{}'
```

`/v1/durability` lists placements with their last audit. A challenge asks each holder
for a fresh Merkle proof; a holder that cannot answer is marked unreachable, and the
scheduler's repair path fills missing shards from survivors. Repair costs
`1 + m/k` times the shard bytes; `4+2` is `1.5x`.

### Garbage collection

Orphaned shards are deleted in two phases, with a default 24-hour grace period:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/durability/gc \
  -H 'content-type: application/json' \
  -d '{"dryRun":true}'
```

Review `wouldDelete` first. Then run the same call with `"dryRun":false`. A first scan
records candidates; a later scan deletes only candidates older than the grace period.
`"gracePeriodMs":0` deletes on the first scan and is meant for tests.

GC asks *this API's* placement registry which shards are referenced. If you run several
APIs against one holder set, each with its own placement directory, one API's GC will
see the others' shards as unreferenced. Keep the grace period, or run GC from the API
that owns the records. Holder-side rollback: `POST /v1/holder/gc/reset` clears the
candidate file.

### Tokens and quotas

Tokens are shared bearer secrets, not identities. Rotate by listing old and new values
(comma-separated) on the holder and client; remove the old value once clients have
switched. Quotas are byte caps (`507` when exceeded) and request-rate caps (`429`).
Neither is a billing system, and neither survives a process restart if the shard
directory is wiped.

### Health checks

- Holder: `GET /v1/holder` with the bearer token.
- Pin service: `GET /health`.
- API: `GET /v1/durability` (empty list is fine) and `GET /v1/storage/usage`.
- Audit state: `GET /v1/durability`; `under-replicated` means repair has not succeeded
  or the scheduler has not run since the failure.

## What is not done

- **TLS.** Terminate it in a reverse proxy; do not expose holders or the API directly.
- **Key management for the sealed tier.** `RAREXT_SEALED_SECRET` is a raw secret with
  no wrapping, rotation, per-tenant isolation, or AAD binding; the envelope is
  unreviewed. Treat sealed storage as a prototype.
- **A chunked holder wire format.** Holders accept whole shards as JSON. Large files
  can be encoded with `erasure-stream.ts` (peak RSS about 395 MiB at 1 GiB), but those
  streamed shard files are not placeable over HTTP yet. The MCP put path caps input at
  `RAREXT_STORAGE_MAX_BYTES` (8 MiB default, 32 MiB hard cap).
- **`fsync`/power-loss durability.** Writes are temp-and-rename atomic against a
  process crash, not a power cut.
- **Bad-holder quarantine and writer identity.** A token authorizes traffic, not a
  person. There is no automatic ban list, and no proof that a writer owned the bytes.
- **Scale.** The 1 GiB benchmark is the largest measured placement. Repair and GC are
  per-holder loops with no sharding of the control plane.

If any of those are load-bearing for you, the honest answer is that this is not ready
for that deployment yet.
