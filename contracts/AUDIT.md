# RarextAnchor audit trail

> **External audit: NOT PERFORMED.**
>
> **Auditor review: REQUIRED.**
>
> **Live deployment: BLOCKED.**
>
> **Funded testnet deployment: allowed only through the guarded script, with no
> value and no production claim.**

This document is an audit trail, a review scope, and a manual checklist. It is
not an audit report, and no external firm has reviewed this contract. The
contract is not deployed to any chain. Do not describe it as audited or live.

## Baseline

| Item | Value |
| --- | --- |
| Contract | `contracts/RarextAnchor.sol` |
| Contract version | `1.0.0` |
| Original implementation commit | `33e3cbb` (`feat(contracts): add the RAREXT EVM anchor contract`) |
| Original source SHA-256 | `94e14312a017178c358284ffd52429f217948757a30a83a84ad7754f7c2eb656` |
| Current source SHA-256 | `de959d17ce44f9e3d24adda074adbf1e67eacf6e89de97a90322595586655162` |
| Git blob | `7a8e733f2f0eac0f52d93d85441358b7b1724e33` |
| Creation bytecode SHA-256 | `9923a601128717344f060b98f3f2679fe749be42dabbcd510a24d44be9d558a9` |
| Runtime bytecode SHA-256 | `4966357a6af858713d53d329ca52e4ac117d3e4e8ec00e73bcce495b9a7d62a1` |
| ABI SHA-256 | `8947e90e961a225d558a26fe052ba88d13181c46de94ca12f9f28df3363a9d79` |
| Compiler | `solc 0.8.38` |
| Optimizer | enabled, `runs: 200` |
| EVM target | `cancun` |
| OpenZeppelin Contracts | `5.0.2` |
| OpenZeppelin Contracts Upgradeable | `5.0.2` |
| Proxy | OpenZeppelin `ERC1967Proxy` |
| Tests | `npm run test:contracts`; `npm test` includes the suite |

The current source hash covers the zero-owner initialization fix in finding
F-01. It does not represent an external audit baseline until an auditor records
it.

Verify the whole baseline (source, git blob, bytecode, ABI) with the pinned
toolchain:

```bash
npm run audit:baseline
```

The script compiles with the checked-in settings, hashes the creation and runtime
bytecode and the ABI, and fails when any value differs from this table. It is also
run by `npm run test:contracts`. A source or dependency change that is not
recorded here fails the check instead of being silently reviewed. To inspect a
single file by hand:

```bash
shasum -a 256 contracts/RarextAnchor.sol
git hash-object contracts/RarextAnchor.sol
```

The deployment record written by the testnet script captures the source hash,
git commit, toolchain versions, addresses, transaction hashes, and audit flags at
the moment of deployment. A record is evidence of what was deployed, not evidence
that an audit occurred.

## Scope

In scope:

- `RarextAnchor` storage, initialization, publishing, authorization, pausing, and
  upgrade authorization.
- UUPS/ERC-1967 proxy integration and the implementation/initializer boundary.
- Two-step ownership and the disabled renounce path.
- Publisher allowlist behavior.
- The 512-byte metadata bound, root uniqueness, event shape, and the compatibility
  `anchor(bytes32,bytes32[])` entry point.
- The `anchors(uint256)` read shape used by `apps/api/src/chains/relay.ts`.
- The deploy and upgrade runbooks in `contracts/README.md`.
- The testnet deployment guard in `contracts/scripts/deploy-anchor-testnet.mjs`.

Out of scope:

- OpenZeppelin library internals beyond their integration and pinned versions.
- The EVM, RPC providers, chain finality, reorg policy, and gas markets.
- The off-chain registry, relay signer, API, and storage system.
- Economic, legal, or token design.
- Confidentiality of metadata: it is public calldata and public log data.

## Contract model

`RarextAnchor` is an append-only commitment log behind an ERC-1967 proxy.

- The proxy address is the stable address. The implementation address is not a
  client entry point.
- The owner is the only account that may upgrade, pause, unpause, or change the
  publisher allowlist. Ownership is two-step, and renounce is disabled.
- The owner may always publish. An explicitly authorized publisher may publish
  until revoked.
- Publishing enforces a nonzero root, unique roots, and metadata of at most 512
  bytes. It stores `keccak256(metadata)`, the publisher, and the block timestamp,
  and emits `AnchorPublished` with the metadata.
- `anchors(uint256)` returns `(bytes32 root, uint64 timestamp)`, the shape the EVM
  relay reads. The first ABI word is the root.
- There is no delete, update, transfer, withdrawal, or custody function.

## Required review areas

### 1. UUPS and ERC-1967 proxy

Implementation:

- The implementation constructor calls `_disableInitializers()`.
- The proxy is initialized atomically with `initialize(initialOwner)` at
  deployment.
- `_authorizeUpgrade(address)` is `onlyOwner`.
- `upgradeToAndCall` is inherited from OZ UUPS and checks the proxiable UUID.
- The implementation and proxy addresses are separately deployed and recorded.
- The storage gap is `uint256[40]` after the contract's own mappings.

Tests:

- `deploys behind an upgradeable proxy and starts unpaused`
- `upgrades only through the owner and preserves anchors`
- `cannot initialize or upgrade the implementation directly`

Internal result: the proxy starts initialized, an unauthorized upgrade reverts,
the owner upgrade changes `version()` while preserving the anchor, direct
implementation initialization reverts with `InvalidInitialization`, and a direct
implementation upgrade reverts with `UUPSUnauthorizedCallContext`.

Residual risk: a compromised owner can upgrade to arbitrary code; a storage-layout
mistake in a future implementation can corrupt anchors; this repository has no
automated OpenZeppelin Upgrades storage-layout diff in CI. The deployment script
verifies the proxy's ERC-1967 implementation slot, but an auditor must still review
the layout for every upgrade.

Auditor checks:

- Confirm the proxy constructor cannot be front-run or reinitialized.
- Confirm the implementation cannot be initialized or upgraded directly.
- Compare storage layout between implementations and confirm the gap is consumed
  before new variables are appended.
- Confirm `proxiableUUID()` cannot be called through the proxy.
- Confirm the upgrade authority is the intended owner and no other path reaches
  `_authorizeUpgrade`.
- Confirm there is no delegatecall to untrusted code outside the upgrade path.

### 2. Two-step ownership

Implementation:

- `Ownable2StepUpgradeable` keeps `owner` and `pendingOwner` separate.
- `transferOwnership` only starts a transfer; the pending owner must call
  `acceptOwnership`.
- `renounceOwnership()` is overridden and always reverts with `RenounceDisabled`.
- `initialize` rejects `address(0)` with `ZeroAddress`.

Tests:

- `moves ownership in two steps and disables renounce`
- `refuses a zero owner during initialization`

Internal result: the old owner remains in control until acceptance, an unrelated
account cannot accept, the old owner loses owner-only access after acceptance, and
renounce reverts.

Residual risk: loss or compromise of the owner key is a centralization risk. The
contract cannot recover a lost key. Owner key custody, multisig policy, and upgrade
signing are operational controls outside this contract.

Auditor checks:

- Confirm every owner-only function uses the intended owner state.
- Confirm the pending-owner transition cannot be hijacked.
- Confirm renounce cannot be reached through another inherited path.
- Confirm a zero pending owner cannot become an active owner.

### 3. Publisher allowlist

Implementation:

- `setPublisher(address,bool)` is `onlyOwner`; zero address reverts with
  `ZeroAddress`.
- `publish` and `anchor` allow the owner or an allowed publisher.
- `PublisherSet` emits every allowlist change.
- A revoked publisher cannot publish a new root.
- Both write paths are `whenNotPaused`.

Tests:

- `only the owner or an authorized publisher may publish`
- `authorizes and revokes publishers, and rejects the zero address`
- `pauses and unpauses only through the owner`

Internal result: an unrelated account gets `NotPublisher`, authorization and
revocation both take effect, and the owner retains write access.

Residual risk: the allowlist is a hot-key surface. A compromised publisher can
publish any nonzero root and metadata until the owner revokes it or pauses. There
is no per-publisher nonce, rate limit, or on-chain revocation list. The owner can
publish without being on the allowlist by design.

Auditor checks:

- Confirm no non-owner path changes `_publishers`.
- Confirm the owner's implicit write access is intentional and documented.
- Confirm pausing blocks both `publish` and `anchor`.
- Confirm a revoked publisher cannot bypass the check through the compatibility
  wrapper.
- Confirm event indexing captures authorization changes.

### 4. Bounded metadata and append-only roots

Implementation:

- `MAX_METADATA_BYTES` is 512 and is not mutable.
- Both `publish` and `anchor` route through `_publish`, so both enforce the bound.
- `anchor` uses `abi.encode(bytes32[])`, which is 64 bytes of array overhead plus
  32 bytes per id. The largest compatible batch is 14 ids (512 bytes); 15 ids
  reverts with `MetadataTooLarge`.
- A zero root reverts with `ZeroRoot`; a repeated root reverts with
  `DuplicateRoot`.
- The metadata hash and full metadata are emitted; the raw metadata is stored.
- Ids start at 1, and `anchorCount` is monotonic.

Tests:

- `publishes a root and metadata, emits the event, and exposes the adapter read`
- `rejects duplicate roots`
- `bounds metadata at 512 bytes`
- `keeps the documented anchor(bytes32,bytes32[]) entry point`
- `fits 14 publication ids in the compatibility wrapper and rejects 15`

Residual risk: operators must keep EVM publication batches at 14 ids or fewer.
`RAREXT_ANCHOR_EVERY` is not capped by this contract or by the registry batching
code. The contract rejects an oversized batch, but the registry then needs an
operator-visible failure and a smaller retry. This is documented in the deployment
runbook and is a launch blocker for any configuration that batches more than 14
publications per EVM root.

Auditor checks:

- Confirm the 512-byte bound is enforced on every write path.
- Confirm the 14-id compatibility limit and the exact boundary behavior.
- Confirm the root uniqueness check cannot be bypassed by a zero or duplicate id.
- Confirm the event and stored metadata hash match.
- Confirm there is no way to mutate or delete a stored anchor.
- Confirm the timestamp cast and id increment are safe for the expected lifetime.

### 5. `anchors(uint256)` read shape

Implementation:

- `anchors(uint256)` returns `(bytes32 root, uint64 timestamp)`.
- The EVM relay pins selector `0x368b733e` and reads the first ABI word as the
  root.
- An unknown id returns a zero root and zero timestamp; the relay treats that as
  unconfirmed.
- The proxy address, not the implementation address, must be configured in the
  registry.

Tests:

- `publishes a root and metadata, emits the event, and exposes the adapter read`
- `the EVM adapter reads back with canonical anchors(uint256) calldata`
- `the EVM adapter accepts the relay's numeric index reference`
- `the EVM adapter does not guess index 0 when the reference has no id`
- `fits 14 publication ids in the compatibility wrapper and rejects 15`

Internal result: the ABI read returns the published root and timestamp, an unknown
id returns zeros, and the off-chain adapter calldata matches
`anchors(uint256)`.

Residual risk: a future implementation that changes the return order or type would
break the relay. The selector and ABI must be treated as an external interface and
covered by an upgrade test.

Auditor checks:

- Confirm the selector and ABI match the documented relay.
- Confirm the return order is part of the compatibility contract.
- Confirm the registry can read the proxy, not the implementation.
- Confirm an unknown or zero id is distinguishable from a confirmed root.

### 6. Pause, custody, and chain assumptions

- Both write paths are pausable; reads remain available.
- The contract does not hold user funds and has no withdrawal path. Do not send
  ETH to it, including through the payable `upgradeToAndCall`.
- Anchors can disappear or move in a reorg if the chain's finality policy is
  ignored. The registry records the transaction reference and block height where
  available, but automatic re-anchoring is not implemented.
- The contract stores metadata in plaintext. It is not private.

## Findings and dispositions

| ID | Severity | Finding | Disposition | Evidence |
| --- | --- | --- | --- | --- |
| F-01 | Medium | `initialize(address(0))` could set the proxy owner to zero and permanently disable owner-only setup. | Fixed with a `ZeroAddress` check and a regression test. | `refuses a zero owner during initialization` |
| F-02 | Medium | The compatibility `anchor` path is limited to 14 publication ids by the 512-byte ABI bound, but the limit was not documented or tested at the boundary. | Documented here and in the deployment runbook; boundary tests added. Registry batching above 14 still requires an operator fix. | `fits 14 publication ids in the compatibility wrapper and rejects 15` |
| F-03 | Low | The deploy script did not verify the proxy's implementation slot or read back the publisher after authorization. | Deploy script now checks proxy code, implementation code, the ERC-1967 implementation slot, and `isPublisher`. | deployment script review |
| F-04 | Blocking | No independent external audit or live deployment exists. | Live deployment remains blocked; this document is not an audit report. | this file, no deployment record |
| F-05 | Info | CI does not run an OpenZeppelin storage-layout diff for upgrades. | Manual auditor check required for every upgrade until automated. | upgrade runbook |
| F-06 | Info | Owner and publisher keys are centralized hot keys; a compromise can write or upgrade. | Operational key custody, multisig, pause, publisher revocation, and upgrade review are required. | ownership and publisher tests |
| F-07 | Info | `upgradeToAndCall` is payable and the contract has no withdrawal path. | Do not send ETH; operational control, not a contract fix. | code review |

No external auditor has validated these dispositions. Severity is the internal
review's assessment, not an audit rating.

## Manual audit checklist

Internal review completed:

- [x] Reproduce the source hash and pinned toolchain.
- [x] Compile with the checked-in compiler settings.
- [x] Run the local-EVM contract tests.
- [x] Review the proxy initialization and implementation boundary.
- [x] Review the owner-only upgrade authorization.
- [x] Review the two-step ownership transition and disabled renounce.
- [x] Review owner and publisher write authorization.
- [x] Review publisher authorization and revocation events.
- [x] Review pausing of both write paths.
- [x] Review nonzero root and unique root enforcement.
- [x] Review the 512-byte metadata bound and the 14-id compatibility boundary.
- [x] Review the `anchors(uint256)` ABI and relay selector.
- [x] Review the deploy script's chain-id, balance, proxy-slot, owner, and publisher checks.
- [x] Record the zero-owner finding and fix.
- [x] Confirm no live deployment or audit report exists.

External auditor must complete and sign:

- [ ] Confirm the commit, source hash, compiler, optimizer, and dependency versions.
- [ ] Confirm the source compiles to the reviewed bytecode and record the bytecode hash.
- [ ] Confirm initialization cannot be front-run or repeated.
- [ ] Confirm the implementation cannot be initialized or upgraded directly.
- [ ] Confirm UUPS authorization has no alternate path.
- [ ] Confirm the ERC-1967 implementation slot and proxy behavior.
- [ ] Confirm storage layout compatibility and the consumption order of `__gap`.
- [ ] Confirm ownership acceptance cannot be hijacked.
- [ ] Confirm renounce is unreachable through inherited paths.
- [ ] Confirm publisher authorization, revocation, and pause behavior.
- [ ] Confirm the owner's implicit publisher role is intended.
- [ ] Confirm both write paths enforce the metadata bound.
- [ ] Confirm the 14-id compatibility boundary.
- [ ] Confirm root uniqueness and zero-root rejection.
- [ ] Confirm event fields, metadata hash, and stored metadata agree.
- [ ] Confirm the `anchors(uint256)` ABI is stable for the relay.
- [ ] Confirm no custody or withdrawal path exists.
- [ ] Review owner and publisher key-management assumptions.
- [ ] Review the upgrade runbook and require a storage-layout check for each upgrade.
- [ ] Record findings with severity, affected commit, and retest evidence.
- [ ] Issue a signed report or a written no-findings statement covering this scope.

## External audit request

An auditor engaged for this contract should receive:

- the commit and source hash above;
- `contracts/RarextAnchor.sol`, `contracts/lib/compile.mjs`, and
  `contracts/test/anchor.test.mjs`;
- the pinned OpenZeppelin and solc versions;
- the deploy and upgrade runbooks in `contracts/README.md`;
- the reproducible baseline command (`npm run audit:baseline`) and the
  deployment record validator (`npm run verify:deployment`);
- the proxy address and deployment record once a testnet deployment exists;
- the EVM relay read shape in `apps/api/src/chains/relay.ts`;
- this document and the finding dispositions.

The report should state the reviewed commit and bytecode hash, list findings by
severity, identify unresolved items, and explicitly say whether the contract is
approved for a value-bearing mainnet deployment. A report covering a different
bytecode or compiler configuration is not a review of this deployment.

## Deployment record validation

The testnet script writes a JSON record next to the addresses. The record can be
checked offline before anyone quotes it:

```bash
npm run verify:deployment -- path/to/deployment.json
```

The validator refuses a record whose source hash is not the current
`contracts/RarextAnchor.sol`, a known mainnet chain id, a non-checksummed or
malformed address, a proxy/implementation mismatch, or any record that has
relaxed `audit.status`, `externalReviewNeeded`, or `liveDeploymentBlocked`.
It does not contact a chain and is not an audit. The checks are covered by
`contracts/test/verify-deployment-record.test.mjs`.

`npm run audit:baseline` pins the reviewed bytecode, and
`contracts/test/audit-baseline.test.mjs` fails if the source, compiler, or
dependency change without the table above being updated. CI (`scripts/ci.sh`; the
GitHub Actions template is `scripts/ci-github-actions.yml`) runs both.

## Deployment gate

| Gate | Status |
| --- | --- |
| Contract source complete | yes |
| Local-EVM tests passing | yes |
| Baseline hash check in tests/CI | yes |
| Deployment record validator | yes |
| Internal review trail | yes, this document |
| External audit report | **no** |
| Auditor review needed | **yes** |
| Funded testnet deployment | allowed only through `npm run deploy:anchor:testnet` |
| Live/mainnet deployment | **blocked** |
| Deployed contract address | none |

The testnet script refuses known mainnet chain ids and writes a deployment record
with `audit.status: "not-performed"`, `audit.externalReviewNeeded: true`, and
`audit.liveDeploymentBlocked: true`. A testnet deployment is not an audit and does
not authorize mainnet.

## Sign-off

| Role | Organization | Status | Evidence |
| --- | --- | --- | --- |
| Internal review | RAREXT Protocol Working Group | Complete, not independent, 2026-10-23 | this file, contract tests |
| External audit | none engaged | Pending | no report |
| Deployment operator | none | Not performed | no deployment record |

Changing this contract, its compiler settings, its OpenZeppelin versions, or its
proxy pattern invalidates the baseline and requires a new review. Do not carry a
sign-off forward to a different bytecode.
