# RFC 0022 — Naming: does RAREXT need its own URL form?

**Status:** The syntax ships, and so does a resolver for it.
`packages/core/src/rarext-uri.ts` parses, canonicalizes and compares a RAREXT reference, and
`packages/core/test/rarext-uri.test.ts` holds its one rule. `resolveRarextUri` (in
`@rarext/agent-sdk`) turns a reference into a VERIFIED object: it plans the candidates the
reference names, walks them with the SDK's existing search — `findVerifiedBundleFromSeeds` owns the
walk, the pins and the refusal records, so no second walk exists — and accepts only a copy whose
recomputed root equals the root the reference carries. A reference to a registry ID is refused
rather than guessed (an id needs the federation list, and guessing would make the hint
load-bearing), and a bare root with no candidates is refused with the reason: it says what to look
for, not where.

Surfaces now PRINT references rather than only accepting them: `demo:resident` ends by naming the
copy it verified, `scripts/site-binding.mjs` names the object a joined site serves, and
`scripts/resolve.mjs` resolves a reference from the command line — exit 0 verified, 1 not, 2 for a
usage error — printing every candidate it refused and why. Verified in the ordinary case against
the project's own live registry: the demo's reference resolves, and a version of it with a wrong
root fails naming both roots.

A reference names CONTENT, not a format. A root may name a bundle's content, a published record's
content, or the sha256 of its bytes, and the resolver reads the same candidates every way: a
registry's bundle is checked by the root its content rebuilds to, a publication record by
`publicationRoot` recomputed over the record, and raw bytes by their sha256 — so an image, a model
file, a tarball of a site or an entry in the storage economy can all be named and verified by a
client that has never heard of their type. A record arrives with things attached that are not part
of it (its root, its durability observation), so the rule reads the fields it declares rather than
whatever keys happen to be present: a client recomputes the digest from exactly what it received.

None of the readings can quietly accept another's copy: a bundle's root and a record's root are
domain-separated from the sha256 of the bytes that carry them, so **the same URL, named by different
roots, is different objects.** That is verified against the project's own live deployment, where the
published `bundleCid` (a CIDv1, base32) and the hex sha256 of the same live bytes are the same
32-byte digest spelled two ways while the bundle root is something else entirely.

What still does not exist: resolving an ANCHOR by its root, and any browser support. Retrieval
remains HTTPS plus the binding convention.

## The problem

The protocol can verify an object. It cannot yet WRITE ONE DOWN in a way that is checkable before
anything is fetched.

Today an object is addressed by a registry's origin plus a path, with its root stated somewhere
else — in a seed, in a bundle, in a sentence of prose. That is fine inside a verified bundle, where
the root is right there, and it is exactly what breaks the moment a reference leaves that context.
A message, a document, an artifact or a chat thread quoting `https://example.com/registry/bundle.json`
has said nothing that can be checked: the string carries no commitment, and the reader either
fetches it on faith or fetches it and then discovers what it is.

So the question is not "should RAREXT run a name service" — it should not, and
`docs/TRANSITION.md` already says so. The question is narrower: **what does a name look like when
it has to survive being written down?**

## The constraint, verified rather than assumed

Three things about this protocol decide the design, and each is in the tree:

1. **Identity does not need a registry.** An object is verified against a root, and the root is a
   digest of the bytes (`verifyBundleShape`, `merkleRoot`, `cidV1` in core). Whoever holds a root
   can fetch the bytes from anywhere — the seeds, a mirror, their own node — and know what they
   have. A name therefore does not have to BE the identity; it only has to be able to CARRY it.
2. **DNS is not ours to replace.** The site-binding convention already lets an existing DNS site
   join without moving, and the URL policy already governs how a document is fetched, hop by hop
   (`fetchWithUrlPolicy`). A new name layer that resolved names itself would be a second DNS, run
   by whoever wrote it.
3. **A location is a hint, never authority.** That is the rule RFC 0019 drew for announcements and
   RFC 0021 reused for proposals: a record proposes where to look, and a fact comes from a
   commitment. A name written down is a location proposal.

## Decision

A `rarext:` URI, with ONE rule:

> **A RAREXT reference carries the root it commits to. Without a root it is a name you have to
> trust, and this protocol does not have those.**

Two forms, and both carry a root:

| Form | What it is |
| --- | --- |
| `rarext:<64-hex root>` | An object by its root. The root IS the address: nothing to resolve, and nothing to trust. |
| `rarext:<authority>/<path>@<64-hex root>` | A LOCATION plus the pin the bytes must rebuild to. The authority is a registry id or a hostname; the path says what to ask for there. |

**The root decides identity, and only the root.** Two references that disagree about where to look
still name one object when they agree about what its bytes must rebuild to (`sameRarextObject`),
which is what makes a reference safe to carry across mirrors and what makes "the same document, on
my node" recognisably the same document.

What a client does with one, in order: parse it (and refuse it if it has no root); if it is a bare
root, fetch from wherever it likes and verify against the root; if it carries a location, try that
location first — through the ordinary URL policy — and verify against the SAME root. The location
never overrides the root, and a location that fails is a mirror to try another of, not a reason to
lower the bar.

Refusals are part of the design and are tested: a reference without a root, a root that is not 64
hex, a path with an empty segment or `..` (how a written address quietly becomes a different
address), and any other scheme — refused by name rather than coerced into this one.

## Alternatives, and why not

- **A new global name service.** The most obvious move and the worst one here: it would be a name
  root run by someone, i.e. the third party as critical infrastructure this project refuses, and it
  would capture every existing site's identity into a namespace they did not choose. It would also
  duplicate DNS, badly, to solve a problem that is about writing a reference down rather than
  looking one up.
- **A `rarext` TLD.** Same objection, plus it asks a standards body to hand over a namespace. Not
  ours to take.
- **Putting the root in an https query string** (`?root=…`). It works, and it is unreadable,
  droppable by any layer that rewrites URLs, and invisible in most prose. A commitment that can be
  lost by accident is not a commitment.
- **No new form at all.** Then a reference in a document stays unverifiable, and the protocol's
  strongest property — you can check what you were given — stops at the edge of its own records.

## Security considerations

- **A reference is not a permission.** Holding a URI grants nothing: no write access, no custody,
  no say in the registry that happens to be named.
- **The location is attacker-controlled text.** A `rarext:` reference arriving from elsewhere is
  subject to the same scheme, address and redirect policy as any other outbound read; the root is
  what makes the fetched bytes acceptable, and the policy is what keeps the fetch from being
  pointed at an instance metadata service.
- **Ambiguity is a bug, so it is refused.** Case, a trailing dot on the authority, a doubled slash
  and the `//` habit all collapse to one canonical spelling, and everything that cannot collapse is
  refused rather than interpreted. A reference that two readers parse differently is worse than no
  reference.
- **Cross-registry confusion.** Nothing stops two registries from publishing objects with the same
  path. `sameRarextObject` compares ROOTS, so the two are simply different objects — the confusion
  is in the hint, and the hint is not what anyone verifies against.

## Compatibility

Additive and inert by construction: a `rarext:` string is not a URL, no existing route or record
changes, and a deployment that never sees one behaves exactly as it does today. The syntax is a
narrowing — it can only ever say less than a URL plus a trust statement — so adopting it later
cannot invalidate anything already written.

## Non-goals

- **Not a name service, and not a replacement for DNS.**
- **No lookup that decides anything.** `resolveRarextUri` walks the candidates a reference names and
  accepts only a copy that rebuilds to the root the caller already holds; it never turns a name into
  a fact, and it holds no registry of names. Deciding what a name means is not deferred or
  delegated — it is not done at all, because the root already did it.
- **No browser support claim.** A browser will hand a `rarext:` string to whatever the user
  configured, or to nothing; the reference is designed for documents, artifacts, agents and
  command lines first.
- **No wallet, no chain, no fee.** A reference costs what the bytes it names cost.

## Open questions

1. **Authority: a registry id, or a hostname?** — **ANSWERED: both, because it is a hint.** A
   hostname resolves today with DNS; a registry id resolves through the federation list; and either
   way the root decides what the reader accepts. The parser lowercases it and strips a trailing dot,
   which is the whole of its authority handling.
2. **Is a path needed at all, if the root is the address?** — **ANSWERED: today yes, later maybe
   not.** A registry's tree is served under a path, so a reference that names one must be able to
   say so; when registries expose roots directly, the path becomes optional and dropping it is a
   narrowing that breaks nothing already written.
3. **What do query strings mean?** — **ANSWERED: nothing, and that is the choice.** The query is
   carried verbatim and treated as opaque, for the reason RFC 0019 gives about locations: this
   document does not invent semantics it cannot verify.
4. **Is `rarext://` with two slashes valid?** — **ANSWERED: accepted when parsing, never
   emitted.** Authors' habits should not invalidate a document; the canonical spelling is one form
   and `formatRarextUri` produces only that.
