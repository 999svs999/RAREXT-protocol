import { canonicalize } from "./canonical.ts";

/**
 * Decisions as artifacts: a proposal with a root, votes that are signed statements, and a tally
 * that is a pure function of the two.
 *
 * RFC 0021's claim is that a community can decide what is good without a committee — because the
 * outcome is not announced by anyone, it is RECOMPUTED by whoever disagrees. That only means
 * something if the recomputation is a function of published inputs and nothing else: no clock, no
 * arrival order, no privileged list. So this module takes exactly those inputs and returns exactly
 * one answer for them. Two readers running it over the same votes get the same bytes, and the
 * digest of the result is what they compare.
 *
 * Two things core deliberately does not do here, and takes as PORTS instead — the same shape as
 * the injected hash in every other primitive in this package:
 *
 *   - `verify`   — checking a signature. Crypto lives in the caller (the SDK's payload verifier,
 *                  the API's key registry), and this module never sees a key it trusts.
 *   - `weights`  — what work a voter has done, when the pinned policy says weight is earned. The
 *                  credit ledger lives in the registry; the rule that uses it lives here.
 *
 * Refusals are recorded BY NAME rather than dropped. A vote that does not count is a finding a
 * reader is owed ("three votes carried an invalid signature") and never a silent subtraction —
 * which is also what makes the tally auditable rather than merely arithmetic.
 */

export const GOVERNANCE_PROPOSAL_KIND = "rarext.governance-proposal.v1";
export const GOVERNANCE_VOTE_KIND = "rarext.governance-vote.v1";

/** A decision put to a community, pinned as a document so its root can be voted on. */
export interface GovernanceProposal {
  kind: typeof GOVERNANCE_PROPOSAL_KIND;
  id: string;
  title: string;
  /** The question, in the words the voters are answering. */
  question: string;
  /** The choice ids a vote may name. A vote for anything else is refused by name. */
  choices: string[];
  /** When voting opens. Omitted means "whenever the proposal was published". */
  opensAt?: string;
  /** When voting closes. Required: a vote window with no end is not a decision. */
  closesAt: string;
  quorum: Quorum;
  policy: VotePolicy;
}

/**
 * What counts as weight. The protocol does not choose between these — RFC 0021's point is that
 * the community pins one, and a reader can see which rule produced the number.
 */
export type VotePolicy = { kind: "key" } | { kind: "work"; creditUnit: string };

export interface Quorum {
  kind: "keys" | "weight";
  /** Required value; 0 means no quorum rule, and the largest weight still has to exist to win. */
  value: number;
}

/** A vote: a signed statement about one proposal. */
export interface GovernanceVote {
  kind: typeof GOVERNANCE_VOTE_KIND;
  /** The root of the proposal document this vote answers. */
  proposalRoot: string;
  choice: string;
  /** Who the vote is attributed to — signed, so it cannot be rewritten. */
  voter: string;
  /** The key that signed, carried so a reader can verify with a port of their own. */
  publicKey: string;
  issuedAt: string;
  suite: string;
  /** Base64 signature over `votePayload(vote)`. */
  signature: string;
}

export type VoteRefusalReason =
  | "malformed"
  | "wrong-proposal"
  | "outside-window"
  | "unknown-choice"
  | "duplicate-voter"
  | "invalid-signature"
  | "unknown-weight";

export interface VoteRefusal {
  voter: string;
  choice: string;
  reason: VoteRefusalReason;
  detail: string;
}

export interface TallyResult {
  proposalRoot: string;
  policy: VotePolicy;
  quorum: { kind: Quorum["kind"]; required: number; achieved: number; met: boolean };
  /** Per choice: how many keys and how much weight, zero-filled for choices nobody picked. */
  counts: Array<{ choice: string; keys: number; weight: number }>;
  accepted: number;
  refused: VoteRefusal[];
  outcome: { kind: "decided"; choice: string } | { kind: "tie"; choices: string[] } | { kind: "no-quorum" };
}

/** The signed statement: the five fields a signature commits to, and nothing else. */
export interface VoteStatement {
  kind: typeof GOVERNANCE_VOTE_KIND;
  proposalRoot: string;
  choice: string;
  voter: string;
  issuedAt: string;
}

/** The exact bytes a vote's signature covers, canonicalized. */
export function voteStatement(vote: GovernanceVote): VoteStatement {
  return {
    kind: GOVERNANCE_VOTE_KIND,
    proposalRoot: vote.proposalRoot,
    choice: vote.choice,
    voter: vote.voter,
    issuedAt: vote.issuedAt,
  };
}

/** The proposal's root: the digest a vote is bound to, so a later edit breaks every vote. */
export function proposalRoot(proposal: GovernanceProposal, sha256: (value: string) => string): string {
  return sha256(canonicalize(proposal));
}

/** The result's root: what two independent recomputations compare instead of arguing. */
export function tallyRoot(result: TallyResult, sha256: (value: string) => string): string {
  return sha256(canonicalize(result));
}

export interface TallyInput {
  proposal: GovernanceProposal;
  votes: GovernanceVote[];
  sha256: (value: string) => string;
  /** Verify one vote's signature. Returns false for a vote that must not count. */
  verify: (vote: GovernanceVote, statement: VoteStatement) => boolean;
  /** Work a voter has done, read when the policy says weight is earned. Absent otherwise. */
  weights?: ((voter: string) => number | undefined) | undefined;
}

/**
 * Recomputation is the whole point, so DRY RUNNING this is not allowed to invent a missing
 * ingredient: a work-weighted policy with no ledger to read is an error, not a zero. A tally that
 * silently weights everyone at nothing looks exactly like a community that did not show up.
 */
export const UNKNOWN_WEIGHT = "the pinned policy weights votes by work, and no ledger was supplied to read";

export function tallyVotes(input: TallyInput): TallyResult | { error: string } {
  const { proposal, sha256 } = input;
  const policy = proposal.policy;
  if (!Array.isArray(proposal.choices) || proposal.choices.length === 0) {
    return { error: "a proposal must offer at least one choice" };
  }
  if (new Set(proposal.choices).size !== proposal.choices.length) {
    return { error: "a proposal must not offer the same choice twice" };
  }
  if (typeof proposal.closesAt !== "string" || proposal.closesAt.length === 0) {
    return { error: "a proposal must close: a vote window with no end is not a decision" };
  }
  if (policy.kind === "work" && typeof input.weights !== "function") {
    return { error: UNKNOWN_WEIGHT };
  }

  const root = proposalRoot(proposal, sha256);
  const opensAt = proposal.opensAt;
  const refused: VoteRefusal[] = [];

  const malformed = (vote: GovernanceVote, detail: string) =>
    refused.push({ voter: String(vote?.voter ?? ""), choice: String(vote?.choice ?? ""), reason: "malformed", detail });

  // Sorted first, because arrival order is not evidence: the same votes in a different order must
  // produce the same result, or "recompute it yourself" means "get the same answer if you happen
  // to have read them in the same sequence".
  const ordered = [...input.votes].sort((left, right) => {
    const byTime = String(left?.issuedAt ?? "").localeCompare(String(right?.issuedAt ?? ""));
    if (byTime !== 0) return byTime;
    const byVoter = String(left?.voter ?? "").localeCompare(String(right?.voter ?? ""));
    if (byVoter !== 0) return byVoter;
    return String(left?.signature ?? "").localeCompare(String(right?.signature ?? ""));
  });

  const accepted: Array<{ vote: GovernanceVote; weight: number }> = [];
  const seen = new Map<string, GovernanceVote>();

  for (const vote of ordered) {
    if (
      typeof vote !== "object" ||
      vote === null ||
      vote.kind !== GOVERNANCE_VOTE_KIND ||
      typeof vote.proposalRoot !== "string" ||
      typeof vote.choice !== "string" ||
      typeof vote.voter !== "string" ||
      vote.voter.length === 0 ||
      typeof vote.publicKey !== "string" ||
      vote.publicKey.length === 0 ||
      typeof vote.issuedAt !== "string" ||
      typeof vote.suite !== "string" ||
      typeof vote.signature !== "string" ||
      vote.signature.length === 0
    ) {
      malformed(vote ?? ({} as GovernanceVote), "the vote does not carry the fields a vote needs");
      continue;
    }
    if (vote.proposalRoot !== root) {
      refused.push({
        voter: vote.voter,
        choice: vote.choice,
        reason: "wrong-proposal",
        detail: `the vote answers proposal ${vote.proposalRoot.slice(0, 16)}…, this one is ${root.slice(0, 16)}…`,
      });
      continue;
    }
    if (typeof opensAt === "string" && opensAt.length > 0 && vote.issuedAt < opensAt) {
      refused.push({ voter: vote.voter, choice: vote.choice, reason: "outside-window", detail: `issued before ${opensAt}` });
      continue;
    }
    if (vote.issuedAt > proposal.closesAt) {
      refused.push({ voter: vote.voter, choice: vote.choice, reason: "outside-window", detail: `issued after ${proposal.closesAt}` });
      continue;
    }
    if (!proposal.choices.includes(vote.choice)) {
      refused.push({
        voter: vote.voter,
        choice: vote.choice,
        reason: "unknown-choice",
        detail: `this proposal offers ${proposal.choices.join(", ")}`,
      });
      continue;
    }
    // Validity BEFORE duplication, and the order matters more than it looks. Two votes from one
    // voter sort by signature when their times match, so checking duplication first made the
    // REFUSAL REASON depend on which ballot happened to sort first: the same two votes could be
    // reported as "invalid-signature + counted" or "duplicate + counted", giving two different
    // result roots for one set of inputs. A tally that claims to be recomputable cannot be
    // recomputable only in its counts. An invalid vote is not a duplicate of anything — it is an
    // invalid vote — so it is refused as one, always, before it can affect the counting at all.
    if (!input.verify(vote, voteStatement(vote))) {
      refused.push({ voter: vote.voter, choice: vote.choice, reason: "invalid-signature", detail: "the signature did not verify" });
      continue;
    }
    const earlier = seen.get(vote.voter);
    if (earlier) {
      refused.push({
        voter: vote.voter,
        choice: vote.choice,
        reason: "duplicate-voter",
        detail: `already counted for ${earlier.choice} at ${earlier.issuedAt}; one key is one vote`,
      });
      continue;
    }

    let weight = 1;
    if (policy.kind === "work") {
      const earned = input.weights?.(vote.voter);
      if (typeof earned !== "number" || !Number.isFinite(earned) || earned < 0) {
        refused.push({
          voter: vote.voter,
          choice: vote.choice,
          reason: "unknown-weight",
          detail: `the ledger has no ${policy.creditUnit} for this voter`,
        });
        continue;
      }
      weight = earned;
    }

    seen.set(vote.voter, vote);
    accepted.push({ vote, weight });
  }

  const counts = proposal.choices.map((choice) => {
    const forChoice = accepted.filter((entry) => entry.vote.choice === choice);
    return {
      choice,
      keys: forChoice.length,
      weight: forChoice.reduce((sum, entry) => sum + entry.weight, 0),
    };
  });

  const achieved = proposal.quorum.kind === "keys" ? accepted.length : counts.reduce((sum, entry) => sum + entry.weight, 0);
  const met = achieved >= proposal.quorum.value;

  let outcome: TallyResult["outcome"];
  if (accepted.length === 0 || !met) {
    outcome = { kind: "no-quorum" };
  } else {
    const ranked = [...counts].sort((left, right) => right.weight - left.weight);
    const best = ranked[0] as { choice: string; weight: number };
    const tied = ranked.filter((entry) => entry.weight === best.weight).map((entry) => entry.choice);
    outcome = tied.length > 1 ? { kind: "tie", choices: tied } : { kind: "decided", choice: best.choice };
  }

  return {
    proposalRoot: root,
    policy,
    quorum: { kind: proposal.quorum.kind, required: proposal.quorum.value, achieved, met },
    counts,
    accepted: accepted.length,
    refused: refused.sort((left, right) =>
      left.voter === right.voter
        ? left.reason.localeCompare(right.reason)
        : left.voter.localeCompare(right.voter),
    ),
    outcome,
  };
}

