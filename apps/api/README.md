# @rarext/api

Dependency-free HTTP API for circuits, attestations, identities, anchors, and the social feed.

```bash
npm run dev:api
```

Implemented:

- `GET /health`
- `GET /v1/tasks`
- `POST /v1/simulate`
- `POST /v1/score`
- `GET /v1/feed?taskId=&author=&parentId=&limit=&offset=`
- `POST /v1/publications` (`{ author, ... }` or `{ payload, signature }`)
- `GET /v1/publications/:id`
- `GET /v1/profiles`
- `GET /v1/profiles/:handle`
- `POST /v1/identities`
- `GET /v1/identities/:handle`
- `POST /v1/anchors`
- `GET /v1/anchors`
- `GET /v1/anchors/:id`
- `POST /v1/anchors/:id/proof`
- `GET /v1/tapeout/status?address=`
- `POST /v1/verify`

Also serves the built web client from `apps/web/public`.

## Storage

The store persists publications, profiles, identities, and anchors to
`.data/rarext.json` by default. Writes are atomic (temp file + rename).

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `RAREXT_DATA` | `.data/rarext.json` | Store path; `none` disables persistence |
| `TRAC_ANCHOR_URL` | unset | Optional webhook anchor transport for Merkle roots; the native RESET transport is blocked (RFC 0001 §4) |
| `RAREXT_ANCHOR_EVERY` | `0` | Auto-anchor after N pending publications |
| `BSC_RPC_URL` | unset | BSC JSON-RPC endpoint for read-only status |
| `BEM_CONTRACT` | unset | `$BEM` ERC-20 contract for balance reads |

## Signed publications

Register an ECDSA P-256 key with `POST /v1/identities`, sign the canonical JSON
`rarext.publication` v1 payload, and post `{ payload, signature }`. The server verifies
the signature, enforces a 10-minute timestamp window, and rejects reused nonces. Once a
handle is registered, unsigned publications claiming it are rejected. See
[`rfcs/0002-signed-publications.md`](../../rfcs/0002-signed-publications.md).

Anchors batch unanchored publication leaves into a Merkle root. `POST /v1/anchors` creates
a batch; `POST /v1/anchors/:id/proof` returns an inclusion proof. If `TRAC_ANCHOR_URL`
is set, the root is announced to it; otherwise the anchor is marked `local`.

The TapeOut adapter only reads `eth_chainId`, `eth_blockNumber`, and an optional ERC-20
`balanceOf`. It never writes to BSC and does not index component or circuit tokens yet.
