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

TIERS = ("public", "sealed")
SEALED_ALGORITHMS = ("xchacha20-poly1305", "aes-256-gcm", "hpke")
MAX_BLOB_BYTES = 5_000_000


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

    root = blob_dir()
    checks = []
    problems = []
    present = 0

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

    correct = len(problems) == 0 and present == len(entries)

    return {
        "correct": correct,
        "score": 1000 if correct else 0,
        "proof": {
            "policy": policy,
            "blobs": len(entries),
            "present": present,
            "checks": checks,
        },
        "details": {
            "policy": policy,
            "present": present,
            "listed": len(entries),
            "problems": problems,
        },
    }
