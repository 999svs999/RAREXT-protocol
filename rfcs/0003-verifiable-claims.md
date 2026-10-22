# RFC 0003: Verifiable claims and the semantic layer

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-21
- **Requires:** RFC 0002
- **Implementation:** `packages/core/src/semantics.ts`, `apps/api/src/semantics.ts`,
  `docs/SEMANTICS.md`

## Summary

RAREXT's protocol proves that an artifact satisfies a challenge. It says nothing about
what that challenge *means*, and in a centralised deployment that gap is filled by
policy: a trusted operator, a trusted verifier, a trusted reading of the spec. In a
decentralised deployment the gap is a hole, because there is no operator to fill it.

This RFC proposes a semantic layer: a versioned, hash-bound, owned description of what a
claim asserts, referenced by every attestation. It separates three questions that are
usually collapsed — is the machine correct, what does the spec mean, does this claim
apply here — and gives each one a named owner and a hash.

The proposal is additive. The anchor, the signature scheme, the artifact format, and the
Merkle tree are unchanged: the chain already commits to hashes, so adding meaning to a
claim does not require touching the chain.

## Motivation

Two problems motivate this.

**Claims are currently underspecified.** An attestation says `correct: true, score: 1000`
against a challenge id. A reader cannot tell which version of the challenge, which
checker, or which reading of the specification the score refers to. When a challenge
changes, old attestations silently acquire a new meaning.

**Enterprise use needs institutional claims.** A machine-checkable claim is not the only
kind that matters. "This batch reconciled" is a statement an organisation is accountable
for, not a theorem. A protocol that only admits the first kind either pretends the
second kind is machine-checkable, or excludes the use case entirely. The semantic layer
makes the difference explicit: `satisfies` claims are re-checkable by anyone, `attests`
claims are accountable but not machine-checked, and the registry will not let one be
published as the other.

## Design

See [`docs/SEMANTICS.md`](../docs/SEMANTICS.md) for the full object model. In short:

- `Semantics` — id, app, version, licensed claim kind, title, summary, `specHash`,
  `verifierHash`, inputs, outputs, interpretation, owner, origin.
- `Claim` — kind, subject hash, semantics id and version, semantics hash, predicate,
  scope, proof kind and hash, verifier and verifier hash.
- `Challenge` gains `semanticsId` and `semanticsVersion`.
- `Attestation` gains `semanticsId`, `semanticsVersion`, `semanticsHash`, `claimKind`,
  `scope`, and `verifierHash`.
- `PublicationPayload` gains a signed `claim` field, so a claim cannot be attached to
  someone else's publication after the fact.

A challenge reports its binding as `ok`, `missing`, `version-mismatch`, or
`spec-mismatch`. The registry synthesises a `derived` semantics record when a challenge
declares no meaning, so gaps are visible rather than implied.

## Consequences

**Good.** A claim is self-describing: subject, meaning, checker, scope. Drift in a spec
or a verifier implementation becomes detectable instead of silent. Claims that are not
machine-checkable become first-class instead of being faked as if they were.

**Bad.** More surface for app authors: three hashes to keep pinned, and a spec edit
without a semantics bump now breaks a binding. The pinned hashes are enforced by the
test suite, so the failure is loud and early, but it is work.

**Bad.** A semantics record is a governance object, and governance objects rot. A
registry where every challenge is `derived` is technically conformant and practically
meaningless. The `origin` field exists so that can be measured.

## Alternatives considered

- **Version the challenge and nothing else.** Simpler, and it covers spec drift. It does
  not cover the gap between the spec and the business meaning, which is the actual
  problem in an ERP deployment.
- **Put the meaning in the verifier.** A verifier that publishes its own prose. This
  couples the meaning to one implementation and makes the verifier a single point of
  failure for interpretation; a separate semantics record can outlive or outgrow it.
- **Free-text claims.** A `claim: string` field. Unverifiable, unversioned, and
  impossible to validate. Rejected.
- **Always machine-check.** Only `satisfies` claims. Excludes the enterprise case and
  invites people to dress an `attests` claim up as `satisfies`. Rejected in favour of
  making the difference legible.

## Open questions

1. Should a semantics record be signed by its owner, and anchored like a publication?
   It should be, but the signing path for non-artifact objects is not defined yet.
2. Should a claim carry an explicit expiry or revocation reference, and should the
   registry expose a list of revoked claims and distrusted verifier hashes?
3. Does the scope need to be a typed contract rather than a string map, so that a scope
   cannot be interpreted differently by two readers?
4. What is the migration path for attestations published before this RFC, which carry
   no semantics binding?

## Implementation status

The core of this RFC is implemented: semantics records, binding checks, claim kinds and
scope validation, the signed claim field, `GET /v1/semantics`, verifier manifests, and
the pinned-hash tests. The RFC remains draft because the open questions above are
unresolved and because private claims (the sealed-body work) are not yet specified.
