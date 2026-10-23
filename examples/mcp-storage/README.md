# MCP storage example

Runs a real MCP stdio server against a local `4+2` holder set, an API, and a pin
service, then calls the storage tools the way an agent would:

1. `rarext_storage_put` erasure-codes the payload, writes six shards to six
   token-protected holders, signs the placement with the local agent key, and registers
   the signed record with the API.
2. `rarext_storage_get` reads and digest-checks the shards, reconstructs the payload,
   and returns it as base64.
3. `rarext_storage_challenge` sends a fresh leaf index and nonce to every holder and
   verifies the Merkle proof.
4. `rarext_storage_audit` reads the witness state left by that challenge.
5. `rarext_storage_pin` computes the CID of the bytes and stores them in the pin
   service.

```bash
node --experimental-strip-types examples/mcp-storage/main.ts
```

No build step and no external service is required; everything binds `127.0.0.1` on an
ephemeral port and is removed on exit. The holder and pin tokens are example constants,
not secrets. The agent key exists only in the temporary directory.

Expected shape:

```
payload: ... bytes, code 4+2, 6 token-protected holders
put: <blobHash>
  shard 0: holder-0 ...
  ...
get: 4 shards read, 0 errors, bytes match
challenge: 6/6 live, 6 required
audit: ok (challenged=true)
pin: pin:<cid>
OK: an MCP client stored, read, challenged, audited, and pinned content.
```

## Configuration for a real agent

```bash
RAREXT_API=http://127.0.0.1:8787 \
RAREXT_STORAGE_HOLDERS='holder-a=http://127.0.0.1:9600,holder-b=http://127.0.0.1:9601,holder-c=http://127.0.0.1:9602' \
RAREXT_HOLDER_TOKEN='...' \
RAREXT_PIN_URL='http://127.0.0.1:9700/v1/pins' \
RAREXT_PIN_TOKEN='...' \
npx rarext-mcp
```

`RAREXT_STORAGE_HOLDERS` falls back to `RAREXT_HOLDERS`; each entry is `id=url`. The
holder count must cover the requested `k+m`. The tokens are shared bearer secrets, not
identities, and plain HTTP exposes them: terminate TLS before exposing a holder or pin
service. See [`docs/STORAGE-SECURITY.md`](../../docs/STORAGE-SECURITY.md).

`rarext_storage_put` reads base64 from the tool call and caps decoded content at
`RAREXT_STORAGE_MAX_BYTES` (default 8 MiB, hard cap 32 MiB). This path still holds the
payload in memory. A file-backed streaming codec exists in
`apps/api/src/erasure-stream.ts` and is measured in
[`bench/storage/RESULTS.md`](../../bench/storage/RESULTS.md), but the MCP path does not
use it and the holder wire format is still whole-shard JSON.
