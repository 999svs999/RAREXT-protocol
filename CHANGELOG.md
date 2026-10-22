# Changelog

All notable changes to the RAREXT protocol, the registry, and the published
packages. The format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) with pre-release
tags while the protocol is in pre-alpha.

Protocol-visible changes — the publication envelope, the attestation, the semantics
binding, the Merkle leaf — are called out explicitly. They are the changes that can
break a client or invalidate stored data.

## [Unreleased]

### Added

- **The durability ledger.** `apps/api/src/durability.ts` places erasure shards on
  independent holders, refuses co-location, challenges with a nonce-bound Merkle leaf
  proof, audits live holders against a tier (`ephemeral` 1, `pinned` k+1, `durable`
  k+m), and repairs any failed shard from k survivors with read/write accounting. 13
  tests, and `npm run demo:durability` runs the whole sequence: 6/6 live, lose one,
  5/6 under-replicated, repair, 6/6, payload matches.
- **A holder wire protocol.** `apps/api/src/holder-server.ts` stores shard bytes under
  their own digest, answers nonce-bound leaf challenges with a Merkle path, and never
  learns the blob hash. `npm run holder` starts one; `httpHolder()` is the client, so
  placement, challenges, and repair work across processes. Three transport tests run
  eight holders over HTTP, stop one, watch the audit degrade, and repair onto a
  reachable spare.
- **Signed placement records.** `apps/api/src/placements.ts` signs a placement with the
  steward's key, embeds the public key, and chains each repair as a new record
  (`sequence` + `previous`). `POST /v1/placements`,
  `GET /v1/placements/:blobHash`, and `GET /v1/placements/:blobHash/history` expose the
  chain; a file-backed registry verifies records and refuses forks. `RFC 0005`
  documents the protocol and its trust boundaries.
- **Scheduled retention challenges.** `apps/api/src/durability-schedule.ts` challenges
  every placed blob on an interval, records each run, reschedules only after the run
  finishes, and shares an in-flight run between callers. The node enables it from
  `RAREXT_HOLDERS` (`id=url,…`) and `RAREXT_CHALLENGE_INTERVAL_MS`; `GET /v1/durability`
  exposes the schedule and audits, `POST /v1/durability/challenge` runs a pass on demand.
  The ledger is rebuilt from persisted placement records on boot. 7 new tests.
- **Durability on the publication itself.** When an artifact lists blobs, the API attaches
  a `durability` observation to the publication (and to feed/build responses): tier, the
  tier's required count, the live count from the last challenge, `unplaced` /
  `unverified` / `ok` / `under-replicated`, and the `placementDigest` that pins the signed
  record used. It is computed on read, not signed by the author, and reports the weakest
  tier across a manifest. 7 new tests.
- **Storage benchmark harness.** `npm run bench:storage` generates a deterministic,
  hash-locked 99.96 MiB corpus (video, photos, audio, text, source, 3D), runs x265,
  AV1, zstd, and the shipped 4+2 erasure path, and writes a Markdown table with
  stored bytes, exactness against the reference digest, PSNR/byte error for bounded
  rows, verify and decode time. A learned runner must declare its decoder size, which
  is added to the storage cost; a declared-lossless mismatch is downgraded to
  `bounded`. Full run: about 66 s on the reference laptop, under a 15-minute enforced
  budget. See `bench/storage/README.md` and `RESULTS.md`.
- **Trust model RFC.** `rfcs/0007-trust-model.md` states what each claim proves, what the
  registry, an app operator, an independent verifier, a holder, and an anchor can lie
  about, the composition rules a reader should follow, and what Trac anchoring would and
  would not add. Documentation only; no behavior change.
- **Store migrations and verified backups.** Snapshots now carry an enforced version:
  an older snapshot moves through an ordered migration chain, and a newer one is
  refused instead of partially loaded and overwritten. `npm run backup:create`
  bundles every file under the data directory (store, placements, operator records)
  with a digest per file and one over the manifest; `backup:verify` detects a changed
  byte or path, and `backup:restore` refuses a non-empty target without `--force`.
  A corrupt snapshot now stops the boot instead of starting empty. 10 new tests and
  `docs/OPERATIONS.md`.
- **Automatic repair on the schedule.** A scheduled or on-demand challenge run now
  heals `under-replicated` blobs: rebuild from any `k` survivors, place on a spare
  holder, challenge the rebuilt shard again, and report `repairs` (filled, bytes read,
  written) and `repairErrors` (for example, no spare holder). A failed repair is
  recorded and the next tick retries; it never stops the schedule. The node enables
  repair by default; the scheduler class does not. 3 new tests.
- **Independent verifier operators.** A verifier can register a self-signed operator
  record (`POST /v1/verifier-operators`) for one app or `*`, and a publisher can attach
  that operator's signed attestation. The registry accepts it without a local verifier,
  stores the attestation exactly as signed, records `verification: "operator"` plus the
  key id and signature, and `/v1/verify` re-checks it with `recomputed: null`. The
  envelope, bindings, and trust trade are in `RFC 0006`. 4 new tests.

## 0.1.0-alpha.3 — 2026-10-22

### Fixed

- **The mirror verifier hashed pairs by concatenation.** `apps/web/src/verify.ts`
  folded `left + right` instead of hashing the pair, so any publication with more
  than one leaf produced a root that did not match the registry. It now runs the
  same async SHA-256 fold as the canonical `merkle.ts`, on every tree shape.
- **The chain adapter's read-back confirmation silently degraded to `skipped`** for
  blocks with more than one root, because its local `merkleRoot` used the same
  broken fold. The duplicate was deleted and the adapter now imports the shared
  implementation.
- **Capabilities and revocations were verified with ECDSA only.** Both routes now
  use the suite-aware `verifyPayload`, so ML-DSA authors can grant capabilities and
  revoke publications.

### Added

- **Erasure-coded storage.** Systematic Reed–Solomon over GF(256) (`k`-of-`n`), with
  shard digests that bind index, parameters, original length, and payload digest.
  Shards are ordinary content-addressed blobs; any `k` rebuild the file and the
  reconstruction is checked against the committed digest. 14 tests.
- **`docs/PRIOR-ART.md`** — what exists (Arweave, Filecoin, Ordinals, EIP-4844,
  Celestia, IPFS, Automerge, neural representations), what none of it does, and the
  physics we do not claim.
- **`docs/STORAGE-FRONTIER.md`** — the representation research agenda: the three
  legitimate trades, the exactness problem, and falsifiable acceptance criteria.
- **A public landing page** describing web4, the four steps of the protocol, and what
  "free" does and does not mean, plus a contributor path in the README.
- **`docs/WEB4.md`** — the definition of the network these pieces add up to, what
  has to be true for the name to hold, and the primitive that is still missing.

### Removed

- **The CI publish path.** The untracked workflow files and the `publish:ci` script
  are gone. There is no dependency on GitHub Actions or an npm registry: `npm run
  check`, `test:examples`, `verify:packages`, and `test:takedown` run locally, and the
  packed tarballs attach to the release.
- **Internal dependency ranges now move with the version.** `sync-version.mjs`
  rewrites `@rarext/*` ranges and `--check` fails when they drift.

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
