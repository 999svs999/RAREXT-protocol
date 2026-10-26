# Changelog

All notable changes to the RAREXT protocol, the registry, and the published
packages. The format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) with pre-release
tags while the protocol is in pre-alpha.

Protocol-visible changes — the publication envelope, the attestation, the semantics
binding, the Merkle leaf — are called out explicitly. They are the changes that can
break a client or invalidate stored data.

## [Unreleased]

- **The published proof page was a second implementation, and the failover landed in the copy
  nobody published.** After adding mirror failover to the generated page, the live page had no
  trace of it: `build-mirror.mjs` writes the local dev tree, while the PUBLISHED page comes from
  `publish-ai-proof.mjs`, which carried its own near-identical copy of the same page. Both were
  "generated correctly" by their own generator, so the duplication was invisible and the fix
  simply went to the unused twin — the same trap as before, one level up: not a broken check but
  a broken assumption about which artefact the check was looking at. The page now exists once,
  in `scripts/mirror-verify-page.mjs`, and both generators call it with their own title and
  heading; the committed `site/registry/mirror/verify.html` was regenerated from that module
  (5,389 → 8,487 chars) and its failover proved again in a real browser (tampered local copy
  rejected with its reason, faithful sibling served, roots equal at 793915a9…). `claim:check`
  now asserts the page's behaviour lives in the module AND that neither generator keeps a
  private copy of the page code — that guard caught two mistakes of its own while being written
  (it first failed on the heading strings, which are legitimate arguments rather than
  duplication), which is recorded because a guard that cannot tell an argument from a copy is
  the same class of error it exists to prevent.
- **The published proof page now fails over between copies, and says which one it used.**
  A visitor who opened a mirror's `verify.html` had no recourse if that mirror's own copy was
  tampered or missing: the page fetched `./bundle.json` and stopped. It now applies the same
  rule as `bundleFromSeed` in the browser — this mirror's copy, then the sibling registry copy
  (whichever relative form the tree is published in), then the locations the seed names —
  accepting the first candidate that verifies **and rebuilds the pinned root**, and printing
  `Served from` plus every rejection with its reason. Proved against a local server in a real
  browser: a tampered mirror page reports `Rejected ./bundle.json: the publications in this
  bundle do not rebuild the anchored root` and serves the faithful sibling copy (roots equal,
  AI renditions re-derived); with both copies tampered it reports "No copy verified" instead of
  a green row; and with a WRONG pin the honest copy is refused with "the bundle root does not
  match the pinned chain root", so the pin really gates client-side. The doc's claim about the
  page is now checked against its generator (build-mirror.mjs), so it cannot rot.
- **The seed's mirror list was a mirror list in name only, and a test held it there.**
  Checking the published seed against the live network — before writing any new code —
  showed its single `mirrors[]` entry pointed back at the registry's own bundle URL, so the
  seed named one location twice and `bundleFromSeed` had nothing to fail over between. The
  deploy was green the whole time because every root matched; a mirror that is a copy of
  the seed is indistinguishable from a mirror by root alone. `scripts/verify-seed-mirrors.mjs`
  is the check that was missing: it fetches the seed, requires at least two DISTINCT
  locations, and requires each to rebuild the pinned root (a merely unreachable location is
  reported, not fatal, while another verifies — mirrors exist to be redundant). It failed on
  the live seed exactly as predicted, then passed once the seed named the mirror tree at
  `/mirror/`, which is a genuinely separate copy that rebuilds the same root. The deploy now
  asserts distinctness too, so this cannot recur. The obsolete assertion in
  `apps/api/test/published-bundle.test.ts` required `mirror.bundle === seed.bundle` — it
  encoded the bug and stayed green for precisely as long as the bug existed; a test can hold
  a defect in place as firmly as it can catch one.
- **Federation's first step, implemented: a client finds the mirror that verifies.**
  `docs/MIRRORS.md` names mirror discovery as the next step; `bundleFromSeed`
  (`apps/api/src/bundle.ts`) is its first half, and it is the half that carries the trust:
  the client tries the seed's own URL and then each mirror in order, and accepts only a
  copy that **rebuilds the root the seed pins**. Internal validity is deliberately not
  enough — a mirror can rewrite both its bytes and the root inside them — so a bundle that
  verifies but rebuilds a different root is refused by the pin, which is the case the test
  exercises directly alongside a tampered copy, a 404, and a seed whose candidates all
  fail (the error names every candidate and why, so an outage reads as evidence). What is
  still missing is stated in the doc rather than implied: mirrors do not gossip, and the
  seed is still a file someone publishes. Test: `apps/api/test/bundle-seed.test.ts`.
- **The claim axis is closed with a checked coverage map (kind 20).** `docs/CLAIMS.md`
  records which documents `claim:check` mechanically verifies (15, with the kind that
  reads each) and which are deliberately prose (8, each with its reason). The map is
  itself checked: every document listed as checked must be referenced by the checker, every
  prose row must state a reason, and no document may appear in both lists — so the axis is
  an auditable boundary rather than an open-ended sweep. Three parser lessons, recorded
  because each failed silently: a fixed three-column regex matched a two-column row ACROSS
  its newline (half the prose table parsed, the rest vanished — cells are now split, not
  matched); `OPERATOR.md` was listed as both checked and prose (the overlap check caught
  it); and a self-test fixture that names a phantom document in the checker's own source
  satisfies "the checker never mentions it" vacuously, so the phantom is now built at
  runtime from the file's length.
- **The crypto doc's runtime floor, leaf versions, and suites are checked (kind 19).**
  `docs/CRYPTO.md` publishes the runtime floor ("Node 22.18+"), the leaf-version history
  ("Leaf version 3 added the profile"), and the suite set (ECDSA P-256, ML-DSA).
  `claim:check` compares the floor with `package.json`'s own `engines.node`, requires the
  shipped `PUBLICATION_LEAF_VERSION` (currently 4) to be at least the documented profile
  version, and derives the suites **functionally** through the SDK's `suiteOf` — a P-256
  key is `ecdsa-p256`, ML-DSA-44/65 keys map to their suites, and a foreign key (RSA) is
  refused rather than silently classified. Self-test: a doctored runtime floor is
  reported.
- **The app-protocol doc's configuration and routes are checked (kind 18).** A coverage
  sweep of the docs found `docs/APP-PROTOCOL.md` — 48 numeric/structural claim lines —
  was the largest unchecked surface. `claim:check` now verifies that every `RAREXT_*`
  name the doc tells an app author to set is actually read by the implementation
  (discovered by walking the api, mcp, chain, core and sdk source trees, not a hand-picked
  file list) and that all 21 published routes are still handled. Two checker bugs were
  found and fixed while wiring it, both recorded because they are the same trap: `root` is
  a URL object, so `path.join` mangles it silently (a directory walk that finds nothing) and
  the file reads that reused the mangled form returned empty strings whose `join("\n")` is
  only 72 characters — the check then reported every documented name as unread at once. The
  walk's file count is now printed in the summary so a future silent-empty walk is visible
  immediately, and a zero-file walk fails loudly.
- **Hardening round: the agent SDK's keyfile and signing boundary (negative result,
  pinned).** The path an external agent touches first — its key file and signatures —
  went from a single 73-line integration case to that plus a fault suite: the keyfile
  round-trips with its identity intact and the README's modes hold (0600 file, 0700
  directory); a second write refuses `EEXIST` instead of clobbering a key, leaving the
  original bytes untouched; seven malformed keyfile shapes are each refused with a
  message naming the problem; the public/private **pairing** is validated (a file cannot
  advertise one identity while signing as another); a signature verifies over its own
  canonical bytes and fails over a modified payload or a flipped bit; and handles
  outside the documented shape are refused at creation. **No defect was found** — the
  SDK already validated more than suspected (the pairing check was in place before this
  round) — so the value is that each property is now pinned, including the file-mode
  claims. One type-level trap recorded: `node:crypto`'s `JsonWebKey` is structurally
  wider than the SDK's, so importing a JWK needs an explicit widening cast that the
  runtime never needed. Guarantees row in `docs/HARDENING.md`.
- **Hardening round: the sealed tier's fault surface (negative result, pinned).** The
  primitives behind "a mirror holds ciphertext it cannot read" got their own fault suite
  in `sealed-path.test.ts`: a round trip is byte-exact while a one-bit tamper of the
  ciphertext or auth tag is refused (`authentication failed`, never partial output), a
  wrong secret is refused, malformed `iv`/`salt`/`authTag` are named in the refusal
  before any crypto runs (an empty ciphertext is valid base64 and refused by
  authentication instead), metadata recorded by a placement is bound to its ciphertext
  (a swapped pair refuses), the same plaintext encrypted twice shares no salt, iv, or
  ciphertext, and the recorded metadata plus committed ciphertext carry no plaintext.
  **No defect was found** — every injected fault was already refused — so the round's
  value is that the refusals are now pinned and the length bound is stated rather than
  implied: AES-GCM is a stream cipher, so ciphertext length equals plaintext length, and
  the sealed tier hides content, not size (`docs/HARDENING.md`, sealed tier row).
- **The mirrors doc's claims are checked, and its CI claim made true.** Seventeenth
  claim kind: `docs/MIRRORS.md`'s bundle routes are held to `app.ts`'s guards, its four
  named npm scripts to `package.json`, its published-copy artifacts to the deploy's own
  sources (`site/registry/{bundle.json,seed.json,mirror/verify.html}` plus the
  `registry/mirror/* → /mirror/*` mapping that makes the URLs resolve) — and its claim
  that the takedown test "runs in CI" to `scripts/ci.sh`. That last one was **false**:
  the doc calls the takedown test the acceptance criterion and says CI runs it, but
  `ci.sh` never did. It passes in about a second, so it is now wired into the gate, and
  the checker keeps the sentence true. The self-test doctors the doc to name an
  undefined script and asserts the mismatch is reported. A second suspicion was checked
  and dismissed rather than assumed: the published `/mirror/` URLs resolve because the
  deploy sources them from `site/registry/mirror/`, not `site/mirror/`.
- **The audit-window and verifier-timeout claims are checked.** Sixteenth claim kind:
  `docs/OPERATIONS.md`'s audit-freshness row and `docs/STORAGE-SECURITY.md`'s
  nonce/timeout statements are verified against the code — `AUDIT_WINDOW_MS` = 15 min
  (imported constant), the 5-minute future-timestamp tolerance (`CLOCK_SKEW_MS` read
  from source), the exact refusal literals the doc quotes and the code must produce,
  `MAX_CHALLENGE_NONCE` as a positive integer, and `MAX_EXTERNAL_VERIFIER_TIMEOUT_MS` =
  300,000 matching the doc's published range. The boundary behaviour stays pinned
  functionally by `apps/api/test/audit-attestation.test.ts`, whose existence and
  execution the evidence-citation kind already enforces — so the checker asserts the
  published numbers, not a second copy of the behaviour. Self-test: a doctored 30-minute
  window is reported. One over-strict assertion was corrected while wiring it: the doc
  quotes one refusal verbatim and describes the other in shorthand, so the check anchors
  each in its own form.
- **Hardening round: the multi-holder gate and the non-loopback holder path.** The
  layer that decides which holders store which shards — and how a client reaches one
  off-loopback — went from two single-case test files to a suite that pins the
  placement contract: with exactly `k + m` holders, a holder answering 5xx (e.g. a
  `507` quota) fails the placement loudly instead of letting it proceed with fewer
  shards; a holder answering with anything that is not a valid shard name is refused
  at placement; the probe/repair path skips spares that reject writes, refuses to
  commit when its lease expires or its placement is forgotten mid-read, and backs off
  after failures instead of storming; and the non-loopback holder streams
  byte-exact with its token enforced. One honest bound is recorded in
  `docs/HARDENING.md` (and in the source): the returned `storedAs` is a locator, not a
  proof — equality with the shard digest is deliberately NOT asserted at placement
  (a holder names the file by its own digest of the bytes it received), so integrity is
  enforced when the bytes are read back against that name; asserting equality there
  refused honest repairs and stub holders that named files by their own rule.
  Supervisor note: the round was agent-authored and carried to green by the
  supervisor after every rail ran dry mid-round (OpenCode/OpenRouter caps, Agnes
  throttle, Google's 20-requests-per-model daily buckets); the mid-write tree it left
  had numbered-line prefixes in the test file, a missing import, and non-deterministic
  holder selection in the 5xx case — all repaired before the commit.
- **Hardening round: the external MCP agent storage path.** The surface "AI lives on
  RAREXT" rests on — an external agent putting and getting bytes through MCP — went
  from 1 guarding test case to 10, with failure injection across the whole path: a
  lying `content-length` is refused loudly and never parsed as a fragment (the holder
  now cross-checks the declared length against the delivered bytes, ends the
  connection, and bounds a stalled body with a timer); the byte quota is checked
  before the stream is consumed (`507` before bytes are stored, both upload paths);
  corrupted shard bytes are caught by the digest check; persistence holds across a
  holder restart; a challenge after GC answers a clean `404` with the ledger recording
  the shard not-live; concurrent identical puts converge to one stored object; a
  revoked identity is refused; malformed tool arguments do not crash the MCP server.
  The per-path guarantees and their bounds are in `docs/HARDENING.md`'s
  "Guarantees by path" table — including the honest bound that a truncated body's 400
  is not always deliverable when the client's FIN races the response: the contract is
  loud refusal, not a specific status. Two defects were found and fixed mid-round
  (a `readJson` signature refactor whose call sites were not updated —
  `setTimeout(…, undefined)` fired instantly and killed every JSON request — and a
  response flushed after its socket was destroyed). Supervisor note: the round was
  authored by the external agent and finished by the supervisor after its turn was
  cut twice (25-minute attempt timeout, then the Agnes text throttle and the Google
  per-minute token wall); the continuation prompt quoted the agent's own failing
  tests as the specification.
- **The snapshot/migration claims in the operations doc are checked.** Fifteenth
  claim kind: `docs/OPERATIONS.md`'s "Snapshots and migrations" and "Game-native
  state migration" sections publish the current snapshot version (2), the 1 → 2
  migration that adds empty `rotations`/`delegations` arrays and preserves the
  existing `publications` array, the load-time refusal of a newer snapshot
  ("newer than this build supports"), the broken-chain refusal, the
  "publications must be an array" validation, the "could not load …" refusal on a
  corrupt file, the game-state plan's kind (`rarext.game-state-migration`),
  version (1), status (`deferred`), mode (`no-op`), its eight durable
  collections, the bundle's copying of extension fields, and the command's
  refusal of `--execute`/`--cutover`. The checker parses the version out of the
  doc and compares it against `CURRENT_SNAPSHOT_VERSION`; runs `migrateSnapshot`
  with a v1 snapshot as a positive control (empty rotations/delegations,
  preserved publications); exercises the newer-snapshot and broken-chain
  refusals through the real `migrateSnapshot` with the published rejection
  messages; confirms the store's load path still carries "publications must be
  an array" and "could not load"; builds a plan through
  `buildGameStateMigrationPlan` and re-derives its kind/version/status/mode and
  collection list from `apps/api/src/game-state-migration.ts`; builds a bundle
  through `buildGameStateMigrationBundle` with an extension field and requires
  it to appear in both the snapshot copy and `unmanagedTopLevelFields`; and
  confirms the script source still refuses cutover. The self-test doctored
  "Snapshot version 2 is current." to "Snapshot version 3 is current." and the
  fixture-changed guard covers the new fixture.
- **The semantics doc's claims are checked against the real validator.** Fourteenth
  claim kind: `docs/SEMANTICS.md` publishes the `Semantics` record's fourteen named
  fields, its two hash fields (`specHash`, `semanticsHash`), the four binding-status
  values (`ok`, `missing`, `version-mismatch`, `spec-mismatch`), the three API routes
  (`GET /v1/semantics`, `GET /v1/semantics/:id`, `GET /v1/challenges`), the four claim
  kinds a record licenses (`satisfies`, `attests`, `produces`, `derives`), and the
  scope rule that a claim's scope keys must appear in the record's `inputs` or
  `outputs`. The checker parses each field name out of the doc and locates it in the
  validator's return object in `apps/api/src/semantics.ts`; re-derives `specHash`
  through `semantics.specHash` and `semanticsHash` through `semantics.semanticsHash`,
  requiring both to be stable 64-char digests; extracts the route guards the same way
  the route-surface kind does; and exercises the scope rule through `bindClaim` — a
  scope-less claim and a scope key the record contemplates (`circuit`) must bind, and
  a key it does not (`dataset`) must be rejected. The self-test doctored the
  interface's `createdAt: string;` to `created: string;` and the fixture-changed
  guard covers the new fixture.
- **The AI-verification vision doc is now a checked claim surface.** Thirteenth claim kind:
  `docs/AI-VERIFICATION.md` publishes the two rendition rule names (`xorshift32-image-v1`,
  `bounded-strip-v1`), the stable verifier hashes derived from their manifests, the
  functional behaviour of `isGenerativeMedia`/`isBoundedMedia` and the deterministic
  raster renderers (`renderRaster`, `renderBoundedRaster` with their rejection guards),
  the verifier module routes (`GET /v1/verifiers`, `GET /v1/verifiers/:app/:hash.mjs`),
  and the attestation field contract. The checker parses the rule names from the doc,
  compares them against `packages/core/src/ai.ts`, calls the real media validators and
  raster functions with positive controls and published rejection inputs, verifies the
  route guards in `apps/api/src/app.ts`, and confirms the verifier hashes are stable.
  The self-test doctored `xorshift32-image-v1` to `xorshift32-image-v2` and the
  fixture-changed guard covers the new fixture.

- **Deploys verify the AI renditions live.** `scripts/deploy-site.mjs`'s post-deploy
  `verifyLive` stage now ends with the AI recomputation smoke check:
  `scripts/verify-live-ai.mjs` runs against the just-deployed mirror URL, re-deriving
  both renditions from the commitments alone and matching the served PNG bytes — the
  same verification a stranger runs — and a non-zero exit fails the deploy. Spawned
  asynchronously (the `spawnSync`-blocks-the-event-loop lesson applied forward).
- **`npm run demo:ai` — the one-command, third-party proof that AI lives on RAREXT.**
  The claim axis had made the docs provable to CI; this makes the vision demonstrable
  to a person. The demo composes the repo's existing gated pieces: it publishes real
  signed generative + bounded AI publications through the live API flow
  (`scripts/publish-ai-proof.mjs`), serves the resulting mirror over loopback HTTP,
  re-derives both AI renditions from the commitments alone
  (`scripts/verify-live-ai.mjs` against the local server), and checks the anchor pins
  the published root and covers the publications — a phase-by-phase receipt, exit
  non-zero on any broken link, writes only to the gitignored `.ai-proof/`.
  Verified 4/4: publish → serve → recompute (2 renditions) → pin. One build
  mistake, recorded: the first version ran the verifier with `spawnSync` while its own
  HTTP server lived in the same process — `spawnSync` blocks the event loop, so the
  server could not accept connections and the child's fetches hung until the timeout
  killed them. The demo now runs children with async `spawn`.
- **The work-economy reward schedule is checked both ways.** Twelfth claim kind:
  `docs/WORK.md`'s credit table (verify 10, store 1, mirror 25, relay 15, publish 5,
  remix 20, report 50) is verified against the `base` values in
  `apps/api/src/work.ts`'s exported `ACTIONS` — every published row must equal the
  code's base for that action, and every action the code defines must appear in the
  doc's schedule, so an undocumented reward cannot pay silently. The self-test doctored
  verify's credit to 12 and the fixture-changed guard covers the new fixture.
- **The chain-registry surface is checked like the API's.** Eleventh claim kind:
  `docs/CHAINS.md` publishes seven chain routes (`POST /chain/anchor`,
  `GET /chain/{state,head,key,proof,blocks/:height,audit}`) and a chains table; the
  checker verifies every published route is handled by `apps/chain/src/server.ts`
  (including the `/chain/blocks/` prefix form), that the table's `trac` row has its
  adapter in `apps/api/src/anchorer.ts`, and that the `evm` row's backing artifacts —
  `contracts/RarextAnchor.sol` and `contracts/scripts/deploy-anchor.mjs` — exist. The
  self-test publishes a `POST /chain/rollback` route the server does not have and
  asserts the mismatch is reported.
- **The fault-limit tables' cited evidence is checked.** Tenth claim kind: the
  fault-limit tables in `docs/OPERATIONS.md` name 30 test files as the measurement for
  each published behaviour; `claim:check` now verifies every citation exists and is
  non-empty in the tree, that the gate's test glob (`apps/api/test/*.test.ts`) is broad
  enough to run them, that the doc cites evidence at all, and that the `BACKUP_VERSION`
  contract the backup-fault section pins (version 1) matches `apps/api/src/backup.ts`.
  The self-test rewrites one citation to a file that does not exist and asserts the
  mismatch is reported — a doc that cites evidence the CI never runs is drift.
- **The operational defaults are checked against the source that reads them.** Ninth
  claim kind: `docs/OPERATOR.md`'s retention/GC defaults — the challenge scheduler "every
  6 hours", storage and pin GC loops "both 24h, `0` disables", and the 24-hour blob GC
  grace — are verified against the actual `??` fallbacks in `apps/api/src/server.ts`,
  `apps/api/src/pin-server.ts`, and `apps/api/src/durability.ts` (6 h, 24 h, 24 h, 24 h).
  The doc's "21600s" rendering and the gracePeriodMs-0 delete-on-first-scan note are
  anchored too. The self-test injects a doctored OPERATOR.md (scheduler "every 12
  hours") and asserts the mismatch is reported.
- **The AI replay bounds are checked functionally, not just as constants.** Eighth claim
  kind: `docs/OPERATIONS.md`'s replay-bounds table states `MAX_GENERATIVE_TOKEN_LENGTH` =
  256 and `MAX_GENERATIVE_OUTPUT_LENGTH` = 1 MiB, and the behavioural claim that a replay
  whose longest token times steps exceeds the bound is rejected without generating.
  `claim:check` verifies the constants against `packages/core/src/ai.ts`, runs a positive
  control (an exact 100-step replay verifies correct — guarding against the check passing
  because the function always returns false), and asserts the published rejection
  behaviour at the arithmetic boundary the doc implies: 256 x 4,097 = 1,048,832 > 2^20 is
  returned as `{ correct: false, expected: "" }`, while 1 MiB / 256 = 4,096 is exactly
  the largest step count that still replays. The self-test injects a doctored bounds row.
- **The published limits are checked against the exported constants.** A programmatic
  sweep found 393 numeric claim lines across 21 docs; the limits table in
  `docs/OPERATIONS.md` cites named constants, so `claim:check` now verifies
  `MAX_BLOB_BYTES` = 32 MiB and `MAX_BODY_BYTES` = 1,000,000 bytes (the doc's "1 MiB" is
  a rounded label, noted where checked), `MAX_GENERATIVE_STEPS` = 100,000 and
  `MAX_VOCAB` = 4,096 — doc values parsed from the markdown, code values imported from
  `apps/api/src/storage.ts`, `apps/api/src/app.ts` (module-local, read from source), and
  `packages/core/src/ai.ts`. The self-test injects a limits table the code outgrows
  (`MAX_VOCAB` = 8,192) and asserts the mismatch is reported. Seventh claim kind.
- **The soak claims are re-derived and artifact-backed.** The 10-minute chaos run was
  re-run against its published numbers: 5,991 puts at 100%, 5,991 retrievals at 100%,
  148 repairs at 100% with 148 re-audits passing, 22 holder kills, 2 transient put
  retries; peak client RSS 196.0 MiB (median 180.3, live heap 22.8 MiB) and peak holder
  RSS 91.8 MiB — better than the published 242/94 MiB, same 100% completion. The log is
  committed as `bench/storage/soak-2026-10-26.log`; HARDENING and OPERATOR cite it with
  the date, and `claim:check` now parses the committed log, requires every operation
  class at 100%, requires OPERATOR's "latest" numbers to be the log's numbers, and its
  self-test feeds a doctored log (99.2% completion) that must be reported.
- **The measured repair claim is re-derived and checked too.** The 1 GiB `4 + 2`
  bench was re-run against the published claim: read 1.000 GiB, write 0.500 GiB, total
  1.500x — the MDS floor, `exact: true` — in 121.7 s (an earlier run of the same
  command: 127 s, so the ratio is the number to trust). `claim:check` now verifies the
  doc's paragraph against `bench/repair/RESULTS.json` — the harness's own committed
  artifact — asserting the ratios add up, `totalRatio` equals the floor, and a plausible
  elapsed time exists; its self-test feeds a doctored record (`totalRatio: 1.4` against
  a floor of 1.5) and asserts the mismatch is reported. The self-test monkey-patch that
  first attempted this was replaced with injection, because reassigning an ESM import
  binding throws.
- **Published claims are checked against the code (`npm run claim:check`).** The
  availability-sampling table in RFC 0010 and the MDS floor `1 + m/k` cited in
  `docs/HARDENING.md` and `docs/STORAGE-FRONTIER.md` are now re-derived from
  `samplesForMissingFraction` and from the codec's own shard sizes, with the table parsed
  out of the RFC itself so editing either the document or the implementation alone fails
  the check. Verified: all four published rows match (20%→21/31, 10%→44/66, 5%→90/134,
  1%→444/657), the prose holds (44 samples miss 10% withholding with probability 0.957%,
  costing 0.48% of the media), and the codec measures the floor at 1.5000x for `4 + 2`,
  1.4001x for `10 + 4`, 1.3334x for `3 + 1`. `--self-test` asserts the checker reports a
  doctored row as a mismatch, so a passing run means something. Runs inside
  `scripts/ci.sh`.
- **The operator and placement gates are pinned branch by branch (hardening).** A sweep
  for store-shaped methods with no in-body type check produced four candidates; all four
  are gated before they store anything, so the sweep found no defect and is recorded as a
  negative result in `docs/HARDENING.md`. What it did change: `verifyOperator` and
  `verifyPlacement` decide who is paid for verifier work and what repair reads, and each
  had four test cases. The operator gate now pins the 17 named refusals it can return and
  the placement gate 16, each with a positive control, and the placement gate asserts
  `digest` is `null` on every refusal so a refused record cannot be handed back as a
  valid chain link.
- **The Trac task registry enforces what it publishes (hardening).** `register`
  checked truthiness only, so the registry accepted and then *served* values its own
  type forbids: an unknown status, a numeric `app`, an object `challengeId`, an
  unparseable `createdAt`, a whitespace handle, and an array handle — the last being
  an entry that appears in `list()` and cannot be fetched by handle at all, because a
  `Map` keys by identity. `get` and `list` also returned the live record, so one
  in-process reader's edit changed the status every other reader saw. Entries are now
  validated field by field, and readers get frozen copies. The task-registry suite
  goes from 3 cases to 9, and the limits are written into `docs/OPERATIONS.md`.
- **An invalid verification clock no longer disables the freshness window (hardening).**
  Every freshness comparison in the audit verifier is numeric, and `NaN` fails all of
  them — so passing `now: NaN` did not narrow the window, it removed it. Measured
  before the fix: an attestation a millisecond past its window verified. The clock is
  now validated exactly as `windowMs` already was. The audit suite goes from 3 cases to
  12, one per mechanism (clock, signature transplant, key substitution, expected
  verifier, algorithm, forged and self-admitted transcript entries, out-of-range leaf
  index, malformed shapes by name, and the unsigned-field bound), and the mechanisms
  are recorded in `docs/HARDENING.md`.
- **One anchor per batch (hardening).** `anchorPending` read the pending set, awaited
  the anchoring adapter, and only then committed — so two overlapping calls both read
  the same batch and both committed it. Measured before the fix: two anchors, the same
  root, the same publications in each, and two adapter submissions. Overlapping calls
  now share a single anchor (same id, same root, one submission). The HTTP route had
  hidden this because one keep-alive connection serializes requests, but the function
  has two call sites and their interleaving was reachable. The anchoring suite goes
  from 2 cases to 11 — concurrency, proof refusals, post-anchor tampering, restart
  durability, root-vs-leaves recomputation, a dead rail, and threshold parsing — and
  the guarantees are written into `docs/ARCHITECTURE.md`.
- **Renditions are checked where they are attested (hardening).** The verifiers
  re-derive an AI artifact's picture from its commitment and reject a rendition
  that is not the function of it. Measured before the fix, four attacks were all
  attested `correct: true` on the serving side — an unknown rendition rule, a
  lying raster digest, a lying bounded plot, and impossible geometry — while the
  browser reported nothing, because a rule it does not implement is silently
  dropped. Now an unimplemented rule or a malformed rendition is refused, and a
  rendition that does not re-derive makes the attestation incorrect with score 0.
  Test coverage for the two AI verifiers goes from 22 cases to 32, and the limits
  are written into `docs/AI-VERIFICATION.md`.
- **Exact rent arithmetic (hardening).** Storage-rent quotes are now computed in
  exact integer arithmetic: the ceiling is taken on the exact rational, so a
  quote can no longer be off by a microcredit in either direction. Measured
  before the fix, a sweep of 25,800 legal quotes disagreed with exact arithmetic
  88 times (including undercharges at TB-scale multi-year terms); the same sweep
  now agrees on every quote that produces a price, and a cost beyond the exact
  range is refused instead of approximated. A pricing object whose policy,
  monthMs, or creditScale drifts from the committed constants is refused rather
  than quoted. Test coverage for the money path goes from 7 cases to 20, one per
  mechanism, with measured limits written into `docs/STORAGE-ECONOMY.md`.
- **Deterministic site deploy.** `npm run deploy:site` projects the committed
  `site/` tree onto `gh-pages`, publishes the mirror at `/mirror/`, refuses to
  write when the seed, bundle, and mirror roots differ or a published byte does
  not match its repo source, and verifies the live bytes, roots, links, and both
  AI renditions after pushing.

- **Reproducible EVM anchor audit package.** `npm run audit:package` writes a
  hash-verified package with the exact contract source, tests, scripts, runbooks,
  relay file, ABI, creation/runtime bytecode, and storage layout, plus a manifest
  and `SHA256SUMS`. `npm run audit:package:verify` checks every checksum, the
  audit status flags, the source hash, and the compiled artifact hashes. A valid
  testnet record can be bundled with `--deployment`. The package records whether
  the tree was dirty and does not change the external-audit or live-deployment
  gate.

- **Storage rent quotes (v1 slice).** `GET /v1/storage/pricing` publishes the
  operator's public and sealed rates, and `GET /v1/storage/quote` returns a
  deterministic 30-day byte-month quote in integer microcredits. `/v1/storage/usage`
  now reports `committedByteMonths` and the latest `retainedUntil`. The public tier
  defaults to free and the sealed rate is operator-configurable. A quote is not a
  reservation and does not charge; settlement remains in
  [RFC 0018](rfcs/0018-storage-rent-settlement.md).

- **Public-testnet rehearsal.** `npm run testnet:rehearsal` starts a chain, three
  token-protected holders, a pin service, and an HTTPS API on loopback; publishes
  through the external SDK; anchors and checks the proof; places, challenges, and
  reconstructs storage; builds and verifies a mirror; restarts the chain and API;
  backs up and restores state; and verifies the mirror with the API stopped. DNS,
  public certificates, firewall rules, and off-host monitoring remain handoff items.

- **Repair-path hardening.** `DurabilityLedger.repair` now reads another survivor when
  a holder drops between the presence probe and `get`, and tries the next free spare
  when a target rejects `put`/`putFile`; streamed repair follows the same rules. A repair
  holds a 30-minute in-memory lease tied to the placement object and refuses to commit
  after a `forget`, `maxPlacements` eviction, replacement, or lease expiry. The challenge
  scheduler backs off failed repairs per blob (60s initial, doubled, 6h cap) and reports
  `repairDeferred`/attempt counts instead of retrying every run. New fault tests cover
  each path, and `docs/OPERATIONS.md` records the measured limits.

- **Community tournament hardening.** `TournamentService` now caps a field at
  `MAX_TOURNAMENT_PARTICIPANTS` (1024) and refuses a participant-count overflow, and a
  recorded result must name the two participants of the match it settles: a winner that
  is not in the match, or a loser that is not its counterpart, is refused. A duplicate
  tournament name and an unknown match id are 400s, not 500s. Concurrent submissions of
  the same result record the match exactly once (synchronous check-and-write).
  Regression tests cover every bound, and `docs/OPERATIONS.md` records the measured
  limits for the next pass.

- **Community tournament (in-memory).** `POST /v1/tournaments` creates a session-scoped
  bracket or round-robin from a participant list, `POST /v1/tournaments/:name/results`
  records a match outcome, and `GET /v1/tournaments[/:name]` reads the bracket or
  standings. Winners advance through single-elimination rounds; round-robin standings
  are ordered by points, then wins, then fewest losses. Nothing is signed or persisted,
  so a restart clears the field. Tests drive a 4-player bracket and a 4-player table to
  known outcomes and exercise the HTTP surface end to end.

- **Task registry on Trac (read-only).** `GET /v1/tracregistry` lists registered task
  handles with status (`pending`/`running`/`completed`/`failed`) and metadata, or a
  single handle by id via `?handle=`. It reads through the Trac adapter and never signs
  or writes. Fixture-backed unit tests cover all four states plus a missing handle, and
  an API-route test pins the returned shape.

- **External-agent MCP storage integration test.** `npm test` now runs
  `apps/api/test/mcp-storage-agent.test.ts`, which starts six token-protected holders,
  the API, and a pin service, then drives the real MCP stdio server through put, get,
  challenge, audit, and pin as an outside client. The test asserts the exact payload,
  all six live challenges, an `ok` audit, and a stored pin.


### Security

- **Storage challenge, transport, placement, and pin hardening.** Challenge responses
  now bind to the requested leaf index and a fresh nonce, reject replays, cap nonce and
  proof sizes, and require an exact Merkle depth. `httpHolder` verifies shard bytes
  against `storedAs`, caps responses, and times out; holder and pin servers support
  optional bearer tokens, bounded bodies, constant-time comparison, and bounded caches.
  Placements reject co-location, oversized or inconsistent shards, impossible required
  counts, and malformed claims before adoption. The pin store recomputes CIDs and writes
  metadata atomically. `docs/STORAGE-SECURITY.md` and RFC 0012 record the model and the
  still-open findings (confidentiality, retrievability, quotas/TLS/identity, lying
  verifiers, orphan GC). Eight security tests.

### Fixed

- **EVM anchor read-back calldata.** `apps/api/src/chains/relay.ts` now calls
  `anchors(uint256)` with the Keccak selector and a directly ABI-encoded id, instead of
  SHA-256 hashing the signature and hex-encoding the ASCII calldata. It also accepts a
  bare numeric relay reference and refuses to guess index 0 when no id is present. Three
  tests pin the calldata against ethers, cover both reference shapes, and cover the
  no-id skip.

### Added

- **Consensus interface and settlement gate.** `GET /v1/consensus/state` exposes a
  state root over the anchor audit trail, a deterministic height-scoped head, and
  settlement status. `POST /v1/consensus/validate` verifies a P-256 or ML-DSA
  signature over a canonical `rarext.consensus.anchor-proof` v1 object, recomputes
  the head and state root at the proof's height, checks the anchor and root against
  the trail, and applies a strict `CONSENSUS_SETTLEMENT_MIN` gate. Reaching the
  minimum is `at-threshold` and invalid; only above it is valid. The API never
  trusts a caller-supplied volume or head. Production settlement volume is pending,
  so `productionDataPending` is true and `liveGating` is false. A three-scenario
  fixture covers below/at/above, and an integration test drives the real anchor
  audit trail and a signed proof through the HTTP endpoints.

- **EVM anchor audit trail and guarded funded-testnet deployment.** `contracts/AUDIT.md`
  records the pinned source and toolchain, the external-audit-not-performed status,
  an internal finding and disposition register, a manual auditor checklist, and the
  blocked live-deployment gate. The contract now rejects a zero owner at
  initialization. The deploy script verifies proxy and implementation code, the
  ERC-1967 implementation slot, and publisher read-back. `npm run deploy:anchor:testnet`
  refuses known mainnet chain ids, requires explicit testnet acknowledgement, runs
  the existing deploy script, and writes a record whose audit flags keep live
  deployment blocked. Tests cover zero-owner initialization, the 512-byte metadata
  boundary, the 14-publication compatibility cap, publisher revocation, and the
  deployment guard. No external audit was performed and no contract was deployed.

- **Game-native state migration skeleton.** `npm run plan:game-state` reads a
  registry snapshot and writes a deferred, no-op preservation plan with collection
  counts, field inventories, canonical digests, unmanaged top-level fields, and
  explicit gaps for active builds, challenges, reputation, and ratings. `--bundle`
  writes every durable record and optional challenge export verbatim for a future
  target. The command never writes the source and refuses `--execute`/`--cutover`.
  Seven tests cover field retention, deterministic digests, challenge export,
  version migration, malformed input, and the deferred gaps. RFC 0017 records the
  cold-cutover runbook, inherited RESET/trac-peer constraints, rollback boundary,
  and the remaining target-schema gate.

- **Sponsored challenges.** A configured community member can sign a
  `rarext.challenge-sponsorship.v1` payload and POST it to
  `/v1/challenges/sponsored`. The registry verifies the member's P-256 or ML-DSA key,
  binds a timestamp and nonce, stores the challenge as `status: "sponsored"`, exposes it
  through the existing challenge API, and emits `rarext.challenge.v1` to an optional
  webhook. The workbench lists sponsored challenges and badges matching feed items. The
  member roster is supplied through `RAREXT_SPONSOR_MEMBERS`; no live community directory
  ships with this repository, and the running registry does not yet persist sponsored
  challenges across restarts. Four tests cover the signed flow, webhook delivery, replay
  and signature rejection, and the unconfigured state.

- **EVM anchor contract and local deployment path.** `contracts/RarextAnchor.sol` is a
  UUPS-upgradeable, two-step-owned, pausable append-only anchor log. It stores a unique
  root, the metadata hash, the publisher, and the timestamp; emits `AnchorPublished` with
  the bounded metadata; and exposes `anchors(uint256)` plus `anchor(bytes32,bytes32[])` for
  the registry's existing EVM adapter. Ten local-EVM tests cover publication, duplicate
  roots, authorization, metadata bounds, pausing, ownership, state-preserving upgrades, and
  direct implementation safety. `npm run deploy:anchor` deploys an implementation and an
  ERC-1967 proxy only when the RPC chain id matches an explicit expected value. The
  contract is **not deployed or audited**; the runbook in `contracts/README.md` records
  what remains.

- **RFC 0016: appchain evaluation.** Evaluates a RAREXT appchain against staying on
  anchored transports. It uses the pinned RESET/trac-peer wire format as primary
  evidence for why native anchor moves are a protocol change, and recommends deferring
  a chain behind a measurable demand, economics, and validator-supply gate.

- **$BEM balance in the web UI.** The community page accepts a BSC address and shows its
  read-only `$BEM` balance from `GET /v1/tapeout/status?address=`. The status response now
  includes `bemDecimals` from `BEM_DECIMALS` (default 18), and the browser bundle formats the
  base units. No signing and no write path.

- **Trac anchor transport boundary.** `apps/api/src/adapters/trac-transport.ts` defines
  `TracAnchorTransport` and the adapter announces through it; `GET /v1/adapters/trac` reports
  the transport kind. The HTTP webhook (`TRAC_ANCHOR_URL`) is the shipped, tested transport.
  The native RESET/trac-peer transport is recorded as blocked: message moves are fixed
  `{v,t,b,h,p,w}` types and MSB transactions only carry a strict `{op,to,amount}` transfer
  command, so there is no anchor move or memo to carry a root. Evidence is in RFC 0001 §4.

- **Trac identity-link prototype.** `POST /v1/identity-links` accepts an optional
  `externalProof` for `network: "trac"`. The proof is a
  [RESET](https://github.com/Trac-Systems/reset) `reset-mcp-login` Ed25519 challenge
  whose `nonce` is `sha256(canonicalize(payload))` and whose `audience` must match the
  RAREXT origin. Trac addresses may be 64-hex or `trac1…` bech32m and are normalized
  before verification. `AgentSigner.identityLinkPayload` and `identityLinkBinding`
  build the payload, and `RarextClient.linkIdentity(payload, signature, externalProof)`
  submits it. The adapter verifies the signature offline; no Intercom round trip and no
  canonical-identity migration yet. Run `npm run example:trac-identity` for the full flow.

- **Read-only TapeOut circuit/component indexer.** `GET /v1/tapeout/circuits`
  reads bounded ERC-721 `Transfer` and ERC-1155 `TransferSingle`/`TransferBatch`
  logs, reports the latest circuit owners and component movements, and returns
  `configured:false` without `TAPEOUT_CIRCUIT_CONTRACT` or
  `TAPEOUT_COMPONENT_CONTRACT`. It never signs or writes.

- **MCP storage tools and a runnable network example.** The MCP server now exposes
  `rarext_storage_put`, `rarext_storage_get`, `rarext_storage_challenge`,
  `rarext_storage_audit`, and `rarext_storage_pin`. Put encodes and places shards on the
  configured holders, signs the placement with the local agent key, and registers it;
  get digest-checks shards before rebuilding; challenge and audit share the process
  ledger; pin computes the CID and calls the pin service. The holder and pin bearer
  tokens are supported through `RAREXT_HOLDER_TOKEN` and `RAREXT_PIN_TOKEN`.
  `examples/mcp-storage` drives the real stdio server end to end against six
  token-protected holders, an API, and a pin service. One integration test covers the
  same verbs directly.

- **Storage roadmap completion (Issues #6–10 closed).** Proof of Retrievability
  specification (RFC 0013), byte and request quotas with rate limiting for holders and
  pins, signed independent audit attestations (RFC 0014), and orphan shard garbage
  collection with grace period and dry run. Added `npm run net`, a local storage
  network runner, property/fuzz tests over erasure, placement, and GC, and a 1 GiB
  throughput/memory benchmark.

  The sealed tier is wired into the real MCP put path. `rarext_storage_put` with
  `sealed:true` encrypts with HKDF-SHA256 + AES-256-GCM (matching RFC 0015) before
  erasure coding, records the salt/IV/tag in the signed placement, and the shard
  digests and Merkle roots cover ciphertext; `rarext_storage_get` decrypts client-side.
  `POST /v1/blobs` rejects `tier:"sealed"` instead of mislabelling plaintext. Covered by
  `apps/api/test/sealed-path.test.ts` and `examples/sealed-storage`.

  Still not a production confidentiality claim: no key wrapping, rotation, per-tenant
  isolation, or envelope review, and `RAREXT_SEALED_SECRET` is a raw caller-held secret.
  Do not upload real secrets or describe sealed storage as audited encryption yet.

- **Raw, bounded shard transport over HTTP.** Holders gained
  `PUT/GET /v1/holder/shards/:hash/raw`: uploads stream the request body to a temp file
  while hashing it, downloads stream the file with a length, and challenge leaves are
  computed from the file rather than a whole-shard buffer. `httpHolder.putFile/getFile`,
  `DurabilityLedger.placeStreamed/retrieveStreamed`, and streamed placement metadata
  (`chunkBytes`, `chunks`, `chunkDigests`) make the 1 GiB file path placeable over real
  holders. `npm run bench:network` measured a 242 MiB client peak and 94 MiB holder peak
  at 1 GiB; the whole-shard JSON path cannot accept 1 GiB because of the 32 MiB body cap.
  Key management for the sealed tier remains open.

- **Streamed placements are signed, auditable, repairable, and proven over the network.**
  `DurabilityLedger.repair` now rebuilds a lost streamed shard from k survivor files with
  `reencodeStreamedShard`, uploads only that shard through raw PUT, and re-audits it;
  `BlobStore.has` no longer reads the whole file just to answer a probe. `npm run net`
  adds a third scenario: an 8 MiB file is chunked at 2+1, placed over raw HTTP, signed
  with `AgentSigner`, registered in `PlacementRegistry`, reloaded from a fresh registry,
  challenged, killed, repaired, re-audited, and retrieved byte-for-byte. Still missing:
  the MCP put path remains 8 MiB in-memory, and streamed repair is not load-tested at
  100 GiB.

- **Bounded placement retention and retry-safe puts.** `DurabilityLedger` accepts a
  `maxPlacements` limit and evicts the oldest placement and its witnesses; `forget()`
  releases one explicitly. The soak uses a limit of 24, a zero-grace orphan GC sweep,
  and up to six put attempts with 250 ms-4 s backoff. Its 604 s rerun completed 5,910
  puts at 100.0% (the prior run was 99.9%), 145 repairs and 145 re-audits at 100%, with
  the ledger pinned at 24 and live JS heap near 10.5 MiB. Client RSS reached a bounded
  median of 170.7 MiB after warm-up; the residual is V8 reserved and external/allocator
  memory, not live heap. Defaults remain unlimited for compatibility.

- **Ten-minute soak and chaos run.** `npm run bench:soak` kept eight token-protected
  holders busy for 611 s with continuous puts, challenges, audits, repairs, and
  retrievals while killing and restarting a random holder every 15-30 s. It recorded
  5,507 puts (99.9%), 5,507 retrievals (100%), 143 repairs (100%), 143 successful
  post-repair re-audits, 21 kills/restarts, and peak client/holder RSS of 222/119 MiB.
  The script writes `bench/storage/SOAK.md`/`SOAK.json` with rates and memory-over-time.
  This is loopback on one machine with reused holder identities; it is not a durability
  proof, and the caveats are printed in the report.

- **`npm run net` now proves the sealed tier end to end.** After the open scenario, it
  encrypts a 64 KiB payload with AES-256-GCM/HKDF-SHA256 before erasure coding, places
  it on three HTTP holders, scans every holder directory for a plaintext marker (zero
  hits, all shard hashes match), kills a holder, repairs onto a spare, then retrieves
  and decrypts back to the original bytes. The documented output is a real run. This is
  still a demo of the envelope, not a key-management or confidentiality claim.

- **Bounded-memory erasure for large payloads.** `apps/api/src/erasure-stream.ts`
  stripes a file into fixed chunks, encodes one chunk at a time, and appends shard
  blocks to disk, so peak memory follows the chunk size rather than the payload size.
  `decodeShardsToFile` reconstructs any `k` of the shard files and verifies both the
  per-chunk digest and the whole-payload digest. At 1 GiB and 4+2, peak RSS fell from
  3243 MiB (in-memory `encodeBytes`) to 393 MiB while remaining byte-exact (8.3x lower);
  encode throughput moved from 11.2 to 8.6 MiB/s and decode from 48.6 to 23.2 MiB/s.
  Holders now also accept raw `PUT`/`GET` of shard files, and
  `DurabilityLedger.placeStreamed`/`retrieveStreamed` use that transport. Over real
  loopback holders the client peak stayed at about 250 MiB for both 64 MiB and 1 GiB,
  while the whole-shard JSON path needed 676 MiB for 64 MiB and cannot store 1 GiB at
  all. Streamed repair now rebuilds one shard at a time from k survivors. See
  `bench/storage/RESULTS.md` and
  `apps/api/test/erasure-stream.test.ts`.

- **Storage failure hardening and multi-loss repair accounting.** `BlobStore` writes
  blobs and its index through unique temp files and renames, rolls back a new blob when
  the index write fails, and no longer swallows index errors. Durability repair reads
  exactly `k` survivors, stages every replacement before moving the signed placement,
  adopts an already-written shard on retry, and fails loudly on a corrupt survivor. Five
  failure-injection tests cover partial repair writes, tampered shards, crash/restart,
  holder churn with two losses, and disk/index failures; `docs/HARDENING.md` records the
  recovery behavior and the remaining limits (no `fsync`, orphan shards, whole-payload
  memory, possession not retrievability). The repair benchmark now takes `--losses`;
  a 1 GiB `4+2`, two-loss run measured 1.000 GiB read + 0.500 GiB written = 1.500x,
  matching the MDS floor `1 + m/k`.

- **Documentation index.** `docs/README.md` links every document in `docs/` exactly
  once, gives reading orders for app developers, verifier operators, and researchers,
  names the draft or stale documents, and points back to the storage frontier. The root
  README links it.

- **Open Graph image for the landing page.** `site/og.png` (1200×630) carries the
  brand mark, headline, and one-line promise; `site/index.html` now declares
  `og:image`, dimensions, alt text, and a large Twitter card. No build step.

- **Runnable erasure-coding example.** `examples/erasure/main.ts` creates 1 MiB,
  encodes `4+2`, stores all six shards through `BlobStore`, deletes one, and rebuilds
  from the five survivors with digest assertions. Linked from the storage contract.

- **Verifiable fair-launch trajectories.** `GET /v1/launches/:mint/trajectory?chain=`
  groups public `launch.plan` attestations by mint and chain, orders them by block,
  separates policy segments, flags duplicate blocks, and reports safe/unsafe checks and
  anchor coverage. A failed check makes the verdict `not-safe`; the series never claims
  safety past its latest check. `apps/api/src/trajectory.ts`, five tests, docs.

- **Published negative results for both research directions.**
  `bench/storage/NEGATIVE-RESULTS.md` records the held-out Huffman expansion (0.64x,
  14.15 MiB total for 9.00 MiB) and the degree-10 Legendre fidelity failure (2212.70x
  ratio, 19.79 dB, 98.84% differing bytes, no residual). It states the acceptance
  criteria, what would overturn each result, threats to validity, and exact
  reproduction. Roadmap research item checked.

- **A self-hosted pinning service for the content adapter.** `apps/api/src/pin-server.ts`
  accepts a bundle and its CID, recomputes the CID from the bytes, stores them under
  `RAREXT_PIN_DIR`, and serves pin metadata/content over HTTP. The adapter now sends the
  bundle bytes, so the service can verify what it pins. `npm run pin`; RFC 0011; five
  tests covering restart, CID mismatch, HTTP round-trip, adapter integration, and refusal.

- **Data availability sampling for media.** `apps/api/src/das.ts` commits 4 KiB chunks
  as Merkle trees over the shards a placement already proves, samples distinct chunks,
  and verifies each byte and proof. It reports the exact hypergeometric miss bound
  `C(N-a,t)/C(N,t)` and the conservative `(1-f)^t`; for 9,216 photo chunks, 44 samples
  (176 KiB) detect 10% withholding with 99% confidence. A holder route serves one leaf
  and its proof. RFC 0010 states the bound, its assumptions, and its non-claims. Five
  tests.

- **Learned and parametric baselines in the storage benchmark.** `bench/storage/learned.mjs`
  adds an order-1 context Huffman codec whose 256×256 model is stored and counted as the
  decoder, and a tensor-product Legendre fit whose coefficients are the entire artifact.
  Measured on the fixed corpus: adaptive Huffman 2.40x on text and 3.02x on source
  (exact), the same model trained on `source.js` and held out on `text.txt` 0.64x
  (negative cross-slice result), and degree-10 Legendre 2212x stored size at 19.79 dB
  PSNR with 98.84% of bytes differing (negative fidelity result). Decoder bytes are now
  counted for every non-classical row, not only `kind: "learned"`. Three tests.

- **Repair-bandwidth measurement at 1 GB.** `bench/repair` encodes a deterministic
  1 GiB payload with the shipped 4 + 2 code, loses a shard, rebuilds it from four
  survivors, and checks both digests. Measured: 1.000 GiB read, 0.250 GiB written,
  1.250 GiB total for a single loss. The `< 1/k` target in the storage contract is
  arithmetically unreachable for an MDS code; the README states the floor (`1 + 1/k`) and
  what a local-reconstruction code would require instead. This run also exposed and fixed
  a real bug: shard digests converted bytes to a hex string, which throws beyond ~512 MB.
  Large shards now stream into the hash with a distinct domain, so a 1 GiB payload
  encodes, verifies, and repairs.

- **RFC 0009: representation kinds.** Defines `exact`, `bounded`, and `generative`
  artifacts, the signed representation record, the verifier result block, semantics
  declarations, display rules, and the acceptance criterion before a research codec can
  become a protocol claim. Documentation only; no envelope change ships yet.

- **Leaderboard UI and capability-based discovery.** `/leaderboard.html` ranks verified
  builds with app and challenge filters, links each row to its signed envelope, and opens
  an unlisted artifact from an artifact id plus capability token. Filters and capability
  inputs are shareable through the URL. One test covers static serving and the home-page
  link.

- **Key rotation and delegated publishing keys.** A rotation record is signed by the key
  being retired and moves the handle to a new key, optionally changing suite; the old
  key stays resolvable so existing publications and capabilities keep verifying, while a
  new publish signed by it is refused. A delegation record lets the root key authorize a
  second key to publish for the handle, optionally scoped to one app and an expiry;
  delegated publications record both `authorKey` and `delegatedBy`. Rotating the root
  retires outstanding delegations. Snapshot version 2 stores rotation and delegation
  history (migration 1 → 2 adds empty arrays). SDK helpers: `rotateIdentity`,
  `delegations`, `delegateKey`, `rotations`, `keyRotationPayload`, `delegationPayload`.
  RFC 0008 documents the records and their trust boundaries. 6 new tests.

- **The durability ledger.** `apps/api/src/durability.ts` places erasure shards on
  independent holders, refuses co-location, challenges with a nonce-bound Merkle leaf
  proof, audits live holders against a tier (`ephemeral` 1, `pinned` k+1, `durable`
  k+m), and repairs any failed shard from k survivors with read/write accounting. 13
  tests, and `npm run demo:durability` runs the whole sequence: 6/6 live, lose one,
  5/6 under-replicated, repair, 6/6, payload matches.
- **A holder wire protocol.** `apps/api/src/holder-server.ts` stores shard bytes under
  their own digest, answers nonce-bound leaf challenges with a Merkle path, and never
  learns the blob hash. `npm run holder` starts one; `httpHolder()` is the client, so
  placement, challenges, and repair work across processes. Three transport tests run
  eight holders over HTTP, stop one, watch the audit degrade, and repair onto a
  reachable spare.
- **Signed placement records.** `apps/api/src/placements.ts` signs a placement with the
  steward's key, embeds the public key, and chains each repair as a new record
  (`sequence` + `previous`). `POST /v1/placements`,
  `GET /v1/placements/:blobHash`, and `GET /v1/placements/:blobHash/history` expose the
  chain; a file-backed registry verifies records and refuses forks. `RFC 0005`
  documents the protocol and its trust boundaries.
- **Scheduled retention challenges.** `apps/api/src/durability-schedule.ts` challenges
  every placed blob on an interval, records each run, reschedules only after the run
  finishes, and shares an in-flight run between callers. The node enables it from
  `RAREXT_HOLDERS` (`id=url,…`) and `RAREXT_CHALLENGE_INTERVAL_MS`; `GET /v1/durability`
  exposes the schedule and audits, `POST /v1/durability/challenge` runs a pass on demand.
  The ledger is rebuilt from persisted placement records on boot. 7 new tests.
- **Durability on the publication itself.** When an artifact lists blobs, the API attaches
  a `durability` observation to the publication (and to feed/build responses): tier, the
  tier's required count, the live count from the last challenge, `unplaced` /
  `unverified` / `ok` / `under-replicated`, and the `placementDigest` that pins the signed
  record used. It is computed on read, not signed by the author, and reports the weakest
  tier across a manifest. 7 new tests.
- **Storage benchmark harness.** `npm run bench:storage` generates a deterministic,
  hash-locked 99.96 MiB corpus (video, photos, audio, text, source, 3D), runs x265,
  AV1, zstd, and the shipped 4+2 erasure path, and writes a Markdown table with
  stored bytes, exactness against the reference digest, PSNR/byte error for bounded
  rows, verify and decode time. A learned runner must declare its decoder size, which
  is added to the storage cost; a declared-lossless mismatch is downgraded to
  `bounded`. Full run: about 66 s on the reference laptop, under a 15-minute enforced
  budget. See `bench/storage/README.md` and `RESULTS.md`.
- **Trust model RFC.** `rfcs/0007-trust-model.md` states what each claim proves, what the
  registry, an app operator, an independent verifier, a holder, and an anchor can lie
  about, the composition rules a reader should follow, and what Trac anchoring would and
  would not add. Documentation only; no behavior change.
- **Store migrations and verified backups.** Snapshots now carry an enforced version:
  an older snapshot moves through an ordered migration chain, and a newer one is
  refused instead of partially loaded and overwritten. `npm run backup:create`
  bundles every file under the data directory (store, placements, operator records)
  with a digest per file and one over the manifest; `backup:verify` detects a changed
  byte or path, and `backup:restore` refuses a non-empty target without `--force`.
  A corrupt snapshot now stops the boot instead of starting empty. 10 new tests and
  `docs/OPERATIONS.md`.
- **Automatic repair on the schedule.** A scheduled or on-demand challenge run now
  heals `under-replicated` blobs: rebuild from any `k` survivors, place on a spare
  holder, challenge the rebuilt shard again, and report `repairs` (filled, bytes read,
  written) and `repairErrors` (for example, no spare holder). A failed repair is
  recorded and the next tick retries; it never stops the schedule. The node enables
  repair by default; the scheduler class does not. 3 new tests.
- **Independent verifier operators.** A verifier can register a self-signed operator
  record (`POST /v1/verifier-operators`) for one app or `*`, and a publisher can attach
  that operator's signed attestation. The registry accepts it without a local verifier,
  stores the attestation exactly as signed, records `verification: "operator"` plus the
  key id and signature, and `/v1/verify` re-checks it with `recomputed: null`. The
  envelope, bindings, and trust trade are in `RFC 0006`. 4 new tests.

## 0.1.0-alpha.3 — 2026-10-22

### Fixed

- **The mirror verifier hashed pairs by concatenation.** `apps/web/src/verify.ts`
  folded `left + right` instead of hashing the pair, so any publication with more
  than one leaf produced a root that did not match the registry. It now runs the
  same async SHA-256 fold as the canonical `merkle.ts`, on every tree shape.
- **The chain adapter's read-back confirmation silently degraded to `skipped`** for
  blocks with more than one root, because its local `merkleRoot` used the same
  broken fold. The duplicate was deleted and the adapter now imports the shared
  implementation.
- **Capabilities and revocations were verified with ECDSA only.** Both routes now
  use the suite-aware `verifyPayload`, so ML-DSA authors can grant capabilities and
  revoke publications.

### Added

- **Erasure-coded storage.** Systematic Reed–Solomon over GF(256) (`k`-of-`n`), with
  shard digests that bind index, parameters, original length, and payload digest.
  Shards are ordinary content-addressed blobs; any `k` rebuild the file and the
  reconstruction is checked against the committed digest. 14 tests.
- **`docs/PRIOR-ART.md`** — what exists (Arweave, Filecoin, Ordinals, EIP-4844,
  Celestia, IPFS, Automerge, neural representations), what none of it does, and the
  physics we do not claim.
- **`docs/STORAGE-FRONTIER.md`** — the representation research agenda: the three
  legitimate trades, the exactness problem, and falsifiable acceptance criteria.
- **A public landing page** describing web4, the four steps of the protocol, and what
  "free" does and does not mean, plus a contributor path in the README.
- **`docs/WEB4.md`** — the definition of the network these pieces add up to, what
  has to be true for the name to hold, and the primitive that is still missing.

### Removed

- **The CI publish path.** The untracked workflow files and the `publish:ci` script
  are gone. There is no dependency on GitHub Actions or an npm registry: `npm run
  check`, `test:examples`, `verify:packages`, and `test:takedown` run locally, and the
  packed tarballs attach to the release.
- **Internal dependency ranges now move with the version.** `sync-version.mjs`
  rewrites `@rarext/*` ranges and `--check` fails when they drift.

## 0.1.0-alpha.2 — 2026-10-22

The launch and decentralisation work: installable packages, a registry that can be
mirrored and taken down, multi-chain anchoring, a market, and a work economy.

### Added

- **A work economy.** Seven actions with different payouts, a work queue, a portable
  verifier format, signed worker submissions, a credit ledger that never pays twice
  for the same artifact, and a rewards board in the web app.
- **A portable verifier.** The chess rules as a single TypeScript implementation
  served by hash, runnable in a browser and on the server, with the same attestation
  from both. The Python implementation was retired behind generated fixtures.
- **A market for agents, robots, and people.** Participant profiles that say what a
  participant is and what it does not claim, listings checked against a published
  policy that forbids promising a return, and network answers computed as the median
  of independent verified contributions.
- **Quantum-ready signatures.** The suite is pluggable, the platform ships ML-DSA
  natively, every publication and attestation records which suite signed it, and
  the Merkle leaf commits to the crypto profile. The registry publishes its policy
  at /v1/crypto.
- **Multi-chain anchoring with independent read-back confirmation,** including the
  RAREXT chain: a signed, hash-linked log of anchor commitments with inclusion
  proofs.
- **A storage economy.** Content-addressed blobs, proof of possession, open and
  sealed tiers, metered usage, time-locked retention commitments, and CIDv1 pointers.
- **Private publications.** `public`, `unlisted` (verified but unlisted, reachable
  with a signed capability), and `sealed` (the registry holds a commitment and a
  salted proof, never the body).
- **Portable registry bundles and a static mirror,** with a takedown test that stops
  the registry and checks the copy still rebuilds the anchored root.
- **Revocation lists** for capabilities and distrusted verifier hashes, signed and
  published, plus a registry seed list for mirror discovery.
- **Publishable packages,** a release process, conventional commits, a changelog, and
  a publish workflow with npm provenance.
- **Eight languages** in the web app, with a right-to-left Arabic layout.

### Protocol-visible changes

- The Merkle leaf covers the whole publication and its crypto profile. Leaf format
  version 3 adds the profile; anchors made with versions 1 and 2 still verify
  against the roots they were anchored with.
- Publications carry `visibility` and `artifactCommitment`, and attestations carry
  `proofKind`, `signatureAlgorithm`, and `cryptoProfile`.
- The signed payload carries the algorithm, so a signature cannot be reinterpreted
  under a different suite.
- The payload kind is `rarext.publication` v1. Envelopes with the earlier
  `fabric.publication` kind are still accepted.
- Challenges may carry a sample artifact for the work queue.

### Known limitations

- A sealed publication's proof is salted: it cannot be brute-forced and it cannot
  be checked by anyone but the author. A zero-knowledge proof is the real answer
  and is not built.
- Browsers still sign classically. WebCrypto has no post-quantum signature
  algorithm, so browser claims are the quantum-weak spot.
- The registry is a single node. The protocol's state is chain-agnostic and
  content-addressed, but no bundle format keeps a mirror in sync automatically.
- The market has listings but no escrow and no dispute flow. Settlement needs the
  chain, and the chain has no settlement yet.
- There is no npm publication, no hosted instance, and no browser identity
  recovery.

## 0.1.0-alpha.1 — 2026-10-22

First tagged release. The protocol, the registry, the SDK, the MCP server, and four
example apps.

### Added

- **Artifact protocol.** Every app can register a challenge set and a deterministic
  verifier; agents publish artifacts that carry a signed provenance envelope.
- **Verifiable claims.** A claim states its subject, the meaning it is bound to, and
  its proof. Three claim kinds: `satisfies` (recomputable by anyone), `attests`
  (accountable, not machine-checked), `produces`, `derives`.
- **Semantic layer.** A versioned, hash-bound record of what a challenge *means*,
  with a named owner and a pinned spec hash. Drift between a challenge and its
  meaning is reported, not silent.
- **Registry.** Signed identities, publications, a feed with pagination, remix
  lineage, Merkle anchoring with proofs, and source, network, and anchor adapters.
- **Agent surfaces.** `@rarext/agent-sdk` and an MCP server with 25 tools, including
  app and semantics discovery and signed artifact publishing.
- **Eight languages** in the web app, with a right-to-left Arabic layout.
- **Four example apps**: the logic workbench, chess, xiangqi, and Go puzzle apps;
  a fair-launch certifier that checks token launches against a published policy; and
  a storage app that proves custody of content-addressed bytes in an open or sealed
  tier.
- **Content-complete anchoring.** The Merkle leaf covers the whole publication, not
  a summary, so a mirror serving altered content cannot match the anchored root.

### Protocol notes

- The publication envelope kind is `rarex.publication` v1. Envelopes with the
  earlier `fabric.publication` kind are still accepted on publish.
- Anchors record the leaf format version. Anchors made before the content-complete
  leaf (version 1) keep verifying against the root they were anchored with.

### Known limitations

- The trace proof is a deterministic hash and leaks small artifacts by brute force.
  Private artifacts need a salted proof or a zero-knowledge proof; neither is shipped.
- The registry is a single node. The protocol's state is chain-agnostic and
  content-addressed, but no bundle format or mirror build exists yet.
- There is no npm publication, no hosted instance, and no browser identity recovery.
