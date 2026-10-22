import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_SNAPSHOT_VERSION,
  migrateSnapshot,
  type SnapshotMigration,
} from "../src/migrations.ts";
import { RarextStore } from "../src/store.ts";

function migration(
  from: number,
  change: (snapshot: Record<string, unknown>) => Record<string, unknown>,
): SnapshotMigration {
  return {
    from,
    to: from + 1,
    description: `${from}->${from + 1}`,
    migrate: change,
  };
}

test("the current snapshot version loads unchanged", () => {
  const result = migrateSnapshot({ version: CURRENT_SNAPSHOT_VERSION, publications: [] });

  assert.equal(result.from, CURRENT_SNAPSHOT_VERSION);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.snapshot, { version: CURRENT_SNAPSHOT_VERSION, publications: [] });
});

test("a snapshot from a newer build is refused, not partially loaded", () => {
  assert.throws(
    () => migrateSnapshot({ version: CURRENT_SNAPSHOT_VERSION + 1 }),
    /newer than this build/,
  );
  assert.throws(() => migrateSnapshot({}), /version must be a positive integer/);
  assert.throws(() => migrateSnapshot({ version: 0 }), /version must be a positive integer/);
  assert.throws(() => migrateSnapshot({ version: 1.5 }), /version must be a positive integer/);
  assert.throws(() => migrateSnapshot([]), /must be a JSON object/);
  assert.throws(() => migrateSnapshot(null), /must be a JSON object/);
});

test("an older snapshot is moved forward through the chain in order", () => {
  const calls: number[] = [];
  const migrations = [
    migration(1, (snapshot) => {
      calls.push(1);
      return { ...snapshot, addedByOne: true };
    }),
    migration(2, (snapshot) => {
      calls.push(2);
      return { ...snapshot, addedByTwo: true };
    }),
  ];

  const result = migrateSnapshot(
    { version: 1, publications: [], kept: "yes" },
    migrations,
    3,
  );

  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(result.applied, ["1->2", "2->3"]);
  assert.equal(result.snapshot.version, 3);
  assert.equal(result.snapshot.addedByOne, true);
  assert.equal(result.snapshot.addedByTwo, true);
  assert.equal(result.snapshot.kept, "yes");
});

test("a broken migration chain fails loudly", () => {
  assert.throws(
    () => migrateSnapshot({ version: 1 }, [migration(2, (snapshot) => snapshot)], 3),
    /no snapshot migration from version 1/,
  );
  assert.throws(
    () => migrateSnapshot({ version: 1 }, [migration(1, (snapshot) => snapshot)], 3),
    /no snapshot migration from version 2/,
  );
  assert.throws(
    () =>
      migrateSnapshot(
        { version: 1 },
        [
          migration(1, (snapshot) => snapshot),
          migration(1, (snapshot) => snapshot),
        ],
        2,
      ),
    /duplicate snapshot migration/,
  );
  assert.throws(
    () =>
      migrateSnapshot(
        { version: 1 },
        [{ from: 1, to: 3, description: "skip", migrate: (snapshot) => snapshot }],
        3,
      ),
    /must advance one version/,
  );
});

test("the store refuses a corrupt or newer snapshot instead of starting empty", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-migrations-"));
  const file = join(root, "rarext.json");

  try {
    writeFileSync(file, JSON.stringify({ version: CURRENT_SNAPSHOT_VERSION, publications: [] }));
    assert.doesNotThrow(() => new RarextStore(file));

    writeFileSync(file, JSON.stringify({ version: CURRENT_SNAPSHOT_VERSION + 1, publications: [] }));
    assert.throws(() => new RarextStore(file), /newer than this build/);

    writeFileSync(file, "{not json");
    assert.throws(() => new RarextStore(file), /could not load/);

    writeFileSync(file, JSON.stringify({ version: 1, publications: "nope" }));
    assert.throws(() => new RarextStore(file), /publications must be an array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
