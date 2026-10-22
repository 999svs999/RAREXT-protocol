/**
 * Fair-launch trajectories.
 *
 * A single SAFE attestation is a badge. A series of attestations at increasing
 * blocks is a trajectory, and the difference is visible only if the series is
 * read as a whole. This module groups launch checks by mint and chain and
 * reports where the policy changed, where blocks repeat, and whether every
 * check in the series passed.
 *
 * It does not re-run the verifier and it does not claim that a short or stale
 * series is safe. The caller must treat the end of the series as the end of the
 * evidence.
 */

export interface LaunchCheckInput {
  publicationId: string;
  block: number;
  correct: boolean;
  score: number;
  challengeId: string;
  semanticsId: string;
  semanticsVersion: number;
  semanticsHash: string;
  verifierHash: string;
  attestedAt: string;
  anchored: boolean;
}

export interface LaunchCheck extends LaunchCheckInput {
  level: "SAFE" | "UNSAFE";
}

export interface TrajectoryPolicy {
  challengeId: string;
  semanticsId: string;
  semanticsVersion: number;
  semanticsHash: string;
}

export interface TrajectorySegment {
  policy: TrajectoryPolicy;
  fromBlock: number;
  toBlock: number;
  count: number;
  safe: number;
  verifierHashes: string[];
}

export type TrajectoryVerdict = "empty" | "safe" | "not-safe" | "ambiguous";

export interface LaunchTrajectory {
  mint: string;
  chain: string;
  count: number;
  safe: number;
  unsafe: number;
  anchored: number;
  fullyAnchored: boolean;
  firstBlock: number | null;
  lastBlock: number | null;
  latest: LaunchCheck | null;
  verdict: TrajectoryVerdict;
  policyChanges: number;
  duplicateBlocks: number[];
  segments: TrajectorySegment[];
  checks: LaunchCheck[];
  summary: string;
}

function policyFor(check: LaunchCheckInput): TrajectoryPolicy {
  return {
    challengeId: check.challengeId,
    semanticsId: check.semanticsId,
    semanticsVersion: check.semanticsVersion,
    semanticsHash: check.semanticsHash,
  };
}

function samePolicy(left: TrajectoryPolicy, right: TrajectoryPolicy): boolean {
  return (
    left.challengeId === right.challengeId &&
    left.semanticsId === right.semanticsId &&
    left.semanticsVersion === right.semanticsVersion &&
    left.semanticsHash === right.semanticsHash
  );
}

export function buildLaunchTrajectory(
  mint: string,
  chain: string,
  input: LaunchCheckInput[],
): LaunchTrajectory {
  const seen = new Set<string>();
  const checks: LaunchCheck[] = input
    .filter((check) => {
      if (seen.has(check.publicationId)) return false;
      seen.add(check.publicationId);
      return Number.isInteger(check.block) && check.block >= 0;
    })
    .map((check) => ({
      ...check,
      level: check.correct ? ("SAFE" as const) : ("UNSAFE" as const),
    }))
    .sort(
      (left, right) =>
        left.block - right.block ||
        left.attestedAt.localeCompare(right.attestedAt) ||
        left.publicationId.localeCompare(right.publicationId),
    );

  if (checks.length === 0) {
    return {
      mint,
      chain,
      count: 0,
      safe: 0,
      unsafe: 0,
      anchored: 0,
      fullyAnchored: false,
      firstBlock: null,
      lastBlock: null,
      latest: null,
      verdict: "empty",
      policyChanges: 0,
      duplicateBlocks: [],
      segments: [],
      checks: [],
      summary: "no public launch checks for this mint and chain",
    };
  }

  const byBlock = new Map<number, number>();
  for (const check of checks) byBlock.set(check.block, (byBlock.get(check.block) ?? 0) + 1);
  const duplicateBlocks = [...byBlock.entries()]
    .filter(([, count]) => count > 1)
    .map(([block]) => block)
    .sort((left, right) => left - right);

  const segments: TrajectorySegment[] = [];
  let policyChanges = 0;

  for (const check of checks) {
    const policy = policyFor(check);
    const last = segments.at(-1);

    if (!last || !samePolicy(last.policy, policy)) {
      if (last) policyChanges += 1;
      segments.push({
        policy,
        fromBlock: check.block,
        toBlock: check.block,
        count: 1,
        safe: check.correct ? 1 : 0,
        verifierHashes: [check.verifierHash],
      });
      continue;
    }

    last.toBlock = check.block;
    last.count += 1;
    if (check.correct) last.safe += 1;
    if (!last.verifierHashes.includes(check.verifierHash)) {
      last.verifierHashes.push(check.verifierHash);
    }
  }

  const unsafe = checks.filter((check) => !check.correct).length;
  const safe = checks.length - unsafe;
  const anchored = checks.filter((check) => check.anchored).length;
  const fullyAnchored = anchored === checks.length;
  const verdict: TrajectoryVerdict =
    unsafe > 0 ? "not-safe" : duplicateBlocks.length > 0 ? "ambiguous" : "safe";
  const latest = checks.at(-1)!;
  const firstBlock = checks[0]!.block;
  const lastBlock = latest.block;

  let summary: string;

  if (verdict === "not-safe") {
    summary = `${checks.length} checks from block ${firstBlock} to ${lastBlock}; ${unsafe} did not pass, so the launch cannot be shown safe as a trajectory`;
  } else if (verdict === "ambiguous") {
    summary = `${checks.length} checks from block ${firstBlock} to ${lastBlock}; duplicate blocks ${duplicateBlocks.join(", ")} make a linear trajectory ambiguous`;
  } else {
    summary = `${checks.length} checks from block ${firstBlock} to ${lastBlock}, all passing; ${anchored}/${checks.length} anchored${policyChanges ? `; ${policyChanges} policy change(s)` : ""}. The series ends at the latest check and says nothing after it.`;
  }

  return {
    mint,
    chain,
    count: checks.length,
    safe,
    unsafe,
    anchored,
    fullyAnchored,
    firstBlock,
    lastBlock,
    latest,
    verdict,
    policyChanges,
    duplicateBlocks,
    segments,
    checks,
    summary,
  };
}
