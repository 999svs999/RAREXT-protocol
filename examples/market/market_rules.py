"""Market rules for the RAREXT market app.

Three challenges, each with one meaning:

* `participant-profile-v1` — what a participant is. A human, an AI agent, or a
  robot, self-attested, with an explicit list of what it does *not* claim. The
  protocol does not special-case any of them; the difference is what they can
  prove.
* `market-listing-v1` — a listing is a well-formed offer whose terms stay inside
  the policy. A listing that promises a return is rejected, because a market for
  agents and robots is exactly where that copy would appear.
* `market-aggregate-v1` — a claim about what the network thinks. It is the
  aggregate of independent, verified contributions, and it only counts as a
  network answer when enough distinct participants contributed.

Fail closed everywhere: a missing field is not a pass.
"""

import hashlib
import json

PARTICIPANT_KINDS = ("human", "agent", "robot")
MAX_LISTING_PRICE = 100_000
MAX_LISTING_DAYS = 365
FORBIDDEN_PROMISE_WORDS = (
    "guaranteed",
    "guarantee",
    "risk-free",
    "risk free",
    "no risk",
    "profit guarantee",
    "assured return",
    "double your",
)


def canonicalize(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    keys = sorted(key for key in value if value[key] is not None)
    return (
        "{"
        + ",".join(
            json.dumps(key) + ":" + canonicalize(value[key]) for key in keys
        )
        + "}"
    )


def digest(value):
    return hashlib.sha256(canonicalize(value).encode("utf-8")).hexdigest()


def _body(artifact):
    body = artifact.get("body")
    if not isinstance(body, dict):
        raise ValueError("market artifact body must be an object")
    return body


def verify_participant_profile(artifact, challenge):
    body = _body(artifact)
    kind = body.get("kind")

    if kind not in PARTICIPANT_KINDS:
        raise ValueError("profile kind must be human, agent, or robot")

    if kind == "agent":
        model = body.get("model")
        if not isinstance(model, str) or not model:
            raise ValueError("an agent profile must name its model")
        if not isinstance(body.get("tools"), list):
            raise ValueError("an agent profile must list its tools")

    if kind == "robot":
        hardware = body.get("hardware")
        if not isinstance(hardware, str) or not hardware:
            raise ValueError("a robot profile must name its hardware class")

    disclosure = body.get("doesNotClaim")
    if not isinstance(disclosure, list) or not disclosure:
        raise ValueError("a profile must say what it does not claim")

    proof = digest(
        {
            "kind": kind,
            "model": body.get("model"),
            "hardware": body.get("hardware"),
            "tools": body.get("tools"),
            "doesNotClaim": disclosure,
        }
    )

    return {
        "correct": True,
        "score": 1000,
        "proof": {
            "market": "participant-profile",
            "kind": kind,
            "profileHash": proof,
        },
        "details": {
            "kind": kind,
            "disclosures": len(disclosure),
        },
    }


def verify_market_listing(artifact, challenge):
    body = _body(artifact)
    spec = challenge.get("spec") or {}
    limits = spec.get("limits") or {}

    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("a listing needs a title")

    price = body.get("priceCredits")
    if not isinstance(price, int) or isinstance(price, bool) or price < 0:
        raise ValueError("priceCredits must be a whole number of credits")
    if price > limits.get("maxPriceCredits", MAX_LISTING_PRICE):
        raise ValueError("priceCredits is above the policy cap")

    expires = body.get("expiresInDays")
    if not isinstance(expires, int) or isinstance(expires, bool):
        raise ValueError("expiresInDays must be a whole number of days")
    if expires < 1 or expires > limits.get("maxDays", MAX_LISTING_DAYS):
        raise ValueError("expiresInDays is outside the policy range")

    text = " ".join(
        str(body.get(field, "")) for field in ("title", "description", "terms")
    ).lower()

    promises = [word for word in FORBIDDEN_PROMISE_WORDS if word in text]
    if promises:
        raise ValueError("a listing may not promise a return: " + ", ".join(promises))

    proof = digest(
        {
            "title": title,
            "priceCredits": price,
            "expiresInDays": expires,
            "seller": body.get("seller"),
        }
    )

    return {
        "correct": True,
        "score": 1000,
        "proof": {
            "market": "listing",
            "priceCredits": price,
            "listingHash": proof,
        },
        "details": {
            "priceCredits": price,
            "expiresInDays": expires,
        },
    }


def _median(values):
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def verify_market_aggregate(artifact, challenge):
    body = _body(artifact)
    spec = challenge.get("spec") or {}
    limits = spec.get("limits") or {}
    min_participants = limits.get("minParticipants", 3)

    contributions = body.get("contributions")
    if not isinstance(contributions, list) or not contributions:
        raise ValueError("an aggregate needs contributions")

    participants = set()
    values = []

    for entry in contributions:
        if not isinstance(entry, dict):
            raise ValueError("each contribution must be an object")

        participant = entry.get("participant")
        if not isinstance(participant, str) or not participant:
            raise ValueError("each contribution must name a participant")

        value = entry.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError("each contribution must carry a numeric value")

        if not isinstance(entry.get("proofRef"), str) or not entry["proofRef"]:
            raise ValueError("each contribution must reference a proof")

        participants.add(participant)
        values.append(value)

    if len(participants) < min_participants:
        raise ValueError(
            f"a network answer needs at least {min_participants} distinct participants"
        )

    declared = body.get("aggregate")
    expected = _median(values)

    if isinstance(declared, (int, float)) and not isinstance(declared, bool):
        if abs(float(declared) - float(expected)) > 1e-9:
            raise ValueError("the declared aggregate does not match the contributions")
    else:
        raise ValueError("the aggregate must be a number")

    return {
        "correct": True,
        "score": 1000,
        "proof": {
            "market": "aggregate",
            "participants": len(participants),
            "contributions": len(values),
            "aggregate": expected,
            "aggregateHash": digest({"values": values, "participants": sorted(participants)}),
        },
        "details": {
            "participants": sorted(participants),
            "minParticipants": min_participants,
            "aggregate": expected,
        },
    }


VERIFIERS = {
    "participant-profile-v1": verify_participant_profile,
    "market-listing-v1": verify_market_listing,
    "market-aggregate-v1": verify_market_aggregate,
}


def verify(artifact, challenge):
    challenge_id = challenge.get("id")
    verifier = VERIFIERS.get(challenge_id)

    if verifier is None:
        raise ValueError(f"unknown market challenge: {challenge_id}")

    return verifier(artifact, challenge)
