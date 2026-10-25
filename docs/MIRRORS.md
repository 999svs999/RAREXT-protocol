# Mirrors and takedown

The claim this document makes is narrow and testable:

> The content and the claims outlive the operator.

Not "the platform is decentralized" in the general sense, and not "the service keeps
running" — a mirror is a copy, and a copy is not a service. The claim is that the
registry's contents are held in a form that anyone can serve, and that a copy can be
checked against the chain without asking the operator whether it is telling the
truth.

## The bundle

A bundle is the registry in a form you can hold:

```
GET /v1/bundles/latest        the most recent anchor
GET /v1/bundles/<root>        a specific anchor, by its root
GET /v1/bundles/latest?verify=1   the bundle plus its verification result
```

It contains the anchored publications, the anchors, the challenges, and the
semantics. The manifest records the root, the leaf format version, and one leaf per
publication.

The bundle verifies itself: recompute each publication's leaf, rebuild the Merkle
root, and it has to land on the root the chain holds. A mirror that alters a title
rebuilds a different root, and the difference is visible. Pin the verifier to the
chain root with `verify.html?root=<root>` when you need more than internal
consistency: the page then rejects a bundle whose recomputed root differs from
the root you supplied.

## The mirror

```bash
npm run mirror:build            # writes .mirror/
npm run mirror:build /some/dir  # or somewhere else
```

A mirror is a directory:

- `bundle.json` and `bundle.js` — the registry state.
- `index.html`, `app.js`, `styles.css` — the workbench, answering its reads from
  the bundle instead of a server.
- `verify.html` — a page that recomputes the root in the browser and tells you
  whether this copy is faithful. Open it with `?root=<chain root>` to pin the
  bundle to a root obtained from the chain or another trusted source; without a
  pin it checks internal consistency only, because a mirror can rewrite both its
  bundle and the root inside it.
- `blobs.json` — small public blobs embedded for `gallery.html`. The gallery
  re-hashes every embedded blob in the browser and skips any whose bytes, size,
  or hash disagree; it never renders unverified metadata. AI renditions carry
  the originating publication's representation label beside the bytes, and the
  mirror verifier re-derives their raster from the commitment. When no
  embedded copy exists, the page falls back to document-relative
  `./v1/blobs/...` paths so it also works under a subpath such as GitHub Pages.

It has no server behind it. Serve it from a static host, a bucket, a NAS, a USB
stick, or a mirror node. The proof it carries is the root.

## The takedown test

```bash
npm run test:takedown
```

This is the acceptance criterion, and it runs in CI:

1. start a registry, publish, anchor;
2. build a mirror;
3. **stop the registry**;
4. serve the mirror from a plain file server;
5. check the mirror still serves the publication, still rebuilds the anchored root,
   and that an altered copy would *not* verify.

If step 5 fails, the content was only ever in the operator's database, and no
amount of protocol language changes that.

## What a mirror does not solve

- **The front door.** A domain and a host are still one operator's. Decentralised
  naming over the content hash is the answer, and it is a dependency, not a
  protocol change.
- **The write path.** Publishing still needs a registry that will accept a signed
  publication. Many registries can accept the same envelopes and gossip; the
  envelopes are already portable, the discovery is not built yet.
- **Liveness.** A mirror serves what it has. It does not know about a
  publication made after it was built. Point a mirror at the registry and it
  catches up; point it at nothing and it serves the last state it verified.
- **The bytes of a sealed blob.** A mirror holds ciphertext it cannot read, which
  is the point.

## The published copy

A static copy of the latest anchored bundle, its seed list, and a browser-verifiable
mirror are published with the project site:

- <https://999svs999.github.io/RAREXT-protocol/registry/bundle.json>
- <https://999svs999.github.io/RAREXT-protocol/registry/seed.json>
- <https://999svs999.github.io/RAREXT-protocol/mirror/>
- <https://999svs999.github.io/RAREXT-protocol/mirror/verify.html>

The seed names the reference registry and the GitHub Pages mirror, and records the
bundle root. It is a copy, not a live registry: it carries the bundle that was
anchored when it was built and does not learn about later publications. The mirror's
verify page accepts `?root=<root>`; the published index links to it with the current
root pinned, so the browser rejects a copy whose recomputed root differs. The
canonical mirror path is `/mirror/`; `npm run deploy:site` projects the committed
`site/` tree onto `gh-pages` and checks the live bytes, roots, and links afterwards.

`npm run publish:proof` copies a locally verified `.ai-proof` result into
`site/registry` and updates the seed. It never generates a proof or contacts a
network. The committed tests read the files back over HTTP and verify the bundle,
the pinned root, the inline blobs, and the AI rendition:

```bash
node --test apps/api/test/published-bundle.test.ts apps/web/test/published-mirror.test.ts
```

## The next step

A mirror is a copy of one registry. Making the copy findable and keeping copies
consistent is the federation problem, and it has two parts:

- a **seed list** of registries, published in the protocol repository and
  optionally anchored, so a client can find mirrors — the static seed above is a
  first step, not a live federation protocol;
- **content addressing for the bundle itself**, so a mirror pointer is a hash
  rather than a URL — that is the IPFS or Arweave pinning adapter, which the
  existing anchor adapter interface already has a slot for.
