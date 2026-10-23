# Storage security model

This page states what the storage stack defends against, which checks are enforced in
code, and what remains open. It is the security companion to
[`HARDENING.md`](HARDENING.md), which records failure recovery, and
[`STORAGE-ECONOMY.md`](STORAGE-ECONOMY.md), which states the storage contract.

The short version: challenges are bound to the request, HTTP peers are bounded and
hash-checked, the pin store is tamper-evident, and signed placements are validated
before they are adopted. Payloads are **not encrypted by default**, and the unreviewed
sealed-tier encryptor still derives its key with PBKDF2 where RFC 0015 specifies HKDF,
so confidentiality is **not claimed**. Challenges prove possession rather than
retrievability, and bearer tokens are shared secrets rather than identities.

## Threat model

In scope:

- a holder that returns the wrong shard, rewrites a response, replays an old challenge
  answer, or claims a shard it does not have;
- a network peer that sends a malformed or oversized HTTP response;
- a caller that submits a malformed, co-located, or impossible signed placement;
- local pin metadata or content that was modified outside the service;
- an unauthenticated network client reaching a holder or pin service that was exposed
  without a token.

Out of scope, and not claimed:

- a host or disk attacker with root/read access to the payload or key material;
- traffic analysis, including shard size and request timing;
- a holder that keeps the Merkle leaves and discards the bytes (see issue
  [#7](https://github.com/999svs999/RAREXT-protocol/issues/7));
- a reporter or verifier that lies about its own audit (see issue
  [#9](https://github.com/999svs999/RAREXT-protocol/issues/9));
- confidentiality of stored bytes. The sealed-tier module is not wired into the put
  path and its key envelope is unreviewed; see [RFC 0015](../rfcs/0015-sealed-tier-encryption.md)
  and issue [#6](https://github.com/999svs999/RAREXT-protocol/issues/6).

## Controls enforced in code

### Challenge binding and proof checks

`respondToChallenge` answers with the requested `index`, the bound `nonce`, the leaf,
and a Merkle proof. `verifyChallengeResponse` checks all of the following before it
hashes a proof:

- the response shape, a nonce of 1–`MAX_CHALLENGE_NONCE` characters, and 64-hex leaf,
  digest, and proof elements;
- `digest === nonceBinding(nonce, leaf)`;
- the proof length is exactly `ceil(log2(max(1, leaves)))`, one sibling per level;
- when a request is supplied, `response.index === request.leafIndex` and
  `response.nonce === request.nonce`, so a replay or a correct proof for another leaf
  fails.

The ledger records a failed response as a miss and does not mark the shard live. The
verification is possession: it does not prove the bytes are still retrievable.

### HTTP holders

`httpHolder` sends an optional bearer token, uses a request timeout (15 s by default),
caps JSON responses (4 KiB for `put`, 256 KiB for challenges, 48 MiB for shard bytes),
rejects a `storedAs` that is not a 64-hex digest, and re-hashes every shard returned by
`get` before accepting it. A lying holder cannot substitute different bytes for the
name the placement recorded.

`createHolderServer` compares the bearer token in constant time, caps the declared and
streamed request body, bounds the challenge nonce, validates the leaf index, and keeps a
bounded leaf cache. The CLI refuses to bind a non-loopback host without
`RAREXT_HOLDER_TOKEN`; that fail-closed check is not a substitute for TLS.

### Signed placements

`verifyPlacement` still checks the signature and streak. In addition, a placement is
rejected when:

- a shard holder is repeated (co-location across shard indices);
- the shard count exceeds 255, or the shard size exceeds 4 GiB;
- the leaf count does not match the shard size and the 4 KiB chunk size, or the payload
  length is inconsistent with the shard sizes;
- a shard object is malformed, the required count is impossible, or the tier/code
  combination cannot meet `required`;
- the blob hash, indices, digests, roots, or stored names are malformed.

These checks are intentionally strict: a signature proves who signed a claim, not that
the claim is physically possible.

### Pin service

`PinStore` recomputes the CID from the bytes on write and on every read, checks that
metadata names the same CID and byte length, validates the root/publication-id bounds,
and writes metadata through a temp file and rename. A modified content or metadata file
is reported as an error instead of being served. `createPinServer` can require a bearer
token and rejects oversized bodies before parsing.

### DAS and transport caps

`httpLeafReader` and the sampler cap response bytes, proof shape, and chunk coordinates,
so a malicious leaf server cannot force unbounded allocation or hashing. The DAS proof
still assumes the placement root is the one the client intended.

## Tokens and deployment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `RAREXT_HOLDER_TOKEN` | holder server, `httpHolder`, API holder set, MCP storage | Shared bearer secret for holder requests. |
| `RAREXT_PIN_TOKEN` | pin server, content adapter, MCP pin | Shared bearer secret for the pin service. |
| `RAREXT_STORAGE_HOLDERS` | MCP storage | `id=url` pairs; falls back to `RAREXT_HOLDERS`. |
| `RAREXT_PIN_URL` | API content adapter, MCP pin | Base URL or full `/v1/pins` endpoint. |

A token is authorization between processes that already trust each other; it is not a
user identity, a capability, or a signature. It is sent over plain HTTP unless a
reverse proxy terminates TLS. The reference pin server binds `127.0.0.1` only, and the
holder CLI refuses a non-loopback bind without a token. To rotate, restart the server
with the new token and update every client; there is no overlap window or key id.

Do not put tokens in command lines or commit them. Use the environment or a process
manager's secret file.

## Sealed tier encryption status

`apps/api/src/sealed-encryption.ts` provides AES-256-GCM encryption with a 12-byte IV,
a 16-byte authentication tag, and a 32-byte key derived with **HKDF-SHA256** from a
16-byte per-payload salt, matching [RFC 0015](../rfcs/0015-sealed-tier-encryption.md).

The real path is wired: `rarext_storage_put` with `sealed:true` encrypts with
`RAREXT_SEALED_SECRET` before erasure coding, records the salt/IV/tag in the signed
placement, and the shard digests and Merkle roots cover ciphertext. `rarext_storage_get`
decrypts after reconstruction. `apps/api/test/sealed-path.test.ts` and
`examples/sealed-storage` exercise it; `POST /v1/blobs` rejects `tier:"sealed"` instead
of mislabelling plaintext.

It is still not a production confidentiality claim: there is no wrapping-key format,
key rotation, per-tenant isolation, or associated-data binding to the placement
identity, and the envelope has not been independently reviewed. Losing
`RAREXT_SEALED_SECRET` loses the data; leaking it loses confidentiality. Do not upload
real secrets or describe the tier as audited until those gaps are closed.

## Open findings

| Finding | Issue |
| --- | --- |
| Sealed encryption is wired with HKDF-SHA256 and committed to ciphertext, but has no key wrapping, rotation, per-tenant isolation, or envelope review. | [#6](https://github.com/999svs999/RAREXT-protocol/issues/6) |
| A challenge proves possession, not retrievability; leaf-only storage can pass. | Addressed in [RFC 0013](../rfcs/0013-proof-of-retrievability.md) |
| No quotas, rate limits, TLS, rotation window, or real writer identity; permissionless placement can squat holders. | [#8](https://github.com/999svs999/RAREXT-protocol/issues/8) |
| A verifier or agent can report its own `ok` without an independently checkable transcript. | [#9](https://github.com/999svs999/RAREXT-protocol/issues/9) |
| Crash, failed repair, and abandoned puts leave unreferenced shards with no GC. | [#10](https://github.com/999svs999/RAREXT-protocol/issues/10) |

Also unchanged from [`HARDENING.md`](HARDENING.md): no `fsync`/power-loss guarantee, no
automatic bad-holder quarantine, and witnesses reset on restart. `encodeBytes` still
holds a whole payload in memory (the MCP put path caps it at 8 MiB); the file-backed
`erasure-stream.ts` path bounds peak RSS by chunk size, but the holder wire format is
still whole-shard JSON.

## Verification

```bash
npx tsc --noEmit
node --test --test-reporter=tap apps/api/test/security-storage.test.ts
node --test --test-reporter=tap apps/api/test/storage-hardening.test.ts
node --test --test-reporter=tap apps/api/test/sealed-storage.test.ts
node --test --test-reporter=tap apps/api/test/sealed-path.test.ts
node --test --test-reporter=tap apps/api/test/storage-properties.test.ts
```

The security tests cover replay and wrong-leaf answers, a lying HTTP holder, holder
token enforcement, the nonce cap, pin tampering and token enforcement, metadata bounds,
and malformed placement claims. Passing them is evidence for the controls above, not a
claim that the open findings are closed.
