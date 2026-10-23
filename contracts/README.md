# Contracts

The EVM anchor contract is implemented and tested against a local EVM. **No
contract from this repository is deployed yet, and none has been audited.** A
live deployment is a separate, deliberate step; see the runbook below.

## Layout

- `RarextAnchor.sol` — the anchor contract.
- `lib/compile.mjs` — compiles the contract and the pinned OpenZeppelin sources
  with `solc`.
- `scripts/deploy-anchor.mjs` — deploys an implementation and an ERC-1967 proxy
  to a chain you name explicitly.
- `test/anchor.test.mjs` — local-EVM tests for publication, authorization,
  pausing, ownership, upgrades, and the compatibility read/write shape.
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
- `anchors(uint256)` returns `(bytes32 root, uint64 timestamp)`, the read shape
  the registry's EVM adapter expects. `anchorAt(uint256)`, `metadataOf(uint256)`,
  `idOf(bytes32)`, `isAnchored(bytes32)`, and `anchorCount()` expose the rest.
- The owner and explicitly authorized publishers may write. The owner always
  may. Publication is pausable.
- Ownership is two-step (`Ownable2Step`), and renouncing ownership is disabled.
- The contract is upgradeable through UUPS. Only the owner may authorize an
  upgrade. The implementation constructor disables initializers, so the
  implementation itself cannot be initialized.

## Compile and test

```bash
npm run test:contracts
```

The tests run against an in-process `@ethereumjs/vm` node. They do not need an
RPC endpoint, a funded key, or a network. `npm test` includes them.

## Deploy to a public testnet

The deploy script refuses to run unless the RPC's chain id matches the expected
chain id. It never defaults to mainnet.

```bash
ANCHOR_RPC_URL='https://…' \
ANCHOR_EXPECTED_CHAIN_ID='11155111' \
ANCHOR_DEPLOYER_KEY='0x…' \
ANCHOR_OWNER='0x…' \
npm run deploy:anchor
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANCHOR_RPC_URL` | yes | JSON-RPC endpoint for the target chain |
| `ANCHOR_EXPECTED_CHAIN_ID` | yes | chain id the RPC must report; the deploy aborts otherwise |
| `ANCHOR_DEPLOYER_KEY` | yes | funded deployer key; read from the environment, never logged |
| `ANCHOR_OWNER` | no | final owner; defaults to the deployer |
| `ANCHOR_PUBLISHER` | no | publisher to authorize; only allowed when the owner is the deployer |

The script deploys the implementation, deploys an `ERC1967Proxy`, initializes it
with the owner, verifies the owner and version, optionally authorizes a
publisher, and prints the chain id, addresses, transaction hashes, and block
numbers as JSON. Keep that output with the deployment record.

If `ANCHOR_OWNER` is not the deployer, the deployer cannot authorize a publisher
after initialization. Let the owner call `setPublisher` instead.

Verify the deployment independently before recording it:

```bash
cast call "$ANCHOR" 'owner()(address)' --rpc-url "$ANCHOR_RPC_URL"
cast call "$ANCHOR" 'version()(string)' --rpc-url "$ANCHOR_RPC_URL"
cast call "$ANCHOR" 'paused()(bool)' --rpc-url "$ANCHOR_RPC_URL"
```

## Upgrade runbook

1. Compile and test the new implementation.
2. Deploy the new implementation without initializing it.
3. As the owner, call `upgradeToAndCall(newImplementation, "0x")` on the proxy.
4. Read back `version()`, `anchorCount()`, and a known anchor to confirm that
   state survived.
5. Keep the old implementation address and the upgrade transaction hash.

The proxy address is the stable contract address. Never point the registry at an
implementation address.

## Audit and live deployment are still open

The repository has source, tests, a threat model in code comments, and a deploy
path. It does **not** have an audit, a live testnet deployment, or a mainnet
deployment. Do not describe it as audited or deployed until those steps are
actually done.

Audit inputs: the contract source, the pinned compiler and OpenZeppelin
versions, the storage layout, the proxy/upgrade path, the ownership and
publisher model, the metadata bound, and the local-EVM tests.

## Rules

- No writes to the sealed TapeOut PoD contract without an audit and legal review.
- No bridge until a dedicated RFC and audit.
- Every contract gets tests, a threat model, and a deployment runbook before
  mainnet.
