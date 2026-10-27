# RFC 0019: Mirror announcements — the gossip step, as signed locations

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-26
- **Requires:** RFC 0002 (signed publications), RFC 0007 (trust model), RFC 0008 (key rotation and delegated publishing)
- **Related:** [`docs/MIRRORS.md`](../docs/MIRRORS.md)
- **Implementation:** step 1 is implemented: the seed's optional `announcements[]`
  is read by the SDK's `findVerifiedBundleFromSeeds`, each record is verified by
  core's `verifyAnnouncement`, and verified announcements enter the union
  `planSeedUnion` already runs. Still missing: discovery of the announcements
  themselves, key resolution through the handle's key history, and the API twin.

## Summary

A seed is a file its operator publishes. It names the registry's bundle URL, the
pinned `bundleRoot` and `bundleCid`, and a list of mirrors — and the only way for
a mirror operator to be found is to be added to that file by whoever owns it.
`docs/MIRRORS.md` states the gap in its own words: mirrors do not gossip, and the
seed is still a file someone publishes. Nothing in the seed says when its mirror
list was last touched either, so a year-old list of dead URLs is still the
complete discovery surface.

This RFC proposes **announcements**: a signed record in which an operator states
where a registry's bundle can be fetched, under which pinned root and content
address, when the statement was issued, and when it stops being believed. The
seed gains an optional `announcements[]` of URLs. A client that reads them folds
each verified announcement into the candidate set it already verifies; a client
that ignores them, or a seed that carries none, behaves exactly as it does today.

The whole design rests on one line: **an announcement proposes LOCATIONS, never
facts.** It cannot change what is verified. It only widens where a client looks.

## Motivation

The federation story is implemented up to one point. A seed names a bundle URL
and mirrors; clients verify copies against the seed's pins — the API's
`bundleFromSeed` and the SDK's `findVerifiedBundle`, each checking a pinned
`bundleCid` over the served bytes with `cidV1` — multiple seeds union their
candidates, and two trusted seeds disagreeing about a registry is a loud stop
(`planSeedUnion` in `packages/core/src/bundle.ts`). The verification sequence
itself is one function — core's `verifyCandidates` — and every non-browser
caller delegates to it.

What is missing is the step before verification: somebody has to say where the
copies are.

- **A mirror cannot tell anyone it exists.** Discovery is a field in a file the
  registry operator writes. A mirror operator with no write access to that file
  has no protocol route at all; they can only ask, out of band, to be added.
- **Nothing bounds staleness.** The seed carries no issue time for its mirror
  list. A client cannot distinguish "this list was published this morning" from
  "this list was published before the last three mirrors died", and learns the
  difference only by trying each URL and recording refusals.
- **The gap is the doc's own.** `docs/MIRRORS.md` says what is still missing is
  a live federation protocol. This RFC does not build one; it writes down the
  smallest signed statement that makes the missing step expressible, so the gap
  can be closed later without redesigning discovery.

Who benefits: a mirror operator gains a way to be published without owning the
seed; a resident gains a candidate list that can be refreshed independently of
the seed file; the registry operator gains a seed that can point at
announcements instead of enumerating every mirror by hand.

If nothing is done: discovery stays a hand-edited list, the seed remains the
single point of failure for finding copies, and the stated gap in
`docs/MIRRORS.md` stands unchanged.

## Guide-level explanation

A mirror operator already holds an identity: an agent key file, created with
`createAgentKeyfile` and read with `readAgentKeyfile`, whose key id is derived by
`publicKeyId` and whose suite is derived by `suiteOf` — never claimed by the
caller. They write a record saying, in effect:

> I am `operator-alice`. I serve the bundle at `https://registry.example/bundle.json`
> from `https://mirror.example/bundle.json`. That copy rebuilds root `3f9c…` and
> hashes to `bafy…`. This statement was issued at 2026-10-26T09:00:00.000Z and
> expires at 2026-11-25T09:00:00.000Z.

They sign the canonical form of that record with `AgentSigner`, exactly the way
RFC 0002 signs a publication and RFC 0008 signs a rotation, publish the signed
record as a small JSON document, and add its URL to their seed:

```json
{
  "bundle": "https://registry.example/bundle.json",
  "bundleRoot": "3f9c…",
  "bundleCid": "bafy…",
  "mirrors": [{ "bundle": "https://mirror.example/bundle.json", "root": "3f9c…" }],
  "announcements": ["https://mirror.example/announcement.json"]
}
```

A client that reads `announcements` fetches each document, checks the signature
and the expiry, and adds the mirror as one more candidate to try. A client that
never looks at the field — or a seed without it — runs the code it runs today,
byte for byte.

The announcement does not get to decide what "verified" means. Whatever it
claims, the copy still has to be fetched as bytes, hashed against the pinned
`bundleCid` when one is pinned, rebuilt through `verifyBundleShape`, and landed
on the pinned `bundleRoot`. An announcement that lies about a root does not
lower the bar; it produces a candidate that fails, or a disagreement that stops
loudly.

## Reference-level design

### Names this RFC introduces

Exactly one name in this RFC is new to the tree: `announcements`, the optional
field on the seed. Every other backticked identifier here already exists in the
source trees, and `scripts/claim-check.mjs` holds that claim — a name that is in
neither place fails the gate.

### The announcement record

```json
{
  "kind": "rarext.mirror-announcement",
  "version": 1,
  "handle": "operator-alice",
  "bundle": "https://registry.example/bundle.json",
  "mirror": "https://mirror.example/bundle.json",
  "bundleRoot": "3f9c…",
  "bundleCid": "bafy…",
  "keyId": "<sha256 of the announcing public key>",
  "algorithm": "ecdsa-p256",
  "issuedAt": "2026-10-26T09:00:00.000Z",
  "expiresAt": "2026-11-25T09:00:00.000Z",
  "nonce": "…"
}
```

It travels as a signed record, the same shape as a signed revocation — the
payload plus a `signature` field:

```json
{
  "announcement": { "…": "the record above" },
  "signature": "<base64 signature by the announcing key>"
}
```

Rules:

- `kind` and `version` are fixed by this RFC. An unknown kind or version is
  refused, not ignored.
- `bundle` is the registry's primary bundle URL — the same URL a seed carries as
  its `bundle`. `mirror` is the URL the announcer claims to serve.
- `bundleRoot` and `bundleCid` are the pins the announcer claims that mirror
  rebuilds. `bundleCid` is optional, exactly as it is on a seed; absence is not a
  contradiction.
- `keyId` is `publicKeyId(publicKey)` and `algorithm` is `suiteOf(publicKey)`,
  both derived from the key that signs. A record cannot claim a suite for a key,
  and a key id that does not match the signature's key is refused.
- `issuedAt` is when the statement was made and `expiresAt` is when it stops
  being believed. A client refuses a record outside that window; `expiresAt`
  must be strictly later than `issuedAt`.
- `nonce` distinguishes one record from the next for the same window, following
  the publication and rotation payloads.
- The signature covers `canonicalize` of the payload without `signature`,
  produced by `AgentSigner.sign` and checked the way every signed record in this
  repository is checked: `verifyPayload` in `apps/api/src/identity.ts`.

Every primitive named above exists in the tree today. This RFC invents a payload,
not a signature scheme.

### What the seed carries

The seed gains one optional field: `announcements`, an array of URLs. Each URL
names an announcement document — a JSON array of signed records. Nothing else in
the seed changes, and no existing field changes meaning.

- Absent or empty: no announcement is fetched, no candidate is added, and the
  client's behaviour is exactly today's.
- Present: each document is read through the same capped reader the bundle paths
  use, `readBundleResponseBytes` under `MAX_BUNDLE_RESPONSE_BYTES`, so an
  announcement URL cannot stream an unbounded body into a verifier.
- The seed remains authoritative for the registry's own pins. An announcement
  can add a location; it cannot edit, override, or retract what the seed pins.

### The client's job

1. Read the seed. If it carries no `announcements`, stop here and run today's
   path unchanged: `planSeedUnion`, then `verifyCandidates`.
2. Otherwise fetch each announcement document, capped as above, and for each
   record: check `kind` and `version`; derive `algorithm` and `keyId` from the
   signing key and require them to match; verify the signature with
   `verifyPayload`; refuse the record if the current time is outside
   `[issuedAt, expiresAt]`; resolve the key through the handle's key history so
   an announcement signed before a rotation still verifies, as RFC 0008 requires
   for old signatures.
3. Convert each surviving record into the seed shape the union already reads:
   the announced `bundle` as the primary URL, the announced `bundleRoot` and
   `bundleCid` as its pins, the announced `mirror` as a candidate, and `url` set
   to the announcement document so a disagreement error is attributed by
   `seedLabel` to the document that made the claim rather than to the mirror it
   points at.
4. Pool those entries with the trusted seeds and hand the pool to
   `planSeedUnion`. The disagreement rule therefore covers announcements with no
   new rule of its own: an announcement that pins a different root or CID for the
   same registry throws the same loud error, naming the field, every value, and
   the seed or announcement document that pinned it — before anything is fetched.
5. Run `verifyCandidates` over the union. Announced candidates are fetched,
   hashed, shape-checked, and root-checked exactly like seed-nominated ones, and
   every refusal is recorded the same way.

Nothing in steps 3–5 is a new verification path. The announcement is translated
into input the existing sequence already accepts.

### Rotation and revocation

An announcing operator must be able to do two things.

- **Rotate.** The announcing key is an ordinary identity key. Rotation is the
  RFC 0008 record, signed by the key being retired (`keyRotationPayload`), so an
  announcement signed by a now-retired key still resolves through the handle's
  key history, while a new announcement must be signed by the current key. A
  client that only trusts the current key must say so rather than silently drop
  older announcements.
- **Revoke.** Three independent ways, all of which already exist in some form:
  remove the entry from the seed's `announcements` (the seed is the operator's
  own file); let `expiresAt` lapse, after which the record is stale by rule; or
  publish a revocation through the existing revocation records, verified by
  `verifyRevocation` and checked by `isRevoked`. The honest limitation is that
  today's revocation kinds are `capability`, `verifier`, and `artifact` — an
  announcing key is none of those, so explicit key-level revocation needs either
  a new kind or the rotation path. This RFC does not pick between them; see Open
  questions.

## Security considerations

**An announcement proposes LOCATIONS, never facts.**

- **It cannot change a pinned root or CID.** A client still runs the existing
  candidate verification — fetch the bytes, hash them against the pinned
  `bundleCid`, rebuild through `verifyBundleShape`, require the recomputed root
  to equal the pinned `bundleRoot` — and still refuses bytes that do not hash,
  whatever any announcement says. An announcement naming a different root for
  the same registry is not a new truth; it is a disagreement, and `planSeedUnion`
  throws loudly before a single byte is fetched.
- **A forged announcement fails signature verification.** The payload is
  canonicalized and checked with `verifyPayload` against a key whose id is
  derived by `publicKeyId` and whose suite is derived by `suiteOf`. There is no
  unsigned path and no caller-chosen suite.
- **An expired announcement is stale.** `issuedAt` and `expiresAt` bound belief
  in the statement. Outside that window the record is discarded before it reaches
  the union, so a mirror that was honest in October does not get to nominate
  candidates in December on October's word.
- **Two operators disagreeing is still the loud stop the union rule already
  provides.** Announcements enter the pool as seed-shaped entries, so they are
  covered by the rule that already exists rather than by a second, parallel one.
  A fork of the trust base stops the resident; nothing races, and "first
  announcement wins" never silently picks a side.
- **Replay re-proposes the same location.** Within the validity window, replaying
  a record adds a candidate that is already there; the signature covers the pins,
  so a replay cannot swap in a different root. Outside the window the window rule
  refuses it. This is a statement about where to look, not a bearer capability.
- **Amplification is bounded by the caps that already exist.** An announcement
  document is read through `readBundleResponseBytes` under
  `MAX_BUNDLE_RESPONSE_BYTES`, the same 8 MiB ceiling a bundle response gets, so
  a hostile announcement URL is refused at the cap instead of handed to every
  verifier as an allocation. The number of announcement URLs is bounded by the
  seed, which is already trusted input.
- **Availability is the real exposure.** A valid announcement that disagrees
  with a trusted seed stops the union loudly — correct as an integrity result,
  and a denial-of-service shape as an availability one, because any identity
  that can produce a valid signature can produce the disagreement. That is why
  who may announce is an open question and not an assumption.
- **What an announcement does not prove.** It does not prove the mirror is
  online, that it holds the bytes, that it will hold them next week, or that its
  operator is honest. It proves only that an identity said so, at a time, until a
  time. Everything stronger is still the verification sequence's job.

## Alternatives considered

- **Keep editing the seed file by hand.** Rejected as the whole answer: it is
  the stated gap, it gives a mirror operator no route that does not run through
  another operator, and it carries no issue time to bound staleness.
- **Unsigned mirror lists.** Rejected. A list any client may trust lets anyone
  inject candidates and pins; a hostile entry with a conflicting root would
  either stop the union with no attribution to name or be silently ignored,
  which is the "first seed wins" disease in a different costume. A signature
  buys attribution and a revocable identity for the price of a field the
  machinery already has.
- **Announcements that assert liveness** — "I served this root at 09:00", a
  heartbeat a client treats as freshness. Rejected for now: liveness is a fact
  about a remote server that the announcer cannot prove to a third party without
  a challenge protocol, and a document that claims it invites clients to trust
  the claim. Expiry bounds belief in the statement; it does not create evidence.
- **A gossip protocol, a DHT, or real-time propagation.** Rejected as scope: each
  is a new transport with its own failure modes, and none of them removes the
  need for a signed, expiring statement about where copies live.
- **Anchoring announcements.** Rejected for this RFC: an anchor proves that a
  batch of leaves existed at a point in time, not that a mirror is reachable,
  and the seed itself can already be anchored. Anchoring a location list would
  add a publication step without changing what a client can conclude from it.
- **Making announcements mandatory.** Rejected: it would break the additivity
  below for no verification benefit.

## Non-goals

- No DHT, no new transport, no real-time gossip, no consensus, and no
  registry-to-registry write path.
- No change to what "verified" means. Verification remains: hash the bytes,
  rebuild the root, compare it to the pin, refuse on mismatch.
- No liveness protocol, no challenge-response to prove a mirror is up, and no
  ranking, scoring, or automatic selection among mirrors.
- No new identity system, no new signature scheme, and no new key custody story:
  announcements ride on the identity machinery that already exists.
- No takedown semantics beyond expiry, seed edits, and the revocation records
  that already exist.
- No implementation in this RFC. The deliverable here is the design and the
  checks that keep its references honest.

## Compatibility

This is additive by construction.

- The seed gains an optional `announcements[]`. Absent means today's exact
  behaviour: no fetch, no new candidate, no change in error wording or ordering.
- A client that ignores announcements entirely keeps working. It reads the same
  fields it reads today, runs `planSeedUnion` and `verifyCandidates` over the
  same input, and verifies the same bytes against the same pins.
- No existing seed field changes meaning: `bundle`, `bundleRoot`, `bundleCid`,
  `mirrors`, and `pins` are untouched, and a seed written today remains valid
  without edits.
- No change to the bundle format, the leaf, the anchor, the publication
  envelope, or the verification sequence. Announcements are translated into the
  seed shape those functions already accept, which is why this design needs no
  new runtime code to be *expressible*.
- Reversible: delete the field and the documents it points at, and nothing
  stored anywhere depends on them.
- An announcing operator must be able to rotate the announcing key (RFC 0008
  rotation, signed by the retiring key, so old announcements still resolve) and
  to revoke: withdraw the seed entry, let the record expire, or publish a
  revocation. Until a key-level revocation kind exists, rotation and short
  expiry are the working answer, and this RFC does not pretend otherwise.
- An operator who wants to announce must hold an agent key, sign the record with
  `AgentSigner`, publish the document at a stable URL, and list that URL — no
  write access to anyone else's seed is required.

## Open questions

1. **Who may announce?** Any identity, or only identities a seed lists? Any
   identity maximises openness and gives every key holder a denial-of-service
   path through the disagreement stop; seed-listed identities make federation
   as closed as the seed it replaces. This RFC does not settle it.
2. **How long may an announcement live, and who caps it?** A maximum lifetime,
   a clock-skew allowance for `issuedAt`, and what a client treats as "now" are
   all unspecified here.
3. **Where does signature verification run?** `verifyPayload` lives in
   `apps/api/src/identity.ts` today; the SDK signs but does not export a
   signature verifier. Does a resident that reads announcements itself need a
   verifier export, or does verification stay behind the API?
4. **Does revoking an announcing key need a new revocation kind?** The kinds
   today are `capability`, `verifier`, and `artifact`. Rotation plus expiry works
   but is not a "do not trust this key" statement a client can fetch.
5. **Are announcement documents cached, and for how long?** A fetch per client
   per seed per refresh is a new dependency on a mirror's availability; the
   refusal-recording behaviour of the existing sequence suggests the answer but
   does not fix it.
6. **Should the announcement list itself be pinned?** If the seed's
   `announcements[]` can be edited by whoever serves the seed, a hostile edit
   removes or redirects discovery without touching the pins.
7. **What happens when an announced mirror 404s?** The existing sequence records
   the refusal and moves on; whether an announcer accumulates a bad-reputation
   penalty is undecided, and deliberately not invented here.

## Decision

**Draft.** The gap is real and named by `docs/MIRRORS.md`; the design above is
the smallest signed statement that closes the discovery half of it without
touching verification. No code ships with this RFC. It may move to Proposed when
the open questions above — above all, who may announce — are answered, and when
an implementation can demonstrate that a seed without `announcements` behaves
exactly as it does today.
