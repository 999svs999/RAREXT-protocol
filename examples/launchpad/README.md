# Fair-launch verifier

The ApesDaily launchpad's certifier, as a RAREXT app: it certifies token launches
against a pinned policy. It is the protocol version of the launchpad's internal
certifier — same checks, same thresholds, but the policy, the verifier, and the verdict
are all public and re-runnable.

See [`docs/FAIR-LAUNCH.md`](../../docs/FAIR-LAUNCH.md) for the model and
[`docs/SEMANTICS.md`](../../docs/SEMANTICS.md) for what a claim is bound to.

## Run

```bash
# terminal 1
python3 server.py

# terminal 2
RAREXT_VERIFIERS=examples/launchpad/verifiers.json \
RAREXT_CHALLENGES=examples/launchpad/challenges.json \
RAREXT_SEMANTICS=examples/launchpad/semantics.json \
npm run dev:api
```

```bash
curl -s http://127.0.0.1:8787/v1/semantics
curl -s http://127.0.0.1:8787/v1/challenges
```

## Publish a launch plan

The artifact is the *plan*, not a verdict. The verifier reads the chain itself.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/artifacts \
  -H 'content-type: application/json' \
  -d '{
    "author": "apesdaily",
    "title": "Launch plan: 0xsafe",
    "challengeId": "fair-launch-v1",
    "artifact": {
      "app": "launchpad",
      "kind": "launch.plan",
      "version": 1,
      "mediaType": "application/json",
      "body": {
        "chain": "base",
        "mint": "0xsafe",
        "block": 21000000,
        "policy": "fair-launch-v1",
        "declared": {
          "creatorAllocationPct": 2.0,
          "transferTaxPct": 0.0,
          "feeRecipient": "0xfeed"
        }
      }
    }
  }'
```

The attestation carries `semanticsId: "launchpad/fair-launch-v1"`, the policy
hash, the block it was read at, and the `verifierHash` of this implementation.

## Checks

| Check | Passes when | Limit |
| --- | --- | --- |
| `contract_deployed` | contract code is present on chain | — |
| `mint_revoked` | owner is renounced | — |
| `not_upgradeable` | not an upgradeable proxy | — |
| `supply_burned` | supply burned to the dead address | ≥ 25% |
| `top_holder` | largest holder share | ≤ 3% |
| `unique_holders` | unique top holders | ≥ 5 |
| `liquidity_locked` | LP burned or curve-managed | — |
| `no_transfer_tax` | declared transfer tax | ≤ 1% |
| `creator_allocation` | declared creator allocation | ≤ 5% |

The limits live in the challenge spec, so changing one is a policy change, not a
code change: new challenge version, new semantics version, repinned hashes.

## Levels

- `SAFE` — every required check read and passed. The claim is `correct`.
- `RISK` — a check was read and failed. The attestation lists what failed and why.
- `UNKNOWN` — a required field could not be read. **Not** correct. Fail closed:
  an unreadable chain is never a pass.

## Chain data

`chain_snapshot.json` stands in for the RPC so the example runs with no network
and no third-party packages:

```json
{ "base": { "0xsafe": { "deployed": true, "ownerRenounced": true, "upgradeable": false, "supplyBurnedPct": 30.4, "topHolderPct": 1.8, "uniqueTopHolders": 11, "lp": "burned" } } }
```

Swap `snapshot_reader` for an RPC reader and the checks are unchanged. A mint that
is missing from the snapshot reads as unknown, which fails closed.

## Test

```bash
cd examples/launchpad
python3 -m unittest -v test_fair_launch
```
