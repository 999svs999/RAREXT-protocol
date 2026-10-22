"""Storage verifier for FABRIC: proof of possession and proof of terms.

A storage manifest lists blobs with the terms they are stored under. This
verifier reads the referenced bytes and checks that what is on disk is what the
manifest claims: the content hashes to the declared digest, the size matches, the
tier is licensed by the policy, and a sealed entry really is stored as a sealed
envelope rather than plaintext.

The result is a claim a buyer can check: "these bytes exist, they hash to this,
and they are held under these terms". The manifest's Merkle root binds the entry,
and the manifest is a publication whose leaf is in an anchor root, so the chain of
trust runs from a blob digest to a timestamped public commitment.

Fail closed. A missing blob, a mismatched digest, or an unreadable directory is
not a pass.
"""

import hashlib
import json
import os
import time

TIERS = ("public", "sealed")
SEALED_ALGORITHMS = ("xchacha20-poly1305", "aes-256-gcm", "hpke")
MAX_BLOB_BYTES = 5_000_000


def canonicalize(value):
    """The canonical JSON form the protocol hashes."""
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


def retention_commitment(opening, digest, retention_until):
    payload = f"{opening}:{canonicalize({'hash': digest, 'retentionUntil': retention_until})}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def blob_dir():
    return os.environ.get("RAREXT_BLOB_DIR", os.path.join(".data", "blobs"))


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def read_blob(root, digest):
    path = os.path.join(root, digest)
    if not os.path.isfile(path):
        return None
    if os.path.getsize(path) > MAX_BLOB_BYTES:
        return None
    return path


def is_sealed_envelope(path):
    """A sealed blob must be an envelope, not plaintext we can read."""
    try:
        with open(path, "rb") as handle:
            head = handle.read(4096)
    except OSError:
        return False

    try:
        envelope = json.loads(head.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False

    if not isinstance(envelope, dict):
        return False

    algorithm = str(envelope.get("alg", "")).lower()
    if algorithm not in SEALED_ALGORITHMS:
        return False

    if not isinstance(envelope.get("nonce"), str) or not envelope["nonce"]:
        return False

    if not isinstance(envelope.get("ciphertext"), str):
        return False

    return True


def verify(artifact, challenge):
    if artifact.get("app") != "storage" or artifact.get("kind") != "storage.manifest":
        raise ValueError("expected a storage.storage.manifest artifact")

    body = artifact.get("body")
    if not isinstance(body, dict):
        raise ValueError("storage manifest body must be an object")

    spec = challenge.get("spec") or {}
    policy = spec.get("policy") or "storage-v1"
    limits = spec.get("limits") or {}
    allowed_tiers = tuple(limits.get("tiers") or TIERS)
    require_sealed_envelope = bool(limits.get("requireSealedEnvelope", True))

    entries = body.get("blobs")
    if not isinstance(entries, list) or len(entries) == 0:
        raise ValueError("storage manifest must list at least one blob")

    now = time.time()
    root = blob_dir()
    checks = []
    problems = []
    present = 0
    retention = {"committed": 0, "matured": 0, "unproven": 0}

    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("manifest entries must be objects")

        digest = entry.get("hash")
        tier = entry.get("tier")
        sealed = bool(entry.get("sealed"))

        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError("manifest entry hash must be a sha256 digest")
        if tier not in allowed_tiers:
            problems.append(f"tier {tier} is not licensed by policy {policy}")
            checks.append({"hash": digest, "tier": tier, "read": True, "ok": False})
            continue

        path = read_blob(root, digest)

        if path is None:
            problems.append(f"blob {digest[:12]} is not present in the store")
            checks.append({"hash": digest, "tier": tier, "read": False, "ok": False})
            continue

        actual = sha256_file(path)
        if actual != digest:
            problems.append(f"blob {digest[:12]} does not hash to its name")
            checks.append({"hash": digest, "tier": tier, "read": True, "ok": False})
            continue

        size = os.path.getsize(path)
        declared_size = entry.get("size")
        if isinstance(declared_size, int) and declared_size != size:
            problems.append(f"blob {digest[:12]} size does not match the manifest")
            checks.append({"hash": digest, "tier": tier, "read": True, "ok": False})
            continue

        if sealed and require_sealed_envelope and not is_sealed_envelope(path):
            problems.append(f"blob {digest[:12]} is declared sealed but is not an envelope")
            checks.append({"hash": digest, "tier": tier, "read": True, "ok": False})
            continue

        present += 1
        checks.append({"hash": digest, "tier": tier, "read": True, "ok": True})

        # Retention: the commitment says the node bound itself to holding the
        # blob until a time. The opening, once the term has matured, shows the
        # commitment was made by whoever still holds the blob. A node that
        # deleted the blob early cannot produce either half.
        commitment = entry.get("retentionCommitment")
        retention_until = entry.get("retentionUntil")

        if commitment:
            if not isinstance(commitment, str) or len(commitment) != 64:
                problems.append(f"blob {digest[:12]} has a malformed retention commitment")
                retention["unproven"] += 1
            elif not retention_until:
                problems.append(f"blob {digest[:12]} commits to retention without a term")
                retention["unproven"] += 1
            else:
                retention["committed"] += 1
                opening = entry.get("retentionOpening")

                if opening:
                    expected = retention_commitment(opening, digest, retention_until)
                    if expected != commitment:
                        problems.append(
                            f"blob {digest[:12]} has a retention opening that does not match its commitment"
                        )
                        retention["unproven"] += 1
                    elif now < _time(retention_until):
                        problems.append(
                            f"blob {digest[:12]} opened a retention term before it matured"
                        )
                        retention["unproven"] += 1
                    else:
                        retention["matured"] += 1

    correct = len(problems) == 0 and present == len(entries)

    return {
        "correct": correct,
        "score": 1000 if correct else 0,
        "proof": {
            "policy": policy,
            "blobs": len(entries),
            "present": present,
            "checks": checks,
            "retention": retention,
        },
        "details": {
            "policy": policy,
            "present": present,
            "listed": len(entries),
            "problems": problems,
            "retention": retention,
        },
    }


def _time(value):
    import datetime

    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0
