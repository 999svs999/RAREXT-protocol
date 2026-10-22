# RFC 0011: A pinning service for the content adapter

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Depends on:** RFC 0006 (content addressing), RFC 0005 (durable placements)
- **Implementation:** `apps/api/src/pin-server.ts`, `apps/api/test/pinning.test.ts`

## Summary

The content adapter already computes a CIDv1 locally and, when `RAREXT_PIN_URL` is set,
hands it to an external service. It did not ship a service to hand it to. This RFC adds
a small self-hosted pinning service that accepts the bundle, verifies the CID, stores
the bytes, and serves them back.

The service is deliberately boring: a directory, an HTTP API, no daemon, no IPFS
dependency. It is the reference implementation of the contract the adapter already
speaks.

## Contract

`POST /v1/pins` with:

```json
{
  "cid": "bafk...",
  "content": "<base64 bundle bytes>",
  "root": "<optional anchor root>",
  "publicationIds": ["pub-1"]
}
```

The service decodes the content, recomputes `cidV1Raw(content)`, and rejects the request
with `400` unless it equals `cid`. That check is the whole trust model: a pin is the
bytes named by their own digest. A valid pin returns `201`:

```json
{
  "cid": "bafk...",
  "bytes": 52,
  "root": "...",
  "publicationIds": ["pub-1"],
  "pinnedAt": "2026-10-23T00:00:00.000Z",
  "reference": "pin:bafk..."
}
```

- `PUT` is not used; posting the same CID again is idempotent and returns the existing
  record.
- `GET /v1/pins` lists records, newest first.
- `GET /v1/pins/:cid` returns the record plus base64 content.
- `DELETE /v1/pins/:cid` unpins and returns `204`; a missing pin is `404`.
- `GET /health` returns `{ "ok": true, "pins": n }`.

The adapter sends the exact bytes it hashed, so no third party has to trust a CID it
cannot verify. It ignores fields it does not know, which keeps the contract usable by a
larger pinning service.

## Storage

Pins live under `RAREXT_PIN_DIR` (default `.data/pins`):

- `<cid>.bin` — the raw bundle bytes;
- `<cid>.json` — CID, byte length, optional root and publication IDs, and `pinnedAt`.

Writes are temp-file-and-rename, so a crash does not leave a half-written pin under a
valid name. Content is capped at 32 MiB, enough for a registry bundle; this is not a
media store. A pin is removed only by `DELETE`; there is no automatic expiry in this
version.

## Running it

```bash
RAREXT_PIN_DIR=.data/pins RAREXT_PIN_PORT=9700 npm run pin
RAREXT_PIN_URL=http://127.0.0.1:9700/v1/pins npm run dev:api
```

The service binds `127.0.0.1` by default. Put it behind the operator's normal reverse
proxy and authentication if it is exposed; it has no auth of its own because it is
meant to run beside the registry on a trusted host.

## What this proves

- The pinned bytes have the claimed CID.
- The service accepted and retained those bytes at a point in time.
- A reader can fetch the bundle by its content address.

It does **not** prove that the bytes are still readable later, that another host has a
copy, or that the anchor root is valid. Retention is measured by the holder/repair
system; anchoring is measured by the chain read-back. A pin is one replica, not
permanence.

## Tests

Five tests cover persistence across restart, CID mismatch and path-like CID rejection,
the full HTTP pin/read/list/unpin flow, adapter-to-service round-trip, and rejection of
bytes that do not match the claimed CID.

## Non-goals

- No IPFS or Arweave client; this is a local reference service.
- No garbage collection or quota enforcement beyond the per-pin size cap.
- No authentication, TLS, or multi-tenant isolation.
- No claim that a pin makes a bundle permanent.
