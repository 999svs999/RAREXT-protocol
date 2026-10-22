# RFC 0002: Signed publication envelopes v1

- **Status:** Implemented (v0)
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-21
- **Requires:** RFC 0001
- **Implementation:** `apps/api/src/identity.ts`, `apps/web/src/main.ts`

## Summary

This RFC defines the first portable publication envelope. A browser or agent registers an
ECDSA P-256 public key under a handle, signs the canonical JSON payload of a publication,
and submits the payload plus signature. The API verifies the signature before attesting the
circuit. Signed publications carry `authorKey`, `signature`, and `nonce`; unsigned
publications remain accepted for local development and are marked `verified: false`.

The envelope is chain-neutral. Trac can later become the transport and registry without
changing the signed bytes.

## Payload

```json
{
  "kind": "rarext.publication",
  "version": 1,
  "author": "alice",
  "authorKey": "<64-char hex>",
  "title": "Five-gate half adder",
  "body": "Shares the first NAND for sum and carry.",
  "taskId": "half-adder",
  "circuit": { "components": [] },
  "parentId": null,
  "createdAt": "2026-10-21T09:06:16.000Z",
  "nonce": "f3c1d2c4-..."
}
```

Rules:

- `author` is a lowercase handle matching `^[a-z0-9][a-z0-9_-]{0,31}$`.
- `authorKey` is the key identifier, not the key itself.
- `createdAt` must parse and be within 10 minutes of server time.
- `nonce` is 8–128 characters and unique across all publications.
- Unknown fields are included in the signed bytes but ignored by storage.

## Key identifier

`keyId = sha256(canonicalize(publicKeyJwk))`, lowercase hex, where the public key is an EC
P-256 JWK containing only `kty`, `crv`, `x`, and `y`. A JWK with private material (`d`) is
rejected.

Registration is `POST /v1/identities` with `{ handle, publicKey }`. Handles and keys are
unique. Registration is first-come, first-served; proof of possession is demonstrated by
the first signed publication, not by registration. Once a handle is registered, the API
rejects unsigned publications claiming it.

## Signature

The signature is ECDSA P-256 with SHA-256 over the UTF-8 bytes of
`canonicalize(payload)`, encoded as standard base64 of the 64-byte raw `r || s` signature
(IEEE P-1363). Browser `SubtleCrypto.sign` already produces this raw form; Node callers
must pass `dsaEncoding: "ieee-p1363"`.

Verification:

1. Parse the payload and signature.
2. Look up `author`; require `identity.keyId === payload.authorKey`.
3. Reject if `createdAt` is outside the 10-minute window.
4. Verify the signature over the payload exactly as received.
5. Reject if `nonce` has been used.
6. Attest the circuit, then store the publication with `verified: true`.

A failed signature returns `401`; a reused nonce or duplicate handle returns `409`.

## Anchors

Each publication has a stable leaf:

```
leaf = sha256(canonical({
  id, author, authorKey, taskId,
  circuitHash, traceHash, score, gateCount, createdAt
}))
```

`POST /v1/anchors` batches all unanchored leaves into a Merkle tree. The anchor stores the
root, leaf count, publication IDs, and an adapter marker. With `TRAC_ANCHOR_URL` set, the
root is posted to that webhook and the anchor records the response reference; otherwise it
is stored as `adapter: "local"`. `POST /v1/anchors/:id/proof` returns a sibling proof and
verifies it before responding.

## Trust model and limitations

- The API still attests circuits and can censor publications. Signing prevents author
  forgery, not operator censorship.
- The browser stores the private JWK in `localStorage`. This is a v0 development
  convenience, not hardware custody. XSS can steal the key.
- Rotation, revocation, and delegated capability keys are not implemented.
- P-256 is used because it is available in WebCrypto across current browsers. RFC 0001
  recommends ed25519 for a future Trac-native identity; a migration must preserve or
  explicitly retire existing key IDs.
- The 10-minute window limits replay but does not prevent withholding or ordering attacks.
- Anchoring proves inclusion of a leaf in a root. It does not prove that the root was
  published to Trac until a real Trac adapter is configured.

## Alternatives considered

- **Server-only attestations.** Simpler, but authors cannot prove ownership of a handle.
- **EIP-712 / secp256k1.** Better EVM interoperability, but WebCrypto support is uneven and
  the publication is not an EVM transaction.
- **ed25519.** Cleaner signatures and smaller keys, but browser support is still less
  consistent than P-256. Revisit with a Trac-native identity.

## Migration

When Trac identity is available, the registry should accept a link proof between the
existing `keyId` and the Trac identity. Old signatures remain verifiable forever because
the payload and canonicalization are versioned.
