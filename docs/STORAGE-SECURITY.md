# Storage security model

This page states what the storage stack defends against, which checks are enforced in
code, and what remains open. It is the security companion to
[`HARDENING.md`](HARDENING.md), which records failure recovery, and
[`STORAGE-ECONOMY.md`](STORAGE-ECONOMY.md), which states the storage contract.

The short version: challenges are bound to the request, HTTP peers are bounded and
hash-checked, the pin store is tamper-evident, and signed placements are validated
before they are adopted. Payloads are **not encrypted by default**. The opt-in sealed
tier uses HKDF-SHA256 + AES-256-GCM, supports key ids and client-side rotation, and
never gives holders a key, but the envelope is unreviewed and has no key wrapping,
associated-data binding, or per-tenant isolation, so production confidentiality is
**not claimed**. Challenges prove possession rather than retrievability, and bearer
tokens are shared secrets rather than identities.

## Threat model

In scope:

- a holder that returns the wrong shard, rewrites a response, replays an old challenge
  answer, or claims a shard it does not have;
- a network peer that sends a malformed or oversized HTTP response;
- a caller that submits a malformed, co-located, or impossible signed placement;
- a verifier that signs an audit under a key other than the operator key the reader
  expects, omits a holder it never challenged, reuses a challenge nonce, or presents a
  transcript outside the verification window;
- local pin metadata or content that was modified outside the service;
- an unauthenticated network client reaching a holder or pin service that was exposed
  without a token.

Out of scope, and not claimed:

- a host or disk attacker with root/read access to the payload or key material;
- traffic analysis, including shard size and request timing;
- a holder that keeps the Merkle leaves and discards the bytes (see issue
  [#7](https://github.com/999svs999/RAREXT-protocol/issues/7));
- a trusted verifier that lies about when a challenge ran, or replays an old valid
  leaf/proof as a new challenge. The attestation carries a verifier-signed timestamp,
  not a holder-signed timestamp, and there is no public challenge log (see issue
  [#9](https://github.com/999svs999/RAREXT-protocol/issues/9));
- confidentiality of stored bytes against a determined holder or host attacker. The
  opt-in sealed path is wired and holders receive only ciphertext, but its key envelope
  is unreviewed and has no wrapping, associated-data binding, or per-tenant isolation;
  see [RFC 0015](../rfcs/0015-sealed-tier-encryption.md) and issue
  [#6](https://github.com/999svs999/RAREXT-protocol/issues/6).

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

### Independent audit attestations

`signAuditAttestation` signs a canonical placement digest, blob hash, verifier key id,
timestamp, and one transcript entry per holder. `verifyAuditAttestation` checks:

- the signature over the canonical payload and that `verifierKeyId` is derived from
  `verifierPublicKey`; callers that need signer authenticity must also pass an expected
  verifier key id or public key;
- the blob hash and recomputed placement digest, so a transcript cannot be moved to
  another placement;
- exactly one entry for every placement shard, with no unknown or repeated holders;
- unique, non-empty nonces of at most `MAX_CHALLENGE_NONCE` characters, and a fresh
  nonce from `newAuditChallenge` for each concurrent audit;
- an attestation and transcript inside `AUDIT_WINDOW_MS` (15 min by default), with at
  most 5 min of future clock skew;
- `verified: true` plus a fresh `verifyChallengeResponse` result for every entry.

The window rejects an old signed attestation and a challenge entry whose response
window has closed. It does not prove the holder answered at that exact second: the
verifier controls the timestamp, so this is evidence from a trusted operator, not a
trustless timestamp. A reader that omits the expected key verifies integrity and
placement binding but not the operator's identity. The verifier is implemented and
tested, but the default API/MCP audit endpoint still returns witness state and does not
emit these attestations.

### Verifier operator keys

Operator registration is permissionless and self-signed. A rotated key is a new key id
beside the old record; old attestations remain valid while the old key is registered.
Revocation is explicit: the operator posts a self-signed revocation to
`/v1/verifier-operators/:keyId/revocation`, and the registry rejects every attestation
from that key, including ones issued before the revocation. This is a fail-closed
historical invalidation, not a "valid at signing time" model. Revoked ids persist in
`operators.json` and cannot re-register. Rotation alone never rewrites or invalidates
old attestations.

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

### Reconstruction and repair data path

`decodeBytes` refuses fewer than `k` shards, duplicate indices, mixed code
parameters, mixed shard sizes, a shard whose index-bound digest does not verify, and
a reconstructed payload that does not hash to the committed payload digest. The
streamed path (`decodeShardsToFile`) additionally checks every selected shard file
against the signed shard size, SHA-256, and 4 KiB leaf count before it opens the
output. It writes to a unique temporary sibling and renames only after the full
payload hash matches, so a corrupt, truncated, or relabelled shard cannot leave a
partial destination file.

Streamed repair (`reencodeStreamedShard`) checks survivor file sizes before reading,
decodes one chunk at a time, and compares the rebuilt shard's size, SHA-256, leaf
count, and Merkle root with the signed placement before upload. A corrupt survivor
therefore fails either a chunk digest or the rebuilt-shard check; it cannot silently
become a signed shard. A shard copied from another index with a recomputed self-digest
still fails the final payload digest, so byte equality alone is not treated as a
valid replacement. `verifyProof` is bound to the stored root, leaf index, and exact
proof path; a wrong root, wrong index, truncated proof, or reordered siblings returns
`false`, and the challenge path records `bad-proof`.

Limits: the streamed preflight and decode are separate reads, so a file rewritten
between them is caught only by the final payload hash; the temp output is discarded,
but this is not an `fsync`/power-loss guarantee. The preflight reads each selected
shard twice, and a corrupt shard among the first `k` fails closed rather than being
skipped in favour of an extra survivor. Merkle roots are checked on challenges and
on rebuilt shards; streamed decode checks the signed SHA-256 and leaf count, not a
fresh root over every shard. Regression tests are in
`apps/api/test/erasure-storage.test.ts`, `apps/api/test/erasure-stream.test.ts`,
`apps/api/test/persistence.test.ts`, and `apps/api/test/merkle.test.ts`.

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
16-byte per-payload salt. The envelope and signed placement also carry a key id,
matching [RFC 0015](../rfcs/0015-sealed-tier-encryption.md)'s cipher and KDF.

The real path is wired: `rarext_storage_put` with `sealed:true` encrypts before erasure
coding and records `algorithm`, `kdf`, `salt`, `iv`, `authTag`, and `keyId` in the
signed placement; shard digests and Merkle roots cover ciphertext. `rarext_storage_get`
reconstructs and decrypts client-side. Holders receive neither the plaintext nor any
key: rotating the keyring is a client/agent operation, not a holder one.
`POST /v1/blobs` still rejects `tier:"sealed"` instead of mislabelling plaintext.

### Keyring and rotation

`RAREXT_SEALED_KEYS` is a JSON object `{ active, keys, revoked? }`. `keys` maps key ids
to secrets of 16-1024 bytes, `active` selects the key for new puts, and `revoked` is a
deny-list. `RAREXT_SEALED_SECRET` remains a legacy alias for the key id `legacy`; when
both are set, the legacy key is added to the ring unless it conflicts. Key ids are
1-64 letters, digits, dots, colons, underscores, or hyphens.

A sealed placement names one key id, so rotation is per whole blob: add the new key,
make it active for new puts, keep the old key for reads, and revoke it only when every
blob under it is re-uploaded or may become unreadable. Old blobs stay readable while
their key id remains configured and unrevoked. A revoked id is refused even if its
material is still present; an unconfigured id is unknown. A read snapshots the keyring
before contacting holders, so an environment rotation cannot strand an in-flight read.

Metadata without a key id is legacy data: it opens only through a configured `legacy`
key, or when the ring has exactly one key. Re-sealing an existing blob is not an
in-place operation: fresh salt and IV produce a new ciphertext and blob hash, so the
client must re-encrypt and re-upload every shard. The placement registry refuses an
extension whose sealed metadata differs from the current record, so an old blob's
ciphertext cannot be relabelled with a new key id in place. There is no partial
rotation because one envelope covers the whole payload before erasure coding; metadata
cannot name a different key per shard. A key id is public placement metadata, never a
secret.

It is still not a production confidentiality claim: there is no wrapping-key format,
associated-data binding to the placement identity, per-tenant isolation, recovery
path, or independent envelope review. Losing a key loses every blob sealed under that
id; leaking it loses their confidentiality. Errors and logs must never contain a
secret, plaintext, nonce, salt, tag, or ciphertext; regression tests compare stringified
errors against those values. Do not upload real secrets or describe the tier as audited
until the remaining gaps are closed.

## Open findings

| Finding | Issue |
| --- | --- |
| Sealed encryption is wired with HKDF-SHA256, key ids, rotation/revocation, and committed ciphertext, but has no key wrapping, AAD binding, per-tenant isolation, recovery, or envelope review. | [#6](https://github.com/999svs999/RAREXT-protocol/issues/6) |
| A challenge proves possession, not retrievability; leaf-only storage can pass. | Addressed in [RFC 0013](../rfcs/0013-proof-of-retrievability.md) |
| No quotas, rate limits, TLS, rotation window, or real writer identity; permissionless placement can squat holders. | Partly addressed: the API now has a write token with rotation, a per-process request limit, a total blob quota, and optional TLS ([#8](https://github.com/999svs999/RAREXT-protocol/issues/8), [`OPERATOR.md`](OPERATOR.md#public-exposure-and-write-limits)); still missing are per-client quotas, a durable rotation window, and an identity that is stronger than a shared token. Placement authority remains the steward's signing key. |
| A verifier or agent can report its own `ok` without an independently checkable transcript. | Partly addressed by signed, fully covered audit attestations and operator key revocation ([#9](https://github.com/999svs999/RAREXT-protocol/issues/9)); still missing holder-signed challenge timestamps, a public challenge log, and emission from the default audit endpoint. |
| Crash, failed repair, and abandoned puts leave unreferenced shards with no GC. | Addressed: scheduled holder and blob GC ships with a 24h grace period and a dry-run default ([#10](https://github.com/999svs999/RAREXT-protocol/issues/10)); residual risk is a stale or single-node reference view, covered in [`OPERATIONS.md`](OPERATIONS.md#automatic-garbage-collection). |

Also unchanged from [`HARDENING.md`](HARDENING.md): no `fsync`/power-loss guarantee, no
automatic bad-holder quarantine, and witnesses reset on restart. `encodeBytes` still
holds a whole payload in memory (the MCP put path caps it at 8 MiB). The file-backed
`erasure-stream.ts` path bounds peak RSS by chunk size, `placeStreamed`/`retrieveStreamed`
move shards over raw HTTP, and streamed repair rebuilds one shard at a time from k
survivors. Repair is still per-placement and not load-tested at 100 GiB.

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
