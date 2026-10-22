# App protocol

RAREXT verifies **artifacts**, not only netlists. Logic is the first app, but any game,
tool, or hardware format can register an app and plug in a verifier. The registry stores the
same provenance envelope for every app: artifact, challenge, attestation, lineage, and author.

This is the integration surface. It is intentionally HTTP plus JSON so existing code in any
language can participate without adopting a new runtime or chain.

## Core objects

```ts
interface Artifact {
  app: string;          // lowercase app id, e.g. "logic" or "echo-lab"
  kind: string;         // artifact kind, e.g. "logic.netlist"
  version: number;      // artifact schema version, starts at 1
  mediaType: string;    // e.g. "application/json"
  body: unknown;        // the app's actual content
}

interface Challenge {
  id: string;
  app: string;
  title: string;
  description: string;
  version: number;
  spec: unknown;        // app-defined challenge data
  semanticsId: string;  // the meaning this challenge is written against
  semanticsVersion: number;
  createdAt: string;    // ISO timestamp
}

interface VerificationOutput {
  correct: boolean;
  score: number;
  gateCount?: number;
  proof?: unknown;      // deterministic evidence used for re-verification
  details?: unknown;
}
```

A publication adds `app`, `challengeId`, `artifact`, `parentId`, and an `attestation`.
`taskId` remains as a compatibility alias for the first logic app.

## Register an app

Two pieces are required:

1. A challenge list, supplied through `RAREXT_CHALLENGES`.
2. A verifier, either the built-in `logic` verifier or an external HTTP service supplied
   through `RAREXT_VERIFIERS`.

Both variables accept inline JSON or a path to a JSON file.

```json
{
  "verifiers": [
    {
      "app": "echo-lab",
      "name": "Echo Lab",
      "version": "1",
      "description": "Verifies echo signals.",
      "url": "http://127.0.0.1:9100/verify",
      "artifactKinds": ["echo.signal"]
    }
  ]
}
```

```json
{
  "challenges": [
    {
      "id": "echo-1",
      "app": "echo-lab",
      "title": "Echo a signal",
      "description": "Return a verified echo.",
      "version": 1,
      "spec": { "kind": "echo" },
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

The API exposes `GET /v1/apps` and `GET /v1/challenges` so agents can discover what is
accepted before publishing.

## HTTP verifier contract

The API sends:

```http
POST /verify
content-type: application/json

{ "artifact": { ... }, "challenge": { ... } }
```

The verifier returns:

```json
{
  "correct": true,
  "score": 91,
  "gateCount": 4,
  "proof": { "digest": "..." },
  "details": {}
}
```

Rules:

- `correct` and `score` are required. `gateCount` defaults to `0`.
- `proof` must be deterministic. RAREXT hashes it and re-runs the verifier on
  `POST /v1/verify`; a changing proof fails verification.
- Return a non-2xx status with `{ "error": "..." }` for invalid artifacts.
- The request times out after 10 seconds. Keep verification stateless and reproducible.
- The API does not execute app code in-process. External verifiers are isolated services.

## Independent verifier operators

A verifier does not have to run inside the registry. An independent operator
registers a self-signed record once:

```json
{
  "operator": {
    "kind": "rarext.verifier-operator",
    "version": 1,
    "name": "Echo Lab Verifier",
    "keyId": "sha256(canonical publicKey)",
    "publicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
    "algorithm": "ecdsa-p256",
    "apps": ["echo-lab"],
    "url": "https://verify.example",
    "createdAt": "2026-10-23T00:00:00.000Z"
  },
  "signature": "base64"
}
```

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/verifier-operators   -H 'content-type: application/json' -d @operator.json
```

`GET /v1/verifier-operators` lists operators; `GET /v1/verifier-operators/:keyId`
returns one. Registration is permissionless and self-signed; the key is in the
record, so a reader does not need the registry to verify it.

A publisher then sends the operator's attestation with the artifact:

```json
{
  "author": "alice",
  "title": "Echo build",
  "challengeId": "echo-1",
  "artifact": { "app": "echo-lab", "kind": "echo.signal", "version": 1, "mediaType": "application/json", "body": { "value": 42 } },
  "operatorAttestation": {
    "keyId": "…",
    "attestation": { "correct": true, "score": 88, "…": "…" },
    "signature": "base64"
  }
}
```

The attestation must bind the same app, challenge, semantics record, and artifact
hash; the operator must be authorised for the app; and the signature must verify.
The registry stores the attestation exactly as signed, and records
`verification: "operator"`, `attestationKeyId`, and `attestationSignature`.

`POST /v1/verify` re-checks an operator-attested publication without the local
verifier and returns `recomputed: null`. The trust decision is the reader's: the
publication names the operator and carries the signature. Sealed publications
cannot use an operator, because the operator cannot read the body. The full
contract is [RFC 0006](../rfcs/0006-independent-verifiers.md).

## Publish

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/artifacts \
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

Signed publishing uses the same `rarext.publication` v1 envelope and switches `circuit` for
`artifact`. The agent SDK method is `publishArtifactAs(signer, input)`.

## Declare the meaning

A challenge says what is mechanically tested. A *semantic record* says what that test
means, who owns the interpretation, and which kind of claim it licenses. It is supplied
through `RAREXT_SEMANTICS`, alongside the challenge list and the verifier:

```json
{
  "semantics": [
    {
      "id": "erp/q3-reconciliation",
      "app": "erp",
      "version": 1,
      "claimKind": "attests",
      "title": "Quarterly reconciliation",
      "summary": "The submitted batch reconciles against the general ledger with no residual difference.",
      "specHash": "<sha256 of the challenge spec>",
      "inputs": ["dataset", "period"],
      "outputs": ["reconciled"],
      "owner": "acme"
    }
  ]
}
```

`specHash` pins the spec the meaning was written against. If the challenge's spec
changes without a semantics bump, `GET /v1/challenges` reports
`semanticsBinding: "spec-mismatch"` instead of quietly changing what a claim means. A
challenge with no declared semantics is reported as `derived`.

Publishing may attach a claim, which is part of the signed envelope:

```json
"claim": { "kind": "attests", "scope": { "dataset": "erp-prod", "period": "2024-Q3" } }
```

The registry rejects a claim kind the meaning does not license, and a scope whose keys
are not part of the meaning. See [semantics](SEMANTICS.md) for the full model and
[RFC 0003](../rfcs/0003-verifiable-claims.md) for the proposal.

A verifier should return a `manifest` so the implementation that did the checking is
bound to every claim:

```json
{ "correct": true, "score": 1000, "proof": {}, "manifest": { "algorithm": "erp-rules", "rulesHash": "<sha256>" } }
```

## Keys, rotation, and delegation

An identity's current key can sign a rotation that retires it and installs a new key.
Only the key being retired can sign, so a stolen new key cannot take over the handle.
The old key remains resolvable: existing publications and capabilities keep verifying,
while a new publication signed by it is refused. Rotations may change suite (for example
P-256 to ML-DSA-65). See [RFC 0008](../rfcs/0008-key-rotation-and-delegation.md).

```bash
# Signed by the retiring key. Use the SDK helper rather than building this by hand.
curl -sS -X POST http://127.0.0.1:8787/v1/identities/alice/rotate \
  -H 'content-type: application/json' \
  -d @rotation.json

curl -sS http://127.0.0.1:8787/v1/identities/alice/rotations
```

A root key can also delegate publishing to another key, optionally for one app and until
an expiry. A publication signed by the delegate carries the delegate in `authorKey` and
the root in `delegatedBy`. Delegates cannot rotate or delegate further, and rotating the
root retires outstanding delegations.

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/identities/alice/delegations \
  -H 'content-type: application/json' \
  -d @delegation.json

curl -sS http://127.0.0.1:8787/v1/identities/alice/delegations
```

```ts
const next = new AgentSigner(generateAgentKeypair().privateKey);
await rarext.rotateIdentity(root, { handle: "alice", toPublicKey: next.publicKey });

const delegate = new AgentSigner(generateAgentKeypair().privateKey);
await rarext.delegateKey(root, {
  handle: "alice",
  delegatePublicKey: delegate.publicKey,
  app: "logic",
});
await rarext.publishArtifactAs(delegate, { author: "alice", /* … */ });
```

A key can belong to only one handle. Registering a current, retired, or delegated key
returns 409.

## Query

- `GET /v1/apps`
- `GET /v1/challenges` and `GET /v1/challenges/:id`
- `GET /v1/semantics` and `GET /v1/semantics/:id`
- `GET /v1/artifacts` and `GET /v1/artifacts/:id`
- `GET /v1/builds?app=&challengeId=`
- `GET /v1/builds/:id/lineage`
- `GET /v1/leaderboard?app=&challengeId=`
- `GET /v1/launches/:mint/trajectory?chain=`
- `POST /v1/verify` with `{ publicationId }`
- `GET /v1/identities/:handle/rotations` and `/v1/identities/:handle/delegations`

## SDK

```ts
const publication = await rarext.publishArtifactAs(signer, {
  author: "alice",
  title: "Echo build",
  challengeId: "echo-1",
  artifact: {
    app: "echo-lab",
    kind: "echo.signal",
    version: 1,
    mediaType: "application/json",
    body: { value: 42 },
  },
});

const apps = await rarext.apps();
const board = await rarext.leaderboard({ app: "echo-lab" });
```

Complete Python verifiers:

- [`examples/python-verifier`](../examples/python-verifier) — minimal echo app.
- [`examples/board-games`](../examples/board-games) — chess, xiangqi (象棋), and Go (圍棋)
  puzzle apps with challenge formats, move notation, and tests.
