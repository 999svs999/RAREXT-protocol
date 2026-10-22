# Brands

Two brands, one company, one protocol. This document is the rulebook; it exists
because renaming a public protocol twice is expensive and because the two brands
answer to different audiences.

| | RAREXT | ApesDaily |
| --- | --- | --- |
| What it is | The company and the protocol it ships | The public-facing brand |
| Audience | Developers, agents, institutions, partners | Everyone else — the public internet |
| Surfaces | API, SDK, MCP server, registry, docs, protocol kinds | Workbench, feed, launchpad, store, daily ritual, dweb apps |
| Repository | `rarext-protocol` (this repo) | `APESDAILY` |
| Packages | `@rarext/core`, `@rarext/agent-sdk`, `@rarext/mcp` | `@apesdaily/*` when needed |
| Env prefix | `RAREXT_*` | `APESDAILY_*` |
| MCP tools | `rarex_*` | — |
| Protocol kinds | `rarex.publication` | — |

## The rule

**RAREXT appears where the infrastructure did the work. ApesDaily appears where the
public product is.**

That single sentence resolves most cases:

- "Checked by RAREXT" — the registry verified it, so RAREXT is named.
- "Welcome to ApesDaily" — the user-facing surface, so ApesDaily is named.
- "Runs on the RAREXT protocol" — the public surface crediting the infrastructure.

The public surface never pretends to be the protocol, and the protocol never
borrows the consumer brand. RAREXT sells infrastructure; ApesDaily is where the
public meets it.

## The neutrality rule

RAREXT is both the company that builds the protocol and the protocol's steward. That
is a real conflict of interest, and it is handled by one rule:

> **The operator does not verify its own claims.**

ApesDaily's launches are certified by a verifier anyone can run against a published
policy — not by a process inside the ApesDaily app. The RAREXT consultancy publishes
its own engineering work through the same public path. If a claim can only be
checked by the party that benefits from it, the protocol has failed at the only job
it has.

This is why the fair-launch policy lives in a challenge spec, why the verifier's
source hash travels in every attestation, and why the anchor exists: three
independent parties can look at the same launch and reach the same answer.

## The portfolio

```
ApesDaily  (public brand)                RAREXT  (company + protocol)
├── launchpad        ──────────────▶     ├── registry, SDK, MCP
├── store                                    ├── artifact + claim protocol
├── workbench / feed                         ├── verifiers, semantics, anchoring
└── daily ritual, dweb apps
```

ApesDaily is a user of RAREXT, and RAREXT is used by the ApesDaily team. Neither
depends on the other being trustworthy, because the protocol's job is to make trust
unnecessary.

## Naming rules

- The protocol is RAREXT. Package scope `@rarext/*`, env prefix `RAREXT_*`, MCP
  tools `rarex_*`, payload kinds `rarex.*`. These are wire formats: changing them
  breaks other operators, so they change rarely and with an RFC.
- The public brand is ApesDaily. It appears on anything a member of the public sees:
  the workbench, the feed, the launchpad, the store.
- The protocol repo may ship the public surface, because it is the reference
  implementation. When the surface grows past the protocol's needs it can be split
  out without changing the protocol.
- Never mix the two in one string except as an explicit attribution ("Runs on the
  RAREXT protocol"), which names who built what.
- A project's own name is not a substitute for the protocol's: a third-party app on
  RAREXT uses its own brand on the surface and RAREXT only in the attribution.

## Legal and economic separation

The two brands are separate for a reason beyond taste.

- The protocol is Apache-2.0 code and CC BY 4.0 documentation. It is infrastructure
  and it is meant to be run by anyone, including competitors.
- The consumer surface and any token mechanics are ApesDaily's business, and they
  are the part that carries regulatory exposure. The protocol does not sell tokens
  and does not promise returns; see [fair launches](FAIR-LAUNCH.md).
- A failure in the token line must not take the protocol down with it, and a
  protocol change must not require the consumer business to move.
