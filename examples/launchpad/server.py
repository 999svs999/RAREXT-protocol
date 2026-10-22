#!/usr/bin/env python3
"""RAREXT fair-launch verifier service.

Run:
    python3 server.py

Endpoints:
    POST /launch/verify
    GET  /health

The verifier reads chain state from a snapshot file so the example runs with no
network and no third-party packages. Swap `snapshot_reader` for an RPC reader
and the checks are unchanged: the policy lives in the challenge spec, not here.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fair_launch

PORT = int(os.environ.get("PORT", "9300"))
MAX_BODY = 1_000_000
SNAPSHOT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "chain_snapshot.json"
)


def load_snapshot():
    if not os.path.exists(SNAPSHOT):
        return {}
    with open(SNAPSHOT, "r", encoding="utf-8") as handle:
        return json.load(handle)


def manifest():
    """Identifies this implementation so a claim binds to the code that checked it."""
    return {
        "app": "launchpad",
        "artifactKind": "launch.plan",
        "algorithm": "fair-launch-v1",
        "rulesHash": fair_launch.sha256(
            open(
                os.path.join(
                    os.path.dirname(os.path.abspath(__file__)), "fair_launch.py"
                ),
                "rb",
            ).read()
        ),
    }


def dispatch(path, request):
    if path != "/launch/verify":
        raise LookupError("not found")

    artifact = request.get("artifact")
    challenge = request.get("challenge")

    if not isinstance(artifact, dict) or not isinstance(challenge, dict):
        raise ValueError("artifact and challenge must be objects")

    reader = fair_launch.snapshot_reader(load_snapshot())
    output = fair_launch.verify(artifact, challenge, reader)
    output["manifest"] = manifest()
    return output


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "app": "launchpad"})
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
        print(f"[launchpad] {fmt % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"RAREXT fair-launch verifier listening on http://127.0.0.1:{PORT}")
    server.serve_forever()
