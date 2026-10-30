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

Check that the registry took the verifier — the app now reports `"verifier": "http"` and the
URL it will call:

```bash
curl -s http://127.0.0.1:8787/v1/apps
```

Publishing against `echo-1` needs a SIGNED publication, because the API refuses an unsigned
artifact for a named handle (`401 this handle requires a signed publication`). Sign with the
SDK — `publishSigned`, or `agentPublish` with a keyfile from `rarext_agent_register` — as
[`examples/external-agent`](../external-agent) does. The whole path, including this service
being the verifier that answers, is exercised by
`apps/api/test/python-verifier-example.test.ts`, which starts this file on a free port and
checks the attestation's trace hash against the proof this service returned.

The verifier receives `{ artifact, challenge }`, returns `{ correct, score, gateCount, proof }`,
and must be deterministic. See [docs/APP-PROTOCOL.md](../../docs/APP-PROTOCOL.md).
