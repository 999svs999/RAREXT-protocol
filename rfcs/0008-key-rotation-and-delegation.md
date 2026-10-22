# RFC 0008: Key rotation and delegated publishing keys

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-23
- **Depends on:** RFC 0002 (signed publications), RFC 0007 (trust model)
- **Implementation:** `apps/api/src/key-management.ts`, `apps/api/src/store.ts`,
  `packages/agent-sdk/src/index.ts`

## Summary

A handle is a name bound to a key. Keys leak, laptops are replaced, and an agent may
want a short-lived signing key while keeping the public handle. This RFC adds two signed
records to the registry:

- **Rotation** moves a handle from its current key to a new one. The record is signed by
  the key being retired, so possession of the new key alone cannot take over a handle.
- **Delegation** lets the root key authorize another key to publish for the handle,
  optionally restricted to one app and to an expiry. The delegate can publish; it cannot
  rotate the root or delegate further.

Both records are append-only and include the handle, every key involved, the suite of
each key, a timestamp, and a nonce. Both are verified before they are stored, and
neither changes how an already stored publication verifies.

## Consequences at a glance

- Old publications and capabilities keep verifying after a rotation. Verification
  resolves a key through the handle's key history, not only the current key.
- A new publish signed by a retired key is refused. The error names the reason instead
  of reporting a generic signature failure.
- A delegated publish records both keys: `authorKey` is the delegate that signed, and
  `delegatedBy` is the root key that authorized it.
- Rotating the root retires outstanding delegations: their `rootKeyId` no longer matches
  the current key, so they stop authorizing new publishes. They remain in the list as
  history.
- Keys are single-use. A key that is current, retired, or delegated cannot be registered
  to another handle.

## Key rotation

```json
{
  "kind": "rarext.key-rotation",
  "version": 1,
  "handle": "alice",
  "fromKeyId": "<sha256 of the old public key>",
  "fromPublicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "fromAlgorithm": "ecdsa-p256",
  "toKeyId": "<sha256 of the new public key>",
  "toPublicKey": { "kty": "AKP", "alg": "ML-DSA-65", "pub": "…" },
  "toAlgorithm": "ml-dsa-65",
  "createdAt": "2026-10-23T12:00:00.000Z",
  "nonce": "…",
  "signature": "<signature by the old key over the other fields>"
}
```

Verification, in order:

1. `handle` is registered.
2. `fromKeyId` is the identity's current key and `fromAlgorithm` matches it.
3. `fromKeyId`/`fromAlgorithm` are derived from `fromPublicKey`, and likewise for the new
   key. A caller cannot claim a suite for a key.
4. The old key's signature verifies over the canonical payload without `signature`.
5. The new key is not current, retired, or delegated to any handle.
6. The old key has not already rotated this handle.

The registry stores the record, marks the old key retired with its public key and suite,
and replaces the identity's current key. History answers `GET /v1/identities/:handle/rotations`.
A rotation may change suite (for example P-256 to ML-DSA-65); publications carry the
suite they were signed with, so old signatures are never reinterpreted.

This RFC does not define a recovery path if both keys are lost. That is a social and
identity-link question, not a protocol one; a handle with no reachable key can still be
read, but it cannot publish or rotate.

## Delegated publishing

```json
{
  "kind": "rarext.delegation",
  "version": 1,
  "handle": "alice",
  "rootKeyId": "<current root key>",
  "delegateKeyId": "<sha256 of the delegate key>",
  "delegatePublicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "algorithm": "ecdsa-p256",
  "scopes": ["publish"],
  "app": "logic",
  "createdAt": "2026-10-23T12:00:00.000Z",
  "expiresAt": "2026-11-22T12:00:00.000Z",
  "nonce": "…",
  "signature": "<signature by the root key>"
}
```

- `scopes` is currently the single value `publish`. Unknown scopes are rejected rather
  than ignored.
- `app` restricts the delegation to a publication whose `artifact.app` matches. `null`
  allows any app.
- `expiresAt` is checked when the record is accepted and again on every use. `null` means
  no expiry.
- The root key must be the current key at both issuance and use.
- The delegate key must not already be in use.

A publish signed by a delegate is accepted only if an active delegation exists for that
handle, delegate key, and app. The registry then verifies the envelope with the delegate
key and stores `authorKey = delegateKeyId` and `delegatedBy = rootKeyId`. Readers can
distinguish "the root signed this" (`delegatedBy` is `null`) from "the root authorized
this key to sign" without changing the signature format.

A delegate cannot issue a rotation (it does not hold the current root key) and cannot
issue a delegation (the registry requires the root key's signature and current key ID).
A delegation is not a capability token: it authorizes publishing for a handle, while
capabilities authorize reading one artifact.

## API and SDK

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `POST` | `/v1/identities/:handle/rotate` | rotation record | `{ identity, rotation }` (201) |
| `GET` | `/v1/identities/:handle/rotations` | — | `KeyRotation[]` |
| `POST` | `/v1/identities/:handle/delegations` | delegation record | `Delegation` (201) |
| `GET` | `/v1/identities/:handle/delegations` | — | `Delegation[]` |

SDK helpers sign the record and post it:

```ts
const next = new AgentSigner(generateAgentKeypair().privateKey);

await rarext.rotateIdentity(root, { handle: "alice", toPublicKey: next.publicKey });

const delegate = new AgentSigner(generateAgentKeypair().privateKey);
await rarext.delegateKey(root, {
  handle: "alice",
  delegatePublicKey: delegate.publicKey,
  app: "logic",
  expiresAt: null,
});

await rarext.publishArtifactAs(delegate, { author: "alice", /* … */ });
```

## Persistence and compatibility

Snapshot version 2 adds `rotations` and `delegations` arrays. Migration 1 → 2 fills empty
arrays. A version-1 snapshot still loads; the key history for an identity that never
rotated is empty. Retired public keys are rebuilt from the rotation records on load, so
old publications and capabilities keep verifying without a separate key archive.

Delegations and rotations are verified before they reach the store. The store repeats
the cheap invariants (current root, no key reuse) so a direct caller cannot bypass them.

## Threat model

| Attempt | Result |
| --- | --- |
| Attacker holds the new key and rotates the handle | Refused: the old key must sign. |
| Attacker replays an old rotation | The old key is retired; it is no longer current. |
| Attacker replays a delegation after the root rotates | `rootKeyId` no longer matches; no authorization. |
| Attacker edits the app or expiry of a signed delegation | Signature fails. |
| Delegate tries to rotate or delegate | Both require a signature by the current root key. |
| Delegate key is registered as a second handle | Refused as already in use. |
| Old publication is re-signed by a retired key | Refused for new publishes; existing history is untouched. |
| Registry lies about which key is current | It can withhold a rotation, but a reader who has the rotation record can verify it against the old key. |

The registry is still the availability and ordering point for the key history. A reader
who needs to resist a withholding registry must fetch and keep rotation records, the same
way it must keep anchors or capabilities it cares about.

## Non-goals

- No recovery or social rotation.
- No scopes beyond `publish`.
- No delegation chains: a delegate cannot delegate.
- No revocation of a delegation other than expiry or root rotation. A future record can
  add explicit revocation without changing these payloads.
