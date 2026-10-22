import hashlib
import json
import os
import shutil
import tempfile
import unittest

import storage_rules

CHALLENGE = {
    "id": "storage-v1",
    "app": "storage",
    "spec": {
        "policy": "storage-v1",
        "limits": {"tiers": ["public", "sealed"], "requireSealedEnvelope": True},
        "failClosed": True,
    },
}

ENVELOPE = {
    "alg": "xchacha20-poly1305",
    "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
    "ciphertext": "Y2lwaGVydGV4dA==",
    "recipients": [{"keyId": "abc", "wrapped": "Z3JhcA=="}],
}


def write_blob(root, payload):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    with open(os.path.join(root, digest), "wb") as handle:
        handle.write(payload)
    return digest, len(payload)


def manifest_entry(digest, size, tier="public", sealed=False, retention=None):
    return {
        "hash": digest,
        "size": size,
        "tier": tier,
        "sealed": sealed,
        "retentionUntil": retention,
    }


def artifact(entries):
    return {
        "app": "storage",
        "kind": "storage.manifest",
        "version": 1,
        "mediaType": "application/json",
        "body": {"policy": "storage-v1", "blobs": entries},
    }


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="fabric-storage-test-")
        self.previous = os.environ.get("RAREXT_BLOB_DIR")
        os.environ["RAREXT_BLOB_DIR"] = self.root

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("RAREXT_BLOB_DIR", None)
        else:
            os.environ["RAREXT_BLOB_DIR"] = self.previous
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_present_blob_is_proven(self):
        digest, size = write_blob(self.root, "hello world")
        result = storage_rules.verify(
            artifact([manifest_entry(digest, size)]), CHALLENGE
        )
        self.assertTrue(result["correct"])
        self.assertEqual(result["proof"]["present"], 1)
        self.assertEqual(result["details"]["problems"], [])

    def test_a_missing_blob_is_not_proven(self):
        digest, size = write_blob(self.root, "hello world")
        os.remove(os.path.join(self.root, digest))
        result = storage_rules.verify(
            artifact([manifest_entry(digest, size)]), CHALLENGE
        )
        self.assertFalse(result["correct"])
        self.assertIn("not present", result["details"]["problems"][0])

    def test_content_that_does_not_hash_to_its_name_is_rejected(self):
        digest, size = write_blob(self.root, "hello world")
        with open(os.path.join(self.root, digest), "wb") as handle:
            handle.write(b"tampered")
        result = storage_rules.verify(
            artifact([manifest_entry(digest, size)]), CHALLENGE
        )
        self.assertFalse(result["correct"])
        self.assertIn("does not hash to its name", result["details"]["problems"][0])

    def test_a_wrong_size_is_rejected(self):
        digest, size = write_blob(self.root, "hello world")
        result = storage_rules.verify(
            artifact([manifest_entry(digest, size + 1)]), CHALLENGE
        )
        self.assertFalse(result["correct"])
        self.assertIn("size does not match", result["details"]["problems"][0])

    def test_a_sealed_entry_must_be_an_envelope(self):
        digest, size = write_blob(self.root, "plaintext secret")
        result = storage_rules.verify(
            artifact([manifest_entry(digest, size, tier="sealed", sealed=True)]),
            CHALLENGE,
        )
        self.assertFalse(result["correct"])
        self.assertIn("not an envelope", result["details"]["problems"][0])

    def test_a_sealed_envelope_is_accepted(self):
        digest, size = write_blob(self.root, json.dumps(ENVELOPE))
        result = storage_rules.verify(
            artifact([manifest_entry(digest, size, tier="sealed", sealed=True)]),
            CHALLENGE,
        )
        self.assertTrue(result["correct"])

    def test_an_unlicensed_tier_is_rejected(self):
        digest, size = write_blob(self.root, "hello world")
        result = storage_rules.verify(
            artifact([manifest_entry(digest, size, tier="enterprise")]), CHALLENGE
        )
        self.assertFalse(result["correct"])
        self.assertIn("not licensed", result["details"]["problems"][0])

    def test_one_missing_blob_fails_the_whole_manifest(self):
        good, good_size = write_blob(self.root, "a")
        bad = "b" * 64
        result = storage_rules.verify(
            artifact([manifest_entry(good, good_size), manifest_entry(bad, 3)]),
            CHALLENGE,
        )
        self.assertFalse(result["correct"])
        self.assertEqual(result["proof"]["present"], 1)
        self.assertEqual(result["proof"]["blobs"], 2)

    def test_only_storage_manifests_are_accepted(self):
        other = artifact([])
        other["kind"] = "something.else"
        with self.assertRaises(ValueError):
            storage_rules.verify(other, CHALLENGE)

    def test_an_empty_manifest_is_rejected(self):
        with self.assertRaises(ValueError):
            storage_rules.verify(artifact([]), CHALLENGE)


if __name__ == "__main__":
    unittest.main()
