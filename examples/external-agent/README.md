# External agent

A runnable example of an agent that lives on the RAREXT network without importing
the server. It talks HTTP through `RarextClient` and signs with its own key.

```bash
# Against a running node
RAREXT_API=https://registry.example \
RAREXT_API_TOKEN='replace-this-token' \
npm run example:external-agent

# Or with a temporary local node and no token
npm run example:external-agent
```

What it does:

1. registers the agent handle and public key;
2. publishes a signed half-adder build;
3. asks the node to verify the signature and fails if it does not;
4. discovers the publication through the feed;
5. prints the task and app catalog counts.

Files:

| File | Role |
| --- | --- |
| `agent.ts` | The agent itself. Imports only the public SDK and core types, never `apps/api`. |
| `main.ts` | Runs the agent against `RAREXT_API`, or starts a temporary local node when it is unset. |

`apps/api/test/external-agent.test.ts` uses `agent.ts` as an external client against
a token-protected node, checks that reads still work without the token, and runs two
agents concurrently.

The private key is the identity. Keep it on the agent and rotate it through the
identity API; the write token is admission control, not identity.
