import assert from "node:assert/strict";
import test from "node:test";

import {
  DURABLE_GAME_STATE_COLLECTIONS,
  buildGameStateMigrationBundle,
  buildGameStateMigrationPlan,
  gameStateChallengeFields,
  type GameStateMigrationBundle,
} from "../src/game-state-migration.ts";

const NOW = "2026-10-23T12:00:00.000Z";

const publication = {
  id: "publication-1",
  author: "alice",
  authorKey: "key-1",
  delegatedBy: null,
  signatureAlgorithm: "ecdsa-p256",
  title: "Half adder",
  body: "a build",
  app: "logic",
  challengeId: "half-adder",
  artifact: {
    app: "logic",
    kind: "logic.netlist",
    version: 1,
    mediaType: "application/json",
    body: { components: [] },
  },
  taskId: "half-adder",
  circuit: { components: [{ id: "sum", type: "OUTPUT", inputs: ["a"] }] },
  visibility: "public",
  artifactCommitment: "sha256:artifact",
  parentId: null,
  source: {
    kind: "github",
    repo: "alice/half-adder",
    url: "https://github.com/alice/half-adder",
    ref: "main",
    path: "adder.json",
    commit: "abc123",
    license: "MIT",
  },
  createdAt: "2026-10-20T00:00:00.000Z",
  attestedAt: "2026-10-20T00:00:01.000Z",
  verified: true,
  signature: "publication-signature",
  nonce: "nonce-1",
  attestation: {
    id: "attestation-1",
    verifier: "builtin",
    app: "logic",
    challengeId: "half-adder",
    taskId: "half-adder",
    circuitHash: "sha256:circuit",
    traceHash: "sha256:trace",
    correct: true,
    score: 88,
    gateCount: 9,
    semanticsId: "logic/half-adder",
    semanticsVersion: 1,
    semanticsHash: "sha256:semantics",
    claimKind: "satisfies",
    scope: { mint: "mint-1" },
    verifierHash: "sha256:verifier",
    proofKind: "recomputable",
    signatureAlgorithm: "ecdsa-p256",
    cryptoProfile: "classical",
    createdAt: "2026-10-20T00:00:01.000Z",
  },
  verification: "recomputed",
  attestationKeyId: "key-2",
  attestationSignature: "attestation-signature",
  durability: {
    policy: "durability-v1",
    source: "registry-observation",
    tier: "durable",
    required: 4,
    live: 5,
    status: "ok",
    observedAt: "2026-10-21T00:00:00.000Z",
    windowMs: 60000,
    blobs: [
      {
        hash: "blob-1",
        tier: "durable",
        required: 4,
        live: 5,
        status: "ok",
        sequence: 7,
        placementDigest: "sha256:placement",
      },
    ],
  },
  extensionField: "keep-publication",
};

const identity = {
  handle: "alice",
  keyId: "key-1",
  algorithm: "ecdsa-p256",
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  createdAt: "2026-10-19T00:00:00.000Z",
  extensionField: "keep-identity",
};

const anchor = {
  id: "anchor-1",
  root: "root-1",
  publicationIds: ["publication-1"],
  leafCount: 1,
  leafVersion: 1,
  createdAt: "2026-10-20T01:00:00.000Z",
  adapter: "evm",
  reference: "42",
  receipts: [
    {
      adapter: "evm",
      status: "ok",
      reference: "42",
      chain: "anvil",
      family: "evm",
      height: 42,
      hash: "0xabc",
      confirmed: true,
      extensionField: "keep-receipt",
    },
  ],
  extensionField: "keep-anchor",
};

const identityLink = {
  id: "link-1",
  handle: "alice",
  network: "trac",
  externalId: "trac-1",
  proofUrl: "https://example.test/proof",
  verified: true,
  createdAt: "2026-10-19T01:00:00.000Z",
  extensionField: "keep-link",
};

const revocation = {
  id: "revocation-1",
  kind: "verifier",
  target: "sha256:verifier",
  reason: "superseded",
  issuer: "alice",
  issuedAt: "2026-10-22T00:00:00.000Z",
  extensionField: "keep-revocation",
};

const credit = {
  keyId: "key-1",
  action: "verify",
  bounty: 10,
  challengeId: "half-adder",
  artifactHash: "sha256:artifact",
  at: "2026-10-20T00:00:02.000Z",
  extensionField: "keep-credit",
};

const rotation = {
  kind: "rarext.key-rotation",
  version: 1,
  handle: "alice",
  fromKeyId: "key-0",
  fromPublicKey: { kty: "EC", crv: "P-256", x: "old-x", y: "old-y" },
  fromAlgorithm: "ecdsa-p256",
  toKeyId: "key-1",
  toPublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  toAlgorithm: "ecdsa-p256",
  createdAt: "2026-10-19T00:00:00.000Z",
  nonce: "rotation-nonce",
  signature: "rotation-signature",
  extensionField: "keep-rotation",
};

const delegation = {
  kind: "rarext.delegation",
  version: 1,
  handle: "alice",
  rootKeyId: "key-1",
  delegateKeyId: "delegate-1",
  delegatePublicKey: { kty: "EC", crv: "P-256", x: "delegate-x", y: "delegate-y" },
  algorithm: "ecdsa-p256",
  scopes: ["publish"],
  app: "logic",
  createdAt: "2026-10-19T00:00:00.000Z",
  expiresAt: "2027-10-19T00:00:00.000Z",
  nonce: "delegation-nonce",
  signature: "delegation-signature",
  extensionField: "keep-delegation",
};

const challenge = {
  id: "half-adder",
  app: "logic",
  title: "Half adder",
  description: "Build a half adder",
  version: 2,
  spec: { cases: [] },
  sampleArtifact: {
    app: "logic",
    kind: "logic.netlist",
    version: 1,
    mediaType: "application/json",
    body: { components: [] },
  },
  semanticsId: "logic/half-adder",
  semanticsVersion: 2,
  createdAt: "2026-10-18T00:00:00.000Z",
  status: "sponsored",
  sponsor: "alice",
  extensionField: "keep-challenge",
};

const snapshot = {
  version: 3,
  publications: [publication],
  identities: [identity],
  anchors: [anchor],
  identityLinks: [identityLink],
  revocations: [revocation],
  credits: [credit],
  rotations: [rotation],
  delegations: [delegation],
  extensionTopLevel: { reputation: "not-codified" },
};

function bundleFor(): GameStateMigrationBundle {
  return buildGameStateMigrationBundle(snapshot, {
    source: ".data/rarext.json",
    generatedAt: NOW,
    challenges: { challenges: [challenge] },
    challengeSource: "challenge-export.json",
  });
}

test("the migration plan is a deferred no-op with deterministic digests", () => {
  const before = JSON.stringify(snapshot);
  const plan = buildGameStateMigrationPlan(snapshot, {
    source: ".data/rarext.json",
    generatedAt: NOW,
    challenges: { challenges: [challenge] },
    challengeSource: "challenge-export.json",
  });
  const repeat = buildGameStateMigrationPlan(structuredClone(snapshot), {
    source: ".data/rarext.json",
    generatedAt: NOW,
    challenges: { challenges: [challenge] },
    challengeSource: "challenge-export.json",
  });

  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(plan.kind, "rarext.game-state-migration");
  assert.equal(plan.version, 1);
  assert.equal(plan.status, "deferred");
  assert.equal(plan.mode, "no-op");
  assert.equal(plan.target, null);
  assert.equal(plan.sourceVersion, 3);
  assert.equal(plan.snapshotVersion, 3);
  assert.deepEqual(plan.appliedMigrations, []);
  assert.equal(plan.fallback.sourceMutated, false);
  assert.equal(plan.fallback.targetWritten, false);
  assert.match(plan.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.sourceDigest, repeat.sourceDigest);
  assert.deepEqual(plan.collections, repeat.collections);
  assert.equal(plan.generatedAt, NOW);
});

test("every durable collection and record field is retained", () => {
  const bundle = bundleFor();
  const collections = new Map(bundle.collections.map((item) => [item.name, item]));

  assert.deepEqual(
    bundle.collections.map((item) => item.name),
    [...DURABLE_GAME_STATE_COLLECTIONS],
  );

  for (const name of DURABLE_GAME_STATE_COLLECTIONS) {
    const source = (snapshot as Record<string, unknown>)[name] as unknown[];
    assert.deepEqual(bundle.snapshot[name], source, `${name} records changed`);
    assert.equal(collections.get(name)?.count, source.length);
    const fields = collections.get(name)?.fields ?? [];
    for (const key of Object.keys(source[0] as Record<string, unknown>)) {
      assert.ok(fields.includes(key), `${name}.${key} is missing from the field inventory`);
    }
  }

  assert.deepEqual(bundle.snapshot["extensionTopLevel"], {
    reputation: "not-codified",
  });
  assert.ok(bundle.unmanagedTopLevelFields.includes("extensionTopLevel"));
  assert.equal(
    (bundle.snapshot.publications as Record<string, unknown>[])[0].extensionField,
    "keep-publication",
  );
  assert.equal(
    ((bundle.snapshot.publications as Record<string, unknown>[])[0].attestation as Record<
      string,
      unknown
    >).proofKind,
    "recomputable",
  );
});

test("the challenge export is preserved without normalization", () => {
  const bundle = bundleFor();
  const challengePlan = bundle.external.challenges;

  assert.equal(challengePlan.captured, true);
  assert.equal(challengePlan.count, 1);
  assert.equal(challengePlan.source, "challenge-export.json");
  assert.match(challengePlan.digest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(bundle.challenges, [challenge]);

  for (const field of gameStateChallengeFields()) {
    assert.ok(challengePlan.fields.includes(field), `challenge.${field} is not inventoried`);
  }
});

test("a missing challenge export is explicit, not silently empty", () => {
  const bundle = buildGameStateMigrationBundle(snapshot, { generatedAt: NOW });

  assert.equal(bundle.external.challenges.captured, false);
  assert.equal(bundle.external.challenges.count, 0);
  assert.equal(bundle.external.challenges.digest, null);
  assert.equal(bundle.challenges, null);
  assert.ok(bundle.gaps.some((gap) => gap.id === "challenges"));
});

test("the plan names every uncodified game-native state gap", () => {
  const plan = buildGameStateMigrationPlan(snapshot, { generatedAt: NOW });
  const gapIds = plan.gaps.map((gap) => gap.id);

  assert.deepEqual(gapIds, [
    "active-builds",
    "challenges",
    "reputation",
    "ratings",
    "target-schema",
  ]);
  assert.ok(plan.gaps.every((gap) => gap.blocking));
  assert.ok(plan.checklist.some((item) => item.includes("GET /v1/challenges")));
  assert.ok(plan.derived.some((item) => item.name === "profiles"));
  assert.ok(
    plan.derived.some(
      (item) => item.name === "profiles" && item.fields.includes("totalScore"),
    ),
  );
});

test("an older snapshot is advanced in memory while its records survive", () => {
  const old = {
    version: 1,
    publications: [publication],
    identities: [identity],
    anchors: [anchor],
    kept: "yes",
  };
  const bundle = buildGameStateMigrationBundle(old, { generatedAt: NOW });

  assert.equal(bundle.sourceVersion, 1);
  assert.equal(bundle.snapshotVersion, 3);
  assert.deepEqual(bundle.appliedMigrations, [
    "add key rotations and delegated publishing keys",
    "add durable challenge storage",
  ]);
  assert.deepEqual(bundle.snapshot.publications, [publication]);
  assert.deepEqual(bundle.snapshot.identities, [identity]);
  assert.deepEqual(bundle.snapshot.rotations, []);
  assert.deepEqual(bundle.snapshot.delegations, []);
  assert.deepEqual(bundle.snapshot.challenges, []);
  assert.equal(bundle.snapshot.kept, "yes");
});

test("malformed and newer snapshots are refused", () => {
  assert.throws(
    () => buildGameStateMigrationPlan({ version: 4, publications: [] }),
    /newer than this build/,
  );
  assert.throws(
    () => buildGameStateMigrationPlan({ version: 2 }),
    /publications must be an array/,
  );
  assert.throws(
    () => buildGameStateMigrationPlan({ version: 2, publications: {} }),
    /publications must be an array/,
  );
  assert.throws(
    () =>
      buildGameStateMigrationPlan({
        version: 2,
        publications: [],
        identities: [null],
      }),
    /identities\[0\] must be an object/,
  );
  assert.throws(
    () =>
      buildGameStateMigrationPlan(
        { version: 2, publications: [] },
        { challenges: { notChallenges: [] } },
      ),
    /challenges must be an array/,
  );
  assert.throws(
    () =>
      buildGameStateMigrationPlan(
        { version: 2, publications: [] },
        {
          challenges: [
            {
              id: "bad",
              app: "logic",
              title: "Bad",
              description: "Bad",
              status: "unknown",
            },
          ],
        },
      ),
    /invalid status/,
  );
});
