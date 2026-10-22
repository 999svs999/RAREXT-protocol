# Glossary

**Adapter** — A pluggable integration around the proof core, such as local anchoring, Trac, TapeOut, or GitHub. Adapters declare capabilities and are never a trust root.

**Agent** — A software actor with keys, capabilities, and an identity. In RAREXT, agents are the primary client and first-class creators.

**Anchor** — A Merkle root over a batch of publication leaves, stored locally or announced to a Trac webhook. Inclusion is provable without trusting the API.

**App** — A namespace of challenges and artifact kinds with one verifier, such as `logic` or `echo-lab`. Apps can use the built-in verifier or an external HTTP service in any language.

**Artifact** — The portable envelope `{ app, kind, version, mediaType, body }`. A netlist is the body of the built-in `logic.netlist` artifact; other apps choose their own kinds and bodies.

**Attestation** — A verifier-signed claim that an artifact passed a challenge under specific artifact and proof hashes.

**Build** — The public term for a published artifact plus its attestation, source pin, and lineage. For the logic app the artifact is a netlist; “circuit” is used only when discussing the TapeOut or netlist layer.

**Identity** — An ECDSA P-256 key registered under a handle. The public key ID is canonical; the handle is a human-readable pointer. See RFC 0002.

**Identity link** — A signed claim connecting a RAREXT handle to an external account, verified by a public proof such as a GitHub gist owned by that account. It proves control, not reputation.

**$BEM** — The reward token of TapeOut's Proof of Design mining system on BNB Chain. RAREXT reads it; it does not mint or custody it.

**Circuit** — A netlist of components with named inputs and outputs. In TapeOut, a taped-out circuit is an NFT.

**Component** — A NAND gate or LATCH used to build circuits. In TapeOut, components are ERC-1155 tokens that are burned on tapeout.

**Content hash** — A cryptographic hash of a publication's canonical content, used to reference it without trusting a server.

**RAREXT** — This project. The protocol and infrastructure for verifiable builds: artifact, challenge, verifier, claim, and a portable registry.

**Key ID** — `sha256(canonicalize(publicKeyJwk))`. Used as the stable identity reference in signed payloads.

**Key rotation** — A signed record from the retiring key that moves a handle to a new key. The old key stays resolvable for existing publications and capabilities but cannot sign new ones ([RFC 0008](../rfcs/0008-key-rotation-and-delegation.md)).

**Delegation** — A signed record from a root key authorizing another key to publish for a handle, optionally restricted to one app and an expiry. The delegate can publish only; it cannot rotate or delegate further.

**Ledger** — An external ordering and ownership substrate such as TapeOut on BNB Chain or Trac. RAREXT anchors roots there but does not store content on a ledger or operate one.

**LATCH** — A level-sensitive D latch. In this repository: `inputs: [data, enable]`.

**Merkle root** — A single hash committing to an ordered set of leaves. RAREXT anchors publication leaves in batches.

**Netlist** — The list of components and connections that defines a logic circuit. The source of truth for the built-in logic app.

**NAND** — A logic gate that outputs 0 only when both inputs are 1. Functionally complete, so all logic can be built from it.

**PoD (Proof of Design)** — TapeOut's mining mechanism, which weights rewards by circuit design quality and efficiency rather than raw compute.

**Publication** — An artifact plus metadata: app, challenge, title, source, attestation, and lineage. The registry object. May carry a signed identity envelope.

**Registry** — The queryable index of builds, attestations, source pins, identity links, and adapter receipts. The product surface; the ledger is only its anchor.

**Lineage** — The ancestor and descendant graph formed by parent links between builds.

**Remix** — A derived build with an explicit lineage edge to its parent.

**Reuse** — A direct child build that references another build as its parent. The search API reports this as `reuses`.

**Signed envelope** — A canonical JSON `rarext.publication` v1 payload plus an ECDSA P-256 signature, timestamp, and nonce.

**Source** — Provenance for an imported build: repository, exact commit, path, and license. Distribution and attribution, not trust.

**Tapeout** — The irreversible act of burning components to mint a finished circuit. Borrowed from semiconductor manufacturing.

**Trac Network** — A peer-to-peer, self-custodial L1 with agent-first and local-first design goals. Intended home for RAREXT identity, tasks, and attestations.

**Trace** — The canonical record of a simulation: per-pass values, final outputs, and settle status. Hashed for verification.

**Verifier** — The component that validates an app artifact and returns a deterministic proof. Logic runs in-process; other apps can run as isolated HTTP services. Open source and independently reproducible.

**Verifier operator** — An independent party that runs a verifier and signs its attestations with its own key. The registry accepts a signed attestation without recomputing, and the publication records the operator's key id and signature so a reader can check it.

**XP** — Non-transferable participation points. Not a token and not an investment.
