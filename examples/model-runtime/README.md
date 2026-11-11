# Model runtime deployment examples

Drop-in supervisors for `rarext-runtime`, in the local and remote placements.
(The third placement, storage-native `web4`, needs no engine supervisor: a
provider fetches and runs the committed weights and engine from RAREXT. See
[`docs/WEB4-MODEL.md`](../../docs/WEB4-MODEL.md).)

Local: the engine stays a separate process; keep it and the runtime on the same
host so the engine endpoint is loopback.

- `docker-compose.yml` — Ollama + pull + deploy + verifier + registry + runtime.
- `launchd/com.rarext.runtime.plist.template` — macOS.
- `systemd/rarext-runtime.service` — Linux.

Remote (cloud-only): the runtime is purely a control plane. It holds no weights,
downloads no model files, and runs no inference; every request is forwarded to
an OpenAI- or Anthropic-compatible provider.

- `cloud/Dockerfile`, `cloud/compose.yml`, `cloud/Caddyfile` — runtime +
  verifier + registry + TLS edge, no engine container, no model volume.
- `cloud/compose.adopt.yml` — a control plane that serves a card already
  published to RAREXT, with no deploy step or local `deployment.json`.
- `cloud/.env.example` — provider endpoint, public URL, gateway token, registry.

Read [`docs/MODEL-RUNTIME.md`](../../docs/MODEL-RUNTIME.md) for local placement
and [`docs/CLOUD-RUNTIME.md`](../../docs/CLOUD-RUNTIME.md) for the cloud-only
path. Replace `/Users/r/rarext-protocol` and user names with your own paths.

```bash
# Docker (from the repo root)
docker compose -f examples/model-runtime/docker-compose.yml up --build

# then
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"hello"}],"temperature":0,"seed":42}'
```
