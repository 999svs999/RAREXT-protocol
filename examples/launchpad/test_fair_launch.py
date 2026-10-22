import json
import os
import unittest

import fair_launch

HERE = os.path.dirname(os.path.abspath(__file__))

CHALLENGE = {
    "id": "fair-launch-v1",
    "app": "launchpad",
    "spec": {
        "policy": "fair-launch-v1",
        "limits": {
            "minSupplyBurnedPct": 25,
            "maxTopHolderPct": 3,
            "minUniqueTopHolders": 5,
            "maxCreatorAllocationPct": 5,
            "maxTransferTaxPct": 1,
        },
        "scorePenaltyPerFailedCheck": 30,
        "failClosed": True,
    },
}

SNAPSHOT = json.load(open(os.path.join(HERE, "chain_snapshot.json"), encoding="utf-8"))


def plan(mint, **overrides):
    declared = {
        "creatorAllocationPct": 2.0,
        "transferTaxPct": 0.0,
        "feeRecipient": "0xfeed",
    }
    declared.update(overrides.pop("declared", {}))
    body = {
        "chain": "base",
        "mint": mint,
        "block": 21_000_000,
        "policy": "fair-launch-v1",
        "declared": declared,
    }
    body.update(overrides)
    return {
        "app": "launchpad",
        "kind": "launch.plan",
        "version": 1,
        "mediaType": "application/json",
        "body": body,
    }


def reader():
    return fair_launch.snapshot_reader(SNAPSHOT)


class FairLaunchTests(unittest.TestCase):
    def test_a_compliant_launch_is_safe(self):
        result = fair_launch.verify(plan("0xsafe"), CHALLENGE, reader())
        self.assertTrue(result["correct"])
        self.assertEqual(result["proof"]["level"], "SAFE")
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["proof"]["policy"], "fair-launch-v1")
        self.assertEqual(result["details"]["failed"], [])

    def test_an_unsafe_launch_fails_with_reasons(self):
        result = fair_launch.verify(plan("0xrug"), CHALLENGE, reader())
        self.assertFalse(result["correct"])
        self.assertEqual(result["proof"]["level"], "RISK")
        self.assertIn("mint_revoked", result["details"]["failed"])
        self.assertIn("liquidity_locked", result["details"]["failed"])
        self.assertTrue(result["details"]["problems"])

    def test_unreadable_data_fails_closed(self):
        result = fair_launch.verify(plan("0xpartial"), CHALLENGE, reader())
        self.assertFalse(result["correct"])
        self.assertEqual(result["proof"]["level"], "UNKNOWN")
        self.assertIn("supply_burned", result["details"]["unreadable"])

    def test_an_unknown_token_is_not_safe(self):
        result = fair_launch.verify(plan("0xmissing"), CHALLENGE, reader())
        self.assertFalse(result["correct"])
        self.assertEqual(result["proof"]["level"], "UNKNOWN")

    def test_creator_allocation_over_the_cap_is_rejected(self):
        result = fair_launch.verify(
            plan("0xsafe", declared={"creatorAllocationPct": 12.0}),
            CHALLENGE,
            reader(),
        )
        self.assertFalse(result["correct"])
        self.assertIn("creator_allocation", result["details"]["failed"])

    def test_transfer_tax_over_the_cap_is_rejected(self):
        result = fair_launch.verify(
            plan("0xsafe", declared={"transferTaxPct": 5.0}),
            CHALLENGE,
            reader(),
        )
        self.assertFalse(result["correct"])
        self.assertIn("no_transfer_tax", result["details"]["failed"])

    def test_the_proof_records_the_block_it_was_read_at(self):
        result = fair_launch.verify(plan("0xsafe"), CHALLENGE, reader())
        self.assertEqual(result["proof"]["block"], 21_000_000)
        self.assertEqual(result["details"]["asOf"], 21_000_000)
        self.assertEqual(result["proof"]["policyHash"], fair_launch.policy_hash(CHALLENGE["spec"]))

    def test_a_launch_plan_must_name_its_mint_chain_and_block(self):
        for missing in ("mint", "chain", "block"):
            artifact = plan("0xsafe")
            del artifact["body"][missing]
            with self.assertRaises(ValueError):
                fair_launch.verify(artifact, CHALLENGE, reader())

    def test_only_launch_plans_are_accepted(self):
        artifact = plan("0xsafe")
        artifact["kind"] = "something.else"
        with self.assertRaises(ValueError):
            fair_launch.verify(artifact, CHALLENGE, reader())

    def test_the_verdict_is_reproducible(self):
        first = fair_launch.verify(plan("0xsafe"), CHALLENGE, reader())
        second = fair_launch.verify(plan("0xsafe"), CHALLENGE, reader())
        self.assertEqual(first["proof"], second["proof"])


if __name__ == "__main__":
    unittest.main()
