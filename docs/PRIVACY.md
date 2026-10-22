# Privacy and access

Two things a registry needs before it can hold anything a business would not
publish: a way to keep something out of the feed, and a way to hand it to exactly
one person.

## Visibility

Every publication carries a visibility.

| Visibility | In the feed | Searchable | Retrievable by id | Registry holds the body |
| --- | --- | --- | --- | --- |
| `public` | yes | yes | yes | yes |
| `unlisted` | no | no | with a capability | yes |
| `sealed` | no | no | with a capability | **no** |

`unlisted` is a private build that the registry still verifies: the artifact is
checked, the attestation is real, and the work is simply not listed. Reach it by id
with a capability.

`sealed` is a build the registry never sees. The publication carries a
**commitment** — the hash of the artifact — and the author's own attestation, and
the body stays with the author. The registry stores a promise it cannot check.

## Capabilities

A capability is a small signed grant:

```json
{
  "artifactId": "…",
  "issuedAt": "2026-10-22T00:00:00.000Z",
  "expiresAt": null,
  "nonce": "…",
  "grantee": null
}
```

signed by the **author** of the publication with their identity key, and passed as
`?capability=…`. The author is the party with something to protect, so the grant
is theirs to make; the registry only checks that the signature is real, that the
grant names this artifact, and that it has not expired. A capability for one
artifact does not open another, a tampered grant does not verify, and an expired
one is refused.

The signature format matches the publication envelope: P-256 over the canonical
JSON, in the `ieee-p1363` encoding.

## Why sealed proofs are weaker, on purpose

The normal proof is **recomputable**: anyone can take the artifact, run the
verifier, and get the same trace hash. That is what makes it a proof.

A sealed publication cannot be recomputed, because the registry does not have the
artifact. So the proof is **salted** — computed with a secret only the author
holds — and the attestation says `proofKind: "salted"`. The consequences are
honest and worth stating:

- A third party **cannot** check that a sealed build passes its challenge. The
  claim is the author's word, bound to a commitment and a timestamp.
- A salted proof **cannot** be brute-forced. The deterministic trace hash leaks
  small artifacts: for a five-gate circuit the space is small enough to enumerate,
  and the hash identifies the circuit. Salting removes that leak.

So sealing trades public checkability for the absence of leakage, and the
`proofKind` field is what tells a reader which trade was made. A verifier that
wants both needs a zero-knowledge proof, which is the real answer and is not
built yet.

## What is not here

- **No key custody.** The author holds the artifact and the salt. If they lose
  them, the sealed publication is a commitment to nothing.
- **No revocation yet.** A capability can expire, but there is no published
  revocation list, so a leaked capability cannot be withdrawn before it expires.
- **No private search.** An unlisted or sealed artifact is reachable by id, not
  discoverable. The index is public by construction, which is a leak in itself:
  it says how much work exists and when.

## For app authors

- Set `visibility` on the publication. The registry will not list anything else.
- Mint a capability with the author's key and hand it to the party that should
  see the work.
- For sealed work, publish the commitment and a salted attestation, and keep the
  salt and the artifact. The semantics record for the challenge should say that
  its claims are author-attested, so nobody reads a `salted` proof as if it were
  recomputable.
