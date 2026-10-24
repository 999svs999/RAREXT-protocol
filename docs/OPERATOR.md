# Operator guide: storage network

This guide is for someone who wants to run the storage pieces rather than read the
design. It covers the local demo, a persistent multi-holder set, the API, the pin
service, a client, and the things that will bite you.

Status: holders, placement, challenge/audit, repair, GC, quotas, rate limits, token
rotation, and the sealed client path are implemented and tested on loopback and a
non-loopback interface. There is no built-in TLS, no managed key service, no multi-writer
coordination, and no production-scale (100 GiB) run. Read [`STORAGE-SECURITY.md`](STORAGE-SECURITY.md) and
[`HARDENING.md`](HARDENING.md) before exposing anything.

## Prerequisites

- Node 22.18 or newer (the repo is tested on Node 24; it loads `.ts` directly).
- `npm install` in the repository root.
- Disk for each holder directory and for the API's `.data` directory.
- Ports are loopback by default. Holders bind `127.0.0.1:9600` unless configured.

## One command: `npm run net`

This runs three scenarios against holders and a pin service on ephemeral loopback
ports. The open scenario stores a 64 KiB payload at `k=2, m=1`. The sealed scenario
encrypts before erasure coding (AES-256-GCM, HKDF-SHA256), scans every holder directory
for a plaintext marker, kills one holder, repairs onto a spare, and decrypts the
retrieved bytes back to the original. The streamed scenario writes 8 MiB into chunked
shard files over raw HTTP, registers a signed streamed placement, reloads it from a
fresh registry, audits, kills, repairs, re-audits, and retrieves any k shards exactly.
Each scenario removes its temporary directory:

```bash
npm run net
```

Real output from this checkout (ports and blob hash vary per run):

```
[RAREXT Net] Open scenario in /var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/rarext-net-ZCOgXz...
[RAREXT Net] Holder 0 listening on http://127.0.0.1:55800
[RAREXT Net] Holder 1 listening on http://127.0.0.1:55801
[RAREXT Net] Holder 2 listening on http://127.0.0.1:55802
[RAREXT Net] Pin service listening on http://127.0.0.1:55803
[RAREXT Net] Storing 64 KiB test payload across holders (k=2, m=1)...
[RAREXT Net] Placed blob 2456fe62d126b7d441917251e19a6c0922c3a7152e216879ebc8d33a15161ffa across 3 shards.
[RAREXT Net] Running challenge and audit...
[RAREXT Net] Audit status: ok (live: 3/3)
[RAREXT Net] Simulating failure: shutting down Holder 1...
[RAREXT Net] Audit status after failure: under-replicated
[RAREXT Net] Provisioning spare Holder 3 and triggering repair...
[RAREXT Net] Repair complete. Filled 1 shard(s).
[RAREXT Net] Audit status after repair: ok
[RAREXT Net] Retrieving and verifying byte-exact payload reconstruction...
[RAREXT Net] SUCCESS: Decoded payload matches original byte-for-byte!
[RAREXT Net] Open scenario stopped and cleaned up.
[RAREXT Net] Sealed scenario in /var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/rarext-net-sealed-l360jk...
[RAREXT Net] Holder 0 listening on http://127.0.0.1:55816
[RAREXT Net] Holder 1 listening on http://127.0.0.1:55817
[RAREXT Net] Holder 2 listening on http://127.0.0.1:55818
[RAREXT Net] Pin service listening on http://127.0.0.1:55819
[RAREXT Net] Encrypted 65536 plaintext bytes to 65536 ciphertext bytes (aes-256-gcm, hkdf-sha256) before erasure coding.
[RAREXT Net] Placed blob 2ce02543f9acd1c53c31e1fccefa83fe9bf53509e405a970a37b70a730dc0044 across 3 shards.
[RAREXT Net] holder-0 directory: 1 shard file(s), 32768 bytes, 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] holder-1 directory: 1 shard file(s), 32768 bytes, 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] holder-2 directory: 1 shard file(s), 32768 bytes, 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] Running challenge and audit...
[RAREXT Net] Audit status: ok (live: 3/3)
[RAREXT Net] Simulating failure: shutting down Holder 1...
[RAREXT Net] Audit status after failure: under-replicated
[RAREXT Net] Provisioning spare Holder 3 and triggering repair...
[RAREXT Net] Repair complete. Filled 1 shard(s).
[RAREXT Net] holder-3 directory after repair: 1 shard file(s), 0 plaintext-marker hits, 0 hash mismatches
[RAREXT Net] Audit status after repair: ok
[RAREXT Net] Retrieving and verifying byte-exact payload reconstruction...
[RAREXT Net] SUCCESS: decrypted 65536 bytes match the original plaintext byte-for-byte!
[RAREXT Net] Sealed scenario stopped and cleaned up.
[RAREXT Net] Streamed scenario in /var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/rarext-net-streamed-FA0u1t...
[RAREXT Net] holder-0 listening on http://127.0.0.1:55831
[RAREXT Net] holder-1 listening on http://127.0.0.1:55832
[RAREXT Net] holder-2 listening on http://127.0.0.1:55833
[RAREXT Net] Encoded 8388608 bytes into 3 shard files of 4194304 bytes each (8 chunk(s), 2+1).
[RAREXT Net] Signed streamed placement registered: status 201, sequence 0, verified=true.
[RAREXT Net] Reloaded the signed placement from a fresh registry and ledger.
[RAREXT Net] Running challenge and audit...
[RAREXT Net] Audit status: ok (live: 3/3)
[RAREXT Net] Simulating failure: shutting down Holder 1...
[RAREXT Net] Audit status after failure: under-replicated
[RAREXT Net] Provisioning spare Holder 3 and repairing the streamed shard...
[RAREXT Net] Streamed repair filled 1 shard(s), read 8388608 bytes, wrote 4194304 bytes.
[RAREXT Net] Audit status after repair: ok
[RAREXT Net] Retrieving any k streamed shards over raw HTTP...
[RAREXT Net] SUCCESS: 2 streamed shards reconstructed 8388608 bytes byte-for-byte.
[RAREXT Net] Streamed scenario stopped and cleaned up.
```

If you see all three `SUCCESS` lines and all three cleanup lines, the open, sealed, and
streamed paths work on your machine, no holder directory contained the plaintext marker,
and the signed streamed placement survived a fresh registry load plus a holder loss. The
demo is ephemeral; for a network that survives a terminal, use the commands below.

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

### Run a holder on another machine

A holder is an HTTP process; it does not have to be on the same host as the API or the
MCP client. On the holder host, bind an address that host can reach and require a token:

```bash
RAREXT_HOLDER_ID=alice-1 \
RAREXT_HOLDER_DIR=/var/lib/rarext/holder-1 \
RAREXT_HOLDER_HOST=0.0.0.0 \
RAREXT_HOLDER_PORT=9600 \
RAREXT_HOLDER_TOKEN='replace-this-token' \
npm run holder
```

`0.0.0.0` listens on every interface. To limit exposure, set `RAREXT_HOLDER_HOST` to the
specific LAN or VPN address instead. Allow only the API/client networks through the
firewall and terminate TLS in a reverse proxy; the bearer token is sent on every request
and is visible without TLS. The holder refuses a non-loopback bind without a token, but
that check is not encryption or authentication of the operator.

From the API or MCP client, use the holder's reachable address in the same id=url list:

```bash
RAREXT_HOLDERS='alice-1=http://192.0.2.10:9600' \
RAREXT_HOLDER_TOKEN='replace-this-token' \
npm run dev:api
```

The holder id must match the id the client uses. A placement is a signed map from shard
index to holder id and `storedAs`; changing the id later makes the shard unreachable
through the old placement. For an agent on another machine, use the same URL and token
in `RAREXT_STORAGE_HOLDERS` when starting the MCP server.

Check reachability from the client host before placing anything:

```bash
curl -s http://192.0.2.10:9600/v1/holder \
  -H 'authorization: Bearer replace-this-token'
```

The cross-interface test is `node --test apps/api/test/non-loopback-holder.test.ts`; it
binds child holders to a discovered non-loopback IPv4 address, places a shard on one,
challenges and audits it, then reconstructs the payload. It skips when the host has no
non-loopback IPv4 interface.

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

#### Public exposure and write limits

The defaults are loopback and unmetered. Before binding to a public interface, set a
token, a request limit, a disk quota, and TLS (either here or at a reverse proxy):

| Env | Default | Effect |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Bind address and port. |
| `RAREXT_API_TOKEN` | unset | Comma-separated bearer tokens for rotation. When set, every non-read request needs `Authorization: Bearer <token>`; reads stay open. |
| `RAREXT_API_MAX_REQUESTS` | `0` (off) | Requests per 60s window; over the limit returns `429`. The counter is per process, not per client IP. |
| `RAREXT_BLOB_QUOTA_BYTES` | unset | Total node blob bytes; a write that would cross it returns `507`. `GET /v1/storage/quota` reports the limit and used bytes. |
| `RAREXT_TLS_CERT`, `RAREXT_TLS_KEY` | unset | Serve HTTPS directly. Set both or neither. A reverse proxy is fine instead; the process then stays on loopback. |
| `RAREXT_GC_DRY_RUN` | `true` | Collection only records candidates until set to `false`; see [garbage collection](#garbage-collection). |

A GC request that would delete (`dryRun:false`), and a holder shard `DELETE`, are
refused with `403` when they arrive from a non-loopback address and no token is
configured. With a token configured, the token is required for the destructive pass as
well. This keeps an unauthenticated public node from being wiped through its own GC
endpoint; set `RAREXT_API_TOKEN` before exposing the API. A reverse proxy makes every
request look loopback, so terminate auth at the proxy or set the API token as well.

The token is a shared secret, not an identity: it decides whether a caller may write,
not who they are. Writers are identified by the signing key on a placement or
publication, and that is what the registry verifies. Rotate by listing old and new
tokens, then remove the old one once clients have switched. The API token does not
replace holder and pin tokens; those protect the storage processes separately.

The per-blob cap (`32 MiB`) still applies on top of the total quota. A quota refusal is
reported before any bytes are written, and re-uploading identical content does not
count twice because blobs are content-addressed.

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

### 5. An external agent

An agent on another machine needs three things: the API base URL, a write token if the
node sets one, and its own signing key. It does not need a copy of this repository's
server code; `RarextClient` is the HTTP boundary.

```bash
RAREXT_API=https://registry.example RAREXT_API_TOKEN='replace-this-token' npm run example:external-agent
```

Without `RAREXT_API` the same script starts a temporary local node and cleans up. The
agent registers its handle, publishes a signed build, asks the node to verify the
signature, and reads the publication back from the feed. `apps/api/test/external-agent.test.ts`
runs this path against a node with a write token, without the token (reads only), and
with two agents at once. See [`examples/external-agent`](examples/external-agent).

The agent key is the agent's identity. Keep it on the agent, never send it to the node,
and rotate it through `/v1/identities/:handle/rotate` rather than overwriting the file.
The API token is only an admission control; it is not the agent's identity.

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

The API and the pinning service collect on a timer (`RAREXT_GC_INTERVAL_MS` and
`RAREXT_PIN_GC_INTERVAL_MS`, both 24h, `0` disables). Both default to a dry run, so
the first scheduled pass records candidates and does not delete; set
`RAREXT_GC_DRY_RUN=false` / `RAREXT_PIN_GC_DRY_RUN=false` once the candidate list
looks right. The API computes its own reference set from publications and
placements. See
[`OPERATIONS.md`](OPERATIONS.md#automatic-garbage-collection) for the grace period
and the single-node caveat.

Orphaned shards can also be collected on demand, in two phases, with a default
24-hour grace period:

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

- **TLS.** The API can serve HTTPS directly (`RAREXT_TLS_CERT`/`RAREXT_TLS_KEY`), but a
  reverse proxy is still the recommended edge. Holders and the pin service remain
  HTTP-only, so keep them on a private network or front them too.
- **Key management for the sealed tier.** `RAREXT_SEALED_SECRET` is a raw secret with
  no wrapping, rotation, per-tenant isolation, or AAD binding; the envelope is
  unreviewed. Treat sealed storage as a prototype.
- **Large file input at the MCP boundary.** Holders accept raw file upload/download,
  `placeStreamed`/`retrieveStreamed` move a 1 GiB blob with a flat client peak (about
  242 MiB on the reference laptop), and streamed repair rebuilds one shard at a time
  from k survivors. The MCP put path still caps input at `RAREXT_STORAGE_MAX_BYTES`
  (8 MiB default, 32 MiB hard cap); use the HTTP/raw path for large files.
- **`fsync`/power-loss durability.** Writes are temp-and-rename atomic against a
  process crash, not a power cut.
- **Bad-holder quarantine and writer identity.** A token authorizes traffic, not a
  person. There is no automatic ban list, and no proof that a writer owned the bytes.
  The API token, rate limit, and blob quota bound abuse but do not establish who wrote;
  signed publications and placements establish *what* key signed, not ownership of the
  content.
- **Ledger retention.** `DurabilityLedger` keeps every placement by default. A
  long-lived process that puts new blobs continuously must pass `maxPlacements` or call
  `forget()`; evicted placements and their witnesses can no longer be challenged or
  retrieved through that ledger. `POST /v1/holder/gc/scan` removes their holder shards
  once the grace period passes. The soak uses retention 24 and a zero-grace sweep; the
  production GC default is 24 hours and dry-run.
- **Scale.** 1 GiB is the largest measured network placement, and the 10-minute chaos
  run uses 64 KiB payloads (latest: 5,910 puts at 100%, 145 repairs, 23 kills; the
  earlier 611 s run had 143 repairs at 99.9% puts; see `bench/storage/SOAK.md`). Repair
  and GC are per-holder loops with no sharding of the control plane; streamed repair is
  bounded but not load-tested at 100 GiB. The public summary is
  [`STORAGE.md`](STORAGE.md).

If any of those are load-bearing for you, the honest answer is that this is not ready
for that deployment yet.
