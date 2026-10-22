#!/usr/bin/env python3
"""Minimal RAREXT external verifier.

Run:
    python3 verifier.py

Then start the API with RAREXT_VERIFIERS and RAREXT_CHALLENGES pointing at
the example configs in this directory.
"""

import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP = os.environ.get("RAREXT_VERIFIER_APP", "echo-lab")
KIND = os.environ.get("RAREXT_VERIFIER_KIND", "echo.signal")
PORT = int(os.environ.get("PORT", "9100"))
MAX_BODY = 1_000_000


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def verify(artifact, challenge):
    if not isinstance(artifact, dict) or not isinstance(challenge, dict):
        raise ValueError("artifact and challenge must be objects")
    if artifact.get("app") != APP:
        raise ValueError(f"unsupported app: {artifact.get('app')}")
    if artifact.get("kind") != KIND:
        raise ValueError(f"unsupported artifact kind: {artifact.get('kind')}")
    if challenge.get("app") != APP:
        raise ValueError(f"challenge belongs to another app: {challenge.get('app')}")
    if "body" not in artifact:
        raise ValueError("artifact.body is required")

    digest = hashlib.sha256(canonical(artifact["body"]).encode("utf-8")).hexdigest()

    return {
        "correct": True,
        "score": 100,
        "gateCount": 0,
        "proof": {"algorithm": "sha256", "digest": digest},
        "details": {"app": APP, "kind": KIND},
    }


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/verify":
            self.send_error(404)
            return

        length = int(self.headers.get("content-length", "0"))
        if length > MAX_BODY:
            self.send_json(413, {"error": "request body is too large"})
            return

        try:
            request = json.loads(self.rfile.read(length) or b"{}")
            output = verify(request.get("artifact"), request.get("challenge"))
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
        print(f"[verifier] {fmt % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"RAREXT verifier for {APP} listening on http://127.0.0.1:{PORT}/verify")
    server.serve_forever()
