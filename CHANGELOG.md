# Changelog

All notable changes to the RAREXT protocol, the registry, and the published
packages. The format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) with pre-release
tags while the protocol is in pre-alpha.

Protocol-visible changes — the publication envelope, the attestation, the semantics
binding, the Merkle leaf — are called out explicitly. They are the changes that can
break a client or invalidate stored data.

## [Unreleased]

- **External-agent MCP storage integration test.** `npm test` now runs
  `apps/api/test/mcp-storage-agent.test.ts`, which starts six token-protected holders,
  the API, and a pin service, then drives the real MCP stdio server through put, get,
  challenge, audit, and pin as an outside client. The test asserts the exact payload,
  all six live challenges, an `ok` audit, and a stored pin.


### Security

- **Storage challenge, transport, placement, and pin hardening.** Challenge responses
  now bind to the requested leaf index and a fresh nonce, reject replays, cap nonce and
  proof sizes, and require an exact Merkle depth. `httpHolder` verifies shard bytes
  against `storedAs`, caps responses, and times out; holder and pin servers support
  optional bearer tokens, bounded bodies, constant-time comparison, and bounded caches.
  Placements reject co-location, oversized or inconsistent shards, impossible required
  counts, and malformed claims before adoption. The pin store recomputes CIDs and writes
  metadata atomically. `docs/STORAGE-SECURITY.md` and RFC 0012 record the model and the
  still-open findings (confidentiality, retrievability, quotas/TLS/identity, lying
  verifiers, orphan GC). Eight security tests.

### Fixed

- **EVM anchor read-back calldata.** `apps/api/src/chains/relay.ts` now calls
  `anchors(uint256)` with the Keccak selector and a directly ABI-encoded id, instead of
  SHA-256 hashing the signature and hex-encoding the ASCII calldata. It also accepts a
  bare numeric relay reference and refuses to guess index 0 when no id is present. Three
  tests pin the calldata against ethers, cover both reference shapes, and cover the
  no-id skip.

### Added

- **EVM anchor audit trail and guarded funded-testnet deployment.** `contracts/AUDIT.md`
  records the pinned source and toolchain, the external-audit-not-performed status,
  an internal finding and disposition register, a manual auditor checklist, and the
  blocked live-deployment gate. The contract now rejects a zero owner at
  initialization. The deploy script verifies proxy and implementation code, the
  ERC-1967 implementation slot, and publisher read-back. `npm run deploy:anchor:testnet`
  refuses known mainnet chain ids, requires explicit testnet acknowledgement, runs
  the existing deploy script, and writes a record whose audit flags keep live
  deployment blocked. Tests cover zero-owner initialization, the 512-byte metadata
  boundary, the 14-publication compatibility cap, publisher revocation, and the
  deployment guard. No external audit was performed and no contract was deployed.

- **Game-native state migration skeleton.** `npm run plan:game-state` reads a
  registry snapshot and writes a deferred, no-op preservation plan with collection
  counts, field inventories, canonical digests, unmanaged top-level fields, and
  explicit gaps for active builds, challenges, reputation, and ratings. `--bundle`
  writes every durable record and optional challenge export verbatim for a future
  target. The command never writes the source and refuses `--execute`/`--cutover`.
  Seven tests cover field retention, deterministic digests, challenge export,
  version migration, malformed input, and the deferred gaps. RFC 0017 records the
  cold-cutover runbook, inherited RESET/trac-peer constraints, rollback boundary,
  and the remaining target-schema gate.

- **Sponsored challenges.** A configured community member can sign a
  `rarext.challenge-sponsorship.v1` payload and POST it to
  `/v1/challenges/sponsored`. The registry verifies the member's P-256 or ML-DSA key,
  binds a timestamp and nonce, stores the challenge as `status: "sponsored"`, exposes it
  through the existing challenge API, and emits `rarext.challenge.v1` to an optional
  webhook. The workbench lists sponsored challenges and badges matching feed items. The
  member roster is supplied through `RAREXT_SPONSOR_MEMBERS`; no live community directory
  ships with this repository, and the running registry does not yet persist sponsored
  challenges across restarts. Four tests cover the signed flow, webhook delivery, replay
  and signature rejection, and the unconfigured state.

- **EVM anchor contract and local deployment path.** `contracts/RarextAnchor.sol` is a
  UUPS-upgradeable, two-step-owned, pausable append-only anchor log. It stores a unique
  root, the metadata hash, the publisher, and the timestamp; emits `AnchorPublished` with
  the bounded metadata; and exposes `anchors(uint256)` plus `anchor(bytes32,bytes32[])` for
  the registry's existing EVM adapter. Ten local-EVM tests cover publication, duplicate
  roots, authorization, metadata bounds, pausing, ownership, state-preserving upgrades, and
  direct implementation safety. `npm run deploy:anchor` deploys an implementation and an
  ERC-1967 proxy only when the RPC chain id matches an explicit expected value. The
  contract is **not deployed or audited**; the runbook in `contracts/README.md` records
  what remains.

- **RFC 0016: appchain evaluation.** Evaluates a RAREXT appchain against staying on
  anchored transports. It uses the pinned RESET/trac-peer wire format as primary
  evidence for why native anchor moves are a protocol change, and recommends deferring
  a chain behind a measurable demand, economics, and validator-supply gate.

- **$BEM balance in the web UI.** The community page accepts a BSC address and shows its
  read-only `$BEM` balance from `GET /v1/tapeout/status?address=`. The status response now
  includes `bemDecimals` from `BEM_DECIMALS` (default 18), and the browser bundle formats the
  base units. No signing and no write path.

- **Trac anchor transport boundary.** `apps/api/src/adapters/trac-transport.ts` defines
  `TracAnchorTransport` and the adapter announces through it; `GET /v1/adapters/trac` reports
  the transport kind. The HTTP webhook (`TRAC_ANCHOR_URL`) is the shipped, tested transport.
  The native RESET/trac-peer transport is recorded as blocked: message moves are fixed
  `{v,t,b,h,p,w}` types and MSB transactions only carry a strict `{op,to,amount}` transfer
  command, so there is no anchor move or memo to carry a root. Evidence is in RFC 0001 §4.

- **Trac identity-link prototype.** `POST /v1/identity-links` accepts an optional
  `externalProof` for `network: "trac"`. The proof is a
  [RESET](https://github.com/Trac-Systems/reset) `reset-mcp-login` Ed25519 challenge
  whose `nonce` is `sha256(canonicalize(payload))` and whose `audience` must match the
  RAREXT origin. Trac addresses may be 64-hex or `trac1…` bech32m and are normalized
  before verification. `AgentSigner.identityLinkPayload` and `identityLinkBinding`
  build the payload, and `RarextClient.linkIdentity(payload, signature, externalProof)`
  submits it. The adapter verifies the signature offline; no Intercom round trip and no
  canonical-identity migration yet. Run `npm run example:trac-identity` for the full flow.

- **Read-only TapeOut circuit/component indexer.** `GET /v1/tapeout/circuits`
  reads bounded ERC-721 `Transfer` and ERC-1155 `TransferSingle`/`TransferBatch`
  logs, reports the latest circuit owners and component movements, and returns
  `configured:false` without `TAPEOUT_CIRCUIT_CONTRACT` or
  `TAPEOUT_COMPONENT_CONTRACT`. It never signs or writes.

- **MCP storage tools and a runnable network example.** The MCP server now exposes
  `rarext_storage_put`, `rarext_storage_get`, `rarext_storage_challenge`,
  `rarext_storage_audit`, and `rarext_storage_pin`. Put encodes and places shards on the
  configured holders, signs the placement with the local agent key, and registers it;
  get digest-checks shards before rebuilding; challenge and audit share the process
  ledger; pin computes the CID and calls the pin service. The holder and pin bearer
  tokens are supported through `RAREXT_HOLDER_TOKEN` and `RAREXT_PIN_TOKEN`.
  `examples/mcp-storage` drives the real stdio server end to end against six
  token-protected holders, an API, and a pin service. One integration test covers the
  same verbs directly.

- **Storage roadmap completion (Issues #6–10 closed).** Proof of Retrievability
  specification (RFC 0013), byte and request quotas with rate limiting for holders and
  pins, signed independent audit attestations (RFC 0014), and orphan shard garbage
  collection with grace period and dry run. Added `npm run net`, a local storage
  network runner, property/fuzz tests over erasure, placement, and GC, and a 1 GiB
  throughput/memory benchmark.

  The sealed tier is wired into the real MCP put path. `rarext_storage_put` with
  `sealed:true` encrypts with HKDF-SHA256 + AES-256-GCM (matching RFC 0015) before
  erasure coding, records the salt/IV/tag in the signed placement, and the shard
  digests and Merkle roots cover ciphertext; `rarext_storage_get` decrypts client-side.
  `POST /v1/blobs` rejects `tier:"sealed"` instead of mislabelling plaintext. Covered by
  `apps/api/test/sealed-path.test.ts` and `examples/sealed-storage`.

  Still not a production confidentiality claim: no key wrapping, rotation, per-tenant
  isolation, or envelope review, and `RAREXT_SEALED_SECRET` is a raw caller-held secret.
  Do not upload real secrets or describe sealed storage as audited encryption yet.

- **Raw, bounded shard transport over HTTP.** Holders gained
  `PUT/GET /v1/holder/shards/:hash/raw`: uploads stream the request body to a temp file
  while hashing it, downloads stream the file with a length, and challenge leaves are
  computed from the file rather than a whole-shard buffer. `httpHolder.putFile/getFile`,
  `DurabilityLedger.placeStreamed/retrieveStreamed`, and streamed placement metadata
  (`chunkBytes`, `chunks`, `chunkDigests`) make the 1 GiB file path placeable over real
  holders. `npm run bench:network` measured a 242 MiB client peak and 94 MiB holder peak
  at 1 GiB; the whole-shard JSON path cannot accept 1 GiB because of the 32 MiB body cap.
  Key management for the sealed tier remains open.

- **Streamed placements are signed, auditable, repairable, and proven over the network.**
  `DurabilityLedger.repair` now rebuilds a lost streamed shard from k survivor files with
  `reencodeStreamedShard`, uploads only that shard through raw PUT, and re-audits it;
  `BlobStore.has` no longer reads the whole file just to answer a probe. `npm run net`
  adds a third scenario: an 8 MiB file is chunked at 2+1, placed over raw HTTP, signed
  with `AgentSigner`, registered in `PlacementRegistry`, reloaded from a fresh registry,
  challenged, killed, repaired, re-audited, and retrieved byte-for-byte. Still missing:
  the MCP put path remains 8 MiB in-memory, and streamed repair is not load-tested at
  100 GiB.

- **Bounded placement retention and retry-safe puts.** `DurabilityLedger` accepts a
  `maxPlacements` limit and evicts the oldest placement and its witnesses; `forget()`
  releases one explicitly. The soak uses a limit of 24, a zero-grace orphan GC sweep,
  and up to six put attempts with 250 ms-4 s backoff. Its 604 s rerun completed 5,910
  puts at 100.0% (the prior run was 99.9%), 145 repairs and 145 re-audits at 100%, with
  the ledger pinned at 24 and live JS heap near 10.5 MiB. Client RSS reached a bounded
  median of 170.7 MiB after warm-up; the residual is V8 reserved and external/allocator
  memory, not live heap. Defaults remain unlimited for compatibility.

- **Ten-minute soak and chaos run.** `npm run bench:soak` kept eight token-protected
  holders busy for 611 s with continuous puts, challenges, audits, repairs, and
  retrievals while killing and restarting a random holder every 15-30 s. It recorded
  5,507 puts (99.9%), 5,507 retrievals (100%), 143 repairs (100%), 143 successful
  post-repair re-audits, 21 kills/restarts, and peak client/holder RSS of 222/119 MiB.
  The script writes `bench/storage/SOAK.md`/`SOAK.json` with rates and memory-over-time.
  This is loopback on one machine with reused holder identities; it is not a durability
  proof, and the caveats are printed in the report.

- **`npm run net` now proves the sealed tier end to end.** After the open scenario, it
  encrypts a 64 KiB payload with AES-256-GCM/HKDF-SHA256 before erasure coding, places
  it on three HTTP holders, scans every holder directory for a plaintext marker (zero
  hits, all shard hashes match), kills a holder, repairs onto a spare, then retrieves
  and decrypts back to the original bytes. The documented output is a real run. This is
  still a demo of the envelope, not a key-management or confidentiality claim.

- **Bounded-memory erasure for large payloads.** `apps/api/src/erasure-stream.ts`
  stripes a file into fixed chunks, encodes one chunk at a time, and appends shard
  blocks to disk, so peak memory follows the chunk size rather than the payload size.
  `decodeShardsToFile` reconstructs any `k` of the shard files and verifies both the
  per-chunk digest and the whole-payload digest. At 1 GiB and 4+2, peak RSS fell from
  3243 MiB (in-memory `encodeBytes`) to 393 MiB while remaining byte-exact (8.3x lower);
  encode throughput moved from 11.2 to 8.6 MiB/s and decode from 48.6 to 23.2 MiB/s.
  Holders now also accept raw `PUT`/`GET` of shard files, and
  `DurabilityLedger.placeStreamed`/`retrieveStreamed` use that transport. Over real
  loopback holders the client peak stayed at about 250 MiB for both 64 MiB and 1 GiB,
  while the whole-shard JSON path needed 676 MiB for 64 MiB and cannot store 1 GiB at
  all. Streamed repair now rebuilds one shard at a time from k survivors. See
  `bench/storage/RESULTS.md` and
  `apps/api/test/erasure-stream.test.ts`.

- **Storage failure hardening and multi-loss repair accounting.** `BlobStore` writes
  blobs and its index through unique temp files and renames, rolls back a new blob when
  the index write fails, and no longer swallows index errors. Durability repair reads
  exactly `k` survivors, stages every replacement before moving the signed placement,
  adopts an already-written shard on retry, and fails loudly on a corrupt survivor. Five
  failure-injection tests cover partial repair writes, tampered shards, crash/restart,
  holder churn with two losses, and disk/index failures; `docs/HARDENING.md` records the
  recovery behavior and the remaining limits (no `fsync`, orphan shards, whole-payload
  memory, possession not retrievability). The repair benchmark now takes `--losses`;
  a 1 GiB `4+2`, two-loss run measured 1.000 GiB read + 0.500 GiB written = 1.500x,
  matching the MDS floor `1 + m/k`.

- **Documentation index.** `docs/README.md` links every document in `docs/` exactly
  once, gives reading orders for app developers, verifier operators, and researchers,
  names the draft or stale documents, and points back to the storage frontier. The root
  README links it.

- **Open Graph image for the landing page.** `site/og.png` (1200×630) carries the
  brand mark, headline, and one-line promise; `site/index.html` now declares
  `og:image`, dimensions, alt text, and a large Twitter card. No build step.

- **Runnable erasure-coding example.** `examples/erasure/main.ts` creates 1 MiB,
  encodes `4+2`, stores all six shards through `BlobStore`, deletes one, and rebuilds
  from the five survivors with digest assertions. Linked from the storage contract.

- **Verifiable fair-launch trajectories.** `GET /v1/launches/:mint/trajectory?chain=`
  groups public `launch.plan` attestations by mint and chain, orders them by block,
  separates policy segments, flags duplicate blocks, and reports safe/unsafe checks and
  anchor coverage. A failed check makes the verdict `not-safe`; the series never claims
  safety past its latest check. `apps/api/src/trajectory.ts`, five tests, docs.

- **Published negative results for both research directions.**
  `bench/storage/NEGATIVE-RESULTS.md` records the held-out Huffman expansion (0.64x,
  14.15 MiB total for 9.00 MiB) and the degree-10 Legendre fidelity failure (2212.70x
  ratio, 19.79 dB, 98.84% differing bytes, no residual). It states the acceptance
  criteria, what would overturn each result, threats to validity, and exact
  reproduction. Roadmap research item checked.

- **A self-hosted pinning service for the content adapter.** `apps/api/src/pin-server.ts`
  accepts a bundle and its CID, recomputes the CID from the bytes, stores them under
  `RAREXT_PIN_DIR`, and serves pin metadata/content over HTTP. The adapter now sends the
  bundle bytes, so the service can verify what it pins. `npm run pin`; RFC 0011; five
  tests covering restart, CID mismatch, HTTP round-trip, adapter integration, and refusal.

- **Data availability sampling for media.** `apps/api/src/das.ts` commits 4 KiB chunks
  as Merkle trees over the shards a placement already proves, samples distinct chunks,
  and verifies each byte and proof. It reports the exact hypergeometric miss bound
  `C(N-a,t)/C(N,t)` and the conservative `(1-f)^t`; for 9,216 photo chunks, 44 samples
  (176 KiB) detect 10% withholding with 99% confidence. A holder route serves one leaf
  and its proof. RFC 0010 states the bound, its assumptions, and its non-claims. Five
  tests.

- **Learned and parametric baselines in the storage benchmark.** `bench/storage/learned.mjs`
  adds an order-1 context Huffman codec whose 256×256 model is stored and counted as the
  decoder, and a tensor-product Legendre fit whose coefficients are the entire artifact.
  Measured on the fixed corpus: adaptive Huffman 2.40x on text and 3.02x on source
  (exact), the same model trained on `source.js` and held out on `text.txt` 0.64x
  (negative cross-slice result), and degree-10 Legendre 2212x stored size at 19.79 dB
  PSNR with 98.84% of bytes differing (negative fidelity result). Decoder bytes are now
  counted for every non-classical row, not only `kind: "learned"`. Three tests.

- **Repair-bandwidth measurement at 1 GB.** `bench/repair` encodes a deterministic
  1 GiB payload with the shipped 4 + 2 code, loses a shard, rebuilds it from four
  survivors, and checks both digests. Measured: 1.000 GiB read, 0.250 GiB written,
  1.250 GiB total for a single loss. The `< 1/k` target in the storage contract is
  arithmetically unreachable for an MDS code; the README states the floor (`1 + 1/k`) and
  what a local-reconstruction code would require instead. This run also exposed and fixed
  a real bug: shard digests converted bytes to a hex string, which throws beyond ~512 MB.
  Large shards now stream into the hash with a distinct domain, so a 1 GiB payload
  encodes, verifies, and repairs.

- **RFC 0009: representation kinds.** Defines `exact`, `bounded`, and `generative`
  artifacts, the signed representation record, the verifier result block, semantics
  declarations, display rules, and the acceptance criterion before a research codec can
  become a protocol claim. Documentation only; no envelope change ships yet.

- **Leaderboard UI and capability-based discovery.** `/leaderboard.html` ranks verified
  builds with app and challenge filters, links each row to its signed envelope, and opens
  an unlisted artifact from an artifact id plus capability token. Filters and capability
  inputs are shareable through the URL. One test covers static serving and the home-page
  link.

- **Key rotation and delegated publishing keys.** A rotation record is signed by the key
  being retired and moves the handle to a new key, optionally changing suite; the old
  key stays resolvable so existing publications and capabilities keep verifying, while a
  new publish signed by it is refused. A delegation record lets the root key authorize a
  second key to publish for the handle, optionally scoped to one app and an expiry;
  delegated publications record both `authorKey` and `delegatedBy`. Rotating the root
  retires outstanding delegations. Snapshot version 2 stores rotation and delegation
  history (migration 1 → 2 adds empty arrays). SDK helpers: `rotateIdentity`,
  `delegations`, `delegateKey`, `rotations`, `keyRotationPayload`, `delegationPayload`.
  RFC 0008 documents the records and their trust boundaries. 6 new tests.

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
