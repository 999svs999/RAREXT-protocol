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

The shipped implementation matches this: `apps/api/src/sealed-encryption.ts`
derives a 32-byte key with HKDF-SHA256 over a unique 16-byte salt and the info
string `rarext-sealed-tier-v1`. Earlier builds used PBKDF2-SHA256; the switch was
made on 2026-10-23 so the code and this RFC agree.

### Ciphertext Structure
```ts
export interface SealedEnvelope {
  ciphertext: string; // base64 encoded
  iv: string;         // base64 encoded 12-byte IV
  authTag: string;    // base64 encoded 16-byte GCM tag
  salt: string;       // base64 encoded salt for the key derivation
  keyId?: string;     // public id of the sealing key; absent on legacy blobs
}
```

### Encryption / Decryption Pipeline
1. **Encrypt:** Raw Payload $\rightarrow$ AES-GCM($DEK$, $IV$) $\rightarrow$ Ciphertext.
2. **Encode:** Ciphertext $\rightarrow$ `encodeBytes()` $\rightarrow$ Erasure Shards ($k+m$).
3. **Store:** Shards placed on HTTP/Directory holders.
4. **Decode & Decrypt:** Retrieve $k$ shards $\rightarrow$ Decode Ciphertext $\rightarrow$ Decrypt AES-GCM($DEK$, $IV$, $Tag$) $\rightarrow$ Raw Payload.

### Key IDs and Rotation
The placement records one public `keyId` for the whole sealed payload. The client
configures a keyring with `RAREXT_SEALED_KEYS = { active, keys, revoked? }`;
`keys` maps ids to raw secrets, `active` selects the key for new puts, and `revoked`
denies reads under an id even if its material remains configured.
`RAREXT_SEALED_SECRET` is a legacy alias for the id `legacy`.

Rotation is a client/agent operation, not a holder operation: holders never receive a
key. To rotate, add the new id, make it active, and keep the old id for reads until
every blob under it is re-uploaded; then revoke or remove it. A read snapshots the
keyring before holder I/O. Legacy metadata without a `keyId` opens only through a
configured `legacy` key, or when the ring has exactly one key. Re-sealing is not
in-place: new salt and IV change the ciphertext and blob hash, so it requires
re-uploading every shard, and the placement registry refuses a chained record that
changes the sealed metadata for an existing blob. One envelope covers the whole
payload, so there is no per-shard or partial rotation.

---

## 3. Verification & Acceptance

- **Sealed Storage Test (`apps/api/test/sealed-storage.test.ts`):** Verifies that when a payload is stored under the `sealed` tier with client-side encryption enabled, inspecting the underlying files on the holder directory reveals only AES ciphertext and zero plaintext bytes of the original payload.
- **Key Loss Behavior:** Without the corresponding key, decryption throws a generic AEAD authentication failure. A revoked id is refused even when its material is still present; an unknown id is refused. Errors name at most the public key id and never a secret, plaintext, nonce, salt, tag, or ciphertext.

## 4. Implementation status and remaining limits

- The module is `apps/api/src/sealed-encryption.ts`. It is wired into the real MCP
  path: `rarext_storage_put` with `sealed:true` encrypts the plaintext with the
  active keyring key before `encodeBytes`, records the HKDF salt, IV, GCM tag, and
  public key id in the signed placement, and returns the ciphertext blob hash.
  `rarext_storage_get` snapshots the keyring, reconstructs the ciphertext, and
  decrypts with the key named by the placement. A missing, wrong, revoked, or
  unknown key fails closed.
- `apps/api/test/sealed-path.test.ts` exercises that path end to end: it asserts
  that holder files contain no plaintext or key material, that each shard digest and
  Merkle root recompute over ciphertext, that the blob hash is the ciphertext digest,
  that decryption succeeds across key rotation, that a revoked/unknown key and
  malformed keyring fail, and that a rotation during an in-flight read is harmless.
  `apps/api/test/sealed-storage.test.ts` covers keyring rotation, legacy fallback,
  whole-blob failure on a mismatched key id, and error non-leakage.
- `examples/sealed-storage` is the runnable version of the same path.
- The HTTP blob endpoint `POST /v1/blobs` rejects `tier:"sealed"` rather than
  storing plaintext under a sealed label. That endpoint does not erasure-code, so
  it is not the sealed path.
- Still open, and why the tier is **not** production-grade confidentiality yet:
  there is no wrapping-key format or recovery path, no associated-data binding to
  the placement identity, no per-tenant key isolation, and the envelope has not
  been independently reviewed. Keyring rotation and revocation are implemented, but
  every key is a raw caller-held secret; losing it loses the data, and leaking it
  loses confidentiality. Redacting errors and logs is tested but still a client
  responsibility at the edges.
- Do not upload real secrets or describe the sealed tier as audited end-to-end
  encryption until those gaps are closed.
