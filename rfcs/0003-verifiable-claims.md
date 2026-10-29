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

1. **Should a semantics record be signed and anchored like a publication?** —
   **ANSWERED: yes, and it is — a semantics commitment is published as an ordinary
   publication.** Semantics records travel in the bundle, but the bundle's root is a
   Merkle root over PUBLICATION leaves, so a record that is only a FIELD is editable
   while the root still verifies: an anchor in name only. The fix is the one RFC 0020
   applies to seed lists — commit to the thing INSIDE the proof.
   `semanticsCommitmentArtifact` publishes `id@version -> digest` for each record's
   canonical form, so the same leaf and root helpers that cover every other claim cover
   the meaning a claim was made against; editing a committed digest moves the root a
   client already holds, which is the test that decides whether "anchored" means
   anything. What is committed is more than the record's prose: `specHash`,
   `verifierHash`, `owner` and the interpretation all sit inside the digest, so the
   rule a verdict was produced by is anchored with the meaning it was judged against.
2. **Should a claim carry a revocation reference, and should the registry expose
   revoked claims and distrusted verifier hashes?** — **ANSWERED: yes, and it does.**
   Revocation is first-class: `REVOCATION_KINDS` names `artifact` (this claim is
   withdrawn) and `verifier` (do not trust verdicts from this rule's hash) beside
   `capability` and `key`, `/v1/revocations` publishes them, and the lookups are
   fail-closed — a check that cannot reach the list refuses rather than assuming
   "not revoked". A verifier-hash revocation is exactly the "distrusted verifier" the
   question asks for, stated as the digest the attestation already carries rather than
   as a name anyone could re-use.
3. **Does the scope need a typed contract rather than a string map?** — **ANSWERED: it
   is a published, versioned record PLUS a spec hash, which is stronger than either.**
   A binding is an `(id, version)` reference into the registry's semantics, so two
   readers resolve the SAME text rather than each parsing their own map —
   `semanticsBinding` refuses to accept a challenge whose version no longer matches,
   and the challenge's spec is hashed (`specHash`) so a spec edited under a stable
   version is caught rather than believed. The remaining string-shaped surface is the
   scope map, and it is bounded by `scopeAllows`: a scope can only narrow the
   predicate, never assert something the semantics record does not say.
4. **What is the migration path for attestations with no semantics binding?** —
   **ANSWERED: they are reported as UNBOUND, not silently accepted.** A challenge
   carrying no semantics reference resolves as `"missing"` (and a stale version as
   `"version-mismatch"`), so the registry surfaces challenges whose meaning nobody
   owns instead of issuing a verdict that pretends a meaning was agreed. An
   attestation is never left blank either: with no explicit binding it records a
   DERIVED id (`app/challengeId`), so an old claim is labelled with the meaning its own
   identifiers imply and a reader can see that no semantics record was ever named for
   it. Old attestations therefore keep verifying as artifacts while the record they
   would bind to is reported as missing rather than assumed — the honest label for a
   claim made before the meaning was written down.

## Sequencing the live change

Committing the LIVE registry's own semantics is safe only as a sequence, because the
root is pinned in more than one place: the bundle, the mirror's copy of it, the seed
that names the root, the anchor that points at it, and the landing page's
`data-pin-root` link. The order is:

1. re-publish the bundle with the semantics commitment as a further publication (the
   shape RFC 0020's own commitment already takes in that same bundle);
2. re-pin — the seed and the anchor data now name the new root;
3. re-anchor, so the anchor's subject is the root that covers the commitment;
4. redeploy, whose own post-checks recompute the root from the served bytes.

Half-applying it is worse than the gap it closes: a published bundle whose root nothing
pins is a bundle whose proof nobody can check. The delta is measured rather than
assumed — `packages/core/test/semantics.test.ts` builds the commitment against the
committed bundle's own publications and semantics and shows the root move, and that
every record it carries resolves to the digest committed for it.

## Implementation status

The core of this RFC is implemented: semantics records, binding checks, claim kinds and
scope validation, the signed claim field, `GET /v1/semantics`, verifier manifests, and
the pinned-hash tests. The RFC remains draft because the open questions above are
unresolved and because private claims (the sealed-body work) are not yet specified.
