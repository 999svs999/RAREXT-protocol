# RFC 0013: Proof of Retrievability vs. Proof of Possession

- **Status:** Proposed / Design Specification
- **Issue:** [#7](https://github.com/999svs999/RAREXT-protocol/issues/7)
- **Author:** RAREXT Protocol Working Group

## Abstract

This RFC specifies the protocol extension and challenge redesign required to upgrade RAREXT storage challenges from **Proof of Possession (PoP)** to **Proof of Retrievability (PoR)**. 

Currently, a holder answers a durability challenge (`/v1/holder/challenge`) by producing a Merkle leaf hash and inclusion proof for a requested chunk index, bound to a fresh nonce. While this proves that the holder possessed the Merkle leaves at the time of the challenge, a malicious or space-constrained holder can discard the underlying shard payload bytes, retaining only the tiny Merkle tree structure (or root + required sibling authentication paths), and still successfully answer any challenge. This vulnerability is Issue #7.

---

## Threat Model and Limitation of Possession Proofs

1. **Leaf-Only Storage:** A shard of size $S$ is chunked into $L = \lceil S / 256 \rceil$ leaves. Each leaf is 32 bytes (SHA-256 digest of chunk content). The Merkle tree of $L$ leaves requires approximately $2L \times 32$ bytes of storage. For a 1 MiB shard ($L = 4096$), the Merkle tree requires less than 256 KiB, whereas the shard payload requires 1 MiB. A malicious holder can discard 75% of its storage while retaining 100% pass rate on random chunk challenges.
2. **Precomputed Responses:** If challenges do not incorporate un-guessable dynamic byte inspection, a holder can precompute or cache responses.

---

## Design: Proof of Retrievability (PoR)

To guarantee that the holder actually retains the full shard payload bytes (not just the Merkle tree leaves), we introduce a two-part challenge:

### 1. Merkle Leaf Challenge (Baseline PoP)
- The verifier selects a random leaf index $i \in [0, L-1]$ and a fresh nonce $N$.
- The holder returns the chunk bytes (or hash) and the Merkle proof for leaf $i$, verifying that the leaf matches the committed shard root.

### 2. Byte Inspection Challenge (Retrievability Extension)
- Along with leaf index $i$, the challenge specifies a pseudo-random byte offset $o$ within chunk $i$ (or across the shard), seeded by the nonce $N$ and shard hash.
- Alternatively, and more robustly for file storage: **Vector-based Data Sampling (VDS)**. 
- The challenge demands the exact raw bytes of $k$ randomly selected sub-chunks or byte ranges within the shard, accompanied by a collision-resistant commitment (e.g., polynomial evaluation or Merkle opening of the sub-chunk).

### Protocol Flow

1. **Challenge Request (`POST /v1/holder/retrievability-challenge`)**:
   ```json
   {
     "storedAs": "...",
     "leafIndex": 42,
     "byteOffset": 128,
     "byteLength": 64,
     "nonce": "..."
   }
   ```
2. **Challenge Response**:
   ```json
   {
     "index": 42,
     "proof": [...],
     "bytes": "base64...",
     "byteProofSignature": "..."
   }
   ```
3. **Verification**:
   - Verify Merkle inclusion proof for leaf index 42 against the shard root.
   - Hash the returned raw `bytes` and verify that they match the pre-image of leaf 42 (or that the requested sub-range matches the expected chunk content).
   - Because leaf 42 is a collision-resistant hash (SHA-256) of the 256-byte chunk, a holder that discarded the chunk bytes cannot reconstruct the correct sub-range bytes unless it retained the full chunk payload.

---

## Bounding Verifier Work and Response Size

- **Byte Sampling Limit:** Constrain requested raw bytes per challenge to a small fixed window (e.g., 32 to 64 bytes per chunk, max 5 chunks per challenge).
- **Network Bandwidth:** Total response size remains under 2 KiB per challenge, preventing amplification attacks while forcing the holder to access underlying disk storage.
- **Disk I/O Cost:** Forces random disk access (seek + read), eliminating the memory-only leaf cache shortcut.

---

## Impact on Ledger, Witnesses, and Failure Handling

- **Audit Status:** If a holder fails the byte retrievability challenge (returns wrong bytes, missing bytes, or fails Merkle verification), the witness records an immediate **retrievability failure**.
- **Quarantine and Eviction:** Unlike a transient network timeout, a verified retrievability failure immediately quarantines the holder, marks its shards as under-replicated in the durability ledger, and triggers priority repair on spare holders.
- **Documentation Update:** Closes Issue #7 in `docs/STORAGE-SECURITY.md` and transitions the security model from "Proof of Possession" to "Provable Retrievability".
