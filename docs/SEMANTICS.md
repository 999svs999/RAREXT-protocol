# Semantics

The protocol can prove that an artifact satisfies a challenge. It cannot prove that
satisfying a challenge means what the parties think it means. The semantic layer makes
the *meaning* of a claim a versioned, hash-bound, owned object, so that a reader can
tell three different questions apart:

1. **Is the machine correct?** — the artifact satisfies the machine spec. Proven by the
   verifier, re-checkable by anyone.
2. **What does the machine spec mean?** — owned by whoever wrote the semantics, hashed,
   versioned, and published.
3. **Does this claim apply here?** — owned by the claimer, scoped explicitly.

Confusing these is how "the system says it is fine" becomes an unfalsifiable claim.
RAREXT keeps them separate on purpose.

## Objects

| Object | Answers | Owner |
| --- | --- | --- |
| `Challenge` | what is mechanically tested | app author |
| `Semantics` | what that test means, in words, for a domain | semantics owner |
| `Claim` | what one party asserts, about one subject, under some scope | claimer |

### Semantics

```ts
interface Semantics {
  id: string;                 // "logic/half-adder", "erp/q3-reconciliation"
  app: string;
  version: number;
  claimKind: ClaimKind;       // which kind of claim this meaning licenses
  title: string;
  summary: string;
  specHash: string;           // the spec this meaning was written against
  verifierHash: string | null;// the checker that was used, when known
  inputs: string[];
  outputs: string[];
  interpretation: { doc, owner, reviewedAt } | null;
  owner: string;
  origin: "declared" | "derived";
  createdAt: string;
}
```

`specHash` is the hash of the machine spec the meaning was written against. It is the
load-bearing field: if the challenge's spec changes without a semantics bump, the
binding breaks and the registry says so instead of quietly changing what the claim
means.

`origin` separates a meaning someone actually wrote (`declared`) from one the registry
synthesised from a bare challenge (`derived`). Derived semantics mean nobody has taken
responsibility for the interpretation, and a registry full of derived semantics is a
registry whose claims are only as good as their titles.

### Claim kinds

| Kind | Asserts | Proof |
| --- | --- | --- |
| `satisfies` | the subject satisfies the spec | recomputable by anyone |
| `attests` | an institution asserts a fact the protocol cannot check | accountable signature |
| `produces` | the subject was produced by a stated process | committed proof |
| `derives` | the subject follows from a prior one | lineage |

A semantics record licenses exactly one kind. Publishing an `attests` claim against a
`satisfies` meaning is rejected, and so is a scope the meaning does not cover. This is
where an MIS/ERP deployment earns its keep: "batch 2024-Q3 reconciled" is an `attests`
claim with a scope, not a machine-checkable `satisfies` claim dressed up as one.

### Scope

A claim may carry a scope — a small map such as `{ dataset: "erp-prod", period:
"2024-Q3" }`. Scope keys must appear in the semantics' `inputs` or `outputs`, so a
claim cannot smuggle in a qualifier the meaning never contemplated. Scope is what
stops a claim about one batch from being read as a claim about all of them.

## Hashes and drift

Three hashes travel with every attestation:

- `specHash` — which machine spec was tested.
- `semanticsHash` — which meaning the claim is bound to.
- `verifierHash` — which implementation did the checking. For the built-in logic
  verifier this is the hash of the verifier manifest; for external verifiers it is the
  hash of the manifest the verifier returns, which for the board-game example includes
  the SHA-256 of the rule source file.

If a verifier's rules change, its hash changes, and older claims stay bound to the
older hash. Nothing is silently re-interpreted. The registry can then show that a
verifier drifted, and a future revocation record can mark a hash as distrusted.

## Binding status

`GET /v1/challenges` reports, per challenge:

- `semanticsBinding`: `ok`, `missing`, `version-mismatch`, or `spec-mismatch`.
- `semanticsHash`: the commitment to the meaning.
- `semanticsOrigin`: `declared` or `derived`.

A challenge whose meaning was never declared shows `derived`, which is the registry's
way of saying "the words in the title are all the interpretation you get".

## Trust assumptions

| Property | Mechanism | Residual trust |
| --- | --- | --- |
| Authorship | ECDSA P-256 signature | the key holder |
| Existence and time | Merkle anchor | the anchor service, the chain |
| Integrity | content hash in the signed envelope | none |
| Machine correctness | recomputable proof | the challenge spec |
| Meaning | semantics owner, hashed and versioned | the semantics owner |
| Applicability | claimer, scoped | the claimer |
| Privacy | client-side encryption (not yet shipped) | the key holder |

A proof shows that an artifact satisfies *the spec as written*. It cannot show that the
spec means the right thing. "Reconciled" is a business definition before it is a
cryptographic one, so challenge definitions for regulated claims need a named owner, a
review date, and a version — which is what `Semantics.interpretation` records.

## Limitations

- **Small search spaces leak.** The current logic proof is a deterministic trace hash.
  For a five-gate circuit the space is enumerable, so a published proof can identify
  the circuit. Sealed and private modes need a salted proof or a zero-knowledge proof;
  that work is tracked separately and is not done here.
- **Metadata leaks.** Who published against which meaning, and when, is public even
  when the body is not. Batching and salting the anchor reduce but do not remove this.
- **Erasure.** A chain commitment to a deleted artifact's hash survives the deletion.
  The limit is explicit: the data can be destroyed, the record that a commitment
  existed cannot.
- **Drift is detected, not prevented.** The registry reports a broken binding; it does
  not stop a challenge author from changing a spec.

## API

```
GET /v1/semantics              list every meaning with its hash
GET /v1/semantics/:id          one meaning, latest version
GET /v1/semantics/:id?version= one meaning at a version
GET /v1/challenges             challenges with binding status and meaning hash
```

Publishing accepts a claim:

```json
{
  "author": "acme-agent",
  "challengeId": "q3-reconciliation",
  "claim": { "kind": "attests", "scope": { "dataset": "erp-prod", "period": "2024-Q3" } },
  "artifact": { "app": "erp", "kind": "erp.batch", "version": 1, "body": {} }
}
```

The claim is part of the signed envelope, so it cannot be added to someone else's
publication after the fact.

## For app authors

1. Write the semantics first: what the challenge means, in one paragraph, with a named
   owner.
2. Pin the spec hash and repin it whenever the spec changes, bumping the version.
3. Publish a verifier manifest so the implementation that did the checking is bound to
   every claim.
4. Point the registry at it with `RAREXT_SEMANTICS`, next to `RAREXT_CHALLENGES` and
   `RAREXT_VERIFIERS`.

See [`rfcs/0003-verifiable-claims.md`](../rfcs/0003-verifiable-claims.md) for the
proposal this implements.
