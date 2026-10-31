import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  GOVERNANCE_BUDGET_KIND,
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  canonicalize,
  creditLedgerRoot,
  proposalRoot,
  voteStatement,
} from "../../../packages/core/src/index.ts";
import type { GovernanceProposal, GovernanceVote } from "../../../packages/core/src/index.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const byteHash = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

/** A registered identity for the pledger, so a pledge binds a real key. */
function registerIdentity(store: RarextStore, handle: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const keyId = sha256(canonicalize(jwk));
  store.addIdentity({
    handle,
    displayName: handle,
    keyId,
    publicKey: jwk,
    algorithm: "ecdsa-p256",
    createdAt: new Date().toISOString(),
    links: [],
    verified: true,
  } as never);
  return {
    keyId,
    signPayload(payload: Record<string, unknown>): string {
      return signBytes("sha256", Buffer.from(canonicalize(payload)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

function proposalFixture(closesAt: string): GovernanceProposal {
  return {
    kind: GOVERNANCE_PROPOSAL_KIND,
    id: `prop-${sha256(randomish()).slice(0, 12)}`,
    title: "Fund the mirror operators",
    question: "Should the treasury pledge credits to the mirror operators?",
    choices: ["yes", "no"],
    closesAt,
    quorum: { kind: "keys", value: 1 },
    policy: { kind: "key" },
  };
}

function randomish(): string {
  return `${Date.now()}-${Math.random()}`;
}

function pledge(from: string, targetRoot: string, payOn = "yes", amount = 500) {
  return {
    kind: GOVERNANCE_BUDGET_KIND,
    version: 1,
    from,
    to: "mirror-operator-key",
    amount,
    reason: "the operators kept every mirror current",
    payOn,
    createdAt: new Date().toISOString(),
    proposalRoot: targetRoot,
  };
}

/** A voter whose ballot is cast INSIDE the window of a proposal that has since closed. */
function voterInWindow(closesAt: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    jwk,
    issuedAt: new Date(Date.parse(closesAt) - 60_000).toISOString(),
    signStatement(statement: unknown): string {
      return signBytes("sha256", Buffer.from(canonicalize(statement)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

function castInWindow(prop: GovernanceProposal, root: string, who: ReturnType<typeof voterInWindow>, choice: string): GovernanceVote {
  const base = {
    kind: GOVERNANCE_VOTE_KIND,
    proposalRoot: root,
    choice,
    voter: `anon-${sha256(canonicalize(who.jwk)).slice(0, 8)}`,
    publicKey: who.jwk,
    issuedAt: who.issuedAt,
    suite: "ecdsa-p256",
  } as unknown as GovernanceVote;
  return { ...base, signature: who.signStatement(voteStatement(base)) };
}

test("a budget: pledged with a signature, persisted, refused twice, executed exactly once", async () => {
  const store = new RarextStore();
  const pledger = registerIdentity(store, "treasury");
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, base } = await start(store);

  try {
    const created = await post(base, "/v1/governance/proposals", document);
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const { root } = JSON.parse(createdBody) as { root: string };

    // No budget, nothing to execute.
    const nothing = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    assert.equal(nothing.status, 404);

    // The refusals that must not store anything come FIRST, while no budget exists yet: a second
    // pledge for a funded decision is refused before its payload is even read, which is the point.
    const stray = pledge(pledger.keyId, "b".repeat(64));
    const elsewhere = await post(base, `/v1/governance/proposals/${root}/budget`, {
      payload: stray,
      signature: pledger.signPayload(stray),
    });
    assert.equal(elsewhere.status, 400);
    assert.match(((await elsewhere.json()) as { error: string }).error, /not this one/);

    // A pledge signed by a key that is NOT the pledger's is refused: the money leaves THAT key or
    // it leaves nothing.
    const stranger = registerIdentity(new RarextStore(), "nobody");
    const forged = await post(base, `/v1/governance/proposals/${root}/budget`, {
      payload: pledge(pledger.keyId, root),
      signature: stranger.signPayload(pledge(pledger.keyId, root)),
    });
    assert.equal(forged.status, 401);
    assert.match(((await forged.json()) as { error: string }).error, /does not match the key that will be debited/);

    // And the ledger shows none of it: a refusal leaves nothing behind.
    assert.equal(store.listCredits().length, 0);

    // NOW the pledge, signed by the key that will be debited.
    const payload = pledge(pledger.keyId, root);
    const signed = { payload, signature: pledger.signPayload(payload) };
    const accepted = await post(base, `/v1/governance/proposals/${root}/budget`, signed);
    const acceptedBody = await accepted.text();
    assert.equal(accepted.status, 201, acceptedBody);
    const budgetBody = JSON.parse(acceptedBody) as { budget: { from: string; amount: number } };
    assert.equal(budgetBody.budget.from, pledger.keyId);

    // A second pledge is refused: a decision is funded once.
    assert.equal((await post(base, `/v1/governance/proposals/${root}/budget`, signed)).status, 409);

    // The window is closed and the decision is "yes": execute.
    const voted = await post(base, `/v1/governance/proposals/${root}/votes`, castInWindow(document, root, voterInWindow(closesAt), "yes"));
    const votedBody = await voted.text();
    assert.equal(voted.status, 201, votedBody);

    const executed = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    const executedBody = await executed.text();
    assert.equal(executed.status, 201, executedBody);
    const paid = JSON.parse(executedBody) as {
      records: Array<{ keyId: string; bounty: number; artifactHash: string; action: string }>;
      ledgerRoot: string;
    };
    assert.equal(paid.records.length, 2);
    assert.equal(paid.records[0]!.bounty, -500, "the pledger is debited: the protocol never mints");
    assert.equal(paid.records[1]!.bounty, 500);
    assert.equal(paid.records[0]!.artifactHash, root, "both sides reference the decision");
    assert.equal(paid.records[0]!.action, "governance", "a governance payment is not board work");
    assert.equal(paid.ledgerRoot, creditLedgerRoot(store.listCredits(), byteHash), "the published commitment is the recomputed one");

    // Executing again is refused: the same decision is never paid twice.
    const replay = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    assert.equal(replay.status, 409);
    assert.match(((await replay.json()) as { error: string }).error, /never paid twice/);
  } finally {
    await stop(server);
  }
});

test("execution refuses what is not a decision: an open window, a tie, a no, an unmet quorum", async () => {
  const store = new RarextStore();
  const pledger = registerIdentity(store, "treasury");
  const { server, base } = await start(store);

  try {
    // An OPEN window: the tally exists but it is not a decision yet.
    const open = proposalFixture(new Date(Date.now() + 60_000).toISOString());
    const openRoot = proposalRoot(open, sha256);
    const openCreated = await post(base, "/v1/governance/proposals", open);
    assert.equal(openCreated.status, 201);
    await post(base, `/v1/governance/proposals/${openRoot}/budget`, {
      payload: pledge(pledger.keyId, openRoot),
      signature: pledger.signPayload(pledge(pledger.keyId, openRoot)),
    });
    const tooEarly = await post(base, `/v1/governance/proposals/${openRoot}/execute`, {});
    assert.equal(tooEarly.status, 409);
    assert.match(((await tooEarly.json()) as { error: string }).error, /not a decision/);

    // A CLOSED window and a "no": the budget named "yes", so nothing is owed.
    const refused = proposalFixture(new Date(Date.now() - 5_000).toISOString());
    const refusedRoot = proposalRoot(refused, sha256);
    await post(base, "/v1/governance/proposals", refused);
    await post(base, `/v1/governance/proposals/${refusedRoot}/budget`, {
      payload: pledge(pledger.keyId, refusedRoot),
      signature: pledger.signPayload(pledge(pledger.keyId, refusedRoot)),
    });
    const voted = await post(
      base,
      `/v1/governance/proposals/${refusedRoot}/votes`,
      castInWindow(refused, refusedRoot, voterInWindow(refused.closesAt), "no"),
    );
    assert.equal(voted.status, 201);
    const decidedNo = await post(base, `/v1/governance/proposals/${refusedRoot}/execute`, {});
    assert.equal(decidedNo.status, 409);
    assert.match(((await decidedNo.json()) as { error: string }).error, /nothing is owed/);

    // And the ledger shows no payment for either: refusing to execute leaves nothing behind.
    assert.equal(store.listCredits().length, 0);
  } finally {
    await stop(server);
  }
});
