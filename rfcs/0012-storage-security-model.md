# RFC 0012: Storage security model and residual findings

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Requires:** RFC 0004 (storage economy), RFC 0005 (durable placements),
  RFC 0010 (data availability sampling), RFC 0011 (pinning service)
- **Implementation:** `apps/api/src/durability.ts`,
  `apps/api/src/holder-server.ts`, `apps/api/src/placements.ts`,
  `apps/api/src/pin-server.ts`, `apps/api/src/das.ts`,
  `apps/api/test/security-storage.test.ts`
- **Normative companion:** [`docs/STORAGE-SECURITY.md`](../docs/STORAGE-SECURITY.md)

## Summary

This RFC fixes the interpretation of the storage wire protocol: what a challenge
proves, what a bearer token authorizes, which malformed claims are refused, and which
security properties are explicitly **not** promised. It changes verifier strictness and
deployment defaults, not the on-disk placement, leaf, or publication formats.

Status is Draft because the open findings below are not closed. A node may implement
this RFC and still be vulnerable to them; the point of the RFC is to make that
statement precise instead of implied.

## Motivation

The placement and holder code grew from "can these bytes be rebuilt" to "is a remote
holder actually holding them". That added a network surface, a challenge response, a
pin service, and a bearer-token story. Without a written model, three errors are easy:

1. treating a valid signature as evidence that a placement is physically possible;
2. treating a possession proof as a retrievability proof;
3. treating a shared token as an identity or a confidentiality mechanism.

Each error produces a claim the code cannot support. This RFC separates the checks that
are enforced from the findings that remain.

## Decision

### 1. Challenge responses bind to the request

A response is valid only when it contains the requested leaf index, the fresh nonce,
`digest = sha256(nonce ‖ leaf)` (domain-separated in the implementation), a 64-hex leaf
and proof, and exactly one proof element per Merkle level. The verifier caps nonce
length and rejects old answers, wrong-leaf answers, and overlong proofs before hashing.
A response that fails is a miss; it is not evidence of liveness.

### 2. HTTP peers are bounded and hash-checked

A holder response is not trusted until its limits and names are checked. `storedAs` must
be a 64-hex digest, shard bytes returned by `get` must hash to that name, JSON bodies are
size-capped, and requests time out. Holder and pin servers support a bearer token,
bounded bodies, constant-time token comparison, and bounded caches. The holder CLI
refuses a non-loopback bind without a token.

### 3. Placements are validated, not just signed

A signature authenticates the steward; it does not prove that shard indices are unique,
that holders are distinct, that the declared length matches the shard sizes and leaf
counts, or that the required count is reachable. Those invariants are checked before a
placement is adopted. Co-location, more than 255 shards, shard size above 4 GiB,
inconsistent payload lengths, malformed shard objects, and impossible required counts are
refused.

### 4. Pins are tamper-evident

The pin store recomputes the CID on write and read, checks metadata against content, and
writes metadata through a temp file and rename. A modified file is an error, not a
silently served record. The service can require a token and bounds the publication ids
and root it accepts.

### 5. Tokens are shared secrets, not identity

`RAREXT_HOLDER_TOKEN` and `RAREXT_PIN_TOKEN` authorize requests between processes that
already trust each other. They do not identify a writer, cannot be scoped, have no
rotation overlap, and are exposed by plain HTTP. TLS termination and real authorization
are deployment work, not properties of this RFC. The reference pin service binds
loopback only.

### 6. No format version bump

The publication kind, Merkle leaf version 3, placement record version 1, and wire paths
are unchanged. This RFC tightens acceptance and documents limits; a peer that served
valid data before still does, and a peer that relied on accepting malformed claims now
fails. That is a deliberate compatibility choice for the pre-alpha wire.

## Residual findings

These are open issues, not implementation details to be papered over:

| Finding | Issue |
| --- | --- |
| Payloads and shards are plaintext; `sealed` does not encrypt holder-visible bytes. | [#6](https://github.com/999svs999/RAREXT-protocol/issues/6) |
| Possession is not retrievability; leaf-only storage can pass a challenge. | [#7](https://github.com/999svs999/RAREXT-protocol/issues/7) |
| No quotas, rate limits, TLS, token rotation window, or writer identity; placement can squat holders. | [#8](https://github.com/999svs999/RAREXT-protocol/issues/8) |
| A verifier can self-report `ok` without an independently checkable transcript. | [#9](https://github.com/999svs999/RAREXT-protocol/issues/9) |
| Crash, failed repair, and abandoned puts leave orphan shards with no GC. | [#10](https://github.com/999svs999/RAREXT-protocol/issues/10) |

Also unchanged: no `fsync`/power-loss guarantee, no automatic bad-holder quarantine, no
persistent witnesses, no whole-payload streaming, and no cross-holder transaction.

## Alternatives considered

- **Version the wire before fixing the open findings.** Rejected for now: the strictness
  changes are backward-compatible for honest peers, and a new version would not close
  confidentiality, retrievability, or identity by itself.
- **Make the token an HMAC-signed capability with holder ids and expiry.** Useful, but it
  is only meaningful after quotas and identity exist; see issue #8.
- **Call the challenge a proof of retrievability.** Rejected: a leaf-only holder can
  pass. Issue #7 defines what a real proof would require.

## Compatibility and testing

The security tests cover replay and wrong-leaf answers, a lying HTTP holder, holder-token
enforcement, nonce caps, pin tampering and token enforcement, metadata bounds, and
malformed placement claims. Run:

```bash
npx tsc --noEmit
node --test --test-reporter=tap apps/api/test/security-storage.test.ts
```

Passing tests support the controls in this RFC; they do not close the findings table.
