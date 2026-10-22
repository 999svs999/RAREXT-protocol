# Python verifier example

This shows an existing service in another language joining RAREXT without changing its
runtime. The API only needs an HTTP endpoint that verifies one artifact against one challenge.

```bash
# terminal 1
python3 verifier.py

# terminal 2
RAREXT_VERIFIERS=examples/python-verifier/verifiers.json \
RAREXT_CHALLENGES=examples/python-verifier/challenges.json \
npm run dev:api
```

Check registration and publish:

```bash
curl -s http://127.0.0.1:8787/v1/apps
curl -s -X POST http://127.0.0.1:8787/v1/artifacts \
  -H 'content-type: application/json' \
  -d '{
    "author": "alice",
    "title": "Echo build",
    "challengeId": "echo-1",
    "artifact": {
      "app": "echo-lab",
      "kind": "echo.signal",
      "version": 1,
      "mediaType": "application/json",
      "body": { "value": 42 }
    }
  }'
```

The verifier receives `{ artifact, challenge }`, returns `{ correct, score, gateCount, proof }`,
and must be deterministic. See [docs/APP-PROTOCOL.md](../../docs/APP-PROTOCOL.md).
