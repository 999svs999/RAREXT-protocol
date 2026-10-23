# Documentation

The README says what the project is. This page says which document answers your
question, and in what order to read them.

The open questions are not hidden in a roadmap footnote: they live in the storage
frontier, linked once below. Read that before treating any storage claim here as
settled.

## Suggested reading order

**App developer** — build against the registry without adopting the whole protocol:
APP-PROTOCOL → ARCHITECTURE → SEMANTICS → PRIVACY → STORAGE-ECONOMY → OPERATIONS →
GLOSSARY.

**Verifier operator** — run a node, a holder, or an independent verifier:
ARCHITECTURE → CRYPTO → SEMANTICS → CHAINS → STORAGE-ECONOMY → STORAGE-SECURITY →
OPERATIONS → MIRRORS → GLOSSARY.

**Researcher or skeptic** — test the claims rather than the pitch:
LITEPAPER → WEB4 → PRIOR-ART → STORAGE-FRONTIER → STORAGE-ECONOMY → STORAGE-SECURITY →
CRYPTO → WORK → MARKET.

Those are names, not links, so every document is linked once in the reference below.

## Reference

| Document | The question it answers |
| --- | --- |
| [APP-PROTOCOL.md](APP-PROTOCOL.md) | How does an app publish an artifact, get it verified, and read it back over HTTP? |
| [ARCHITECTURE.md](ARCHITECTURE.md) | What are the components, what talks to what, and which parts are still target-state? |
| [BRANDING.md](BRANDING.md) | Which brand is speaking, and what may each one claim? |
| [CHAINS.md](CHAINS.md) | How is an anchor written to a chain, and how is it read back independently? |
| [CRYPTO.md](CRYPTO.md) | What does the protocol assume cryptographically, and what breaks under a quantum adversary? |
| [FAIR-LAUNCH.md](FAIR-LAUNCH.md) | How does a token launch become a checkable trajectory instead of a badge? |
| [GLOSSARY.md](GLOSSARY.md) | What does this protocol mean by adapter, anchor, attestation, build, or holder? |
| [HARDENING.md](HARDENING.md) | What storage failures are tested, what is recovered, and what is still not handled? |
| [LITEPAPER.md](LITEPAPER.md) | What is the thesis, and what is explicitly not being sold? |
| [MARKET.md](MARKET.md) | How can agents, robots, and people trade on the same terms without the protocol knowing what they are? |
| [MIRRORS.md](MIRRORS.md) | Can the registry survive its operator, and what exactly does a mirror prove? |
| [OPERATIONS.md](OPERATIONS.md) | What must an operator back up, restore, migrate, and monitor? |
| [OPERATOR.md](OPERATOR.md) | How do I run holders, the API, pinning, and GC, and what is still missing? |
| [PRIOR-ART.md](PRIOR-ART.md) | What already exists, what does it not do, and what narrow composition is actually new? |
| [PRIVACY.md](PRIVACY.md) | How do unlisted and sealed artifacts stay out of the feed while remaining addressable? |
| [SEMANTICS.md](SEMANTICS.md) | What does a passing verifier result mean, who owns that meaning, and how is drift detected? |
| [STORAGE-ECONOMY.md](STORAGE-ECONOMY.md) | How do erasure coding, placement, retention proofs, repair, and metering fit together? |
| [STORAGE-FRONTIER.md](STORAGE-FRONTIER.md) | Which compression and representation questions are open, and what would count as an honest answer? |
| [STORAGE-SECURITY.md](STORAGE-SECURITY.md) | What storage attacks are handled, what do tokens mean, and which security findings are still open? |
| [WEB4.md](WEB4.md) | What is web4 here, and which primitive is still missing? |
| [WORK.md](WORK.md) | What work can a person or agent do, how is it checked, and what does it pay? |

## Stale or draft material

- **ARCHITECTURE.md** opens with “v0 scaffold” and describes the target architecture;
  parts of it lag the code. Treat the wire protocol and tests as current.
- **LITEPAPER.md** is version 0.1, a draft for public comment, not a feature list.
- **PRIOR-ART.md** is a snapshot of what was checked when it was written. Re-check a
  competitor before quoting the comparison.
- **STORAGE-FRONTIER.md** is a research agenda. The measured failures are in
  [`bench/storage/NEGATIVE-RESULTS.md`](../bench/storage/NEGATIVE-RESULTS.md), and a
  result that is not in the benchmark has no storage claim.

Where the open questions live: the storage frontier, in the reference above.
