# RFC 0006: Independent verifier operators

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Requires:** RFC 0002 (signed publications), RFC 0003 (verifiable claims)
- **Implementation:** `apps/api/src/verifier-operators.ts`,
  `docs/APP-PROTOCOL.md`, `apps/api/test/verifier-operators.test.ts`,
  `apps/api/test/independent-verifiers.test.ts`

## Summary

Today the registry runs the verifier itself, in-process or by calling a verifier
service it configured. That makes the registry the only place an attestation can
come from. This RFC lets a **verifier operator** — an independent party with its
own key — attest to an artifact, and lets the registry accept that signed
attestation without re-running the verifier, while binding it to the exact
artifact and challenge.

## Motivation

The trust table in `docs/ARCHITECTURE.md` says "external app verifier — app
operator". That is a promise the code did not keep: a publication is only accepted
if the registry can recompute the attestation, so an app whose verifier the
registry does not run cannot be published at all.

Three reasons to change that:

1. **Coverage.** A registry cannot bundle every app's verifier. An app should be
   able to run its own verifier and have its attestations accepted.
2. **Cost.** Recomputing a heavy verifier on every publish is work the registry
   may not be able to afford; an operator that already ran it can hand over the
   result.
3. **Independence.** A verifier run by someone other than the publisher, with a
   key that can be checked by anyone, is a stronger claim than "the registry says
   so", provided the operator is named and the signature travels with the result.

The trade is explicit: the registry stops recomputing, so it can no longer promise
that the attestation is what *its* code would produce. It can promise that the
named operator signed this attestation for this artifact, and a reader can decide
whether to trust that operator.

## Design

### Operator registration

An operator self-registers with a signed record:

```json
{
  "operator": {
    "kind": "rarext.verifier-operator",
    "version": 1,
    "name": "Echo Lab Verifier",
    "keyId": "sha256(canonical publicKey)",
    "publicKey": { … },
    "algorithm": "ecdsa-p256",
    "apps": ["echo-lab"],
    "url": "https://verify.example",
    "createdAt": "2026-10-23T00:00:00.000Z"
  },
  "signature": "base64"
}
```

Registration is permissionless: `POST /v1/verifier-operators` accepts any record
whose signature verifies, whose key id matches its key, and whose app list is
non-empty (`*` means every app). Re-registering the same record is `200`; a second,
different record for the same key is `409`. `GET /v1/verifier-operators` lists
them; `GET /v1/verifier-operators/:keyId` returns one. The registry stores the
registration for convenience, not as an authority: the key is in the record, so a
reader can verify it without the registry.

### The attestation envelope

A publisher includes an `operatorAttestation` in the publication payload (or in
the request body for an unsigned publication):

```json
{
  "keyId": "…",
  "attestation": { "kind-agnostic attestation object, see RFC 0003" },
  "signature": "base64 over canonicalize(attestation)"
}
```

The registry accepts it only when all of the following hold:

- the key id is registered and authorised for the artifact's app;
- the signature verifies against the operator's key;
- `attestation.app` and `attestation.challengeId` match the publication's challenge;
- `attestation.circuitHash` equals `sha256(canonicalize(artifact))`, so the
  attestation cannot be lifted from another artifact;
- `attestation.semanticsId` and `semanticsVersion` match the challenge;
- `correct` is `true`, `score` is finite and non-negative, and `gateCount` is a
  non-negative integer;
- the attestation's own algorithm and crypto profile match the operator's.

Nothing is rewritten after verification. The stored attestation is byte-for-byte
what the operator signed, so its signature still verifies years later.

### Verification modes

A publication records how it was attested:

| Mode | Meaning |
| --- | --- |
| `recomputed` | the registry ran its verifier (the old path, default) |
| `operator` | an authorised operator signed the attestation; the registry did not recompute |
| `attested` | a sealed publication carries only the author's attestation |

`attestationKeyId` and `attestationSignature` are stored beside the attestation.
`POST /v1/verify` uses them when present: it re-checks the operator signature and
every binding, returns `{ valid, reason, attestation, recomputed: null, operator }`,
and does not need the local verifier for that app. If they are absent, the route
behaves as before and recomputes.

### Trust boundary

- The registry can refuse an operator or an attestation; it cannot forge one.
- An operator can lie about an artifact. The publication names the operator, and
  the signature is public; a reader that trusts a different operator set can
  ignore the publication, and anyone can re-run the verifier hash the operator
  published.
- The author's signature (when present) covers the envelope including
  `operatorAttestation`, so the author cannot later claim they published a
  different attestation.
- Sealed publications cannot use an operator: the body is not visible to anyone
  but the author.

## What this RFC does not do

- No staking, slashing, or dispute resolution for operators. Registration is a
  name, not a bond.
- No automatic discovery or health checks; the URL is informational.
- No trust tiers ("three independent operators must agree"). One signature is
  enough, and the trust decision belongs to the reader.
- No change to `/v1/verifications`, the worker-bounty path, which still recomputes.

## Open questions

1. Should an app declare a required operator set, and should a publication from a
   different operator be rejected?
2. Should an operator's verifier bytes be pinned by hash in the publication, so a
   reader can fetch and run exactly what signed?
3. How does an operator prove liveness — a heartbeat, a challenge, or nothing?
4. Should the registry keep a fee schedule for operator attestations, or leave
   that to the app?

## Implementation status

Implemented and tested: self-signed operator registration with persistence, the
operator attestation envelope, acceptance in both the signed-payload and unsigned
publish paths, the stored verification mode and signature, and `/v1/verify` for
operator-attested publications. Not implemented: everything under "What this RFC
does not do".
