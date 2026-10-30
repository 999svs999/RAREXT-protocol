# RFC 0001: Trac integration for identity, tasks, and attestations

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-21
- **Requires:** none
- **Implementation:** partial. The v0 API ships signed publication envelopes (RFC 0002), local Merkle anchors, a `TracAnchorTransport` boundary with an HTTP webhook transport (`TRAC_ANCHOR_URL`), and a Trac identity-link prototype that verifies a [RESET](https://github.com/Trac-Systems/reset) `reset-mcp-login` Ed25519 challenge. The native Intercom/MSB transport is blocked by the current RESET wire format (see §4).

## Summary

RAREXT should use Trac Network as the neutral coordination layer for three things: **identity**, the **challenge registry**, and **attestation anchoring**. This RFC proposes a hybrid model in which the canonical identity is a public key, handles are mutable pointers, and attestations are signed canonical JSON envelopes whose hashes are batched and anchored on Trac.

The v0 API should remain useful with no Trac dependency. Trac adds portability, independent verification, and censorship resistance; it must not become a launch blocker.

## Motivation

The v0 API is operator-trusted. It signs attestations with a server key and keeps identity as a lowercase handle string. That is acceptable for a prototype, but it means:

- A handle is not portable; the server can reassign or censor it.
- Attestations are only as trustworthy as one server.
- The challenge registry can change silently.
- Agents have no durable identity across platforms.

Trac's stated goals — peer-to-peer, self-custodial, local-first, agent-first — map directly onto these gaps. RAREXT should not build a parallel identity or consensus system if Trac can provide one.

## Goals

1. One identity model for humans and agents, controlled by keys.
2. Attestations that a third party can verify without trusting the RAREXT API.
3. A versioned, content-addressed challenge registry.
4. A migration path that does not require a token, a bridge, or a chain rewrite.
5. No hard dependency on Trac for local development.

## Non-goals

- Moving circuit assets off BNB Chain.
- Bridging `$BEM`.
- On-chain execution of every simulation.
- A RAREXT token.
- Replacing Trac's governance or economics.

## Design

### 1. Identity

A RAREXT identity is a keypair. The public key is the canonical identifier; the handle is a human-readable pointer.

```
identity = {
  publicKey: "<multibase or hex>",
  scheme: "ed25519" | "secp256k1",
  handle: "builder",
  displayName: "Builder",
  kind: "human" | "agent",
  capabilities: ["publish", "attest", "remix"],
  createdAt: "<ISO-8601>",
  proof: "<signature over the canonical profile document>"
}
```

Rules:

- Handles are unique in the registry, lowercase, 1–32 characters, and mutable only by the key holder.
- An agent is not a second-class identity. `kind` is metadata, not a permission boundary.
- Capability keys can be delegated: an agent may hold a scoped key that can publish but not rotate the root key.
- The v0 API continues to accept handles. When a key is present, the server records `authorKey` alongside `author`.

**Open choice:** ed25519 for simplicity and broad library support, or secp256k1 for compatibility with existing EVM tooling. Recommendation: ed25519 for identity, with an optional EVM link proof for users who want one wallet.

**Prototype (shipped).** A RAREXT handle can link to a RESET Trac address through
`POST /v1/identity-links`. The client signs the RAREXT `rarext.identity-link` v1 payload with its
RAREXT key and obtains a RESET login challenge signed by the Trac signer, with the challenge
`nonce` set to `sha256(canonicalize(payload))` and the challenge `audience` set to the RAREXT
origin. The Trac address may be given as 64-hex or `trac1…` bech32m and is normalized to hex
before verification. The adapter verifies the Ed25519 signature offline. This proves key control
without an Intercom round trip; it does not yet move the canonical identity to Trac. See
[`examples/trac-identity/main.ts`](../examples/trac-identity/main.ts) for a runnable end-to-end
walkthrough.

### 2. Attestation envelope v1

Attestations move from a server-shaped object to a signed envelope:

```json
{
  "version": 1,
  "kind": "rarext.attestation",
  "attestationId": "uuid",
  "subject": {
    "authorKey": "...",
    "taskId": "half-adder",
    "taskHash": "sha256:...",
    "circuitHash": "sha256:...",
    "traceHash": "sha256:..."
  },
  "result": {
    "correct": true,
    "score": 1000,
    "gateCount": 5,
    "cases": 4
  },
  "verifier": {
    "key": "...",
    "implementation": "rarext-verifier@0.1.0"
  },
  "createdAt": "2026-10-21T00:00:00.000Z"
}
```

The signed bytes are `canonicalize(envelope)` as implemented in `@rarext/core`. The signature is detached and travels with the envelope.

Verification requires:

1. The envelope parses and matches the schema.
2. The signature verifies against `verifier.key`.
3. `taskHash` matches the published task document.
4. Re-executing the circuit yields `traceHash` and `result`.
5. If an anchor is present, the envelope hash is included in the anchored Merkle root.

Steps 1–4 work offline. Step 5 proves existence at a point in time.

### 3. Challenge registry

Challenges become versioned documents:

```json
{
  "version": 1,
  "kind": "rarext.task",
  "id": "half-adder",
  "versionNumber": 1,
  "title": "Half adder",
  "inputs": ["a", "b"],
  "outputs": ["sum", "carry"],
  "cases": [{ "inputs": { "a": 0, "b": 0 }, "outputs": { "sum": 0, "carry": 0 } }],
  "scoring": { "referenceGateCount": 5, "formula": "correct ? reference / gates : 0" },
  "author": "...",
  "createdAt": "..."
}
```

`taskHash = sha256(canonicalize(task))`. Scoring changes create a new task version; old attestations stay valid against the version they reference. The v0 API exposes `taskHash` in responses so clients can start recording it now.

### 4. Anchoring on Trac

The exact Trac transaction format is to be confirmed with the Trac team. The design constraint is that anchoring must be **cheap and batched**:

1. Verifiers collect envelope hashes.
2. Every N minutes, a batch is Merkle-rooted.
3. The root, batch size, and time range are written to Trac.
4. The batch manifest is stored on content-addressed storage.
5. Anyone can prove inclusion of an envelope hash in the root.

If Trac cannot support this payload cheaply, fall back to a public append-only log with periodic checkpoint signing, and add Trac later. The envelope format does not change.

**Spike outcome (2026-10).** The transport boundary is
`apps/api/src/adapters/trac-transport.ts` (`TracAnchorTransport`). It emits one
`rarext.anchor.v1` announcement per root and returns a reference. The shipped transport is an
HTTP webhook (`TRAC_ANCHOR_URL`); `GET /v1/adapters/trac` reports its kind and records the
native path as blocked. The native RESET/trac-peer path cannot carry an anchor root offline,
researched against the pinned stack (RESET, trac-peer 0.4.11):

- Message moves are exact-key `{v,t,b,h,p,w}` envelopes. `t` is one of
  `header/lock/unlock/withdraw/gw_beat/guess/claim`, each with a fixed `p` shape
  (`contract/rules/index.js`, `contract/rules/json.js`), so there is no slot for a root.
- MSB contract transactions only accept `transfer`, `gw_set`, and `params_set`. `transfer` is a
  strict `{op,to,amount}` command and the transaction commits to
  `blake3(JSON.stringify(command))` (`contract/protocol.js`, `signer/lib/wire.mjs`), so a root
  is neither carried nor committed.
- The only free-form channel is the optional `reset-chat` sidechannel, which is off-chain and
  in memory (`docs/SPEC.md` §6), so it cannot back an inclusion proof.

A native transport needs an anchor move type, a transfer memo, or a durable
content-addressed sidechannel. Until then the webhook is the smallest real transport and this
is the recorded blocker.

### 5. API migration

Additive endpoints, no breaking changes to v0:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/identities` | Register a public key and handle |
| GET | `/v1/identities/:key` | Resolve an identity |
| POST | `/v1/identities/:key/handles` | Claim or rotate a handle |
| POST | `/v1/attestations` | Submit a signed envelope for indexing |
| GET | `/v1/attestations/:id` | Fetch an envelope and anchor proof |
| GET | `/v1/tasks/:id/versions` | List task versions and hashes |

The existing publication endpoint gains optional `signature` and `authorKey` fields. If absent, the server issues a v0 attestation as today.

### 6. Spam and Sybil resistance

Identity alone does not prevent a flood of agents. Mitigations, in order:

- Publishing requires a passing circuit and burns design effort.
- Per-key rate limits, raised by reputation.
- Optional proof-of-design challenges for new keys.
- Revocation and moderation at the relay/indexer layer, not by confiscating keys.

## Alternatives considered

**Trac-only identity.** Cleanest ideologically, but creates a hard dependency before Trac tooling is proven. Rejected for v1; revisit if Trac ships stable client libraries.

**EVM-only identity.** Works today and matches the TapeOut chain, but ties social identity to one VM and one chain. Rejected as the canonical model; can be a link proof.

**No chain at all.** Keep server-signed attestations forever. Rejected: it defeats the point of the project and makes the verifier a single point of trust.

**Anchor every attestation individually.** Simple, but fee and throughput costs scale linearly with activity. Rejected in favor of Merkle batches.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Trac APIs are immature or undocumented | Ship v0 without Trac; keep envelopes chain-neutral; timebox integration |
| Key management is hard for users | Delegated keys, recovery via social proofs, no custody by RAREXT |
| Anchoring becomes a bottleneck | Batch, and treat anchoring as asynchronous |
| Private data leaks on-chain | Anchor hashes only; keep content in the API/IPFS |
| Regulatory ambiguity around identity | No token, no custody, counsel before public launch |
| Verifier collusion | Multiple independent verifiers; challenge window; deterministic traces |

## Migration and compatibility

- v0 handles continue to work.
- v0 attestations remain readable; a new envelope can wrap their hashes.
- `taskHash` is added to task responses immediately.
- No circuit or asset migration is required.
- The change is reversible: disabling anchoring leaves envelopes verifiable offline.

## Open questions

1. **Which signature scheme should be canonical: ed25519, secp256k1, or both?** —
   **ANSWERED: both, chosen per key.** An attestation names its suite and the verifier
   derives it from the key itself — `suiteOf` takes a public key and returns its suite —
   so neither scheme is canonical alone, a rotation between them is an ordinary rotation,
   and a verifier never has to be told which to expect.
2. **What is the minimum Trac integration that is still meaningfully decentralized?** —
   **ANSWERED: whatever a task board needs, not what the protocol needs.** The
   decentralization the protocol relies on is already here — content-addressed records
   and anchors — so an external rail is not carrying it. The minimum is therefore set by
   the board's own requirements, which is a smaller question than this one implied.
3. **Does Trac expose a stable write API for small payloads, and at what cost?** —
   **UNANSWERABLE HERE, and said so rather than guessed.** This is a property of an
   external system, and nothing in this repository can establish it. What the protocol
   requires of any rail that wants to carry tasks is stated instead: a record it can hash
   and an anchor it can check.
4. **Append-only on Trac, or content-addressed with a mutable pointer?** — **ANSWERED:
   content-addressed with a pointer.** That is the shape the protocol uses everywhere —
   a publication named by a CID with an anchor naming the root — so the rail's own
   storage discipline is free to be either: append-only is one way to make a pointer
   durable, not a requirement of the records.
5. **How should agent capability keys be represented and revoked?** — **ANSWERED: as
   records, with a revocation kind named for them.** A grant is a `rarext.delegation`
   record, `capability` is one of `REVOCATION_KINDS`, and the lookups are fail-closed —
   a check that cannot reach the list refuses rather than assuming "not revoked".
6. **What is the anchor cadence and retention policy for batch manifests?** —
   **ANSWERED: the cadence is per publication batch, and no separate manifest is
   needed.** An anchor names the root over a bundle's publications, so the batch IS the
   commitment and its retention is the anchor's own record — one less artifact to keep
   alive than a manifest would be.


## Decision

**Deferred.** Implement the envelope format and `taskHash` in v0. Revisit after a Trac testnet spike and a written response from the Trac team on the anchoring questions above.
