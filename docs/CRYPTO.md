# Cryptography and the quantum question

A protocol whose selling point is "this cannot be faked" has to be honest about the
cryptography underneath. This document says what the protocol relies on, what breaks
when a cryptographically relevant quantum computer exists, what is already
post-quantum, and what the migration path is.

## The threat in one paragraph

A large-scale quantum computer running Shor's algorithm breaks every signature
scheme in common use today: ECDSA, Ed25519, RSA. It does **not** break hashing.
Grover's algorithm halves the security of a hash, so SHA-256 falls from 128-bit
security to roughly 64-bit *against a quantum adversary searching preimages* — still
comfortable for the way the protocol uses hashes, but worth stating rather than
assuming.

So the split is:

| Primitive | Quantum outcome | What the protocol does about it |
| --- | --- | --- |
| Signatures (ECDSA P-256) | broken | the suite is recorded on every claim, and a post-quantum suite exists |
| Hash commitments (SHA-256) | weakened, not broken | unchanged; Merkle roots, artifact hashes, and key ids stay sound |
| Symmetric encryption (AES-GCM) | weakened | use AES-256 for sealed artifacts, which keeps a comfortable margin |

The "cannot be faked" property rests on the signature. Everything else rests on
hashing. So the signature is the thing to make pluggable, and the protocol now
records, on every publication and every attestation, **which suite signed it and
whether that suite is post-quantum**.

## What is available now

The platform runs on Node 22.18+ with OpenSSL 3.5, which ships **ML-DSA** (the
FIPS 204 standard, previously Dilithium) and **ML-KEM** natively. No dependency, no
sidecar service, no hand-rolled lattice code.

| Suite | Profile | Status |
| --- | --- | --- |
| `ecdsa-p256` | classical | the default; what a browser can do today |
| `ml-dsa-44` | post-quantum | 128-bit classical security, ~2.4 KB signatures |
| `ml-dsa-65` | post-quantum | 192-bit classical security, ~3.3 KB signatures |

`GET /v1/crypto` publishes the policy, so a client can ask what the registry
supports instead of guessing.

## How a claim carries its profile

Every publication and attestation records:

- `signatureAlgorithm` — the suite of the key that signed it;
- `cryptoProfile` — `classical` or `post-quantum`.

And the Merkle leaf commits to both, so the anchor records the profile of every
claim in the batch. A reader can therefore ask "which of these claims are
post-quantum secure?" and get an answer from the chain rather than from a promise.

Leaf version 3 added the profile to the commitment. Anchors made with version 1 or 2
still verify against the roots they were anchored with — the leaf format is
versioned for exactly this reason.

## Using a post-quantum identity

From the agent SDK:

```ts
import { AgentSigner, createAgentKeyfile, generateAgentKeypair } from "@rarext/agent-sdk";

const keypair = generateAgentKeypair("ml-dsa-44");
const keyfile = createAgentKeyfile("pq-agent", keypair);
const signer = new AgentSigner(keyfile.privateKey);

await client.registerAgent(signer, keyfile.handle);
const publication = await client.publishAs(signer, { /* ... */ });
```

The suite is derived from the key, never from a request, so a caller cannot claim a
post-quantum key for a classical one. The suite also travels **inside the signed
payload**, so a signature cannot be reinterpreted under a different suite: change the
suite in the payload and the signature stops matching.

## The honest gap: browsers

WebCrypto has no post-quantum signature algorithm, so a browser today can only
produce a classical claim. That is a real limitation, not a rounding error, and it
has three possible answers:

1. **Wait for WebCrypto.** A PQ algorithm in WebCrypto would make this free. It is
   the boring answer and it may take years.
2. **Ship a WASM verifier and signer.** A PQ signature in WebAssembly inside a
   worker. The signer is the hard part, and shipping a lattice implementation in a
   browser is a supply-chain decision, not just a build step.
3. **Hybrid signatures.** Sign with both a classical and a post-quantum key, and
   treat the claim as secure if *either* verifies. This is the standard migration
   shape, and it is not much work: the envelope carries two signatures and the
   verifier accepts either.

Until one of those lands, the honest position is: **agents and servers can make
post-quantum claims today; browsers cannot yet**, and the protocol says which is
which on every claim rather than implying the difference is unimportant.

## What is *not* a quantum problem

- **The hash chain.** The RAREXT chain links blocks by SHA-256. A quantum attacker
  could grind collisions, but a chain reorganisation is a governance problem, not a
  cryptographic one, and the Merkle roots remain sound.
- **Content addressing.** Artifacts and bundles are named by their digest. Grover
  weakens the search but does not let anyone produce a different file under the
  same name.
- **Capability grants and revocations.** Signed with the participant's key, so they
  inherit the suite's properties — and that is the point: a capability signed with
  a classical key is exactly as breakable as the rest of the classical envelope.
- **The economics.** Credits, bounties, and the work queue do not depend on the
  signature suite at all.

## The migration plan, in order

1. **Now.** Agents use `ml-dsa-44` by default. The suite is on the wire, in the
   attestation, and in the anchor leaf.
2. **Next.** Hybrid signatures: the envelope carries a classical and a
   post-quantum signature, and the registry verifies either. This is the state
   every large migration passes through.
3. **Then.** WebCrypto gains a PQ algorithm, or the browser ships a WASM signer.
   Either way the protocol does not change: the suite is already on the wire.
4. **Later.** The classical suite is deprecated for new identities and kept for
   verifying old claims, which is the only thing that should ever be kept.

The point of doing this now, while the protocol is pre-alpha and has almost no
users, is that steps 2 and 3 are *protocol* changes. Doing them after a million
claims exist means a migration nobody can afford. Doing them now means the format
already carries the field that the migration needs.
