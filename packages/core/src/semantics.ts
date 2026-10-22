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
    semanticsId: semantics.id,
    semanticsVersion: semantics.version,
    semanticsHash: attestation.semanticsHash,
    predicate: claimPredicate(semantics, challengeId),
    scope: attestation.scope,
    proofKind:
      attestation.claimKind === "satisfies"
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
