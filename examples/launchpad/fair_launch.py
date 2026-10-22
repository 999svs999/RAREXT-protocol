"""Fair-launch verifier for RAREXT.

A launch is published as a *plan* artifact. The verifier reads the chain state for
that plan through an injected reader and checks the launch against a pinned policy.
The policy lives in the challenge spec, so it is versioned with the challenge and
bound to a semantics record: "fair" is a defined meaning with a named owner, not a
badge.

Two properties matter more than the individual checks:

* **Fail closed.** Anything the verifier cannot read is not a pass. An unreadable
  field produces level UNKNOWN, and UNKNOWN is not correct.
* **Point in time.** The attestation is true as of the block it read. A launch can
  be safe at block N and unsafe at N+1, so a fair launch is a *trajectory* of
  attestations, not one badge.

The check set and thresholds mirror the launchpad certifier this app replaces, so
existing launches keep their verdicts while becoming re-checkable by anyone.
"""

import hashlib
import json

LEVEL_SAFE = "SAFE"
LEVEL_RISK = "RISK"
LEVEL_UNKNOWN = "UNKNOWN"

READABLE_LP = ("burned", "curve", "locked")


def sha256(value):
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def policy_hash(spec):
    """Hash of the policy the verdict was decided against."""
    return sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")))


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check(checks, name, read, ok, label):
    checks.append({"name": name, "read": bool(read), "ok": bool(ok), "label": label})
    return bool(read) and bool(ok)


def evaluate(observations, declared, spec):
    """Apply the policy to a set of observations. Returns (level, score, checks)."""
    limits = spec.get("limits") or {}
    penalty = spec.get("scorePenaltyPerFailedCheck", 30)
    checks = []

    deployed = _check(
        checks,
        "contract_deployed",
        observations.get("deployed") is not None,
        observations.get("deployed") is True,
        "contract code verified present on-chain"
        if observations.get("deployed") is True
        else "no contract at this address (or not deployed)",
    )

    renounced = _check(
        checks,
        "mint_revoked",
        "ownerRenounced" in observations,
        observations.get("ownerRenounced") is True,
        "owner renounced — no one can mint new supply"
        if observations.get("ownerRenounced") is True
        else "owner is NOT renounced — minting is still possible",
    )

    upgradeable = _check(
        checks,
        "not_upgradeable",
        "upgradeable" in observations,
        observations.get("upgradeable") is False,
        "not an upgradeable proxy (logic is fixed)"
        if observations.get("upgradeable") is False
        else "upgradeable proxy — the deployer can change the logic later",
    )

    min_burn = limits.get("minSupplyBurnedPct", 25)
    burn_pct = observations.get("supplyBurnedPct")
    burn_ok = _check(
        checks,
        "supply_burned",
        _number(burn_pct),
        _number(burn_pct) and burn_pct >= min_burn,
        f"{burn_pct}% of supply burned at 0x0…dead ({min_burn}% threshold)"
        if _number(burn_pct)
        else "supply burn unprovable (total supply or dead balance unreadable)",
    )

    max_top = limits.get("maxTopHolderPct", 3)
    top_pct = observations.get("topHolderPct")
    top_ok = _check(
        checks,
        "top_holder",
        _number(top_pct),
        _number(top_pct) and top_pct <= max_top,
        f"top-1 holder owns {top_pct:.1f}% (no more than {max_top}%)"
        if _number(top_pct)
        else "holder distribution unproven — no top-holder data",
    )

    min_holders = limits.get("minUniqueTopHolders", 5)
    holders = observations.get("uniqueTopHolders")
    holders_ok = _check(
        checks,
        "unique_holders",
        _number(holders),
        _number(holders) and holders >= min_holders,
        f"{holders} unique top holders (at least {min_holders} required)"
        if _number(holders)
        else "holder distribution malformed",
    )

    lp = observations.get("lp")
    lp_ok = _check(
        checks,
        "liquidity_locked",
        isinstance(lp, str) and lp != "unknown",
        lp in ("burned", "curve"),
        f"LP is BURNED — liquidity cannot be pulled"
        if lp == "burned"
        else (
            "LP is curve-managed"
            if lp == "curve"
            else (
                "LP is held or locked elsewhere — check the lock"
                if lp == "locked"
                else (
                    "LP is not verifiably burned or locked — the deployer may be able to pull it"
                    if lp == "unsafe"
                    else "could not determine the LP lock state"
                )
            )
        ),
    )

    max_tax = limits.get("maxTransferTaxPct", 1)
    tax = declared.get("transferTaxPct")
    tax_ok = _check(
        checks,
        "no_transfer_tax",
        _number(tax),
        _number(tax) and tax <= max_tax,
        f"transfer tax {tax}% (no more than {max_tax}%)"
        if _number(tax)
        else "transfer tax not declared",
    )

    max_allocation = limits.get("maxCreatorAllocationPct", 5)
    allocation = declared.get("creatorAllocationPct")
    allocation_ok = _check(
        checks,
        "creator_allocation",
        _number(allocation),
        _number(allocation) and allocation <= max_allocation,
        f"creator allocation {allocation}% (no more than {max_allocation}%)"
        if _number(allocation)
        else "creator allocation not declared",
    )

    results = (
        deployed,
        renounced,
        upgradeable,
        burn_ok,
        top_ok,
        holders_ok,
        lp_ok,
        tax_ok,
        allocation_ok,
    )

    failed = [name for name, ok in zip(
        [
            "contract_deployed",
            "mint_revoked",
            "not_upgradeable",
            "supply_burned",
            "top_holder",
            "unique_holders",
            "liquidity_locked",
            "no_transfer_tax",
            "creator_allocation",
        ],
        results,
    ) if not ok]

    unreadable = [check["name"] for check in checks if not check["read"]]

    if unreadable:
        level = LEVEL_UNKNOWN
    elif failed:
        level = LEVEL_RISK
    else:
        level = LEVEL_SAFE

    score = max(0, 100 - penalty * len(failed))

    return level, score, checks, failed, unreadable


def verify(artifact, challenge, reader):
    """Verify a launch plan against the challenge policy.

    ``reader`` is called as reader(mint, chain, block) and returns observations
    for that token, or None when the token cannot be read. It is injected so the
    checks stay deterministic in tests; in production it performs the chain read.
    """
    body = artifact.get("body") or {}
    spec = challenge.get("spec") or {}

    if artifact.get("app") != "launchpad" or artifact.get("kind") != "launch.plan":
        raise ValueError("expected a launchpad launch.plan artifact")

    mint = body.get("mint")
    chain = body.get("chain")
    block = body.get("block")
    declared = body.get("declared") or {}

    if not isinstance(mint, str) or not mint:
        raise ValueError("launch plan must name a mint")
    if not isinstance(chain, str) or not chain:
        raise ValueError("launch plan must name a chain")
    if not isinstance(block, int) or isinstance(block, bool) or block < 0:
        raise ValueError("launch plan must name the block it was observed at")

    observations = reader(mint, chain, block) or {}

    level, score, checks, failed, unreadable = evaluate(
        observations, declared, spec
    )

    problems = []
    if "mint_revoked" in failed:
        problems.append("mint authority is active — the creator can mint new supply")
    if "not_upgradeable" in failed:
        problems.append("the contract is upgradeable — the logic can change later")
    if "supply_burned" in failed:
        problems.append("supply burn is below the policy threshold")
    if "top_holder" in failed:
        problems.append("a single holder controls too much supply")
    if "unique_holders" in failed:
        problems.append("holder distribution is too thin to rule out a bundle")
    if "liquidity_locked" in failed:
        problems.append("liquidity is not verifiably burned or locked")
    if "no_transfer_tax" in failed:
        problems.append("transfer tax is above the policy limit")
    if "creator_allocation" in failed:
        problems.append("creator allocation is above the policy limit")
    if unreadable:
        problems.append(
            "the verifier could not read all required chain data (fail closed — treat as not safe)"
        )

    return {
        "correct": level == LEVEL_SAFE,
        "score": score,
        "proof": {
            "policy": spec.get("policy"),
            "policyHash": policy_hash(spec),
            "chain": chain,
            "mint": mint,
            "block": block,
            "level": level,
            "checks": checks,
            "observed": observations,
        },
        "details": {
            "level": level,
            "failed": failed,
            "unreadable": unreadable,
            "problems": problems,
            "asOf": block,
        },
    }


def snapshot_reader(snapshot):
    """Build a reader over a chain snapshot: {chain: {mint: observations}}.

    The snapshot stands in for the RPC so the example runs without a network or
    any third-party package. A mint that is not in the snapshot reads as unknown,
    which fails closed.
    """
    chains = snapshot or {}

    def read(mint, chain, block):
        chain_data = chains.get(chain) or {}
        entry = chain_data.get(mint.lower()) or chain_data.get(mint)
        if not entry:
            return None
        observed = dict(entry)
        observed.setdefault("block", block)
        return observed

    return read
