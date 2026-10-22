#!/usr/bin/env python3
"""FABRIC storage verifier service.

Run:
    python3 server.py

Endpoints:
    POST /storage/verify
    GET  /health

Reads the blob store read-only. Set RAREXT_BLOB_DIR if the registry keeps its
blobs somewhere other than .data/blobs.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import storage_rules

PORT = int(os.environ.get("PORT", "9400"))
MAX_BODY = 20_000_000
HERE = os.path.dirname(os.path.abspath(__file__))


def manifest():
    return {
        "app": "storage",
        "artifactKind": "storage.manifest",
        "algorithm": "storage-v1",
        "rulesHash": storage_rules.hashlib.sha256(
            open(os.path.join(HERE, "storage_rules.py"), "rb").read()
        ).hexdigest(),
    }


def dispatch(path, request):
    if path != "/storage/verify":
        raise LookupError("not found")

    artifact = request.get("artifact")
    challenge = request.get("challenge")

    if not isinstance(artifact, dict) or not isinstance(challenge, dict):
        raise ValueError("artifact and challenge must be objects")

    output = storage_rules.verify(artifact, challenge)
    output["manifest"] = manifest()
    return output


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "app": "storage"})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        if length > MAX_BODY:
            self.send_json(413, {"error": "request body is too large"})
            return

        try:
            request = json.loads(self.rfile.read(length) or b"{}")
            output = dispatch(self.path, request)
        except LookupError:
            self.send_json(404, {"error": "not found"})
            return
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(422, {"error": str(error)})
            return

        self.send_json(200, output)

    def send_json(self, status, value):
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print(f"[storage] {fmt % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"FABRIC storage verifier listening on http://127.0.0.1:{PORT}")
    server.serve_forever()
