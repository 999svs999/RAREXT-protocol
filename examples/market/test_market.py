import json
import os
import unittest

import market_rules

CHALLENGES = {
    "participant-profile-v1": {
        "id": "participant-profile-v1",
        "app": "market",
        "spec": {"policy": "participant-profile-v1"},
    },
    "market-listing-v1": {
        "id": "market-listing-v1",
        "app": "market",
        "spec": {
            "policy": "market-listing-v1",
            "limits": {"maxPriceCredits": 100000, "maxDays": 365},
        },
    },
    "market-aggregate-v1": {
        "id": "market-aggregate-v1",
        "app": "market",
        "spec": {
            "policy": "market-aggregate-v1",
            "limits": {"minParticipants": 3},
        },
    },
}


def artifact(kind, body):
    return {
        "app": "market",
        "kind": kind,
        "version": 1,
        "mediaType": "application/json",
        "body": body,
    }


class ParticipantProfileTests(unittest.TestCase):
    def test_an_agent_profile_is_accepted(self):
        result = market_rules.verify(
            artifact(
                "participant.profile",
                {
                    "kind": "agent",
                    "model": "some-model-v3",
                    "tools": ["browser", "verifier"],
                    "doesNotClaim": ["sentience", "ownership of any asset"],
                },
            ),
            CHALLENGES["participant-profile-v1"],
        )
        self.assertTrue(result["correct"])
        self.assertEqual(result["proof"]["kind"], "agent")

    def test_a_robot_profile_needs_hardware(self):
        with self.assertRaises(ValueError):
            market_rules.verify(
                artifact(
                    "participant.profile",
                    {"kind": "robot", "doesNotClaim": ["autonomy beyond its task"]},
                ),
                CHALLENGES["participant-profile-v1"],
            )

    def test_a_profile_must_say_what_it_does_not_claim(self):
        with self.assertRaises(ValueError):
            market_rules.verify(
                artifact("participant.profile", {"kind": "human"}),
                CHALLENGES["participant-profile-v1"],
            )

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(ValueError):
            market_rules.verify(
                artifact(
                    "participant.profile",
                    {"kind": "oracle", "doesNotClaim": ["anything"]},
                ),
                CHALLENGES["participant-profile-v1"],
            )


class ListingTests(unittest.TestCase):
    def listing(self, **overrides):
        body = {
            "title": "Verified storage, 100 GB for a year",
            "description": "Content-addressed storage with an inclusion proof.",
            "priceCredits": 250,
            "expiresInDays": 30,
            "seller": "storage-co-op",
            "terms": "Availability is proven by a possession claim.",
        }
        body.update(overrides)
        return artifact("market.listing", body)

    def test_a_well_formed_listing_is_accepted(self):
        result = market_rules.verify(
            self.listing(), CHALLENGES["market-listing-v1"]
        )
        self.assertTrue(result["correct"])
        self.assertEqual(result["proof"]["priceCredits"], 250)

    def test_a_listing_may_not_promise_a_return(self):
        with self.assertRaises(ValueError):
            market_rules.verify(
                self.listing(description="Guaranteed returns, risk free!"),
                CHALLENGES["market-listing-v1"],
            )

    def test_a_price_above_the_cap_is_refused(self):
        with self.assertRaises(ValueError):
            market_rules.verify(
                self.listing(priceCredits=10_000_000),
                CHALLENGES["market-listing-v1"],
            )

    def test_a_listing_needs_a_term(self):
        with self.assertRaises(ValueError):
            market_rules.verify(
                self.listing(expiresInDays=0), CHALLENGES["market-listing-v1"]
            )


class AggregateTests(unittest.TestCase):
    def contributions(self, count=3, values=(10, 20, 30)):
        return [
            {
                "participant": f"agent-{index}",
                "value": values[index % len(values)],
                "proofRef": f"attestation:{index}",
            }
            for index in range(count)
        ]

    def test_a_network_answer_needs_distinct_participants(self):
        body = {
            "question": "what does a verified storage month cost?",
            "contributions": self.contributions(count=3, values=(10, 20, 30)),
            "aggregate": 20,
        }
        body["contributions"][1]["participant"] = "agent-0"
        with self.assertRaises(ValueError):
            market_rules.verify(
                artifact("market.aggregate", body),
                CHALLENGES["market-aggregate-v1"],
            )

    def test_the_aggregate_is_recomputed(self):
        result = market_rules.verify(
            artifact(
                "market.aggregate",
                {
                    "question": "what does a verified storage month cost?",
                    "contributions": self.contributions(),
                    "aggregate": 20,
                },
            ),
            CHALLENGES["market-aggregate-v1"],
        )
        self.assertTrue(result["correct"])
        self.assertEqual(result["proof"]["participants"], 3)
        self.assertEqual(result["proof"]["aggregate"], 20)

    def test_a_wrong_aggregate_is_refused(self):
        with self.assertRaises(ValueError):
            market_rules.verify(
                artifact(
                    "market.aggregate",
                    {
                        "question": "what does a verified storage month cost?",
                        "contributions": self.contributions(),
                        "aggregate": 999,
                    },
                ),
                CHALLENGES["market-aggregate-v1"],
            )

    def test_a_contribution_without_a_proof_is_refused(self):
        body = {
            "question": "what does a verified storage month cost?",
            "contributions": self.contributions(),
            "aggregate": 20,
        }
        del body["contributions"][0]["proofRef"]
        with self.assertRaises(ValueError):
            market_rules.verify(
                artifact("market.aggregate", body),
                CHALLENGES["market-aggregate-v1"],
            )


if __name__ == "__main__":
    unittest.main()
