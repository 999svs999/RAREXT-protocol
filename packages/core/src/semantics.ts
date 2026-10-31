import { canonicalize } from "./canonical.ts";
import { tasks } from "./tasks.ts";
import type {
  Attestation,
  Challenge,
  Claim,
  ClaimKind,
  ClaimScope,
  Semantics,
  SemanticsBinding,
} from "./types.ts";

export const SEMANTICS_CREATED_AT = "2026-01-01T00:00:00.000Z";

/**
 * A semantic record describes what a claim *means*, separately from the machine
 * spec a challenge happens to carry. The specHash pins the spec this meaning
 * was written against: if the spec changes without a semantics bump, the
 * binding breaks and the mismatch is visible instead of silent.
 *
 * The hashes below are pinned expectations. Changing a task's spec requires
 * bumping the matching semantics version and its hash, which the core test
 * suite enforces.
 */
export const LOGIC_SEMANTICS: Semantics[] = [
  {
    id: "logic/half-adder",
    app: "logic",
    version: 1,
    claimKind: "satisfies",
    title: "Add two bits",
    summary:
      "The answer turns on when exactly one start is on. The extra turns on when both starts are on.",
    specHash: "6ef13888989f389d6a853df6c9d4350932ddc8904be2343719ddf596172b15ba",
    verifierHash: "d280af9f3b45e715b60f754f6db08c6c4fb4a50755a16aeccd4a0510ad789f3c",
    inputs: ["circuit"],
    outputs: ["sum", "carry"],
    interpretation: {
      doc: "https://rarext.build/semantics/logic/half-adder@1",
      owner: "rarext",
      reviewedAt: SEMANTICS_CREATED_AT,
    },
    owner: "rarext",
    origin: "declared",
    createdAt: SEMANTICS_CREATED_AT,
  },
  {
    id: "logic/majority",
    app: "logic",
    version: 1,
    claimKind: "satisfies",
    title: "Majority vote",
    summary:
      "The answer turns on when two or more of the three starts are on.",
    specHash: "aa0c1fcc817ecb34338cd7675c3f787da619ca85e4e3dc0a07af095ca1732692",
    verifierHash: "d280af9f3b45e715b60f754f6db08c6c4fb4a50755a16aeccd4a0510ad789f3c",
    inputs: ["circuit"],
    outputs: ["y"],
    interpretation: {
      doc: "https://rarext.build/semantics/logic/majority@1",
      owner: "rarext",
      reviewedAt: SEMANTICS_CREATED_AT,
    },
    owner: "rarext",
    origin: "declared",
    createdAt: SEMANTICS_CREATED_AT,
  },
  {
    id: "logic/mux2",
    app: "logic",
    version: 1,
    claimKind: "satisfies",
    title: "Pick a signal",
    summary:
      "The chooser picks which start reaches the answer. Chooser off picks A, chooser on picks B.",
    specHash: "dc0b9a554f1b187e4ff901228715d3acf797f3824e1859661a90205a28fe9ad3",
    verifierHash: "d280af9f3b45e715b60f754f6db08c6c4fb4a50755a16aeccd4a0510ad789f3c",
    inputs: ["circuit"],
    outputs: ["y"],
    interpretation: {
      doc: "https://rarext.build/semantics/logic/mux2@1",
      owner: "rarext",
      reviewedAt: SEMANTICS_CREATED_AT,
    },
    owner: "rarext",
    origin: "declared",
    createdAt: SEMANTICS_CREATED_AT,
  },
];

/**
 * The declared AI semantics. Where the logic records license "satisfies"
 * claims about circuits, the AI records license the two non-exact kinds:
 * `ai-generative/gen-starter@1` licenses "generative" claims (the output is
 * attested as *coming from* the digest-bound starter model and seed) and
 * `ai-bounded/bounded-starter@1` licenses "bounded" claims (the
 * reconstruction stays within the committed metric bound of the committed
 * reference). Neither is a quality judgment. The verifier hashes are pinned
 * to the live verifier manifests; the app-side test suite enforces the
 * matches.
 */
export const AI_SEMANTICS: Semantics[] = [
  {
    id: "ai-generative/gen-starter",
    app: "ai-generative",
    version: 1,
    claimKind: "generative",
    title: "Output of the committed starter model",
    summary:
      "The attested output is exactly what the digest-bound xorshift32 starter model generates from the committed seed.",
    specHash: "bf2f754113f0c32835ea5b1e6f88f7d694d3a00a9a0ca772c12a7c796de1b6a3",
    verifierHash: "eadd89f10861a56ba3d6db41220ace2a2e9c8349c106538689fe7f24aa549aff",
    inputs: ["model", "seed"],
    outputs: ["output"],
    interpretation: {
      doc: "https://rarext.build/semantics/ai-generative/gen-starter@1",
      owner: "rarext",
      reviewedAt: SEMANTICS_CREATED_AT,
    },
    owner: "rarext",
    origin: "declared",
    createdAt: SEMANTICS_CREATED_AT,
  },
  {
    id: "ai-bounded/bounded-starter",
    app: "ai-bounded",
    version: 1,
    claimKind: "bounded",
    title: "Reconstruction within the committed bound",
    summary:
      "The attested reconstruction stays within the committed metric bound of the committed reference — a graded, metric-scoped satisfaction, not a quality judgment.",
    specHash: "f60f26388d166de74bb596ba449f96a135490c3a690584cb05031a8cf51c8b1f",
    verifierHash: "65fbd3442f42f5d53673eae7e5e6ebc039d422603897e1428479e1e40438203b",
    inputs: ["values"],
    outputs: ["metricValue"],
    interpretation: {
      doc: "https://rarext.build/semantics/ai-bounded/bounded-starter@1",
      owner: "rarext",
      reviewedAt: SEMANTICS_CREATED_AT,
    },
    owner: "rarext",
    origin: "declared",
    createdAt: SEMANTICS_CREATED_AT,
  },
];

export function semanticsForApp(app: string): Semantics[] {
  return LOGIC_SEMANTICS.filter((semantics) => semantics.app === app);
}

export function findSemantics(
  registry: Semantics[],
  id: string,
  version?: number,
): Semantics | null {
  const matches = registry.filter((semantics) => semantics.id === id);

  if (matches.length === 0) return null;
  if (version === undefined) {
    return matches.reduce((latest, current) =>
      current.version > latest.version ? current : latest,
    );
  }

  return matches.find((semantics) => semantics.version === version) ?? null;
}

export function semanticsRecord(semantics: Semantics): string {
  return canonicalize(semantics);
}

export function claimPredicate(semantics: Semantics, challengeId: string): string {
  return `${semantics.id}@${semantics.version} (${challengeId})`;
}

/**
 * Checks that a challenge still points at the meaning it was written against.
 * A challenge that carries no semantics reference is reported as "missing" so
 * the registry can surface challenges whose meaning nobody owns.
 */
export function semanticsBinding(
  challenge: Pick<Challenge, "id" | "spec" | "semanticsId" | "semanticsVersion">,
  registry: Semantics[],
  specHash: string,
): SemanticsBinding {
  const semantics = findSemantics(registry, challenge.semanticsId, challenge.semanticsVersion);

  if (!semantics) {
    const latest = findSemantics(registry, challenge.semanticsId);
    return latest ? "version-mismatch" : "missing";
  }

  return semantics.specHash === specHash ? "ok" : "spec-mismatch";
}

export function claimFromAttestation(
  attestation: Attestation,
  semantics: Semantics,
  challengeId: string,
): Claim {
  return {
    kind: attestation.claimKind,
    subject: attestation.circuitHash,
    representation: attestation.representation,
    metricName: attestation.metricName,
    metricValue: attestation.metricValue,
    semanticsId: semantics.id,
    semanticsVersion: semantics.version,
    semanticsHash: attestation.semanticsHash,
    predicate: claimPredicate(semantics, challengeId),
    scope: attestation.scope,
    proofKind:
      attestation.claimKind === "satisfies" ||
      attestation.claimKind === "generative" ||
      attestation.claimKind === "bounded"
        ? "recomputable"
        : attestation.claimKind === "attests"
          ? "attested"
          : "committed",
    proofHash: attestation.traceHash,
    verifier: attestation.verifier,
    verifierHash: attestation.verifierHash,
    createdAt: attestation.createdAt,
  };
}

export function claimKindAllowed(
  semantics: Semantics,
  kind: ClaimKind,
): boolean {
  return semantics.claimKind === kind;
}

export function scopeAllows(
  semantics: Semantics,
  scope: ClaimScope | null,
): boolean {
  if (!scope) return true;

  return Object.keys(scope).every((key) => key in semantics.inputs);
}

export function logicSemanticsForChallenge(
  challenge: Pick<Challenge, "id" | "app">,
): Semantics | null {
  return (
    LOGIC_SEMANTICS.find(
      (semantics) => semantics.id === `logic/${challenge.id}` && semantics.app === challenge.app,
    ) ?? null
  );
}

export function taskForSemantics(semantics: Semantics) {
  return tasks.find((task) => `logic/${task.id}` === semantics.id) ?? null;
}

/**
 * Anchoring semantics records — RFC 0003's question 1.
 *
 * The bundle's root is a Merkle root over PUBLICATION leaves, and a semantics record
 * is a bundle FIELD: editing it leaves the root verifying, so any anchoring claim
 * about the field is an anchor in name only. The fix is the one RFC 0020 applies to
 * seed lists — commit to the thing INSIDE the proof. A registry publishes a semantics
 * commitment as an ordinary publication carrying `id@version -> digest`, so a reader
 * holding a root can tell whether the meaning it resolved is the one committed to,
 * and editing the field moves the root a client already holds.
 */
export const SEMANTICS_APP = "rarext-semantics";
export const SEMANTICS_COMMITMENT_KIND = "semantics-commitment";

/** The digest a commitment records for one record: its canonical form, hashed. */
export function semanticsRecordDigest(semantics: Semantics, sha256: (value: string) => string): string {
  return sha256(canonicalize(semantics));
}

/** `id@version -> digest` for every record in a registry. */
export function semanticsDigests(
  semantics: Semantics[],
  sha256: (value: string) => string,
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const record of semantics) {
    digests[`${record.id}@${record.version}`] = semanticsRecordDigest(record, sha256);
  }
  return digests;
}

/** A publication-shaped artifact carrying the commitment, like the federation's. */
export function semanticsCommitmentArtifact(digests: Record<string, string>): {
  app: string;
  kind: string;
  version: number;
  mediaType: string;
  body: string;
} {
  return {
    app: SEMANTICS_APP,
    kind: SEMANTICS_COMMITMENT_KIND,
    version: 1,
    mediaType: "application/json",
    body: JSON.stringify({ digests }),
  };
}

/** Read a semantics commitment out of an artifact, or null when it is not one. */
export function parseSemanticsCommitmentArtifact(artifact: {
  app?: unknown;
  kind?: unknown;
  body?: unknown;
}): { digests: Record<string, string> } | null {
  if (artifact.app !== SEMANTICS_APP || artifact.kind !== SEMANTICS_COMMITMENT_KIND) return null;
  if (typeof artifact.body !== "string") return null;
  try {
    const parsed = JSON.parse(artifact.body) as { digests?: unknown };
    if (typeof parsed.digests !== "object" || parsed.digests === null) return null;
    const digests: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.digests as Record<string, unknown>)) {
      if (typeof value !== "string") return null;
      digests[key] = value;
    }
    return { digests };
  } catch {
    return null;
  }
}

/**
 * A bundle that carries its semantics commitment — pure, so it can be tested and so
 * every publisher that wants the commitment gets the SAME one.
 *
 * Two details are easy to get wrong and are therefore here rather than in a script:
 * the new publication is a COPY of an existing one (the leaf requires an attestation),
 * and `representation` is stripped from that attestation. Keeping it would publish the
 * commitment as an AI claim — a fake model result inside the very surface that exists
 * to prove model results (RFC 0020's commitment carries the same warning).
 *
 * Returns the bundle and the added publication's id, or the bundle unchanged when there
 * is nothing to commit or one is already present.
 */
export function withSemanticsCommitment(
  bundle: {
    publications?: Array<Record<string, unknown>>;
    semantics?: Semantics[];
    [key: string]: unknown;
  },
  sha256: (value: string) => string,
): { bundle: typeof bundle; added: string | null; replaced: boolean } {
  const publications = bundle.publications ?? [];
  const records = bundle.semantics ?? [];
  if (records.length === 0) return { bundle, added: null, replaced: false };

  // REPLACE, never carry. A commitment that already exists may cover records that have since
  // changed, and a bundle whose commitment disagrees with its own records is worse than a bundle
  // with no commitment at all: it proves a lie about the meanings its own claims were made
  // against. The commitment is derived from the records the bundle carries NOW, so publishing is
  // a function of the current tree rather than of what a previous publish happened to commit.
  const isCommitment = (publication: Record<string, unknown>) =>
    (publication.artifact as { kind?: unknown } | undefined)?.kind === SEMANTICS_COMMITMENT_KIND;
  const carried = publications.filter(isCommitment);
  const replaced = carried.length > 0;
  const kept = publications.filter((publication) => !isCommitment(publication));
  const template = kept[0] ?? carried[0];
  if (!template) return { bundle, added: null, replaced: false };

  const attestation = { ...(template.attestation as Record<string, unknown> | undefined) };
  delete attestation.representation;

  const id = "pub-semantics-commitment";
  const added = {
    ...template,
    id,
    title: `The ${records.length} semantics records this bundle commits to`,
    attestation,
    artifact: {
      ...(template.artifact as Record<string, unknown>),
      ...semanticsCommitmentArtifact(semanticsDigests(records, sha256)),
    },
  };
  return { bundle: { ...bundle, publications: [...kept, added] }, added: id, replaced };
}

/** The `id@version` key a commitment uses for a record. */
export function semanticsKey(record: Pick<Semantics, "id" | "version">): string {
  return `${record.id}@${record.version}`;
}

export interface SemanticsCommitmentStatus {
  /** How many records the commitment covers. */
  committed: number;
  /** How many of the carried records the commitment's digest matches. */
  matched: number;
  /** The `id@version` keys the commitment does not match, in the order the bundle carries them. */
  missing: string[];
}

/**
 * Does a semantics commitment cover the records a bundle carries — RFC 0003's question 1,
 * answered by a reader rather than by the publisher that wrote it.
 *
 * `digestOf` supplies each record's digest rather than a hasher, because the hashing is the
 * caller's business: a browser's only hasher is async, node's is sync, and a core function
 * that took an async hasher would compare a digest against a Promise and call a true claim
 * false. The COMPARISON and the accounting live here so a page, an agent and a test all
 * apply one rule.
 */
export function semanticsCommitmentHolds(
  commitment: { digests: Record<string, string> },
  records: Array<Pick<Semantics, "id" | "version">>,
  digestOf: (record: Pick<Semantics, "id" | "version">) => string,
): SemanticsCommitmentStatus {
  const missing: string[] = [];
  let matched = 0;
  for (const record of records) {
    const key = semanticsKey(record);
    if (commitment.digests[key] === digestOf(record)) matched += 1;
    else missing.push(key);
  }
  return { committed: Object.keys(commitment.digests).length, matched, missing };
}

/**
 * The semantics commitment a bundle carries, or null when it records none.
 *
 * Null is not false: a bundle that never made the claim is a different statement from one
 * whose claim failed, and a reader that collapsed the two would report an unanchored
 * registry as a broken one.
 */
export function bundleSemanticsCommitment(bundle: {
  publications?: Array<{ artifact?: unknown }>;
}): { digests: Record<string, string> } | null {
  for (const publication of bundle.publications ?? []) {
    const parsed = parseSemanticsCommitmentArtifact((publication?.artifact ?? {}) as never);
    if (parsed) return parsed;
  }
  return null;
}
