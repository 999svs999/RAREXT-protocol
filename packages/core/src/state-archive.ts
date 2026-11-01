/**
 * A state archive: the node's durable state, frozen at an anchor and content-addressed, chained
 * to the archive before it.
 *
 * The registry's PUBLICATIONS have always been verifiable backwards — each anchor is a Merkle
 * root over publication leaves, and a copy either rebuilds the root or does not. The rest of the
 * node's state did not: proposals, votes, credits, admissions existed only in the present tense.
 * A node could rewrite its ledger's history and the only artifact — the current commitment —
 * would silently agree with the rewrite.
 *
 * The archive closes that. At every anchor the node freezes the durable state, hashes it
 * TOGETHER WITH the previous archive's state root, and records the chain. Rewriting any past
 * archive changes its state root, which breaks the NEXT archive's chain, which breaks every
 * archive after it: history is tamper-evident, not merely recorded. The chain anchors at the
 * GENESIS root (64 zeros) — there is nothing before the first archive, and the constant is the
 * honest statement of that rather than a null that every verifier must special-case.
 *
 * The rule lives in core because it is a RULE — the domain separation, the field selection, the
 * canonical form — and the node that makes an archive and the client that verifies it must not
 * be able to disagree about what was hashed.
 */

import { canonicalize } from "./canonical.ts";

export const STATE_ARCHIVE_DOMAIN = "rarext.state-archive.v1";

/** The root the FIRST archive chains to: 64 zeros, the honest name for "nothing before this". */
export const STATE_ARCHIVE_GENESIS_ROOT = "0".repeat(64);

export interface StateArchiveInput {
  /** The anchor this archive was frozen at — the publications' Merkle root. */
  anchorRoot: string;
  /** The previous archive's state root, or STATE_ARCHIVE_GENESIS_ROOT for the first. */
  previousStateRoot: string;
  /** The durable state at the moment of the anchor. */
  proposals: unknown[];
  votes: unknown[];
  credits: unknown[];
  admissions: unknown[];
  at: string;
}

export function stateArchiveProblems(archive: unknown): string[] {
  const problems: string[] = [];
  const record = archive as Partial<StateArchiveInput> | null;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return ["a state archive must be a JSON object"];
  }
  if (typeof record.anchorRoot !== "string" || !/^[0-9a-f]{64}$/.test(record.anchorRoot)) {
    problems.push("a state archive's anchorRoot must be a 64-hex digest");
  }
  if (typeof record.previousStateRoot !== "string" || !/^[0-9a-f]{64}$/.test(record.previousStateRoot)) {
    problems.push("a state archive's previousStateRoot must be a 64-hex digest");
  }
  for (const field of ["proposals", "votes", "credits", "admissions"] as const) {
    if (!Array.isArray(record[field])) {
      problems.push(`a state archive's ${field} must be an array`);
    }
  }
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) {
    problems.push("a state archive's at must be a parseable timestamp");
  }
  return problems;
}

/**
 * The archive's root: the domain, the previous root (the CHAIN), the anchor it was frozen at,
 * and the state — canonicalized, hashed with the caller's function. The client recomputes this
 * from the served archive and compares; a mismatch names the tampering, and a chain whose links
 * disagree names WHERE it happened.
 */
export function stateArchiveRoot(archive: StateArchiveInput, hash: (value: string) => string): string {
  const covered = {
    previousStateRoot: archive.previousStateRoot,
    anchorRoot: archive.anchorRoot,
    proposals: archive.proposals,
    votes: archive.votes,
    credits: archive.credits,
    admissions: archive.admissions,
    at: archive.at,
  };
  return hash(`${STATE_ARCHIVE_DOMAIN}\n${canonicalize(covered)}`);
}
