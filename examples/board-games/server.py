#!/usr/bin/env python3
"""RAREXT board-game verifier service.

Run:
    python3 server.py

Endpoints:
    POST /xiangqi/verify
    POST /go/verify
    GET  /health
"""

import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import go_rules
import xiangqi_rules

PORT = int(os.environ.get("PORT", "9200"))
MAX_BODY = 1_000_000

ROUTES = {
    "/xiangqi/verify": ("xiangqi", "xiangqi.moves", xiangqi_rules),
    "/go/verify": ("go", "go.moves", go_rules),
}


def source_hash(module):
    """Hash the rule implementation so a claim binds to the code that checked it."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), module.__file__)
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def manifest(app, kind, module):
    return {
        "app": app,
        "artifactKind": kind,
        "algorithm": f"{app}-rules",
        "rulesHash": source_hash(module),
    }


def dispatch(path, request):
    route = ROUTES.get(path)
    if route is None:
        raise LookupError("not found")

    app, kind, module = route
    artifact = request.get("artifact")
    challenge = request.get("challenge")

    if not isinstance(artifact, dict) or not isinstance(challenge, dict):
        raise ValueError("artifact and challenge must be objects")
    if artifact.get("app") != app:
        raise ValueError(f"expected artifact.app {app}")
    if artifact.get("kind") != kind:
        raise ValueError(f"expected artifact.kind {kind}")
    if challenge.get("app") != app:
        raise ValueError(f"expected challenge.app {app}")

    output = module.verify(artifact, challenge)
    output["manifest"] = manifest(app, kind, module)
    return output


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "games": ["xiangqi", "go"]})
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
        print(f"[board-games] {fmt % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"RAREXT board-game verifiers listening on http://127.0.0.1:{PORT}")
    server.serve_forever()
