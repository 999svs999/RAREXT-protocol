# Prior art

The protocol is easy to describe in a way that sounds like things that already
exist, and that is a problem: a reviewer who has seen Arweave will assume this is
Arweave with a different logo. This document records what was checked, what those
systems actually do, what they do not do, and the narrow composition this project
claims as its own.

It is deliberately unflattering. A claim is only worth making if the boundary is
drawn honestly.

## What was checked

Search and reading across four areas: permanent on-chain storage, data
availability, content addressing and replicated databases, and provenance /
attestation standards. The sources are listed at the end. This is a survey, not a
patent search; it is meant to keep us from claiming somebody else's work, not to
establish legal novelty.

## The landscape

### Permanent or decentralized storage

| System | What it does | What it does not do |
| --- | --- | --- |
| **Arweave / ArDrive** | Uploads any file — images, video, apps, AI weights — to a blockweave. Miners prove replication; an endowment pays storage from the fee, priced as roughly 20 replicas for 200 years, assuming a Kryder+ decline in storage cost. | No meaning attached to the bytes, no computation over them, no market for verifying them. The unit of trust is "the bytes exist", not "the claim is true". |
| **Filecoin / Storj / Sia** | Storage contracts with proof-of-replication and proof-of-spacetime; a client pays a provider to hold data. | Storage rental only. No semantic layer, no portable proofs about what the data means. |
| **Bitcoin Ordinals / Inscriptions** | Arbitrary content (images, text, video) embedded in taproot witnesses, in practice up to a few megabytes, larger files chained with BCAT. | Genuinely on-chain and permanent, but expensive per byte, not queryable, and no verification of content semantics. It is a publishing medium, not a database. |

### Commitments and availability

| System | What it does | What it does not do |
| --- | --- | --- |
| **EIP-4844 blobs** | Commits a large amount of data with a KZG commitment; consensus nodes persist blobs for a bounded period (initially about 18 days). | Explicitly *not* permanent storage. It solves data availability for rollups, not durable media. |
| **Celestia / EigenDA** | Erasure-coded data availability with sampling, so a light client can check that data exists without downloading it. | Availability only. They neither interpret nor verify the content, and they are not a media database. |
| **IPFS / Swarm** | Content addressing: any object becomes a hash; peers fetch it from whoever has it. | No durability guarantee and no economics. Pinning is a promise made by a person. |

### Replicated, agent-centric databases

| System | What it does | What it does not do |
| --- | --- | --- |
| **Holochain** | Agent-centric source chains in a DHT; every participant is a node. | No global verifiable-computation market; validation rules are app-specific and not portable across ecosystems. |
| **Ceramic / GUN / Automerge** | Shared, eventually consistent data with signed operations and CRDTs. | Convergence, not verification. Nothing proves a computation over the data was done correctly. |

### Provenance and attestation standards

| System | What it does | What it does not do |
| --- | --- | --- |
| **C2PA / Content Credentials** | Signed provenance for media: who captured or edited an image, with a manifest bound to the content. | A signature says who claimed it; it does not let a third party recompute the claim. No economy, no agent participation. |
| **SLSA / in-toto** | Attestations about how software was built, signed by the builder and checkable by a policy. | Build supply chain only; not a general artifact or media protocol, and no market. |
| **W3C Verifiable Credentials** | Portable, signed claims about a subject, issued by an entity. | A credential is trusted through its issuer. There is no deterministic recomputation and no notion of a verifier's own attestation. |

### Representation and compression

| System | What it does | What it does not do |
| --- | --- | --- |
| **Implicit neural representations** (SIREN, NeRF-style) | Represent an image or volume as the weights of a small network that reconstructs it. The closest real instance of "the data is an equation". | The weights *are* data and must be stored; reconstruction is lossy and bounded by the information content of the target. |
| **DNA storage** | Encodes bytes in synthesized DNA; very high density in theory. | Slow, expensive, not suitable for hot data, and not a blockchain. |

## What none of them do

Every system above answers at most one of these questions:

1. **Does the artifact have a published meaning, with a named owner and a versioned hash?** Arweave and Filecoin say nothing about meaning. C2PA describes provenance but not an executable meaning.
2. **Can a third party recompute the claim, not just check a signature?** Verifiable Credentials and C2PA stop at the issuer's signature. SLSA recomputes a build from a recipe, but only for builds.
3. **Does the claim say how strong it is?** A salted proof that only its author can check is weaker than one anyone can recompute, and the difference is usually invisible.
4. **Is there a market where independent participants are paid to verify and replicate?** Filecoin prices storage; nobody prices verification of a claim.
5. **Can a claim be revoked without deleting the history that it was made?** Transparency logs have this property; storage networks generally do not.

The composition of all five — in one protocol, with one portable verifier that
runs identically in a browser and on a server — is what this project claims. We
have not found that composition in a shipped system.

## What this project does *not* claim

These are settled by physics or mathematics, and no implementation changes them.
Keeping the list explicit is how we avoid repeating claims that cannot be true.

- **A hash is lossy.** SHA-256 maps any input to 256 bits. A hash proves identity;
  it cannot reconstruct the bytes.
- **Shannon's bound.** No lossless encoding is smaller than the entropy of the
  data plus its decoder. "Stored as an equation" only wins when the equation — the
  model — is shared and the data is predictable.
- **The Holevo bound.** n qubits yield at most n classical bits on readout.
  Quantum memory is not a larger disk.
- **QR capacity.** A QR code holds about 2,953 bytes. "Video in a QR code" means a
  link, or a fraction of a second at a few pixels.
- **Free is not a property of storage.** Bytes occupy disks owned by somebody who
  pays for power and replacement. A protocol can choose who pays and what is
  promised; it cannot make the cost disappear. Arweave's endowment is a financial
  model for this, and it is the honest comparison — not "free".

## How to test the claim

Three questions a reviewer should ask, with the answers this repository is
supposed to give:

1. **Why not Arweave?** Arweave proves the bytes exist. It does not prove what
   they mean or that a computation over them was performed correctly. See
   [`SEMANTICS.md`](SEMANTICS.md) and [`APP-PROTOCOL.md`](APP-PROTOCOL.md).
2. **Why not IPFS plus a database?** IPFS has no durability guarantee, and a
   database makes the operator the source of truth again. See
   [`MIRRORS.md`](MIRRORS.md) and the takedown test.
3. **What breaks at a thousand times the scale?** On-chain bytes. The answer is
   commitments plus erasure-coded shards plus sampling, not "everyone stores
   everything". See [`STORAGE-ECONOMY.md`](STORAGE-ECONOMY.md).

If any of those answers stops being true, the differentiation has quietly
disappeared and this document should be updated rather than the claim.

## What is being built next

The gap between "we have a commitment" and "the network can prove it still holds
the bytes" is the durability contract:

- erasure-coded shards, so any k of n reconstruct a blob (implemented in
  `apps/api/src/erasure.ts`);
- placement across independent holders with a target replica count;
- retention proofs on a schedule, not only at upload;
- a durability tier on every publication — `ephemeral`, `pinned`, `durable` —
  with the actual replica count exposed, so "forever" is a number a stranger can
  audit;
- pricing per byte-month, so the cost has an owner.

Anything that claims permanence without a number here is marketing.

## Sources

- Arweave lightpaper, yellow paper, and protocol documentation —
  <https://www.arweave.org/files/arweave-lightpaper.pdf>,
  <https://docs.arweave.org/developers/development/overview>
- ArDrive, "Pay once, store forever" — <https://ardrive.io/>
- EIP-4844, Shard Blob Transactions — <https://eips.ethereum.org/EIPS/eip-4844>
- Ethereum, blockchain data storage strategies —
  <https://ethereum.org/developers/docs/data-availability/blockchain-data-storage-strategies/>
- Ordinals and Bitcoin inscriptions — <https://seb.stanfordblockchain.xyz/meta-protocols/ordinals>,
  <https://arxiv.org/html/2401.17581v1>
- Celestia — <https://celestia.org/>; EigenDA — <https://www.eigenlayer.xyz/>
- Filecoin — <https://filecoin.io/>; Storj — <https://www.storj.io/>; Sia — <https://sia.tech/>
- IPFS — <https://ipfs.tech/>; Swarm — <https://www.ethswarm.org/>
- Holochain — <https://www.holochain.org/>; Ceramic — <https://ceramic.network/>;
  Automerge — <https://automerge.org/>
- C2PA — <https://c2pa.org/>; SLSA — <https://slsa.dev/>; in-toto — <https://in-toto.io/>;
  W3C Verifiable Credentials — <https://www.w3.org/TR/vc-data-model/>
- QR capacity — <https://www.qrcode.com/en/about/version.html>
- Holevo bound and quantum readout — <https://www.qubitdecoded.com/track1-quantum-basics/section5-the-full-picture/26-misconceptions.html>
- Shannon, "A Mathematical Theory of Communication" (1948)
