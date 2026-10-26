# What is checked, and what is not

`scripts/claim-check.mjs` runs in CI (`npm run claim:check`) and holds the docs'
published claims to the code that makes them true. This file is the map: which
document is mechanically checked, by which kind, and which documents are
deliberately prose. The checker verifies this map in both directions, so a doc
cannot quietly join the checked list, and a checked doc cannot quietly leave it.

## Checked

| Document | Kind | What is re-derived |
| --- | --- | --- |
| `rfcs/0010-data-availability-sampling.md` | sampling table | every published row re-computed from `samplesForMissingFraction`, with the prose bounds |
| `docs/HARDENING.md` | MDS floor | `1 + m/k` measured from the codec's own shard sizes |
| `docs/STORAGE.md` | throughput artifact | `bench/storage/THROUGHPUT.json`'s peaks and their ratio, against the doc's 1 GiB figures |
| `docs/STORAGE-ECONOMY.md` | rent pricing | the default rate, proration, ceiling rounding, and the documented override, through `quoteStorageRent` |
| `docs/ARCHITECTURE.md` | route surface | every published route still handled by `app.ts` |
| `docs/CHAINS.md` | chain surface | the chain-registry routes and the table's `trac`/`evm` backing artifacts |
| `docs/OPERATIONS.md` | limits, AI bounds, snapshot/migration, audit window, evidence citations | named constants, replay bounds (functionally), snapshot versions, the audit window and its refusal literals, and the test files the fault tables cite |
| `docs/OPERATOR.md` | operational defaults | the `??` fallbacks the doc publishes (challenge interval, GC loops, grace); its narrative guidance rows are prose and are not asserted |
| `docs/AI-VERIFICATION.md` | AI verification doc | rendition rule names, verifier hashes, media validators and raster renderers (functionally), and the verifier routes |
| `docs/SEMANTICS.md` | semantics doc | record fields, binding statuses, routes, claim kinds, and the scope rule through `bindClaim` |
| `docs/STORAGE-SECURITY.md` | audit window | the nonce bound and the verifier-timeout range |
| `docs/WORK.md` | reward table | every action's credit rate, both directions |
| `docs/MIRRORS.md` | mirrors doc | bundle routes, named npm scripts, the takedown test's CI sentence, the published copy's artifacts, and the front door's pinned proof links |
| `docs/APP-PROTOCOL.md` | app protocol | every `RAREXT_*` name read by the implementation, and the published route list |
| `docs/CRYPTO.md` | crypto doc | the runtime floor against `engines.node`, the leaf-version floor, and the suite derivation through `suiteOf` |
| `scripts/` | artifact sources | the inline bundle (`bundle.js`) and proof page (`verify.html`) each live in one module; generators delegate to them and keep no private copies |

## Deliberately prose

| Document | Why the checker does not read it |
| --- | --- |
| `docs/LITEPAPER.md` | states the project's thesis and threat model; its claims are argued, not parameterised |
| `docs/FAIR-LAUNCH.md` | describes policy as a versioned challenge spec; the versioning and repinning it describes are enforced by the semantics and snapshot kinds, not by numbers here |
| `docs/PRIOR-ART.md` | compares published work by others; nothing in this repository can make those statements true or false |
| `docs/GLOSSARY.md` | defines terms used by the other documents |
| `docs/PRIVACY.md` | states what is and is not collected; the enforcement lives in the code paths its own text points at |
| `docs/WEB4.md` | a framing essay for the ecosystem the protocol serves |
| `docs/BRANDING.md` | naming and visual conventions |
| `docs/STORAGE-FRONTIER.md` | open research directions, explicitly unbuilt |

## Adding a claim

Add the kind to `scripts/claim-check.mjs` with a self-test injection and an
anchor-rot guard, then add its row here. A doc that carries mechanical claims
and appears in neither table fails the checker, so the pair stays complete.
