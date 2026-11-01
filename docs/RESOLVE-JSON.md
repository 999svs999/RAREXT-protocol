# Resolving a RAREXT reference as a machine

This is the contract a robot needs to consume a verification verdict WITHOUT reading the
resolver's source. The human-facing version of the same story is RFC 0022; the schema this
document publishes lives at [`site/schema/resolve-outcome.schema.json`](../site/schema/resolve-outcome.schema.json)
and is served at
`https://999svs999.github.io/RAREXT-protocol/schema/resolve-outcome.schema.json`
(JSON Schema draft 2020-12).

## Invocation

```
node scripts/resolve.mjs 'rarext:host/path@<64-hex root>' [--scheme http|https] [--candidate <url> ...] [--json]
```

`--json` prints the outcome document and nothing else to stdout. Plain `node`, no install.

## Exit codes

| code | meaning |
| ---- | ------- |
| `0`  | a copy verified: `resolved` is non-null |
| `1`  | the reference parsed but nothing verified, or the reference was not parseable |
| `2`  | usage error (no JSON is printed in that case) |

A robot branches on the exit code first, then on `resolved` / `error`, and reads
`attempts[].kind` — never the prose in `reason` — to classify what happened at each
location. The kinds are structural: `unreachable` (the host never answered),
`unavailable` (it answered without the object), `malformed` (not parseable as the shape a
reading needs), `mismatch` (it answered and the object does not rebuild the pinned root).

## The outcome document — a verified reference

This is the resolver's own output for the federation's peer registry, unedited:

```json
{
  "reference": "rarext:999svs999.github.io/RAREXT-mirror/registry/bundle.json@46ef40bd237d320d71290e83788a175cfc88f699e378ab3a779fb73d28060d73",
  "canonical": "rarext:999svs999.github.io/RAREXT-mirror/registry/bundle.json@46ef40bd237d320d71290e83788a175cfc88f699e378ab3a779fb73d28060d73",
  "parseError": null,
  "resolved": {
    "kind": "bundle",
    "root": "46ef40bd237d320d71290e83788a175cfc88f699e378ab3a779fb73d28060d73",
    "source": "https://999svs999.github.io/RAREXT-mirror/registry/bundle.json",
    "candidates": 1
  },
  "error": null,
  "attempts": []
}
```

## And a reference that verifies to nothing

A wrong root against the same live location — the attempts say three readings ran and all
three MISMATCHED, which is the machine-readable way of saying the mirror answered but lied:

```json
{
  "reference": "rarext:999svs999.github.io/RAREXT-mirror/registry/bundle.json@1111111111111111111111111111111111111111111111111111111111111111",
  "canonical": "rarext:999svs999.github.io/RAREXT-mirror/registry/bundle.json@1111111111111111111111111111111111111111111111111111111111111111",
  "parseError": null,
  "resolved": null,
  "error": "no candidate rebuilt the pinned root:\n  https://999svs999.github.io/RAREXT-mirror/registry/bundle.json: verifies internally but rebuilds 46ef40bd237d320d71290e83788a175cfc88f699e378ab3a779fb73d28060d73, not the pinned 1111111111111111111111111111111111111111111111111111111111111111; and reading the same candidates as records and as bytes found none whose root is 1111111111111111\u2026",
  "attempts": [
    {
      "url": "https://999svs999.github.io/RAREXT-mirror/registry/bundle.json",
      "reason": "verifies internally but rebuilds 46ef40bd237d320d71290e83788a175cfc88f699e378ab3a779fb73d28060d73, not the pinned 1111111111111111111111111111111111111111111111111111111111111111",
      "kind": "mismatch"
    },
    {
      "url": "https://999svs999.github.io/RAREXT-mirror/registry/bundle.json",
      "reason": "no record rule rebuilds this document to the pinned 1111111111111111\u2026 (as a publication it is 89674bc0df142fc4\u2026; a record is served with its root and durability attached, and those are not part of it)",
      "kind": "mismatch"
    },
    {
      "url": "https://999svs999.github.io/RAREXT-mirror/registry/bundle.json",
      "reason": "its bytes hash to 5a574505651049bf\u2026, not the pinned 1111111111111111\u2026",
      "kind": "mismatch"
    }
  ]
}
```

## What the schema holds, and what holds the schema

The schema is checked the way every claim here is checked: `claim-check` fails the build if
this document stops naming the schema file, if the schema's attempt kinds drift from
`RarextAttemptKind` in `@rarext/sdk`, if the exit codes drift from `scripts/resolve.mjs`, or
if the published page tree loses the schema file. A unit test resolves a fixture through the
CLI with `--json` and validates the output against the schema file itself, so the document,
the schema and the implementation are three views of one contract.
