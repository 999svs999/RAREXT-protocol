# RFC 0020 — Anchoring the seed list

**Status:** Draft. The read side is implemented; the write side waits for the next
anchor, for the reason in "Why not now".

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

1. Who authors the commitment — the registry operator whose bundle carries it,
   or a federation handle? An operator signing a list of OTHER registries is a
   statement about them, and RFC 0019's `announcers` answer ("locations open,
   facts by authority") may apply here too.
2. One commitment per list, or per registries entry? The list is small today;
   the shape should not have to change when it is not.
3. How does a client find the list URL when the commitment is in a bundle it
   read first? The commitment names `listUrl`, which is a location — so a client
   that trusts the bundle trusts that URL for the list, and the digest is what it
   checks. That ordering is worth stating explicitly wherever it is used.
4. Does the commitment need an expiry, so a stale list is visible as stale
   rather than merely old? `generatedAt` is recorded but nothing consumes it.
