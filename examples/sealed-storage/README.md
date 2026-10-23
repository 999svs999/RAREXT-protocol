# Sealed storage example

Runs the real sealed path with three local holders and an API, then stores one
payload with `sealed:true` through the MCP storage implementation.

```bash
npm run example:sealed-storage
```

What it proves, in order:

1. `rarext_storage_put` encrypts the plaintext with HKDF-SHA256 + AES-256-GCM
   using `RAREXT_SEALED_SECRET` before calling `encodeBytes`.
2. The holder directories contain shard files with no plaintext marker.
3. `rarext_storage_get` reconstructs ciphertext from the shards and decrypts it
   client-side; the bytes match the input.
4. A fresh challenge and audit succeed against ciphertext shards.

The placement records `sealed: { algorithm, kdf, salt, iv, authTag }`; the salt,
IV, and tag are metadata, not a key. Losing the secret loses the payload.

What this example does **not** show: key wrapping, rotation, per-tenant keys, or
an independent envelope review. Treat the sealed tier as a working cipher path,
not production confidentiality. See [RFC 0015](../../rfcs/0015-sealed-tier-encryption.md)
and [storage security](../../docs/STORAGE-SECURITY.md).
