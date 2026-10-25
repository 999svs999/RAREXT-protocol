# Chains

The protocol is chain-agnostic by construction: an anchor is a Merkle root plus
receipts, and the registry treats every chain as one adapter among several.
This document says what that means in practice, which chains are wired up, and
what our own chain is and is not.

## The rule that makes it work

**A receipt is worth what the chain can prove, not what the operator says.**

Every chain adapter follows the same shape:

1. submit the anchor — a root and the publication ids — to that chain;
2. **read the chain back** and confirm the root is really there;
3. report a receipt with the confirmation, and the height and hash where the
   chain has them.

The read-back is the point. A relay that lies about submitting cannot produce a
confirmed receipt, because the confirmation comes from the chain's own readers.
An adapter that cannot read the chain back reports `skipped` with the reason,
never `ok`.

## The chains

`RAREXT_CHAINS` lists the chains to anchor to. Adding a chain is configuration.

| Chain | Family | How the root is carried | How it is read back |
| --- | --- | --- | --- |
| **RAREXT** | `rarext` | a block in our own chain | the block and a locally checked Merkle proof; `/chain/audit` walks the hash links and signatures |
| **Base, OP, Arbitrum, Polygon, zkSync** | `evm` | a call to an anchor contract | `eth_call` on the contract, comparing the stored root |
| **Solana** | `solana` | a memo transaction | the transaction's log messages, base58-decoded |
| **Bitcoin** | `bitcoin` | an `OP_RETURN` output | the raw transaction, searched for the root |
| **Cosmos** | `cosmos` | a memo in a transaction | the transaction's memo |
| **Trac** | `trac` | an anchor announcement over the operator webhook (`TRAC_ANCHOR_URL`) | the announcement response |
| **Content addressing** | `content` | a CIDv1 over the bundle | the CID, computed locally and pinned through `RAREXT_PIN_URL`; `npm run pin` serves that contract |
| **Local** | `local` | a durable record in the store | the record itself |

The relay chains use a relay: an endpoint that submits the transaction and
returns a reference. The registry then verifies that reference against the
chain. Relays are the custody hot wallet, and they cannot forge a confirmation.

`examples/chains/chains.json` lists the chains with their ids, families, and
chain ids. An operator sets `RAREXT_CHAINS` to that file, or to their own.

## The RAREXT chain

`apps/chain` is our own chain, and it is the one the protocol ships with.

It is a **hash-linked, signed log of anchor commitments**:

- each block carries the roots anchored in it, a Merkle root over them, the
  previous block's hash, a height, a timestamp, the signer's key id, and the
  registry publication ids that produced those roots;
- every block is signed by the node's key, and the hash covers the whole block,
  including the publication ids when present;
- a reader can walk the history, check every link and every signature, and prove
  that a particular root is in a particular block;
- a restart restores the saved blocks exactly. The node verifies every hash,
  signature, height, Merkle root, and parent link before serving them, and
  refuses to start on a tampered log instead of re-signing a new history.

```bash
npm run chain:node        # http://127.0.0.1:8790
```

```
POST /chain/anchor   { root, publicationIds }  -> { height, hash }
GET  /chain/state                              -> { chainId, height, head }
GET  /chain/head                               -> the current block
GET  /chain/key                                -> the node's public signing key
GET  /chain/proof?root=...                    -> an inclusion proof
GET  /chain/blocks/:height
GET  /chain/audit                              -> a walk of the whole history
```

`publicationIds` are part of the signed block, so the chain can name the
registry records behind a root even when the registry is gone. The roots still
commit to the publication leaves; the ids are the readable index beside them.

### What it is not, yet

It is a **single-writer notary with a chain's interface**. The interface is the
part that is fixed — the registry's adapter talks to this shape, so a consensus
chain can be dropped in behind the same API without touching the protocol.

What a real network adds, and what this does not have:

- **multiple writers** — today one node writes the blocks;
- **consensus** — which block wins when two nodes disagree;
- **finality rules** — how long a block stays valid, and what a reorganisation
  means for an anchor that has already been published;
- **an incentive** — who pays to write a block, and why.

The gate for moving to a real chain is in
[RFC 0016](../rfcs/0016-appchain-evaluation.md): volume to settle, a written and narrow
job for the chain, and a funded validator set. Building a chain before there is
volume is vanity infrastructure, and the interface above means we can defer it
without deferring the protocol.

## Consensus interface

`GET /v1/consensus/state` and `POST /v1/consensus/validate` are the seam a
consensus implementation can serve behind the registry. They do not make the
registry a consensus chain. They expose the **anchor audit trail** as an ordered
settlement log:

- the state root is the Merkle root over anchored roots in creation order;
- the head is a SHA-256 commitment to the chain id, height, state root, and latest
  anchor, so a proof can name a past height without becoming stale;
- the height is the cumulative number of anchored roots, not the number of
  batched publications. Per [RFC 0016](../rfcs/0016-appchain-evaluation.md), one
  anchor root is one settled action and batched publications are amortized into
  it.

The source of truth is the append-only anchor trail in the registry
(`store.listAnchors()`). [RFC 0017](../rfcs/0017-game-native-state-migration.md)
keeps that snapshot authoritative, and the EVM contract audit trail in
[`contracts/AUDIT.md`](../contracts/AUDIT.md) (commit `314c10e`) records the
transport side. The consensus endpoints never take a caller-supplied volume or
head as truth.

```http
GET /v1/consensus/state
```

```json
{
  "kind": "rarext.consensus.state",
  "version": 1,
  "chainId": "rarext-anchor-audit-v1",
  "asOf": "2026-10-23T…",
  "stateRoot": "<merkle root over anchored roots>",
  "head": {
    "height": 2,
    "hash": "<sha256 commitment>",
    "stateRoot": "<same state root>",
    "anchorId": "…",
    "anchorRoot": "…",
    "createdAt": "2026-10-23T…"
  },
  "settlement": {
    "source": "anchor-audit-trail",
    "status": "above-threshold",
    "valid": true,
    "volume": 2,
    "minimum": 1,
    "remainingToExceed": 0,
    "productionDataPending": true,
    "liveGating": false,
    "note": "Volume counts anchored roots…"
  },
  "audit": {
    "source": "anchor-audit-trail",
    "anchors": 2,
    "publications": 2,
    "confirmedAnchors": 0,
    "references": ["rfcs/0017-game-native-state-migration.md", "contracts/AUDIT.md"]
  }
}
```

`POST /v1/consensus/validate` accepts a signature over a canonical
`rarext.consensus.anchor-proof` v1 object:

```json
{
  "proof": {
    "kind": "rarext.consensus.anchor-proof",
    "version": 1,
    "chainId": "rarext-anchor-audit-v1",
    "height": 2,
    "head": "<head at that height>",
    "stateRoot": "<state root at that height>",
    "anchorId": "…",
    "root": "<anchored root>",
    "issuedAt": "2026-10-23T…"
  },
  "publicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "signature": "<base64>"
}
```

The server verifies the P-256 or ML-DSA signature, recomputes the head and state
root at the named height from the audit trail, checks the anchor is in that
prefix and the root matches, and then applies the settlement gate. A signature
proves integrity, not a trusted signer: there is no signer allowlist yet. The
anchor lookup and the volume are always local, so a proof cannot inflate either.

Cumulative settlement volume is gated by `CONSENSUS_SETTLEMENT_MIN`:

- unset means the gate is unconfigured and `valid` is always false;
- the comparison is strict: volume equal to the minimum is `at-threshold` and
  invalid; only `above-threshold` is valid;
- `productionDataPending` is true and `liveGating` is false. The anchor trail is
  real data, but RAREXT has not published a production settlement series, so this
  is a computed interface, not a live authorization to run a chain;
- local anchors count today. `confirmedAnchors` reports how many also have a
  confirmed external receipt, so an operator can see the difference.

This is deliberately not a consensus implementation: one writer still appends
anchors, and finality, reorg handling, validator incentives, and a signer
allowlist remain open. Real settlement volume is the gate for those, not a new
HTTP shape.

## Anchoring to several chains at once

The registry anchors to every configured chain, and an anchor records a receipt
per chain. That gives a second property for free:

> **A single chain's failure, censorship, or outage does not remove an anchor.**

If the chain an operator prefers is down, the anchor still exists on the others.
If an operator censors a publication, the root is still on a chain they do not
control. The same root, on more than one chain, is a much harder thing to
unilaterally rewrite.

The mirror story depends on this: a mirror is checked against a root, and the
root can be confirmed on any chain that has it.

## EVM anchor contract

`contracts/RarextAnchor.sol` is the anchor contract the EVM adapter expects. It
is source-complete and tested against a local EVM, but **not deployed and not
audited**. The audit trail, manual checklist, and blocked-live-deployment status
are in [`contracts/AUDIT.md`](../contracts/AUDIT.md); the funded-testnet wrapper is
`npm run deploy:anchor:testnet`.

It stores each root with `keccak256(metadata)`, the publisher, and the block
timestamp, and emits `AnchorPublished` with the full metadata (capped at 512
bytes). The two write shapes are:

```solidity
publish(bytes32 root, bytes metadata) returns (uint256 id)
anchor(bytes32 root, bytes32[] publicationIds) returns (uint256 id)
```

`anchor` ABI-encodes the publication ids as the metadata blob, so the shape in
the table above keeps working. The 512-byte bound leaves room for 14 ids; a 15th
id reverts. Keep EVM anchor batches at 14 publications or fewer. The read shape is:

```solidity
anchors(uint256 id) returns (bytes32 root, uint64 timestamp)
```

`anchorAt(uint256)`, `metadataOf(uint256)`, `idOf(bytes32)`, `isAnchored(bytes32)`,
and `anchorCount()` expose the rest. Roots are unique; the owner and authorized
publishers may write; the owner can pause writes and is the only account that can
authorize a UUPS upgrade.

The EVM relay wire format is:

1. the registry POSTs `rarext.anchor.v1` with
   `{ protocol, chain, root, publicationIds, address }`;
2. the relay submits `publish(bytes32 root, bytes metadata)` with
   `metadata = abi.encode(publicationIds)`, or calls the compatibility
   `anchor(bytes32 root, bytes32[] publicationIds)` wrapper, which performs the
   same encoding;
3. the relay returns the anchor id as either `<transactionHash>:<id>` or a bare
   numeric id;
4. the registry `eth_call`s `anchors(id)` with the 32-byte id and confirms that
   the first return word is the root. The adapter's calldata is the selector
   `0x368b733e` followed by the 32-byte id, never an ASCII or SHA-256 encoding.

`anchors(id)` is the read-back; `publish` and `anchor` are the write paths.

Local tests: `npm run test:contracts`. Deployment and upgrade runbooks:
[`contracts/README.md`](../contracts/README.md). `npm run audit:package` builds a
hash-verified auditor package with the source, tests, ABI, bytecode, storage
layout, and checksums; `npm run audit:package:verify` checks it. It is evidence of
the reviewed bytes, not an audit report.

## What is still missing

- **A deployed and audited EVM anchor contract.** The implementation, tests,
  audit trail, and guarded funded-testnet path are in `contracts/`; no external
  audit has been performed and no contract is live. Mainnet deployment remains
  blocked until the audit completes.
- **Real relays.** The relay protocol is documented by the request shape
  (`rarext.anchor.v1`), but each chain's signer has to be operated.
- **A native Trac anchor transport.** RESET/trac-peer 0.4.11 has no anchor move or transfer
  memo, so the shipped Trac transport is the operator webhook. The boundary is
  `apps/api/src/adapters/trac-transport.ts`; the blocker and evidence are in RFC 0001 §4.
- **A consensus chain for RAREXT itself**, when the gate is met. The
  `/v1/consensus/*` interface, signed anchor proofs, and strict settlement gate
  ship now; production settlement volume is pending, so live gating is deferred.
- **Re-anchoring after a reorganisation.** If a chain reorganises, an anchor
  might disappear. The receipts record the height, so the ambiguity is visible,
  but there is no automatic re-anchoring yet.
