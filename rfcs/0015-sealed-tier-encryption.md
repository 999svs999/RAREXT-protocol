# RFC 0015: Client-Side Encryption for Sealed Storage Tiers

- **Status:** Proposed / Design Specification
- **Issue:** [#6](https://github.com/999svs999/RAREXT-protocol/issues/6)
- **Author:** RAREXT Protocol Working Group

## Abstract

This RFC specifies client-side envelope encryption for payload data stored under the `sealed` storage tier. Previously, storage shards and pins were stored entirely in plaintext on holders and pinning services, meaning holders could read all user payload bytes. 

This extension introduces authenticated client-side encryption (AES-256-GCM with a derived key envelope) executed **before** erasure coding and storage placement. The holder sees only ciphertext shards, while the Merkle tree and inclusion proofs commit to the ciphertext bytes.

---

## 1. Threat Model & Guiding Principles

1. **Holder Untrustworthiness:** Holders are untrusted storage nodes; they must never receive plaintext payload bytes for `sealed` tier items.
2. **Pre-Erasure Coding Encryption:** Encryption occurs on the raw payload *before* chunking and Reed-Solomon erasure coding. This guarantees that shards stored on distinct holders contain zero plaintext fragments.
3. **Integrity & Authenticity:** AES-256-GCM provides authenticated encryption (AEAD). Any tampering with ciphertext shards fails decryption deterministically.
4. **Key Management Responsibility:** Trust shifts entirely to client-side key management. Loss of the encryption key results in permanent loss of sealed data (ciphertext cannot be recovered or decrypted).
5. **Metadata and Padding Limits:** Encryption does not hide payload length or access frequency (timing and metadata leak).

---

## 2. Encryption Envelope & Flow

### Key Derivation
- Given a master secret or agent wrapping key, a per-blob symmetric data encryption key (DEK) is derived using HKDF-SHA256 with a unique per-blob salt.

> **Implementation deviation (2026-10-23).** The shipped
> `apps/api/src/sealed-encryption.ts` derives the key with **PBKDF2-SHA256**
> (100,000 iterations, 32-byte key) over the same 16-byte random salt, not HKDF.
> The envelope shape matches this RFC, but the construction does not. PBKDF2 is a
> password-stretching KDF; HKDF is extract-and-expand for high-entropy input.
> Either the implementation must move to HKDF or this RFC must be amended and the
> envelope reviewed. Until then the sealed tier is **not** a confidentiality
> claim.

### Ciphertext Structure
```ts
export interface SealedEnvelope {
  ciphertext: string; // base64 encoded
  iv: string;         // base64 encoded 12-byte IV
  authTag: string;    // base64 encoded 16-byte GCM tag
  salt: string;       // base64 encoded salt for the key derivation
}
```

### Encryption / Decryption Pipeline
1. **Encrypt:** Raw Payload $\rightarrow$ AES-GCM($DEK$, $IV$) $\rightarrow$ Ciphertext.
2. **Encode:** Ciphertext $\rightarrow$ `encodeBytes()` $\rightarrow$ Erasure Shards ($k+m$).
3. **Store:** Shards placed on HTTP/Directory holders.
4. **Decode & Decrypt:** Retrieve $k$ shards $\rightarrow$ Decode Ciphertext $\rightarrow$ Decrypt AES-GCM($DEK$, $IV$, $Tag$) $\rightarrow$ Raw Payload.

---

## 3. Verification & Acceptance

- **Sealed Storage Test (`apps/api/test/sealed-storage.test.ts`):** Verifies that when a payload is stored under the `sealed` tier with client-side encryption enabled, inspecting the underlying files on the holder directory reveals only AES ciphertext and zero plaintext bytes of the original payload.
- **Key Loss Behavior:** Documented that without the corresponding key, decryption throws an AEAD auth failure or decryption error.

## 4. Implementation status and confidentiality caveat

- The encryption module exists at `apps/api/src/sealed-encryption.ts` and is
  covered by `apps/api/test/sealed-storage.test.ts`.
- It is **not wired into** the storage verbs, the MCP tools, or the API put path.
  Callers must encrypt explicitly before calling `encodeBytes`. Nothing in the
  default upload path selects the sealed tier and applies this envelope.
- Key derivation differs from this specification: PBKDF2-SHA256 (100,000
  iterations) is used where the RFC says HKDF-SHA256 (see the note in §2).
- The key envelope has not been reviewed. There is no wrapping-key format, no
  rotation story, no associated-data binding to the blob identity, and no test
  that a swapped envelope or a cross-tier substitution fails.
- Therefore: **the sealed tier is not confidential in this build.** Do not upload
  real secrets and do not describe sealed storage as end-to-end encrypted until
  the implementation matches the RFC and that envelope is reviewed.
