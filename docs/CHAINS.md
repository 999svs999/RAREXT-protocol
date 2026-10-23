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
| **RAREXT** | `rarext` | a block in our own chain | the block, its Merkle proof, and the hash link |
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
  previous block's hash, a height, a timestamp, and the signer's key id;
- every block is signed by the node's key, and the hash covers the whole block;
- a reader can walk the history, check every link and every signature, and prove
  that a particular root is in a particular block.

```bash
npm run chain:node        # http://127.0.0.1:8790
```

```
POST /chain/anchor   { root, publicationIds }  -> { height, hash }
GET  /chain/state                              -> { chainId, height, head }
GET  /chain/proof?root=...                    -> an inclusion proof
GET  /chain/blocks/:height
GET  /chain/audit                              -> a walk of the whole history
```

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
[RFC 0004](../rfcs/0004-storage-economy.md): volume to settle, a written and narrow
job for the chain, and a funded validator set. Building a chain before there is
volume is vanity infrastructure, and the interface above means we can defer it
without deferring the protocol.

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

## What is still missing

- **A deployed EVM anchor contract.** The adapter expects a contract with
  `anchors(uint256) returns (bytes32 root, uint64 timestamp)` and an
  `anchor(bytes32,bytes32[])` entry point. The Solidity is small; the deployment
  and the audit are not.
- **Real relays.** The relay protocol is documented by the request shape
  (`rarext.anchor.v1`), but each chain's signer has to be operated.
- **A native Trac anchor transport.** RESET/trac-peer 0.4.11 has no anchor move or transfer
  memo, so the shipped Trac transport is the operator webhook. The boundary is
  `apps/api/src/adapters/trac-transport.ts`; the blocker and evidence are in RFC 0001 §4.
- **A consensus chain for RAREXT itself**, when the gate is met.
- **Re-anchoring after a reorganisation.** If a chain reorganises, an anchor
  might disappear. The receipts record the height, so the ambiguity is visible,
  but there is no automatic re-anchoring yet.
