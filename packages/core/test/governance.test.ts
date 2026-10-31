import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  UNKNOWN_WEIGHT,
  canonicalize,
  proposalRoot,
  tallyRoot,
  tallyVotes,
  voteStatement,
} from "../src/index.ts";
import type { GovernanceProposal, GovernanceVote, TallyResult, VoteRefusalReason } from "../src/index.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// A stand-in for a real signature: deterministic, and sensitive to every signed field. The SDK
// proves the real one; what matters here is the PORT contract, so the tally is exercised without
// core ever touching a key.
const SECRET = "test-key";
const sign = (value: string) => createHash("sha256").update(`${SECRET}|${value}`).digest("base64");
const verify = (vote: GovernanceVote, statement: ReturnType<typeof voteStatement>) =>
  vote.signature === sign(canonicalize(statement));

function proposal(overrides: Partial<GovernanceProposal> = {}): GovernanceProposal {
  return {
    kind: GOVERNANCE_PROPOSAL_KIND,
    id: "p-1",
    title: "Should the registry admit a second operator?",
    question: "Admit operator B?",
    choices: ["yes", "no"],
    closesAt: "2026-12-01T00:00:00.000Z",
    quorum: { kind: "keys", value: 2 },
    policy: { kind: "key" },
    ...overrides,
  };
}

function vote(prop: GovernanceProposal, voter: string, choice: string, issuedAt = "2026-11-01T00:00:00.000Z"): GovernanceVote {
  const base: Omit<GovernanceVote, "signature"> = {
    kind: GOVERNANCE_VOTE_KIND,
    proposalRoot: proposalRoot(prop, sha256),
    choice,
    voter,
    publicKey: `pk:${voter}`,
    issuedAt,
    suite: "ecdsa-p256",
  };
  return { ...base, signature: sign(canonicalize(voteStatement({ ...base, signature: "" }))) };
}

function tallyOf(prop: GovernanceProposal, votes: GovernanceVote[], extra: Record<string, unknown> = {}) {
  return tallyVotes({ proposal: prop, votes, sha256, verify, ...extra });
}

function expectTally(result: TallyResult | { error: string }): TallyResult {
  assert.ok(!("error" in result), "error" in result ? result.error : "");
  return result as TallyResult;
}

const reasons = (result: TallyResult): VoteRefusalReason[] => result.refused.map((entry) => entry.reason);

test("a plain majority decides, and the counts are per choice", () => {
  const prop = proposal();
  const result = expectTally(tallyOf(prop, [vote(prop, "alice", "yes"), vote(prop, "bob", "yes"), vote(prop, "carol", "no")]));
  assert.equal(result.accepted, 3);
  assert.equal(result.refused.length, 0);
  assert.deepEqual(result.outcome, { kind: "decided", choice: "yes" });
  assert.deepEqual(result.counts, [
    { choice: "yes", keys: 2, weight: 2 },
    { choice: "no", keys: 1, weight: 1 },
  ]);
  assert.deepEqual(result.quorum, { kind: "keys", required: 2, achieved: 3, met: true });
});

test("ORDER IS NOT EVIDENCE: the same votes shuffled recompute to the same root", () => {
  const prop = proposal();
  const votes = [
    vote(prop, "alice", "yes"),
    vote(prop, "bob", "no"),
    vote(prop, "carol", "yes", "2026-11-02T00:00:00.000Z"),
    vote(prop, "dave", "no", "2026-11-03T00:00:00.000Z"),
  ];
  const forward = expectTally(tallyOf(prop, votes));
  const reversed = expectTally(tallyOf(prop, [...votes].reverse()));
  const interleaved = expectTally(tallyOf(prop, [votes[2]!, votes[0]!, votes[3]!, votes[1]!]));

  assert.equal(tallyRoot(forward, sha256), tallyRoot(reversed, sha256));
  assert.equal(tallyRoot(forward, sha256), tallyRoot(interleaved, sha256));
});

test("a vote whose signed field was edited after signing does not count", () => {
  const prop = proposal();
  const honest = vote(prop, "alice", "yes");
  const tampered: GovernanceVote = { ...honest, choice: "no" };
  const result = expectTally(tallyOf(prop, [honest, tampered]));
  assert.equal(result.accepted, 1);
  assert.deepEqual(reasons(result), ["invalid-signature"], "the edited ballot is invalid, and called that rather than a duplicate");
  assert.deepEqual(result.counts, [
    { choice: "yes", keys: 1, weight: 1 },
    { choice: "no", keys: 0, weight: 0 },
  ]);
});

test("one key is one vote: a second ballot from the same voter is refused by name", () => {
  const prop = proposal();
  const first = vote(prop, "alice", "yes", "2026-11-01T00:00:00.000Z");
  const second = vote(prop, "alice", "no", "2026-11-02T00:00:00.000Z");
  const result = expectTally(tallyOf(prop, [second, first]));
  assert.equal(result.accepted, 1);
  assert.deepEqual(reasons(result), ["duplicate-voter"]);
  assert.match(result.refused[0]!.detail, /already counted for yes/);
});

test("votes are refused by name: wrong proposal, unknown choice, outside the window, malformed", () => {
  const prop = proposal({ opensAt: "2026-11-01T00:00:00.000Z" });
  const other = proposal({ id: "p-2" });
  const votes = [
    vote(other, "alice", "yes"),
    vote(prop, "bob", "maybe"),
    vote(prop, "carol", "yes", "2026-10-01T00:00:00.000Z"),
    vote(prop, "dave", "yes", "2026-12-02T00:00:00.000Z"),
    { ...vote(prop, "erin", "yes"), kind: "something.else" },
    vote(prop, "frank", "no"),
  ] as GovernanceVote[];
  const result = expectTally(tallyOf(prop, votes));
  assert.equal(result.accepted, 1, "only the well-formed, in-window, correctly-signed vote counts");
  assert.deepEqual(reasons(result).sort(), [
    "malformed",
    "outside-window",
    "outside-window",
    "unknown-choice",
    "wrong-proposal",
  ]);
});

test("a work-weighted policy reads the ledger through a port — and refuses to run without one", () => {
  const prop = proposal({ policy: { kind: "work", creditUnit: "verify-credits" }, quorum: { kind: "weight", value: 10 } });
  const votes = [vote(prop, "alice", "yes"), vote(prop, "bob", "no")];
  const weights = (entry: GovernanceVote) => (entry.voter === "alice" ? 12 : entry.voter === "bob" ? 4 : undefined);

  const weighted = expectTally(tallyOf(prop, votes, { weights }));
  assert.deepEqual(weighted.outcome, { kind: "decided", choice: "yes" });
  assert.deepEqual(weighted.counts, [
    { choice: "yes", keys: 1, weight: 12 },
    { choice: "no", keys: 1, weight: 4 },
  ]);
  assert.deepEqual(weighted.quorum, { kind: "weight", required: 10, achieved: 16, met: true });

  const blind = tallyVotes({ proposal: prop, votes, sha256, verify });
  assert.ok("error" in blind);
  assert.equal((blind as { error: string }).error, UNKNOWN_WEIGHT);

  const partial = expectTally(tallyOf(prop, [vote(prop, "alice", "yes"), vote(prop, "zoe", "no")], { weights }));
  assert.deepEqual(reasons(partial), ["unknown-weight"]);
  assert.equal(partial.accepted, 1);
});

test("quorum is checked, and a tie is reported rather than broken", () => {
  const quiet = proposal({ quorum: { kind: "keys", value: 3 } });
  const result = expectTally(tallyOf(quiet, [vote(quiet, "alice", "yes"), vote(quiet, "bob", "no")]));
  assert.deepEqual(result.outcome, { kind: "no-quorum" });
  assert.deepEqual(result.quorum, { kind: "keys", required: 3, achieved: 2, met: false });

  const tiedProp = proposal();
  const tied = expectTally(tallyOf(tiedProp, [vote(tiedProp, "alice", "yes"), vote(tiedProp, "bob", "no")]));
  assert.deepEqual(tied.outcome, { kind: "tie", choices: ["yes", "no"] }, "no winner is invented from a tie");
});

test("the proposal's root pins it: an edit after voting breaks every vote bound to it", () => {
  const prop = proposal();
  const before = proposalRoot(prop, sha256);
  const edited = proposal({ question: "Admit operator B? (revised)" });
  assert.notEqual(proposalRoot(edited, sha256), before);

  const result = expectTally(tallyOf(edited, [vote(prop, "alice", "yes")]));
  assert.equal(result.accepted, 0);
  assert.deepEqual(reasons(result), ["wrong-proposal"]);
});

test("a proposal that cannot be decided is an error, not a quiet result", () => {
  assert.ok("error" in tallyVotes({ proposal: proposal({ choices: [] }), votes: [], sha256, verify }));
  assert.ok("error" in tallyVotes({ proposal: proposal({ choices: ["yes", "yes"] }), votes: [], sha256, verify }));
  assert.ok("error" in tallyVotes({ proposal: proposal({ closesAt: "" }), votes: [], sha256, verify }));
});

test("REGRESSION: refusals are deterministic too — a duplicate and an invalid ballot do not change the root when reordered", () => {
  // Reproduced before the fix: the duplicate rule ran BEFORE signature verification, and two
  // ballots from one voter sort by signature when their issue times match — so the same set of
  // votes could be reported as "invalid + duplicate" or "duplicate + invalid" depending on which
  // ballot sorted first, giving two different result roots for identical inputs. Order
  // independence of the COUNTS is not enough when the refusals ride along in the same root.
  const prop = proposal();
  const honest = vote(prop, "alice", "yes");
  const edited: GovernanceVote = { ...honest, choice: "no" };
  const duplicate = vote(prop, "alice", "no", "2026-11-04T00:00:00.000Z");
  const outsider = vote(prop, "bob", "yes");

  const permutations = [
    [honest, edited, duplicate, outsider],
    [edited, honest, outsider, duplicate],
    [duplicate, outsider, edited, honest],
    [outsider, duplicate, honest, edited],
  ].map((set) => expectTally(tallyOf(prop, set)));

  const roots = new Set(permutations.map((result) => tallyRoot(result, sha256)));
  assert.equal(roots.size, 1, `one set of votes must recompute to one root, got ${roots.size}`);

  // And the classification is the honest one: the edited ballot is invalid, the later ballot
  // from the same voter is the duplicate, and one vote from that voter is counted.
  assert.deepEqual(reasons(permutations[0]!), ["duplicate-voter", "invalid-signature"]);
  assert.equal(permutations[0]!.accepted, 2);
  assert.deepEqual(permutations[0]!.counts, [
    { choice: "yes", keys: 2, weight: 2 },
    { choice: "no", keys: 0, weight: 0 },
  ]);
});

test("REGRESSION: one key cannot vote every choice by relabelling itself", () => {
  // Reproduced before the fix: duplication was keyed on the voter FIELD, which a voter chooses, so
  // a single key could vote "yes" and "no" by labelling itself differently each time — and the
  // count showed two voters. "One key is one vote" has to be a property of the tally, not a
  // sentence in a document, and the identity that votes is the key the signature verified against.
  const prop = proposal({ quorum: { kind: "keys", value: 1 } });
  const key = vote(prop, "alice", "yes");
  // The attack is not a tampered signature (that is a different failure, and already held), it is
  // a SECOND, properly signed ballot from the same key wearing a different name. Signing the
  // relabelled statement is what makes the case real: the key is unchanged, so only the identity
  // rule can catch it.
  const relabelled: GovernanceVote = { ...key, voter: "definitely-not-alice", choice: "no" };
  relabelled.signature = sign(canonicalize(voteStatement(relabelled)));
  const result = expectTally(tallyOf(prop, [key, relabelled]));
  assert.equal(result.accepted, 1);
  assert.deepEqual(reasons(result), ["duplicate-voter"]);
  assert.deepEqual(result.counts, [
    { choice: "yes", keys: 1, weight: 1 },
    { choice: "no", keys: 0, weight: 0 },
  ]);
});
