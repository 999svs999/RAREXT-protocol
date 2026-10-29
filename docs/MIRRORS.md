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
the root you supplied. And every client that reads a bundle over HTTP —
`bundleFromSeed`, the SDK's `findVerifiedBundle`, `verify-seed-mirrors.mjs`, and
this page's own failover — refuses a response above `MAX_BUNDLE_RESPONSE_BYTES`
(8 MiB, the shared cap in `@rarext/core`; honest bundles are ~21 KiB and grow
with publications, so 8 MiB is generous headroom without being an amplifier)
before the body is fully read, honoring `Content-Length` when it is declared and
counting streamed bytes when it is not, so a hostile mirror is refused at the cap
and skipped like any other bad candidate instead of handing every verifier a
giant allocation.

The whole candidate sequence — fetch the bytes, check the seed's CID pin over
exactly those bytes, verify the bundle's shape, require the recomputed root to
equal the pinned root, record each refusal, accept the first copy that passes —
is ONE function, core's `verifyCandidates`, with the fetch and the digest
injected. `bundleFromSeed`, `findVerifiedBundle`, and `verify-seed-mirrors.mjs`
delegate to it (the checker runs it one location at a time, because its
contract is to report every location, not only the first that passes), so a fix
to the order or the wording lands in every client at once. This page's
failover loop is the one deliberate exception: core consumes the caller's
sha256 synchronously, the only digest a browser holds is WebCrypto's
asynchronous digest, and a second, async twin of the sequence would re-fork
the drift this shared function exists to close.

## The mirror

```bash
npm run mirror:build            # writes .mirror/
npm run mirror:build /some/dir  # or somewhere else
```

A mirror is a directory:

- `bundle.json` and `bundle.js` — the registry state.
- `index.html`, `app.js`, `styles.css` — the workbench, answering its reads from
  the bundle instead of a server. It does not read from bytes it was merely
  shipped: on startup the workbench runs the same check `verify.html` runs
  (`verifyBundle`), pinned the same way — `?root=<root>`, falling back to the
  seed's `bundleRoot` tried from `./seed.json` then `../registry/seed.json`.
  With no pin available it verifies internal consistency only, and says so.
  When the bundle is refused — the bytes do not rebuild the pinned root —
  every read falls through to the network (on a static mirror that is a 404,
  the honest empty state) and the page shows a refusal banner naming the
  computed root and the pinned one. An honest bundle behaves exactly as before.
- `verify.html` — a page that recomputes the root in the browser and tells you
  whether this copy is faithful. Open it with `?root=<chain root>` to pin the
  bundle to a root obtained from the chain or another trusted source; without a
  pin it checks internal consistency only, because a mirror can rewrite both its
  bundle and the root inside it.
  The page itself fails over: it tries this mirror's copy, then the sibling
  registry copy (whichever relative form the tree is published in), then the
  locations the seed names, and accepts the first candidate that verifies **and
  rebuilds the pinned root** — a tampered copy fails the first test, and a copy
  of a different bundle fails the second. Every rejection is shown with its
  reason, and the page always says which location the copy it verified came
  from (`Served from`). When nothing verifies it says so instead of showing a
  green row, so a visitor to a tampered mirror still gets a truthful answer.
  The landing page carries this proof surface at the front door — the pinned
verifier, the gallery, and the browser AI-proof page (`ai.html`), because a
proof nobody can reach is a proof nobody checks: its
  `data-pin-root` links are rewritten at deploy time to carry the anchored
  root, so "Verify this registry" opens the verifier already pinned to the root
  the chain holds, and a deploy whose front door lost its proof links fails.
- `ai.html` — a page that runs the committed model IN THE BROWSER and shows the
  evidence an attestation would carry (the artifact body, the model digest, the
  trace hash, the artifact hash), and recomputes a pasted claim against the same
  rule. Its hashes are asserted against node's in
  `apps/web/test/ai-proof.test.ts`, so a browser that disagreed about the evidence
  would fail the gate rather than quietly produce a different proof.
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

## The SDK's mirror client

An agent does not need the registry to find and check a copy. `@rarext/agent-sdk`
exports `findVerifiedBundle(seed, { fetch, sha256, timeoutMs })`: it reads the
seed's bundle URL and then each mirror as BYTES, checks the seed's `bundleCid`
when one is pinned, verifies the bundle shape, and accepts the first copy whose
recomputed root equals the seed's `bundleRoot`. Every refusal is named, so a
seed whose candidates all fail raises an error listing each URL and why. The
same `verifyBundleShape` and `cidV1` primitives live in `@rarext/core`; the API
and the SDK pass their own sha256, so there is one implementation and no second
copy in the client.

That verified copy is also the whole input to the AI replay. The SDK exports
`replayBundleAi(bundle)`, which walks the publications whose attestation
declares a representation, pairs each with the challenge spec carried in the
same bundle, and replays it through core's `verifyAiArtifact` — no fetch, no
server, no API, and nothing an attestation says can raise `correct`. It
returns the bundle's manifest root beside one verdict per AI claim: the seed,
the steps, and the model digest for a generative replay (with core's
regenerated output beside the output the claim carries), and for a bounded
claim the recomputed metric beside the attested `metricValue`, where a
disagreement is `correct: false` rather than a silent pass. A publication whose
challenge the bundle does not carry is a verdict entry whose error reads
`challenge <id> not in bundle` — reported, never skipped — and a bundle that
claims nothing AI comes back with an empty list.

### The resident demo

`npm run demo:resident` is that path as one command. It fetches the published
seed (default <https://999svs999.github.io/RAREXT-protocol/registry/seed.json>)
or a seed URL you pass, calls the SDK's `findVerifiedBundle` to print every
candidate tried and every refusal by name until a copy rebuilds the pinned root
and CID, then calls `replayBundleAi` to print each AI claim's title,
representation, `correct` verdict, and evidence, tied to that root. It needs no
keys, no server, and no write access, and it exits non-zero when the bundle
cannot be verified or any claim replays false. `npm run demo:resident -- --local
<dir>` serves the same flow from a local tree (a `seed.json` beside the bundle
paths it names) over loopback HTTP, so the end-to-end test runs the actual
command without touching the network.

When the seed names announcement documents, the demo folds them and prints each
record as accepted with its mirror or refused with its reason, resolving the
announcing keys from the documents the publisher serves with the SDK's
`identityFromPublishedDocuments` — no operator, no server of its own. A tree
carrying such records pins its port (`--local <dir> --port <n>`), because a
record is signed over the URLs it names and a signature over a rewritten URL is
not a signature. The end-to-end test proves both directions: a run whose only
workable candidate is the announced mirror passes, and the same run with the
published key revoked fails, naming the revocation.

Honest scope: this demo is run against a LOCAL tree in tests and against the live
seed by hand; the live seed names no announcements, so there the leg prints
nothing to fold. Peer-to-peer discovery of announcement documents themselves
remains missing, as does the seed list in "The next step".

## The next step

A mirror is a copy of one registry. Making the copy findable and keeping copies
consistent is the federation problem, and it has two parts:

- a **seed list** of registries, published in the protocol repository and
  optionally anchored, so a client can find mirrors — served at
  `GET /v1/registries` (and overridable with `RAREXT_REGISTRIES`, inline JSON or
  a file path) and parsed in exactly one place, core's `parseRegistrySeedList` /
  `registrySeedUrl`, because the server that serves the list and the client that
  reads it must not be able to disagree about what it says. The SDK consumes it:
  `findVerifiedBundlesFromRegistryList(listUrl, …)` asks every listed registry
  for a copy of ITS bundle (each registry has its own root, so each is verified
  against its own pins) and REPORTS a registry that does not answer — one dead
  host must not blind a resident to the rest. One call composes the whole walk:
  `joinRegistryNetwork(listUrl, …)` reads the list, verifies each registry's copy
  against its own pins, folds each registry's announcements, and resolves each
  announcer's key from THAT registry's own published documents — reporting every
  registry and every announcement attributed to the registry it came from. Where
  those documents live is not guessed but declared: `identityDocumentUrls(origin,
  surface)` knows the two shapes (`api` = `/v1/identities/<handle>`, `static-tree`
  = `/identities/<handle>.json`), because pointing a resident at the wrong surface
  does not raise an error — every handle simply reads as unknown, and a publisher
  that published everything stops being believed. A list can also be CHECKED
  rather than trusted: a digest covers the ENTRIES (never the server's own
  `self` description, so reaching a server at another hostname is not a change in
  which registries exist), and `registriesFromPublishedList(url, { expectDigest })`
  refuses a list whose entries do not match, naming both digests. Where the
  expectation can come from is RFC 0020's subject: the digest is committed to as
  an ordinary PUBLICATION (`app: "federation"`,
  `artifact.kind: "registry-list-commitment"`), which the SDK reads back with
  `federationCommitment(bundle)` — so a client that trusts a root takes its
  expectation from the root-pinned artifact rather than from the URL it is
  checking. That shape is not cosmetic: the bundle's root is a Merkle root over
  PUBLICATION LEAVES only, so a new bundle field would have been editable while
  the root still verified. And it is LIVE: the published bundle carries that
  commitment — one more publication, so the anchor covers it — and was re-anchored
  at its own root through the `local` rail, with `published-bundle.test.ts` holding
  the property as a standing assertion: the committed digest equals the digest of
  the published list, the anchor's root equals the bundle's root, `leafCount`
  matches the publications, and the commitment is not counted as an AI
  representation. **The walk is bounded and its URLs are not taken on trust:**
  a list may name at most `MAX_REGISTRIES_PER_LIST` (64) registries, and a
  truncation is REPORTED in the result and to the per-registry observer, because a
  silently truncated walk reads as a complete federation. Every URL a list or a
  seed names — a registry's seed, a mirror, an announcement's document — is
  checked against core's URL policy before it is fetched: http or https only, and
  no loopback, private, link-local, CGNAT or unspecified address unless the
  document's OWN location is local (a local tree earns the allowance; a public
  document naming a private bundle does not), with `allowPrivateHosts` for a caller
  who means it. Both callers of the walk, the API's `bundleFromSeeds` and the
  SDK's `findVerifiedBundleFromSeeds`, apply it through the same core functions,
  because a guard on one side of a shared rule is how a shared rule becomes two.
  What that test catches is the whole failure mode of running
  RFC 0020's sequence out of order: a new bundle without a re-anchor, a list
  edited without the digest following, a mirror left holding older bytes. The
  static seed above is a
  first step, and its consumption is implemented: `bundleFromSeed` in
  `apps/api/src/bundle.ts` tries the seed's own URL and then each mirror, in
  order, and accepts only a copy that **rebuilds the root the seed pins**
  (internal validity is not enough, because a mirror can rewrite both its bytes
  and the root inside them). Every candidate that fails is skipped with its
  reason recorded, and a seed whose candidates all fail raises an error naming
  each one — an outage reads as evidence rather than as an opaque failure.
  Multi-seed discovery is implemented too: a resident trusting two operators
  passes both seeds to the SDK's `findVerifiedBundleFromSeeds(seeds, …)` or the
  API-side twin `bundleFromSeeds(seeds, …)`, which verifies the seeds AGREE
  before anything is fetched — every seed naming the same primary `bundle` URL
  must pin the same `bundleRoot` and the same `bundleCid` when both carry one,
  and any disagreement throws naming the registry, the field, and every value
  with the seed URL that pinned it (`the seeds disagree about the registry …`)
  — a fork or an attack that splits the trust base stops the resident loudly;
  it does not race them, and "first seed wins" never silently picks a side —
  and then pools the deduplicated union of every seed's own URL and mirrors,
  so a copy only
  one operator nominated is still tried when the others' candidates all fail,
  returned with the winning copy's contributing seeds and the union's size. A
  seed that carries no `bundleCid` beside one that does is not a disagreement
  (absence is not a contradiction), and the stricter pin governs the shared
   candidates. What is still missing is a live federation protocol: mirrors do
   not gossip, and the seed is still a file someone publishes — the design for
   signed mirror announcements exists as
   `rfcs/0019-mirror-announcements.md`, and its first step is implemented: a
   seed may carry an optional `announcements[]` of URLs naming signed
   announcement documents, the SDK's `findVerifiedBundleFromSeeds` fetches each
   document through the same 8 MiB cap a bundle gets, verifies every record
   with core's `verifyAnnouncement` (the canonical payload, the signature via
   the repo's identity primitives against a key whose id is derived by
   `publicKeyId` and whose suite is derived by `suiteOf`, and the
   `issuedAt`/`expiresAt` window, so an expired record is discarded before it
   can affect anything), and enters each verified record into the same union
   `planSeedUnion` already runs — an announcement proposes LOCATIONS, never
   facts, so an announcement that pins a different root for a registry the
   seed names trips the same loud disagreement stop, naming both values and
   both sources, before any candidate is fetched, and an announced mirror is
   tried exactly like a seed-nominated one. An announcement that cannot be
   fetched, parsed, or verified is reported with its reason and skipped while
   another location verifies — announcements are redundancy, like mirrors. A
   seed without `announcements` behaves exactly as before: no fetch, no new
   candidate, no change in error wording or ordering. Still missing: the
   announcement URLs come from the seed (there is no peer-to-peer discovery of
   announcements themselves), and a resident that reads announcements itself
   must supply the resolver — either the store of an API it trusts, or, with no
   server of its own, `identityFromPublishedDocuments` in the agent SDK, which
   reads a handle's identity, its rotations and the revocation list from the
   documents the publisher serves (`GET /v1/identities/<handle>`, its rotations,
   `GET /v1/revocations`) under the same response cap as every other fetch, and
   decides nothing: the walk, the windows and the revocation rule stay in core.
   With none supplied the honest default is refusal for a keyless record,
   because the envelope never mints its own authority.
   An announcing key is resolved through the handle's key history: a key the
   handle does not vouch for is refused, a revoked key is refused even when the
   window is valid — including by the `key` revocation kind, the one statement
   that says "do not trust this key" rather than "here is the next one" — a
   lifetime beyond the 180-day cap is refused rather than
   clamped (a nomination that never expires is one nobody can retract) with a
   5-minute clock-skew tolerance so a record issued slightly ahead is a clock and
   not a forgery, and a revocation lookup that could not be performed refuses
   the record rather than reading a failed check as proof the key is good —
   "could not tell" is its own outcome, never "not revoked". An announcement
   document may be cached, and the verdict never is: the fold takes an optional
   injected port (`AnnouncementDocumentCache`) whose entry is the parsed
   document plus when it was fetched, and a cached document re-enters the same
   verification a fresh fetch gets — the signature, the key resolution, the
   window, the lifetime cap, and the per-fold revocation lookup — so a record
   whose key is revoked dies on the second fold exactly as it would have on a
   fresh fetch. How long an entry is believed for is the caller's policy
   (`cacheMaxAgeMs`): an entry older than it is a miss, refetched rather than
   silently used, and both outcomes are reported, because a caller should see
   whether a decision travelled on cached bytes. The SDK's
   `MemoryAnnouncementCache` is bounded (an unbounded cache in a long-lived
   resident is a leak) and in memory only, with no persistence — it is an
   optimisation, never a source of truth. The server's own
   store IS the resolver where a caller wires it: `bundleFromSeedForStore(seed, store, options)` answers the port
   straight from the identities, rotations and revocations the API already
   serves, so a keyless record resolves through the store that owns it and is
   refused when that store does not vouch for the announcing key or records it
   revoked. The wired path had no caller until `GET /v1/discovery`
   (docs/APP-PROTOCOL.md): the route folds the operator's seeds through this
   server's own identities and reports which location answered and whose keys
   said so, taking no location from the caller. Who may announce is answered by
   the seed's `announcers`: any resolvable handle may announce a LOCATION for a
   registry the seed already pins, and only while agreeing with those pins,
   while only a handle the seed names may announce a FACT — a registry the seed
   does not pin, or pins that differ. An unvouched contradiction is refused with
   its reason instead of reaching the union's loud stop, which is what closes the
   denial-of-service RFC 0019 warns about; silence is not permission to claim,
   and never a bar to mirroring.
   Both client paths fold announcements and neither owns the rule: the fold and
   the record's verification live in `packages/core/src/announcements.ts`, the
   SDK's `findVerifiedBundleFromSeeds` and the API's `bundleFromSeed` each
   supply only the primitives (a digest, and for the API the identity functions
   it already uses), and claim-check fails if either caller inlines the
   signature or the window check — the third fork is the failure this unit
   exists to prevent;
- **content addressing for the bundle itself**, so a mirror pointer is a hash
  rather than a URL — implemented for the copy the seed names: the seed pins the
  bundle's content address (`bundleCid`, a CIDv1 over the raw sha2-256 of the
  exact published bytes, computed by `publish-proof.mjs`), and every client path
  verifies it — `bundleFromSeed` hashes the bytes a mirror served and refuses a
  copy that hashes elsewhere even if it verifies and rebuilds the pinned root
  (a pointer that is a hash cannot be re-serialized into being), the deploy
  asserts the live bundle hashes to what the live seed pins, and
  `verify-seed-mirrors.mjs` checks each candidate against the pin. Publishing
  THROUGH a content-addressed store is wired up too: `publish-proof.mjs` hands
  the published bytes to `pinBundle` in `apps/api/src/adapters/content.ts`, which
  computes the CID and, when a pinning service is configured
  (`RAREXT_PIN_SERVICE_URL`, falling back to the adapter's `RAREXT_PIN_URL`, with
  `RAREXT_PIN_TOKEN` for the bearer token), POSTs the CID and the bytes to it and
  returns the service's own reference. The seed records what happened in
  `seed.pins`: one `{ cid, service, reference }` entry per configured service,
  `[]` when no service is configured — `bundleCid` carries the content address
  either way — and `{ cid, service, error }` when a configured service refused
  the pin, because a publish must not crash on a pin it could not make and must
  never record a pin it did not make. `verify-seed-mirrors.mjs` then resolves
  each recorded pin — a reference that is a URL fetched as recorded, a bare
  `cid:<cid>` fetched from `${service}/${cid}` — hashes what comes back with the
  same `cidV1Raw`, and reports a pin that does not resolve, serves other bytes,
  or disagrees with `bundleCid` as a failing pin, one line per pin, without
  failing the run while a location verifies: pins are redundant with the
  locations, not a replacement for them. What is still missing is a real
  configured service — the credentials and a deployment to pin to; with none
  configured here `pins` stays `[]` and no pin can resolve — and IPFS/Arweave
  native resolution: until a service is configured and reachable, the hash still
  resolves only at the URLs the seed lists.
