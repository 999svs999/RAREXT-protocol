/**
 * Snapshot migrations.
 *
 * The store is a single JSON snapshot. Every snapshot names its `version`. Loading
 * is allowed to move an older snapshot forward through an ordered migration chain,
 * and must refuse a snapshot written by a newer build — silently starting from an
 * empty store and then overwriting the file is how a registry loses its history.
 */

export const CURRENT_SNAPSHOT_VERSION = 8;

export interface SnapshotMigration {
  from: number;
  to: number;
  description: string;
  migrate(snapshot: Record<string, unknown>): Record<string, unknown>;
}

export const snapshotMigrations: SnapshotMigration[] = [
  {
    from: 1,
    to: 2,
    description: "add key rotations and delegated publishing keys",
    migrate(snapshot) {
      return {
        ...snapshot,
        rotations: Array.isArray(snapshot.rotations) ? snapshot.rotations : [],
        delegations: Array.isArray(snapshot.delegations) ? snapshot.delegations : [],
      };
    },
  },
  {
    from: 2,
    to: 3,
    description: "add durable challenge storage and sponsor nonce tracking",
    migrate(snapshot) {
      return {
        ...snapshot,
        challenges: Array.isArray(snapshot.challenges) ? snapshot.challenges : [],
        sponsorNonces: Array.isArray(snapshot.sponsorNonces) ? snapshot.sponsorNonces : [],
      };
    },
  },
  {
    from: 3,
    to: 4,
    description: "add governance proposals and their votes",
    migrate(snapshot) {
      return {
        ...snapshot,
        proposals: Array.isArray(snapshot.proposals) ? snapshot.proposals : [],
        governanceVotes: Array.isArray(snapshot.governanceVotes) ? snapshot.governanceVotes : [],
      };
    },
  },
  {
    from: 4,
    to: 5,
    description: "add vote sponsorships, so a payer is visible in the record",
    migrate(snapshot) {
      return {
        ...snapshot,
        voteSponsorships: Array.isArray(snapshot.voteSponsorships) ? snapshot.voteSponsorships : [],
      };
    },
  },
  {
    from: 5,
    to: 6,
    description: "add governance budgets, so a pledge outlives the request that made it",
    migrate(snapshot) {
      return {
        ...snapshot,
        governanceBudgets: Array.isArray(snapshot.governanceBudgets) ? snapshot.governanceBudgets : [],
      };
    },
  },
  {
    from: 6,
    to: 7,
    description: "add registry admissions, so the 民主 rail can grow the federation",
    migrate(snapshot) {
      return {
        ...snapshot,
        governanceAdmissions: Array.isArray(snapshot.governanceAdmissions) ? snapshot.governanceAdmissions : [],
        registryAdmissions: Array.isArray(snapshot.registryAdmissions) ? snapshot.registryAdmissions : [],
      };
    },
  },
  {
    from: 7,
    to: 8,
    description: "add state archives, so the ledger's history is tamper-evident",
    migrate(snapshot) {
      return {
        ...snapshot,
        stateArchives: Array.isArray(snapshot.stateArchives) ? snapshot.stateArchives : [],
      };
    },
  },
];

export interface MigratedSnapshot {
  snapshot: Record<string, unknown> & { version: number };
  from: number;
  applied: string[];
}

export function migrateSnapshot(
  raw: unknown,
  migrations: SnapshotMigration[] = snapshotMigrations,
  current: number = CURRENT_SNAPSHOT_VERSION,
): MigratedSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("snapshot must be a JSON object");
  }

  const source = raw as Record<string, unknown>;
  const version = source.version;

  if (!Number.isInteger(version) || (version as number) < 1) {
    throw new Error("snapshot.version must be a positive integer");
  }

  const from = version as number;

  if (from > current) {
    throw new Error(
      `snapshot version ${from} is newer than this build supports (${current}); upgrade the node or restore an older backup`,
    );
  }

  let snapshot: Record<string, unknown> = { ...source };

  if (from === current) {
    return { snapshot: snapshot as MigratedSnapshot["snapshot"], from, applied: [] };
  }

  const chain = new Map<number, SnapshotMigration>();

  for (const migration of migrations) {
    if (!Number.isInteger(migration.from) || !Number.isInteger(migration.to)) {
      throw new Error("snapshot migrations must use integer versions");
    }

    if (migration.to !== migration.from + 1) {
      throw new Error(
        `snapshot migration ${migration.from}->${migration.to} must advance one version`,
      );
    }

    if (chain.has(migration.from)) {
      throw new Error(`duplicate snapshot migration from version ${migration.from}`);
    }

    chain.set(migration.from, migration);
  }

  const applied: string[] = [];
  let at = from;

  while (at < current) {
    const migration = chain.get(at);

    if (!migration) {
      throw new Error(`no snapshot migration from version ${at} to ${at + 1}`);
    }

    snapshot = migration.migrate(snapshot);
    snapshot.version = migration.to;
    applied.push(migration.description || `${migration.from}->${migration.to}`);
    at = migration.to;
  }

  if (at !== current) {
    throw new Error(`snapshot migration chain ended at ${at}, expected ${current}`);
  }

  return { snapshot: snapshot as MigratedSnapshot["snapshot"], from, applied };
}
