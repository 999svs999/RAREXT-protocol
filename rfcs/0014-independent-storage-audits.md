# RFC 0014: Independent Verifiable Storage Audits (Signed Audit Attestations)

- **Status:** Proposed / Design Specification
- **Issue:** [#9](https://github.com/999svs999/RAREXT-protocol/issues/9)
- **Author:** RAREXT Protocol Working Group

## Abstract

This RFC defines **Signed Audit Attestations** to solve Issue #9 ("Lying verifier operators"). Previously, durability verifiers (or MCP agents) reported challenge outcomes and health status locally or via self-reported `ok` statuses without an independently checkable cryptographic transcript. An untrusted or buggy verifier operator could mark unverified or lost shards as live without ever contacting the holders.

This specification introduces a verifiable attestation structure signed by the verifier's agent key, binding the placement record, challenge parameters (nonce, leaf index, timestamp), holder identities, and the holder's signed/verified responses. Any third party can independently audit and verify the transcript without trusting the reporting operator.

---

## 1. Threat Model

- **Lying Verifier Operator:** An operator running a storage challenge loop or MCP agent falsely reports `ok` for unreferenced, offline, or deleted shards to collect rewards or hide durability failures.
- **Transcript Tampering:** An operator attempts to replay old challenge responses or forge challenge timestamps.
- **Third-Party Verification:** A decentralized verifier registry or client wants to verify that a reported storage audit was genuinely performed against the live holder at the claimed time.

---

## 2. Signed Audit Attestation Format

An `AuditAttestation` object is produced after every challenge batch against a placement:

```ts
export interface ChallengeTranscriptEntry {
  holderId: string;
  storedAs: string;
  leafIndex: number;
  nonce: string;
  timestamp: string;
  response: ChallengeResponse; // { index, bytes, proof }
  verified: boolean;
}

export interface AuditAttestation {
  blobHash: string;
  placementDigest: string;
  verifierKeyId: string;
  timestamp: string;
  entries: ChallengeTranscriptEntry[];
  signature: string; // Signed by verifier agent key over canonical serialization
}
```

### Canonical Serialization and Signing
1. The attestation payload excludes the `signature` field.
2. It is deterministically serialized (sorted keys, JSON stringified or binary cbor).
3. Signed using `AgentSigner` (Ed25519 or post-quantum signature suite).

---

## 3. Independent Verification

A third party verifies an `AuditAttestation` by:
1. Recomputing the placement digest or checking it against the `DurabilityLedger` / `PlacementRegistry`.
2. Verifying the verifier's signature against `verifierKeyId`.
3. Re-running `verifyChallengeResponse` on each `ChallengeTranscriptEntry` using the entry's `nonce`, `leafIndex`, `response`, and the holder's shard commitment from the placement.
4. Ensuring `timestamp` is within the allowable challenge validity window (prevents stale replays).

---

## 4. Acceptance & Protocol Impact

- **Self-Reported `ok` Rejected:** In documentation and protocol validation, self-reported `ok` statuses without an accompanying `AuditAttestation` are classified as unverified observations.
- **Test Coverage:** Added `apps/api/test/independent-audit.test.ts` verifying that forged attestations, mismatched transcripts, and invalid signatures are strictly refused.
