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
  /**
   * The key that signed, carried so a reader can verify with a port of their own. Its SHAPE is the
   * verifier's business and not core's: a registry carries JWKs, an agent may carry an opaque key
   * id, and core never looks inside — it passes the carrier to the `verify` port unchanged, the
   * same way it passes a hash implementation instead of importing one.
   */
  publicKey: string | Record<string, unknown>;
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

/**
 * What is wrong with a proposal, if anything — the ONE validation, called by the tally and by any
 * route that accepts a proposal. A node that accepted a proposal the tally would refuse would be
 * storing a decision nobody can compute, so the two must not be able to disagree about what a
 * proposal is.
 */
export function proposalProblems(proposal: GovernanceProposal): string[] {
  const problems: string[] = [];
  if (proposal === null || typeof proposal !== "object") return ["a proposal must be an object"];
  if (proposal.kind !== GOVERNANCE_PROPOSAL_KIND) {
    problems.push(`a proposal must be a ${GOVERNANCE_PROPOSAL_KIND} document`);
  }
  if (typeof proposal.id !== "string" || proposal.id.length === 0) problems.push("a proposal needs an id");
  if (typeof proposal.question !== "string" || proposal.question.length === 0) {
    problems.push("a proposal needs the question voters are answering");
  }
  if (!Array.isArray(proposal.choices) || proposal.choices.length === 0) {
    problems.push("a proposal must offer at least one choice");
  } else if (new Set(proposal.choices).size !== proposal.choices.length) {
    problems.push("a proposal must not offer the same choice twice");
  }
  if (typeof proposal.closesAt !== "string" || proposal.closesAt.length === 0) {
    problems.push("a proposal must close: a vote window with no end is not a decision");
  }
  if (proposal.quorum === null || typeof proposal.quorum !== "object") {
    problems.push("a proposal must state its quorum, even if the value is zero");
  } else if (proposal.quorum.kind !== "keys" && proposal.quorum.kind !== "weight") {
    problems.push("a quorum is counted in keys or in weight");
  } else if (typeof proposal.quorum.value !== "number" || !Number.isFinite(proposal.quorum.value) || proposal.quorum.value < 0) {
    problems.push("a quorum value must be a number of zero or more");
  }
  if (proposal.policy === null || typeof proposal.policy !== "object") {
    problems.push("a proposal must pin a weight policy");
  } else if (proposal.policy.kind !== "key" && proposal.policy.kind !== "work") {
    problems.push("a weight policy is either one key one vote or work-weighted");
  } else if (proposal.policy.kind === "work" && typeof proposal.policy.creditUnit !== "string") {
    problems.push("a work-weighted policy must name the credit unit it reads");
  }
  return problems;
}

/**
 * What is wrong with a vote's SHAPE, if anything — the ONE shape validation, called by the tally
 * and by any route that accepts a vote.
 *
 * It deliberately says nothing about the signature, the voting window, the choice, or the voter's
 * history. Those are the TALLY's findings, and they are reported by name in its result rather than
 * asserted at a boundary that could disagree with it: a node may decline to store an unusable
 * record, but the node is never the one deciding whether a vote counts.
 */
export function voteProblems(vote: GovernanceVote): string[] {
  if (vote === null || typeof vote !== "object") return ["a vote must be an object"];
  const problems: string[] = [];
  if (vote.kind !== GOVERNANCE_VOTE_KIND) problems.push(`a vote must be a ${GOVERNANCE_VOTE_KIND} record`);
  if (typeof vote.proposalRoot !== "string" || vote.proposalRoot.length === 0) {
    problems.push("a vote must name the proposal root it answers");
  }
  if (typeof vote.choice !== "string" || vote.choice.length === 0) problems.push("a vote must name a choice");
  if (typeof vote.voter !== "string" || vote.voter.length === 0) problems.push("a vote must name a voter");
  if (
    vote.publicKey === null ||
    vote.publicKey === undefined ||
    (typeof vote.publicKey === "string" && vote.publicKey.length === 0)
  ) {
    problems.push("a vote must carry the key that signed it");
  }
  if (typeof vote.issuedAt !== "string" || vote.issuedAt.length === 0) problems.push("a vote must say when it was issued");
  if (typeof vote.suite !== "string" || vote.suite.length === 0) problems.push("a vote must name its signature suite");
  if (typeof vote.signature !== "string" || vote.signature.length === 0) problems.push("a vote must carry a signature");
  return problems;
}

export interface TallyInput {
  proposal: GovernanceProposal;
  votes: GovernanceVote[];
  sha256: (value: string) => string;
  /** Verify one vote's signature. Returns false for a vote that must not count. */
  verify: (vote: GovernanceVote, statement: VoteStatement) => boolean;
  /**
   * Work a voter has done, read when the policy says weight is earned. It receives the VOTE and
   * not a voter name, because the account it reads must be the one the ballot was actually signed
   * by: a ledger keyed on a self-chosen label would let anyone vote with someone else's credits.
   */
  weights?: ((vote: GovernanceVote) => number | undefined) | undefined;
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
  const problems = proposalProblems(proposal);
  if (problems.length > 0) {
    return { error: problems[0] as string };
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
  // Keyed by the SIGNING KEY, not by the voter field. The voter field is a label a voter chooses
  // for itself, so keying duplication on it meant one key could vote every choice simply by
  // labelling itself differently — "one key is one vote" would have been a sentence in a document
  // rather than a property of the tally. The key is the identity because the signature was
  // verified against it, and `canonicalize` is enough to tell two keys apart.
  const seen = new Map<string, GovernanceVote>();

  for (const vote of ordered) {
    if (voteProblems(vote).length > 0) {
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
    const identity = canonicalize(vote.publicKey);
    const earlier = seen.get(identity);
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
      const earned = input.weights?.(vote);
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

    seen.set(identity, vote);
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

/**
 * A budget line: the piece that lets a DECISION move credits instead of merely describing them.
 *
 * A proposal decides; nothing in the protocol turned that decision into a payment, so 民主 could
 * steer everything except the money it was supposed to steer. A budget is the pledger's commitment —
 * signed by the key that WILL be debited, carrying the whole proposal it funds, naming the choice
 * that triggers payment — and the payment itself is two ledger entries derived from it by ONE rule,
 * so the debit and the credit can never drift apart.
 *
 * The shape follows the sponsorship pattern exactly: the payload carries the object it is about, the
 * signature covers the whole payload, and nothing is trusted apart from the signer's key. A budget
 * whose proposal is unsound, whose `payOn` is not a choice the proposal offers, or whose amount is
 * not a positive integer is refused by name.
 */
export const GOVERNANCE_BUDGET_KIND = "rarext.governance-budget.v1";

export interface GovernanceBudget {
  kind: typeof GOVERNANCE_BUDGET_KIND;
  version: 1;
  /** The key that will be DEBITED — the pledger, and the signer of this payload. */
  from: string;
  /**
   * Who the decision pays: a single key, or a RECEIPT-HOLDERS spec — every participant holding a
   * receipt with the named `act` (and, when a root is given, for that root) splits the amount
   * evenly at execution time. The spec names a CLASS the node resolves from its own ledger; the
   * ledger is the only thing that can say who the class contains, which is why execution — not
   * the pledge — expands it.
   */
  to: string | { kind: "receipt-holders"; act: string; root?: string };
  /** A positive integer: credits are indivisible, and a zero or negative pledge is not a pledge. */
  amount: number;
  /** Why the money is being pledged — the line a voter reads. */
  reason: string;
  /** The choice whose TALLY DECISION triggers payment. A "no" outcome pays nothing. */
  payOn: string;
  createdAt: string;
  /** The whole proposal being funded, carried so the signature covers the exact question. */
  proposal: GovernanceProposal;
}

/**
 * What is wrong with a budget, if anything — refused BY NAME, like every other record the protocol
 * accepts, so a caller can tell a malformed pledge from one it should not have asked for.
 */
export function governanceBudgetProblems(budget: GovernanceBudget): string[] {
  const problems: string[] = [];

  if (budget === null || typeof budget !== "object") return ["a budget must be an object"];
  if (budget.kind !== GOVERNANCE_BUDGET_KIND) {
    problems.push(`a budget must be a ${GOVERNANCE_BUDGET_KIND} payload`);
  }
  if (budget.version !== 1) problems.push("a budget must be a version 1 payload");
  if (typeof budget.from !== "string" || budget.from.length === 0) {
    problems.push("a budget needs the key that will be debited");
  }
  if (typeof budget.to === "string") {
    if (budget.to.length === 0) {
      problems.push("a budget needs the key that will be credited");
    }
  } else if (typeof budget.to === "object" && budget.to !== null) {
    if (budget.to.kind !== "receipt-holders") {
      problems.push(`a budget's receipt spec must be kind "receipt-holders", not ${JSON.stringify((budget.to as { kind?: unknown }).kind)}`);
    }
    if (typeof budget.to.act !== "string" || budget.to.act.length === 0 || budget.to.act.length > 64) {
      problems.push("a budget's receipt spec needs the act whose holders it pays");
    }
    if (budget.to.root !== undefined && (typeof budget.to.root !== "string" || !/^[0-9a-f]{64}$/.test(budget.to.root))) {
      problems.push("a budget's receipt spec's root, when present, must be a 64-hex digest");
    }
  } else {
    problems.push("a budget needs the key that will be credited, or a receipt-holders spec");
  }
  if (budget.from === budget.to) {
    problems.push("a budget's payer and payee must be different keys: a pledge to yourself is not a commitment");
  }
  if (typeof budget.amount !== "number" || !Number.isInteger(budget.amount) || budget.amount <= 0) {
    problems.push("a budget's amount must be a positive integer of credits");
  }
  if (typeof budget.reason !== "string" || budget.reason.length === 0) {
    problems.push("a budget needs the reason a voter reads");
  }
  if (typeof budget.createdAt !== "string" || budget.createdAt.length === 0) {
    problems.push("a budget needs its creation time");
  }

  const proposalProblemsFound = proposalProblems(budget.proposal);
  if (proposalProblemsFound.length > 0) {
    problems.push(`a budget carries an unsound proposal: ${proposalProblemsFound[0]}`);
    return problems;
  }

  if (typeof budget.payOn !== "string" || budget.payOn.length === 0) {
    problems.push("a budget needs the choice whose decision triggers payment");
  } else if (!budget.proposal.choices.includes(budget.payOn)) {
    problems.push(
      `a budget's payOn must be a choice the proposal offers — ${JSON.stringify(budget.payOn)} is not one of ${budget.proposal.choices.map((choice) => JSON.stringify(choice)).join(", ")}`,
    );
  }

  return problems;
}

/**
 * The payment a decided budget becomes: TWO ledger entries, derived by this one rule so they can
 * never disagree. The pledger's entry is negative — the ledger already understands a record that
 * reduces a balance, because `bounty` is a number — and both entries carry the proposal's ROOT as
 * their artifact reference, which is the same field the board uses to keep the same work from being
 * paid twice: a decision, like a job, is payable once.
 *
 * `at` is the moment of execution, a parameter rather than an input: core stays pure, and the route
 * that executes a decided budget stamps the time.
 */
export function budgetPaymentRecords(
  budget: GovernanceBudget,
  at: string,
  sha256: (value: string) => string,
): Array<{ keyId: string; action: string; bounty: number; challengeId: string; artifactHash: string; at: string }> {
  if (typeof budget.to !== "string") {
    throw new Error("a receipt-holders budget becomes distribution records: call budgetDistributionRecords with the holders");
  }
  // The reference is the proposal's ROOT — a real digest, the same identity a reference names — and
  // it is what makes the payment once-only: both entries carry it as their artifact reference, the
  // field the board already uses to keep the same work from being paid twice.
  const reference = proposalRoot(budget.proposal, sha256);
  const shared = {
    action: "governance",
    challengeId: budget.proposal.id,
    artifactHash: reference,
    at,
  };

  return [
    { keyId: budget.from, bounty: -budget.amount, ...shared },
    { keyId: budget.to, bounty: budget.amount, ...shared },
  ];
}

/**
 * The records a RECEIPT-HOLDERS budget becomes, once the node has resolved the class to actual
 * keys. Zero-sum is the law: the pledger's single debit equals the SUM of the holder credits, so
 * the ledger never mints. Credits are indivisible, so the amount splits evenly and the REMAINDER
 * goes to the first holder in sorted order — deterministic, so two nodes executing the same
 * decision produce byte-identical records. Every entry carries the proposal's root as its
 * artifact reference: a decision, like a job, is payable once, and a replay finds the reference
 * already in the ledger.
 */
export function budgetDistributionRecords(
  budget: GovernanceBudget,
  holders: string[],
  at: string,
  sha256: (value: string) => string,
): Array<{ keyId: string; action: string; bounty: number; challengeId: string; artifactHash: string; at: string }> {
  if (typeof budget.to === "string") {
    throw new Error("a single-recipient budget becomes two records: call budgetPaymentRecords");
  }
  const unique = [...new Set(holders)].sort();
  if (unique.length === 0) {
    throw new Error("the decision pays receipt-holders, and none exist: nothing to distribute");
  }
  const reference = proposalRoot(budget.proposal, sha256);
  const shared = {
    action: "governance",
    challengeId: budget.proposal.id,
    artifactHash: reference,
    at,
  };

  const per = Math.floor(budget.amount / unique.length);
  const remainder = budget.amount - per * unique.length;
  const records = unique.map((keyId, index) => ({
    keyId,
    bounty: index === 0 ? per + remainder : per,
    ...shared,
  }));
  return [{ keyId: budget.from, bounty: -budget.amount, ...shared }, ...records];
}
