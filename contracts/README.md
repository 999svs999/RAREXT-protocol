# Contracts

The EVM anchor contract is implemented and tested against a local EVM. **No
contract from this repository is deployed to a live network, and none has been
externally audited.** The funded-testnet deployment path is shipped and guarded;
a testnet deployment is not an audit and does not authorize mainnet.

The audit trail, scope, manual checklist, findings, and deployment gate are in
[`AUDIT.md`](AUDIT.md). Live deployment is blocked until an external auditor
reviews the deployed bytecode and closes the open review items.

## Layout

- `RarextAnchor.sol` — the anchor contract.
- `AUDIT.md` — audit trail, internal findings, manual checklist, and the
  auditor-review-required / live-deployment-blocked status.
- `lib/compile.mjs` — compiles the contract and the pinned OpenZeppelin sources
  with `solc`.
- `scripts/deploy-anchor.mjs` — deploys an implementation and an ERC-1967 proxy
  to a chain you name explicitly.
- `scripts/deploy-anchor-testnet.mjs` — guarded funded-testnet wrapper that runs
  the deploy script and writes a deployment record with audit flags.
- `scripts/audit-package.mjs` — builds and verifies a deterministic auditor
  package with source, tests, compiled artifacts, storage layout, and checksums.
- `test/anchor.test.mjs` — local-EVM tests for publication, authorization,
  pausing, ownership, upgrades, the metadata bound, and the compatibility read
  and write shapes.
- `test/anchor-deploy.test.mjs` — tests for the testnet chain guard and deployment
  record flags.
- `test/audit-package.test.mjs` — tests for package contents, checksums, and
  tamper detection.
- `test/RarextAnchorV2.sol` — a test-only implementation used to prove that an
  upgrade preserves state.

## What the contract does

`RarextAnchor` is an append-only commitment log:

- `publish(bytes32 root, bytes metadata)` stores the root, `keccak256(metadata)`,
  the publisher, and the block timestamp, then emits `AnchorPublished` with the
  full metadata.
- `anchor(bytes32 root, bytes32[] publicationIds)` is the compatibility entry
  point documented in [`docs/CHAINS.md`](../docs/CHAINS.md). It ABI-encodes the
  ids as the metadata blob.
- Roots are unique. Publishing the same root twice reverts.
- Metadata is capped at `MAX_METADATA_BYTES` (512). Larger blobs belong
  off-chain; the contract stores a commitment, not the bundle.
- `anchor` adds 64 bytes of ABI array overhead plus 32 bytes per id, so a
  compatible batch is at most **14 publication ids**. A 15th id reverts with
  `MetadataTooLarge`. Keep `RAREXT_ANCHOR_EVERY` and any relay batch at 14 or
  fewer; the registry batching code does not enforce this for you.
- `anchors(uint256)` returns `(bytes32 root, uint64 timestamp)`, the read shape
  the registry's EVM adapter expects. `anchorAt(uint256)`, `metadataOf(uint256)`,
  `idOf(bytes32)`, `isAnchored(bytes32)`, and `anchorCount()` expose the rest.
- The owner and explicitly authorized publishers may write. The owner always
  may. Publication is pausable.
- Ownership is two-step (`Ownable2Step`), and renouncing ownership is disabled.
- The contract is upgradeable through UUPS. Only the owner may authorize an
  upgrade. The implementation constructor disables initializers, so the
  implementation itself cannot be initialized.
- The contract holds no funds and has no withdrawal path. Do not send ETH to it.

## Compile and test

```bash
npm run test:contracts
```

The tests run against an in-process `@ethereumjs/vm` node. They do not need an
RPC endpoint, a funded key, or a network. `npm test` includes them.

## Audit package

Build and verify the auditor package:

```bash
npm run audit:package
npm run audit:package:verify -- dist/audit/rarext-anchor
```

The gitignored package contains the exact source, tests, scripts, runbooks, and
relay file from an explicit allowlist; the compiled ABI, creation/runtime
bytecode, and storage layout; a manifest; and `SHA256SUMS`. It records the commit
and dirty state but is not an audit report. Regenerate from a clean commit before
an external review. Include a valid testnet record with:

```bash
npm run audit:package -- --deployment path/to/anchor-testnet.json
```

The package and its limits are described in
[`AUDIT.md`](AUDIT.md#audit-package).

## Funded testnet deployment

The wrapper refuses known mainnet chain ids, requires an explicit testnet
acknowledgement, checks that the RPC chain id matches the expected id, and writes
a deployment record. The underlying deploy script also refuses a zero balance and
verifies the proxy implementation slot, owner, version, pause state, and optional
publisher.

```bash
ANCHOR_TESTNET_CONFIRM='deploy-testnet' \
ANCHOR_RPC_URL='https://…' \
ANCHOR_EXPECTED_CHAIN_ID='11155111' \
ANCHOR_DEPLOYER_KEY='0x…' \
ANCHOR_OWNER='0x…' \
ANCHOR_DEPLOYMENT_RECORD='contracts/deployments/anchor-sepolia.json' \
npm run deploy:anchor:testnet
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANCHOR_RPC_URL` | yes | JSON-RPC endpoint for the target testnet |
| `ANCHOR_EXPECTED_CHAIN_ID` | yes | chain id the RPC must report; known mainnet ids are refused by the wrapper |
| `ANCHOR_DEPLOYER_KEY` | yes | funded deployer key; read from the environment, never logged |
| `ANCHOR_OWNER` | no | final owner; defaults to the deployer |
| `ANCHOR_PUBLISHER` | no | publisher to authorize; only allowed when the owner is the deployer |
| `ANCHOR_TESTNET_CONFIRM` | yes | must be `deploy-testnet` |
| `ANCHOR_DEPLOYMENT_RECORD` | yes | output JSON path; the file must not already exist |

The deployer key must have testnet gas. The script refuses a zero balance and a
chain-id mismatch, but it does not estimate every fee market or guarantee the RPC
will accept the transaction. Fund the key deliberately and keep it out of shell
history, logs, and the repository.

The wrapper deploys the implementation, deploys an `ERC1967Proxy`, initializes it
with the owner, optionally authorizes a publisher, verifies the proxy's
implementation slot and the publisher read-back, and writes a record shaped like:

```json
{
  "kind": "rarext.anchor-deployment",
  "version": 1,
  "networkClass": "testnet",
  "deployedAt": "…",
  "gitCommit": "…",
  "source": {
    "path": "contracts/RarextAnchor.sol",
    "sha256": "…"
  },
  "toolchain": {
    "compiler": "0.8.38",
    "openzeppelinContracts": "5.0.2",
    "openzeppelinContractsUpgradeable": "5.0.2",
    "optimizer": { "enabled": true, "runs": 200 },
    "evmVersion": "cancun"
  },
  "audit": {
    "document": "contracts/AUDIT.md",
    "status": "not-performed",
    "externalReviewNeeded": true,
    "liveDeploymentBlocked": true
  },
  "deployment": {
    "chainId": "…",
    "implementation": "…",
    "proxy": "…",
    "proxyImplementation": "…",
    "owner": "…",
    "publisher": null,
    "transactions": {}
  }
}
```

Keep the record with the deployment. It is evidence of what was deployed, not
evidence of an audit.

### Verify the testnet deployment

```bash
cast code "$ANCHOR" --rpc-url "$ANCHOR_RPC_URL"
cast call "$ANCHOR" 'owner()(address)' --rpc-url "$ANCHOR_RPC_URL"
cast call "$ANCHOR" 'version()(string)' --rpc-url "$ANCHOR_RPC_URL"
cast call "$ANCHOR" 'UPGRADE_INTERFACE_VERSION()(string)' --rpc-url "$ANCHOR_RPC_URL"
cast call "$ANCHOR" 'paused()(bool)' --rpc-url "$ANCHOR_RPC_URL"
cast call "$ANCHOR" 'anchorCount()(uint256)' --rpc-url "$ANCHOR_RPC_URL"
cast storage "$ANCHOR" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url "$ANCHOR_RPC_URL"
```

The last value must end in the implementation address and must match the
`proxyImplementation` in the record. Never point the registry at the
implementation address.

### Minimum deployment checks

1. The chain id matches `ANCHOR_EXPECTED_CHAIN_ID` and is not a known mainnet.
2. The deployer balance is nonzero and the deployment transactions are mined.
3. The proxy and implementation both have code.
4. The ERC-1967 implementation slot points at the intended implementation.
5. `owner()` is the intended owner; `paused()` is false; `version()` is
   `1.0.0`; `UPGRADE_INTERFACE_VERSION()` is `5.0.0`.
6. If a publisher was requested, `isPublisher(publisher)` is true.
7. The deployment record exists and says `liveDeploymentBlocked: true`.
8. The EVM adapter is configured with the **proxy** address, and a smoke-test
   anchor batch is 14 ids or fewer.

## Upgrade runbook

1. Treat the upgrade as a new audit unit. Compile and test the new implementation.
2. Run an OpenZeppelin-compatible storage-layout comparison against the deployed
   implementation; this repository does not automate that check.
3. Deploy the new implementation without initializing it.
4. As the owner, call `upgradeToAndCall(newImplementation, "0x")` on the proxy.
5. Read back `version()`, `UPGRADE_INTERFACE_VERSION()`, `anchorCount()`, and a
   known anchor to confirm that state survived.
6. Keep the old implementation address and the upgrade transaction hash with the
   deployment record.
7. Do not carry the previous audit sign-off to new bytecode without auditor
   confirmation.

The proxy address is the stable contract address. Never point the registry at an
implementation address.

## Audit and live deployment status

The repository has source, local-EVM tests, a deployment guard, and an audit trail.
It does **not** have an external audit report, a live testnet address committed
here, or a mainnet deployment.

- External audit: not engaged.
- Auditor review: required.
- Live deployment: blocked.
- Testnet deployment: allowed through the guarded script, with no production
  claim and no value.

Do not describe the contract as audited or live until an auditor signs a report
for the deployed bytecode and a deployment record exists.

Audit inputs: the contract source, the pinned compiler and OpenZeppelin versions,
the storage layout, the proxy/upgrade path, the ownership and publisher model, the
metadata bound, the `anchors(uint256)` read shape, the local-EVM tests, and the
deployment record.

## Rules

- No mainnet deployment until the external audit is complete and recorded in
  `AUDIT.md`.
- No writes to the sealed TapeOut PoD contract without an audit and legal review.
- No bridge until a dedicated RFC and audit.
- Every contract gets tests, a threat model, and a deployment runbook before
  mainnet.
