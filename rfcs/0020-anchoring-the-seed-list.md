# RFC 0020 — Anchoring the seed list

**Status:** Implemented. The read side ships in the agent SDK; the write side runs in
`scripts/publish-proof.mjs`, which commits the digest and re-anchors the new root
through the `local` rail. The published bundle is anchored at that root today, and
`published-bundle.test.ts` holds the property.

## The problem

`docs/MIRRORS.md` calls the seed list "published in the protocol repository and
**optionally anchored**". The digest of that list now exists — a client can read
`registriesFromPublishedList(url, { expectDigest })` and refuse a list whose
entries do not match. But the expectation has to come from somewhere, and today
the only place it can come from is the same URL. A list that is checkable
against itself is not checkable.

Anchoring means: the list's digest is committed to by something a client already
verifies for other reasons, so tampering with the list (or with the place the
digest is kept) breaks a commitment that cannot be rewritten.

## The constraint, verified rather than assumed

The obvious move — put the digest in the bundle — does not work, and the code
says why. `verifyBundleShape` in `packages/core/src/bundle.ts` computes

```
const leaves = bundle.publications.map((p) => publicationLeaf(p, sha256, leafVersion));
const computedRoot = merkleRoot(leaves, sha256);
```

The root is a Merkle root over **publication leaves only**. Every other field of
the bundle — `challenges`, `semantics`, `manifest` — is outside it. A new field
carrying the list digest would therefore be unprotected: anyone who can edit the
published bundle can edit that field too, and the root still verifies. It would
be an anchor in name only, which is worse than none, because it would look like
one.

The alternative — a new leaf kind inside the root — changes what the root MEANS
for every bundle that exists, including the anchored ones. `docs/CRYPTO.md`
commits to `leafVersion` for exactly this reason; widening the leaf set silently
is the kind of change that protocol exists to prevent.

## Decision

**The commitment is a publication.** Not a new field, not a new leaf kind: an
ordinary artifact of an ordinary publication, using the mechanism the app
protocol already defines for "any app, tool, or hardware format"

- `app`: `federation`
- `artifact.kind`: `registry-list-commitment`
- `artifact.body`: `{ listUrl, digest, generatedAt }`

This satisfies the constraint by construction: a publication IS a leaf, so the
root covers the commitment, so the existing anchor mechanism — which submits a
root for a batch of publications and records the adapter's reference and receipts
— anchors the list along with everything else in that batch. No schema changes,
no new root semantics, and the digest's own design (entries only, never the
served wrapper) carries over untouched.

**The read side ships now.** `federationCommitment(bundle)` in the agent SDK
finds that artifact in a verified bundle and returns `{ listUrl, digest }`, so a
client that already trusts a root can use it as the `expectDigest` for the list —
the expectation coming from the root-pinned artifact rather than from the URL it
is checking.

## Why not now (the write side)

Publishing the commitment changes the bundle's root, and the live bundle's
existing anchor (`fe9eb461…`, root `793915a9…`, `adapter: "local"`) points at the
OLD root — verified, not assumed. Adding the publication and re-pinning
`bundleRoot` without producing a NEW anchor would leave the live copy unanchored,
breaking the very property the change exists to provide, and doing it silently.

The remaining action is therefore not a design question but a sequence:

1. `scripts/publish-ai-proof.mjs` publishes the commitment as one more artifact
   through the same API flow, before the anchor step it already performs — so the
   anchor covers it with no new mechanism;
2. `npm run publish:proof` copies the new bundle and re-pins `bundleRoot` and
   `bundleCid` (it already does both from the bundle);
3. `npm run deploy:site` publishes the committed `site/` tree and verifies the
   live bytes and the live seed's pin;
4. and the honest sentence in `docs/MIRRORS.md` changes from "awaits the next
   anchor" to the reference the new anchor recorded.

Until that sequence runs, the statement stands: checkable exists and is proven;
anchored awaits the next anchor.

## Open questions

1. **Who authors the commitment?** — **ANSWERED: an authority for the list, which
   is why a federation handle is the right signer when the list crosses operators.**
   RFC 0019's rule decides it: an announcement proposes locations, facts come from
   authority. The commitment carries a DIGEST, which is a fact about the list, so
   the operator whose bundle merely happens to carry it is not thereby qualified to
   state it — the signer must be the list's own operator, or a handle the reader
   already trusts across operators. The question's suspicion was right, and the
   answer is not "either": the same rule that governs announcements governs the
   commitment built to protect them.
2. **One commitment per list, or per registries entry?** — **ANSWERED: one per
   list.** `registryListDigest` reduces the entries **in order** to a single
   canonical digest, so the commitment's subject is the list as a whole; a
   per-entry shape would change what the digest covers, which is the thing a client
   holds a root over. The list being small today is not the reason — a shape that
   has to change when the list grows is a version of the protocol, and this one does
   not have to.
3. **How does a client find the list URL?** — **ANSWERED: it trusts the bundle for
   the LOCATION and the digest for the list.** The commitment names `listUrl`, so a
   client that trusts the bundle trusts that URL enough to fetch it, and the digest
   is what decides whether what came back is the list — `registriesFromPublishedList`
   refuses with "the seed list at `<url>` does not match the expected digest". The
   ordering is the protocol's ordinary one, stated here because it is easy to
   misread as trust in the URL: the URL is where to look, never what to believe.
4. **Does the commitment need an expiry?** — **ANSWERED: no expiry is imposed; the
   `generatedAt` is the input a client's own staleness policy needs.** A protocol
   TTL would expire an operator's list for a reason no client can check — the list
   is either the list its digest names or it is not, and that judgement does not
   improve with age. A reader that wants a fresher list re-reads it, and one that
   wants a bound on staleness has `generatedAt` to compare against a clock it
   trusts. Recorded, not enforced: enforcement here would be policy wearing the
   protocol's clothes.
