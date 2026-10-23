# RFC 0017: Game-native state migration — preservation, cold cutover, and the no-op fallback

- **Status:** Deferred (migration skeleton)
- **Author(s):** RAREXT Protocol Working Group
- **Created:** 2026-10-23
- **Requires:** [RFC 0016](0016-appchain-evaluation.md), [RFC 0001](0001-trac-integration.md)
- **Related:** [`docs/CHAINS.md`](../docs/CHAINS.md), [`docs/OPERATIONS.md`](../docs/OPERATIONS.md)

## Summary

RAREXT has not accepted an appchain, and the EVM anchor adapter is an anchored
transport: it is designed to commit a Merkle root and record receipts, not
game-native state. The contract is not deployed or audited. The durable game state
is still the registry snapshot (`rarext.json`, version 2), plus external challenge
configuration. Profiles, leaderboards, lineage, and earnings are derived views.

This RFC defines what must survive an eventual move to a consensus-owned state
machine, what is missing before that move can be designed, and how a cold cutover
would work. It also ships the only executable artifact that is honest today: a
**no-op preservation plan** that inventories the snapshot, preserves every
durable record and extension field, records digests, exports challenges, and
refuses to cut over. The plan is always `status: "deferred"` and the fallback is
to keep serving from the existing registry.

The remaining gate is not the script. It is an accepted target schema for active
builds, challenges, reputation, and ratings.

## Motivation

The v3 roadmap asks for a migration plan before a network can own game state. That
plan cannot be a table of SQL column mappings yet, because three of the four named
state classes are not codified:

| Claimed state | What exists today | Durable? |
| --- | --- | --- |
| Active builds | `Publication` records; feed, `BuildSummary`, lineage, and leaderboard are derived | Publication records yes; an active/closed/archived lifecycle no |
| Challenges | Code seed tasks, `RAREXT_CHALLENGES`, and an in-memory sponsored registry | Only the configured environment source is durable outside the process |
| Reputations | `Profile` counters rebuilt from publications and identities; no score | Derived, not stored |
| Ratings | No rating, match, or tournament record | No |

Writing a migration that invents those schemas would create a target that has never
been reviewed, tested, or accepted. The safer deliverable is a preservation
contract and a cold-cutover runbook that can be exercised when the target schema
exists.

## Guide-level explanation

A migration has three separate jobs:

1. **Preserve the source.** Every signed publication, identity, key rotation,
   delegation, revocation, identity link, anchor receipt, and credit record must
   survive without being re-signed or normalized. Unknown extension fields must
   survive too.
2. **Export what is not in the snapshot.** Challenges are configuration and
   in-memory state. Sponsored challenges are lost on restart, so they must be
   exported before the old process stops.
3. **Switch writers once.** The first cutover is cold: stop the old registry,
   verify a backup, import into a target, compare outputs, then move clients. There
   is no dual-write in the first release because the two stores have no shared
   ordering or conflict resolution.

None of that means the old data is on a chain today. `rarext.json` remains the
source of truth until a future RFC accepts a target and its gate. The EVM anchor
records are evidence of publication roots, not a state export.

## Reference-level design

### Durable snapshot v2 records

These are the fields in `apps/api/src/store.ts` and the core types. A migration
must preserve **all present fields**, including fields marked optional and any
unknown extension fields. It must not apply store defaults during export.

#### `publications`

Build records and their evidence:

- `id`, `author`, `authorKey`, `delegatedBy`
- `signatureAlgorithm`, `title`, `body`, `app`, `challengeId`
- `artifact`: `app`, `kind`, `version`, `mediaType`, `body`
- `taskId`, `circuit` (`components[]` with `id`, `type`, `inputs`)
- `visibility`, `artifactCommitment`, `parentId`
- `source`: `kind`, `repo`, `url`, `ref`, `path`, `commit`, `license`
- `createdAt`, `attestedAt`, `verified`, `signature`, `nonce`
- `attestation`: `id`, `verifier`, `app`, `challengeId`, `taskId`,
  `circuitHash`, `traceHash`, `correct`, `score`, `gateCount`, `semanticsId`,
  `semanticsVersion`, `semanticsHash`, `claimKind`, `scope`, `verifierHash`,
  `proofKind`, `signatureAlgorithm`, `cryptoProfile`, `createdAt`
- `verification`, `attestationKeyId`, `attestationSignature`
- `durability`: `policy`, `source`, `tier`, `required`, `live`, `status`,
  `observedAt`, `windowMs`, and `blobs[]` with `hash`, `tier`, `required`, `live`,
  `status`, `sequence`, `placementDigest`

`Publication` is append-only build history. It is not an active-build lease, a
session, or a tournament entry.

#### `identities`

- `handle`, `keyId`, `algorithm`, `publicKey`, `createdAt`

The handle is registry-scoped today. It is not a RESET account name and there is no
portable handle registry in the pinned RESET surface.

#### `anchors`

- `id`, `root`, `publicationIds`, `leafCount`, `leafVersion`, `createdAt`
- `adapter`, `reference`
- `receipts[]`: `adapter`, `status`, `reference`, optional `error`, and for chain
  receipts `chain`, `family`, `height`, `hash`, `confirmed`

Anchors prove that a batch existed at a point in time. They are not a backup of
the publication bodies and do not contain challenge, profile, or rating state.

#### `identityLinks`

- `id`, `handle`, `network`, `externalId`, `proofUrl`, `verified`, `createdAt`

#### `revocations`

- `id`, `kind` (`capability`, `verifier`, or `artifact`), `target`, `reason`,
  `issuer`, `issuedAt`

#### `credits`

- `keyId`, `action`, `bounty`, `challengeId`, `artifactHash`, `at`

The ledger is per credited key and deduplicated by artifact hash. Migrating it
must not mint a second credit for the same work.

#### `rotations`

- `kind`, `version`, `handle`, `fromKeyId`, `fromPublicKey`, `fromAlgorithm`,
  `toKeyId`, `toPublicKey`, `toAlgorithm`, `createdAt`, `nonce`, `signature`

Retired keys are reconstructed from rotations. A migration that drops the
`fromPublicKey` cannot verify old publications or rebuild that archive.

#### `delegations`

- `kind`, `version`, `handle`, `rootKeyId`, `delegateKeyId`, `delegatePublicKey`,
  `algorithm`, `scopes`, `app`, `createdAt`, `expiresAt`, `nonce`, `signature`

#### Unknown fields

Snapshot v2 is not a closed schema. The current loader ignores top-level fields it
does not know and preserves them when it next writes. The preservation plan lists
those fields in `unmanagedTopLevelFields` and keeps the whole migrated snapshot in
the bundle. A future target may reject an extension field, but it must do so
explicitly; silent dropping is not allowed.

### External challenge records

Challenges are not in snapshot v2. The fields are:

- `id`, `app`, `title`, `description`, `version`
- `spec`
- `sampleArtifact`: `app`, `kind`, `version`, `mediaType`, `body`
- `semanticsId`, `semanticsVersion`, `createdAt`
- `status` (`seed`, `configured`, or `sponsored`)
- `sponsor`

The API's `GET /v1/challenges` response also adds `semanticsBinding`,
`semanticsHash`, and `semanticsOrigin`. Those computed fields are preserved in the
export rather than recomputed by the plan.

`GET /v1/challenges` can export the live registry. `RAREXT_CHALLENGES` is the
configured durable source. The sponsored registry is **in memory**, so sponsored
challenges disappear when the old process stops. They must be exported before
shutdown. The plan accepts an optional challenge file and preserves every record
verbatim; it does not normalize defaults or re-sign anything.

### Derived state

The migration does not treat these as canonical records:

| Derived view | Fields | Source |
| --- | --- | --- |
| Profile | `handle`, `verified`, `publications`, `attestations`, `bestScore`, `totalScore`, `createdAt`, `lastPublishedAt` | Publications and identities |
| Leaderboard | `rank`, `buildId`, `author`, `app`, `challengeId`, `score`, `gateCount`, `createdAt` | Publications |
| Lineage | `build`, `ancestors`, `descendants` | `Publication.parentId` |
| Earnings | `keyId`, `credits`, `byAction`, `jobs` | Credit records |

The profile is a counter cache. [`docs/MARKET.md`](../docs/MARKET.md) says there is
no reputation score; reputation is the set of verified things a key has published.
A future reputation system must define its evidence, decay, dispute rules, and
portability. Recomputing today's counters in a new verifier version and calling
that reputation migration would change meaning without a decision.

### Migration plan artifact

`apps/api/src/game-state-migration.ts` builds this artifact; `npm run
plan:game-state` exposes it:

```json
{
  "kind": "rarext.game-state-migration",
  "version": 1,
  "status": "deferred",
  "mode": "no-op",
  "source": ".data/rarext.json",
  "generatedAt": "2026-10-23T12:00:00.000Z",
  "sourceVersion": 2,
  "snapshotVersion": 2,
  "appliedMigrations": [],
  "sourceDigest": "sha256 of canonical migrated snapshot",
  "target": null,
  "collections": [
    {
      "name": "publications",
      "required": true,
      "count": 1,
      "fields": ["...union of record keys..."],
      "digest": "sha256 of canonical records",
      "description": "..."
    }
  ],
  "derived": ["..."],
  "external": {
    "challenges": {
      "captured": true,
      "source": "challenge-export.json",
      "count": 1,
      "fields": ["..."],
      "digest": "sha256 of canonical records",
      "note": "..."
    }
  },
  "unmanagedTopLevelFields": ["..."],
  "gaps": ["..."],
  "checklist": ["..."],
  "fallback": {
    "action": "no-op",
    "sourceMutated": false,
    "targetWritten": false,
    "note": "..."
  }
}
```

`--bundle` additionally writes the exact migrated snapshot and challenge records.
That file is a preservation artifact for a future target, not a target schema and
not a cutover.

The plan is deterministic for a fixed snapshot, timestamp, and challenge export.
It applies existing snapshot migrations in memory so older snapshots can be
inventoried, but it does not write the source file.

### Migration invariants

A target implementation must hold all of these:

1. **Signatures remain verifiable.** Preserve publication bytes, signature suite,
   key ids, nonces, rotations, delegations, and revocations. Do not canonicalize a
   signed payload into a target-specific encoding without a new signature scheme.
2. **Scores are copied, not recomputed.** `attestation.score`, `gateCount`,
   `semanticsHash`, and `verifierHash` record the verifier that made the claim.
   A new verifier version is new evidence, not a replacement.
3. **Profiles are rebuilt from preserved evidence.** If the target stores a
   profile for query speed, it must be reproducible from the migrated records.
4. **Credits are idempotent.** The same `artifactHash`, `action`, and key must not
   be paid twice during retries or replay.
5. **Anchors are not rewritten.** Keep old roots, receipts, heights, chain ids, and
   confirmation state. A new chain may add anchors; it must not relabel an old
   receipt as a different chain's proof.
6. **Handles and links are not silently remapped.** A handle collision policy must
   be published before accepting target writes.
7. **Unknown fields fail loudly or survive.** The target must not discard source
   fields merely because its current type does not mention them.
8. **The source stays read-only after cutover.** It is the rollback and audit copy
   until the target has a verified retention story.

### Cold-cutover runbook

The script does not perform this runbook. It is the checklist that a future RFC
must execute after the target schema is accepted.

#### Preconditions

- RFC 0016's decision gate has held for 90 consecutive days.
- A follow-up appchain RFC is accepted with a versioned target schema for all four
  state classes.
- The target has a staging environment and an independent finality/reorg policy.
- The operator has a maintenance window longer than a full export, compare, and
  smoke test. There is no dual-write.

#### Freeze and export

1. Record the source commit, snapshot version, start time, and maintenance owner.
2. While the old API is still live, export the challenge registry:
   `curl -fsS http://127.0.0.1:8787/v1/challenges > challenge-export.json`.
3. Put the API and every other writer behind maintenance. Stop writers; holders
   and storage services can stay online.
4. Create and verify a backup:

   ```bash
   npm run backup:create -- --data .data --out backups/pre-migration.json.gz
   npm run backup:verify -- --file backups/pre-migration.json.gz
   ```

5. Build the preservation plan and bundle:

   ```bash
   npm run plan:game-state -- \
     --source .data/rarext.json \
     --challenges challenge-export.json \
     --out migration-plan.json \
     --bundle migration-bundle.json
   ```

6. Record `sourceDigest`, every collection count/digest, the challenge digest, and
   the source snapshot version. Confirm the plan says `status: "deferred"` and
   `sourceMutated: false`; that is expected until a target importer exists.

#### Rehearse and compare

7. Restore the backup into a fresh directory. Import the bundle into a staging
   target using the future importer. The importer must consume the bundle without
   reading or writing the live `.data/rarext.json`.
8. Compare counts and digests for every durable collection. Compare the challenge
   export. Re-verify publication, rotation, delegation, and revocation signatures
   in the target.
9. Compare feed, profile, leaderboard, lineage, and earnings responses between the
   old registry and the target. Where they differ, stop; do not "fix" the target by
   recomputing old evidence.
10. Rehearse rollback before accepting writes: stop the target, restore the
    verified backup to a fresh source directory, start the old API against it, and
    confirm the same outputs.

#### Cutover and rollback

11. Keep the source snapshot and backup read-only. Start the target, move clients
    to it, and only then allow new writes to the target.
12. Rollback is safe **only before the target accepts new writes**. After that,
    the target has records the source does not; a rollback needs a reconciliation
    log and is a second migration. Do not promise a lossless rollback after
    writes resume.

### Inherited RESET/trac-peer blockers

RFC 0016 pins `Trac-Systems/reset` at
`6f432e4391893e859bd100ba395f2fe70cd73aba` and `trac-peer` `2e6f458` (0.4.11).
Those constraints do not disappear because the target is called a migration:

- **No anchor slot.** The move envelope is exactly `{v,t,b,h,p,w}`, `t` is one of
  seven move types, and each payload has a fixed shape. There is no memo.
  Contract transactions accept only `transfer`, `gw_set`, and `params_set`.
  Directly extending RESET for an anchor or game-state move is a hard fork of a
  live coin contract, not a RAREXT schema change.
- **Small message budget.** Messages are capped at 8 KiB and transactions at 4 KiB,
  with 600 moves per height and 6 per address in the reference rules. Full
  publication bodies, durability observations, or challenge specs cannot be
  presumed on-chain. The target must decide what is committed and what remains
  content-addressed.
- **Identity mismatch.** RESET identity is a 64-hex Ed25519 address with a
  `trac1…` alias; RAREXT handles are registry records over P-256 or ML-DSA keys.
  There is no portable handle registry in the pinned tree. Identity migration is
  its own RFC, not a free side effect of state migration.
- **Finality is not inherited.** RESET gateway transfers may wait up to six hours,
  accepted submissions are not final, and Bitcoin headers are counted six deep.
  A cutover must define which receipt is final enough to stop the old writer.
- **The seam is `apps/chain`, not a RESET patch.** RFC 0016's recommended path is
  to keep the `/chain/*` interface and let a consensus implementation replace its
  internals. The EVM adapter stays a read-back transport for anchor receipts.
- **EVM is not a state oracle.** The EVM contract is designed to store roots and
  metadata, not publications, identities, challenges, or credits. It is not deployed
  or audited, and it cannot populate a new target by itself.

### Why the plan is deferred

`GAME_STATE_GAPS` records five blocking gaps:

- `active-builds`: no persisted lifecycle state;
- `challenges`: no durable challenge collection in snapshot v2;
- `reputation`: only derived counters, with no reputation score;
- `ratings`: no records at all;
- `target-schema`: no accepted appchain state model.

The script therefore has no importer, no target writer, and no execute path. Any
attempt to run `--execute` or `--cutover` fails with a message pointing back to
this RFC. The safe fallback is to discard the plan and keep the source registry
serving exactly as it did before.

## Alternatives considered

### No migration now (recommended)

Keep the snapshot as the source of truth and anchors as transports. This is the
current RFC 0016 decision. It is reversible, cheap, and does not invent a schema.
Rejected only when the appchain gate and a target schema are both accepted.

### Treat the EVM anchor as the migration

Rejected. The EVM adapter stores a root, metadata hash, publisher, timestamp, and
receipts. It does not store publications, challenges, identities, profiles, or
credits. A root proves inclusion only when the reader already has the leaves.

### Dual-write during a transition

Rejected for the first cutover. There is no shared ordering, no conflict rule, and
no replay format between the registry and a future chain. Dual-write would turn a
migration bug into permanent divergence. Revisit only with a signed write log and
a reconciliation design.

### Recompute profiles and scores in the target

Rejected. It changes evidence semantics and lets a newer verifier rewrite history.
Profiles may be rebuilt from preserved records; attestation scores are copied.

### Migrate lazily, reading the old registry from the target

Rejected as the primary path. It makes the old operator a permanent dependency and
does not give the target a self-contained state. A read-only archive after cutover
is supported as the rollback copy, not as the target's state model.

### Fork RESET to carry game state

Rejected by RFC 0016. It is a hard fork of a live coin contract, identity remains
RESET's address, and every indexer and client must change. RAREXT controlling its
own schema is the only reason an appchain could work.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Old signatures stop verifying after re-encoding | Preserve signed payloads and suites; verify in staging before cutover |
| Lost in-memory sponsored challenges | Export `GET /v1/challenges` before shutdown; keep `RAREXT_CHALLENGES` |
| Profiles or scores change meaning | Rebuild counters only; copy attestation scores; publish reputation semantics first |
| Duplicate credits after replay | Deduplicate by key, action, challenge, and artifact hash; test retries |
| Dual-write divergence | Cold cutover; no dual-write in the first release |
| Target cannot hold full records within RESET limits | Decide commitments vs content-addressed bodies before schema acceptance |
| Identity or handle collision | Publish a collision and recovery policy before accepting writes |
| Reorg invalidates a target receipt | Define finality; retain old receipts and re-anchor only after finality |
| Extension fields silently dropped | Inventory `unmanagedTopLevelFields`; fail loudly in the target importer |
| Rollback after new writes loses records | Mark rollback safe only before the target accepts writes |
| Snapshot or backup corruption | `backup:create` + `backup:verify`; restore into a fresh directory |
| Operator downtime or partial export | Maintenance window; compare counts and digests; stage the full rehearsal |

## Migration and compatibility

Nothing moves under this RFC. Anchors, receipts, identities, handles, storage
records, and the snapshot format remain valid; RFC 0016 already establishes that
there is no migration while the appchain is deferred. The new plan command reads a
snapshot and writes only a plan or bundle, never the source.

If a future target is accepted, compatibility requires preserving every field
listed above, including unknown extension fields, and preserving verifier evidence
rather than regenerating it. The target may store commitments instead of full
bodies only if it also preserves a retrievable content-addressed copy and says so
in its own RFC.

## Open questions

1. What target fields represent an active, completed, or abandoned build, and who
   is allowed to change that status?
2. Are challenges ordered state, content-addressed configuration, or both? How are
   sponsored challenges made durable before the cutover?
3. What is reputation: a set of signed claims, a numeric score, or a tournament
   rating? What evidence, decay, and dispute rules apply?
4. What is a rating? Is it a match result, a verifier score, a human review, or a
   separate tournament record?
5. Does canonical identity become a chain account, or a RAREXT key with on-chain
   pointers to a handle and delegation records?
6. Which records fit in a RESET-style move and which stay content-addressed under
   the 8 KiB/4 KiB limits?
7. What finality rule lets the old writer stop without risking a reorg that
   invalidates a migrated anchor?
8. Does an audited EVM anchor contract plus an append-only log make the appchain
   unnecessary for another cycle?

## Decision

**Deferred.** Do not migrate game-native state. Keep the snapshot as the source of
truth and treat the EVM adapter as an anchored transport. The preservation plan
and cold-cutover runbook are accepted as scaffolding only.

This RFC may move to Proposed when:

- RFC 0016's decision gate has held for 90 consecutive days and governance accepts
  a follow-up appchain RFC;
- the active-build, challenge, reputation, and rating schemas are published and
  reviewed;
- the target's identity, finality, and data-budget rules are accepted;
- a staging importer preserves every durable field and every signature; and
- the cold-cutover and rollback rehearsal passes without recomputing evidence.

Until then, the correct fallback is the no-op plan: leave the data where it is,
flag the migration as deferred, and keep the registry serving.
