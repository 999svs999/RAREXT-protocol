# Model runtime deployment examples

Drop-in supervisors for `rarext-runtime`. The engine stays a separate process;
keep it and the runtime on the same host so the engine endpoint is loopback.

- `docker-compose.yml` — Ollama + pull + deploy + verifier + registry + runtime.
- `launchd/com.rarext.runtime.plist.template` — macOS.
- `systemd/rarext-runtime.service` — Linux.

Read [`docs/MODEL-RUNTIME.md`](../../docs/MODEL-RUNTIME.md) first. Replace
`/Users/r/rarext-protocol` and user names with your own paths.

```bash
# Docker (from the repo root)
docker compose -f examples/model-runtime/docker-compose.yml up --build

# then
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"hello"}],"temperature":0,"seed":42}'
```
