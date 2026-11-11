import { canonicalize } from "./canonical.ts";
import { sha256Hex, type Sha256 } from "./digest.ts";

/**
 * The forward-compatibility ladder.
 *
 * RAREXT names its network "web4". This module is what "and the generations
 * after it" means, written down as one canonical, content-addressed object:
 * the network generations (5G, 6G, 7G, 8G …), the model-size generations
 * (1G, 6G, 7G, 8G … gigabytes), the web generations (web4 → web8 …), and the
 * protocol-leaf generations (gen-4 → gen-8 …).
 *
 * The ladder is DECLARED, not measured. Every entry carries `shipped`; the
 * ones set false are targets, and the module says so rather than implying the
 * project already runs on 8G transport or serves 8 GB weights. What the module
 * gives the protocol is the part that has to be shared to be useful: one
 * canonical set of ids, one digest, and pure helpers (`networkMeets`,
 * `planModelShards`, `nextGeneration`) that any surface — the browser, an
 * agent, a demo — can recompute from the same bytes.
 *
 * It is deliberately data plus pure functions: no clock, no I/O, no hash
 * implementation. `generationsDigest` takes the caller's sha256, exactly like
 * every other commitment in core.
 */

export const GENERATIONS_KIND = "rarext.generations.v1";

/** The four axes a generation can belong to. */
export type GenerationAxis = "web" | "network" | "model" | "protocol";

/** A naming generation of the web the protocol is built toward. */
export interface WebGeneration {
  id: string;
  /** The ordinal in the name (web4 → 4). Strictly increasing per axis. */
  ordinal: number;
  /** The primitive this generation adds, or would add. */
  adds: string;
  /** True only for the generation the reference implementation ships today. */
  shipped: boolean;
}

/** A declared transport budget. Peak figures are targets, not measurements. */
export interface NetworkProfile {
  /** Peak downlink, megabits per second. */
  downlinkMbps: number;
  /** Peak uplink, megabits per second. */
  uplinkMbps: number;
  /** Median one-way latency budget, milliseconds. */
  latencyMsP50: number;
  /** Whether an edge/MEC tier is assumed to exist at this generation. */
  edge: boolean;
}

export interface NetworkGeneration {
  id: string;
  ordinal: number;
  profile: NetworkProfile;
  shipped: boolean;
}

/** A model-size class, in whole gigabytes — the "6G/7G/8G weights" ladder. */
export interface ModelGeneration {
  id: string;
  /** The class size in gallons of binary gigabytes (GiB). */
  gigabytes: number;
  /** gigabytes × 1024³: the committed weight bytes. */
  sizeBytes: number;
  /** A planning floor: weights plus a working set, not a promise. */
  minMemoryBytes: number;
  /** The shard size the reference bundler uses for this class. */
  shardBytes: number;
  shipped: boolean;
}

/** A generation of the publication-leaf contract. */
export interface ProtocolGeneration {
  id: string;
  ordinal: number;
  /** The `leafVersion` this generation would raise (or did raise). */
  leafVersion: number;
  adds: string;
  shipped: boolean;
}

export interface Generations {
  kind: typeof GENERATIONS_KIND;
  version: 1;
  /** A declared ladder: entries with `shipped: false` are targets. */
  status: "declared";
  web: WebGeneration[];
  network: NetworkGeneration[];
  model: ModelGeneration[];
  protocol: ProtocolGeneration[];
}

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** The one shard size the reference bundler uses across model classes. */
export const MODEL_SHARD_BYTES = 8 * MIB;

function modelClass(gigabytes: number, shipped = false): ModelGeneration {
  const sizeBytes = gigabytes * GIB;
  return {
    id: `${gigabytes}G`,
    gigabytes,
    sizeBytes,
    // Weights plus a working set. A floor for planning, deliberately simple so
    // it is a rule a reader can recompute — not a benchmark of any one engine.
    minMemoryBytes: sizeBytes * 2,
    shardBytes: MODEL_SHARD_BYTES,
    shipped,
  };
}

/**
 * The declared ladder. Ids are stable and sorting is by `ordinal`/`gigabytes`;
 * the validator refuses a ladder whose order or numbering drifts.
 */
export const GENERATIONS: Generations = {
  kind: GENERATIONS_KIND,
  version: 1,
  status: "declared",
  web: [
    {
      id: "web4",
      ordinal: 4,
      adds: "verification as the primitive: recompute a claim instead of trusting a platform",
      shipped: true,
    },
    {
      id: "web5",
      ordinal: 5,
      adds: "a provider declares the transport generation it serves under",
      shipped: false,
    },
    {
      id: "web6",
      ordinal: 6,
      adds: "plan and commit model-size generations over content-addressed weights",
      shipped: false,
    },
    {
      id: "web7",
      ordinal: 7,
      adds: "replay a run committed under one generation under the next",
      shipped: false,
    },
    {
      id: "web8",
      ordinal: 8,
      adds: "an open-ended generation ladder that needs no protocol change",
      shipped: false,
    },
  ],
  network: [
    {
      id: "5G",
      ordinal: 5,
      profile: { downlinkMbps: 1000, uplinkMbps: 100, latencyMsP50: 10, edge: true },
      shipped: true,
    },
    {
      id: "6G",
      ordinal: 6,
      profile: { downlinkMbps: 10000, uplinkMbps: 1000, latencyMsP50: 1, edge: true },
      shipped: false,
    },
    {
      id: "7G",
      ordinal: 7,
      profile: { downlinkMbps: 100000, uplinkMbps: 10000, latencyMsP50: 0.5, edge: true },
      shipped: false,
    },
    {
      id: "8G",
      ordinal: 8,
      profile: { downlinkMbps: 1000000, uplinkMbps: 100000, latencyMsP50: 0.1, edge: true },
      shipped: false,
    },
  ],
  // 1G is SHIPPED: the reference runs GGUFs and RXHF containers under 1 GiB
  // end to end through the storage-native path (see WEB4-MODEL.md). 6G/7G/8G
  // stay targets until a class of that size is served and this flag moves.
  model: [modelClass(1, true), modelClass(6), modelClass(7), modelClass(8)],
  protocol: [
    {
      id: "gen-4",
      ordinal: 4,
      leafVersion: 4,
      adds: "representation kind and bounded-metric evidence in the publication leaf",
      shipped: true,
    },
    {
      id: "gen-6",
      ordinal: 6,
      leafVersion: 6,
      adds: "network- and model-generation commitments in the leaf",
      shipped: false,
    },
    {
      id: "gen-7",
      ordinal: 7,
      leafVersion: 7,
      adds: "a cross-generation replay envelope",
      shipped: false,
    },
    {
      id: "gen-8",
      ordinal: 8,
      leafVersion: 8,
      adds: "the generations registry itself, committed and replayable",
      shipped: false,
    },
  ],
};

/** The digest that makes the ladder a commitment rather than a promise. */
export function generationsDigest(sha256: Sha256): string {
  return sha256Hex(sha256, canonicalize(GENERATIONS));
}

const AXES: GenerationAxis[] = ["web", "network", "model", "protocol"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ordinalOf(entry: Record<string, unknown>): number | null {
  if (typeof entry.ordinal === "number") return entry.ordinal;
  if (typeof entry.gigabytes === "number") return entry.gigabytes;
  return null;
}

/**
 * Structural problems with a ladder, by name. A ladder that renumbers, reorders,
 * duplicates an id, or carries a non-finite profile is refused before anything
 * recomputes a digest over it.
 */
export function generationsProblems(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["generations must be an object"];
  if (value.kind !== GENERATIONS_KIND) errors.push(`generations.kind must be "${GENERATIONS_KIND}"`);
  if (value.version !== 1) errors.push("generations.version must be 1");
  if (value.status !== "declared") errors.push('generations.status must be "declared"');

  for (const axis of AXES) {
    const entries = value[axis];
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push(`generations.${axis} must be a non-empty array`);
      continue;
    }

    const ids = new Set<string>();
    let previous = -Infinity;
    for (const raw of entries) {
      if (!isRecord(raw)) {
        errors.push(`generations.${axis} entries must be objects`);
        continue;
      }
      const id = raw.id;
      if (typeof id !== "string" || id.length === 0) {
        errors.push(`generations.${axis} entry id must be a non-empty string`);
      } else if (ids.has(id)) {
        errors.push(`generations.${axis} has a duplicate id ${id}`);
      } else {
        ids.add(id);
      }
      if (typeof raw.shipped !== "boolean") {
        errors.push(`generations.${axis} entry ${String(id)} must carry a boolean shipped`);
      }

      const ordinal = ordinalOf(raw);
      if (ordinal === null || !Number.isSafeInteger(ordinal)) {
        errors.push(`generations.${axis} entry ${String(id)} must carry an integer ordinal`);
      } else if (ordinal <= previous) {
        errors.push(`generations.${axis} entries must be strictly increasing by ordinal`);
      } else {
        previous = ordinal;
      }

      if (axis === "web" || axis === "protocol") {
        if (typeof raw.adds !== "string" || raw.adds.length === 0) {
          errors.push(`generations.${axis} entry ${String(id)} must name what it adds`);
        }
      }
      if (axis === "protocol" && !Number.isSafeInteger(raw.leafVersion)) {
        errors.push(`generations.protocol entry ${String(id)} must carry an integer leafVersion`);
      }
      if (axis === "network") {
        const profile = raw.profile;
        if (!isRecord(profile)) {
          errors.push(`generations.network entry ${String(id)} must carry a profile`);
        } else {
          for (const key of ["downlinkMbps", "uplinkMbps", "latencyMsP50"] as const) {
            const n = profile[key];
            if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
              errors.push(`generations.network ${String(id)}.${key} must be a positive number`);
            }
          }
          if (typeof profile.edge !== "boolean") {
            errors.push(`generations.network ${String(id)}.edge must be a boolean`);
          }
        }
      }
      if (axis === "model") {
        for (const key of ["gigabytes", "sizeBytes", "minMemoryBytes", "shardBytes"] as const) {
          const n = raw[key];
          if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
            errors.push(`generations.model ${String(id)}.${key} must be a positive integer`);
          }
        }
        if (
          typeof raw.gigabytes === "number" &&
          typeof raw.sizeBytes === "number" &&
          raw.sizeBytes !== raw.gigabytes * GIB
        ) {
          errors.push(`generations.model ${String(id)}.sizeBytes must equal gigabytes × 1024³`);
        }
      }
    }
  }

  return errors;
}

/** Parse a ladder, or null when it is malformed. */
export function parseGenerations(value: unknown): Generations | null {
  return generationsProblems(value).length === 0 ? (value as Generations) : null;
}

/** The ids of one axis, in declared order. */
export function axisLadder(axis: GenerationAxis): string[] {
  return (GENERATIONS[axis] as Array<{ id: string }>).map((entry) => entry.id);
}

/** The highest generation the reference implementation ships on an axis, if any. */
export function shippedGeneration(axis: GenerationAxis): string | null {
  // Entries are strictly increasing by ordinal (the validator holds that), so
  // the last shipped entry in declared order is the highest one.
  let found: string | null = null;
  for (const entry of GENERATIONS[axis] as ReadonlyArray<{ id: string; shipped: boolean }>) {
    if (entry.shipped) found = entry.id;
  }
  return found;
}

/** The declared generation after `id` on an axis, or null at the end of the ladder. */
export function nextGeneration(axis: GenerationAxis, id: string): string | null {
  const ladder = GENERATIONS[axis] as Array<{ id: string }>;
  const index = ladder.findIndex((entry) => entry.id === id);
  if (index < 0 || index === ladder.length - 1) return null;
  return ladder[index + 1]!.id;
}

/** A requirement a transport must meet; any omitted field is not asserted. */
export interface NetworkRequirement {
  downlinkMbps?: number;
  uplinkMbps?: number;
  maxLatencyMsP50?: number;
  edge?: boolean;
}

/**
 * Whether a named network generation covers a requirement. An unknown id is
 * false: a transport the ladder does not name is not declared to exist.
 */
export function networkMeets(id: string, requirement: NetworkRequirement = {}): boolean {
  const entry = GENERATIONS.network.find((candidate) => candidate.id === id);
  if (!entry) return false;
  const { downlinkMbps, uplinkMbps, maxLatencyMsP50, edge } = requirement;
  if (downlinkMbps !== undefined && entry.profile.downlinkMbps < downlinkMbps) return false;
  if (uplinkMbps !== undefined && entry.profile.uplinkMbps < uplinkMbps) return false;
  if (maxLatencyMsP50 !== undefined && entry.profile.latencyMsP50 > maxLatencyMsP50) return false;
  if (edge !== undefined && entry.profile.edge !== edge) return false;
  return true;
}

export interface ModelShardPlan {
  id: string;
  sizeBytes: number;
  shardBytes: number;
  /** ceil(sizeBytes / shardBytes): every byte of the class is covered. */
  shards: number;
}

/**
 * How a model-size class shards. The class size is the committed weight bytes;
 * the shard size defaults to the class's own and may be overridden by a caller
 * that measures its own I/O budget. An unknown class is refused by name.
 */
export function planModelShards(
  id: string,
  options: { shardBytes?: number } = {},
): ModelShardPlan {
  const entry = GENERATIONS.model.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`unknown model generation ${id}`);
  const shardBytes = options.shardBytes ?? entry.shardBytes;
  if (!Number.isSafeInteger(shardBytes) || shardBytes <= 0) {
    throw new Error("shardBytes must be a positive integer");
  }
  return {
    id: entry.id,
    sizeBytes: entry.sizeBytes,
    shardBytes,
    shards: Math.ceil(entry.sizeBytes / shardBytes),
  };
}
