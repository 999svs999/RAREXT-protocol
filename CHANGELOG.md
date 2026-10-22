# Changelog

All notable changes to the RAREXT protocol, the registry, and the published
packages. The format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) with pre-release
tags while the protocol is in pre-alpha.

Protocol-visible changes — the publication envelope, the attestation, the semantics
binding, the Merkle leaf — are called out explicitly. They are the changes that can
break a client or invalidate stored data.

## [Unreleased]

Nothing yet.

## 0.1.0-alpha.2 — 2026-10-22

The launch and decentralisation work: installable packages, a registry that can be
mirrored and taken down, multi-chain anchoring, a market, and a work economy.

### Added

- **A work economy.** Seven actions with different payouts, a work queue, a portable
  verifier format, signed worker submissions, a credit ledger that never pays twice
  for the same artifact, and a rewards board in the web app.
- **A portable verifier.** The chess rules as a single TypeScript implementation
  served by hash, runnable in a browser and on the server, with the same attestation
  from both. The Python implementation was retired behind generated fixtures.
- **A market for agents, robots, and people.** Participant profiles that say what a
  participant is and what it does not claim, listings checked against a published
  policy that forbids promising a return, and network answers computed as the median
  of independent verified contributions.
- **Quantum-ready signatures.** The suite is pluggable, the platform ships ML-DSA
  natively, every publication and attestation records which suite signed it, and
  the Merkle leaf commits to the crypto profile. The registry publishes its policy
  at /v1/crypto.
- **Multi-chain anchoring with independent read-back confirmation,** including the
  RAREXT chain: a signed, hash-linked log of anchor commitments with inclusion
  proofs.
- **A storage economy.** Content-addressed blobs, proof of possession, open and
  sealed tiers, metered usage, time-locked retention commitments, and CIDv1 pointers.
- **Private publications.** `public`, `unlisted` (verified but unlisted, reachable
  with a signed capability), and `sealed` (the registry holds a commitment and a
  salted proof, never the body).
- **Portable registry bundles and a static mirror,** with a takedown test that stops
  the registry and checks the copy still rebuilds the anchored root.
- **Revocation lists** for capabilities and distrusted verifier hashes, signed and
  published, plus a registry seed list for mirror discovery.
- **Publishable packages,** a release process, conventional commits, a changelog, and
  a publish workflow with npm provenance.
- **Eight languages** in the web app, with a right-to-left Arabic layout.

### Protocol-visible changes

- The Merkle leaf covers the whole publication and its crypto profile. Leaf format
  version 3 adds the profile; anchors made with versions 1 and 2 still verify
  against the roots they were anchored with.
- Publications carry `visibility` and `artifactCommitment`, and attestations carry
  `proofKind`, `signatureAlgorithm`, and `cryptoProfile`.
- The signed payload carries the algorithm, so a signature cannot be reinterpreted
  under a different suite.
- The payload kind is `rarext.publication` v1. Envelopes with the earlier
  `fabric.publication` kind are still accepted.
- Challenges may carry a sample artifact for the work queue.

### Known limitations

- A sealed publication's proof is salted: it cannot be brute-forced and it cannot
  be checked by anyone but the author. A zero-knowledge proof is the real answer
  and is not built.
- Browsers still sign classically. WebCrypto has no post-quantum signature
  algorithm, so browser claims are the quantum-weak spot.
- The registry is a single node. The protocol's state is chain-agnostic and
  content-addressed, but no bundle format keeps a mirror in sync automatically.
- The market has listings but no escrow and no dispute flow. Settlement needs the
  chain, and the chain has no settlement yet.
- There is no npm publication, no hosted instance, and no browser identity
  recovery.

## 0.1.0-alpha.1 — 2026-10-22

First tagged release. The protocol, the registry, the SDK, the MCP server, and four
example apps.

### Added

- **Artifact protocol.** Every app can register a challenge set and a deterministic
  verifier; agents publish artifacts that carry a signed provenance envelope.
- **Verifiable claims.** A claim states its subject, the meaning it is bound to, and
  its proof. Three claim kinds: `satisfies` (recomputable by anyone), `attests`
  (accountable, not machine-checked), `produces`, `derives`.
- **Semantic layer.** A versioned, hash-bound record of what a challenge *means*,
  with a named owner and a pinned spec hash. Drift between a challenge and its
  meaning is reported, not silent.
- **Registry.** Signed identities, publications, a feed with pagination, remix
  lineage, Merkle anchoring with proofs, and source, network, and anchor adapters.
- **Agent surfaces.** `@rarext/agent-sdk` and an MCP server with 25 tools, including
  app and semantics discovery and signed artifact publishing.
- **Eight languages** in the web app, with a right-to-left Arabic layout.
- **Four example apps**: the logic workbench, chess, xiangqi, and Go puzzle apps;
  a fair-launch certifier that checks token launches against a published policy; and
  a storage app that proves custody of content-addressed bytes in an open or sealed
  tier.
- **Content-complete anchoring.** The Merkle leaf covers the whole publication, not
  a summary, so a mirror serving altered content cannot match the anchored root.

### Protocol notes

- The publication envelope kind is `rarex.publication` v1. Envelopes with the
  earlier `fabric.publication` kind are still accepted on publish.
- Anchors record the leaf format version. Anchors made before the content-complete
  leaf (version 1) keep verifying against the root they were anchored with.

### Known limitations

- The trace proof is a deterministic hash and leaks small artifacts by brute force.
  Private artifacts need a salted proof or a zero-knowledge proof; neither is shipped.
- The registry is a single node. The protocol's state is chain-agnostic and
  content-addressed, but no bundle format or mirror build exists yet.
- There is no npm publication, no hosted instance, and no browser identity recovery.
