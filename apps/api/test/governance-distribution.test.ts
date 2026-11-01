import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import { budgetDistributionRecords, canonicalize, voteStatement } from "../../../packages/core/src/index.ts";
import type { GovernanceBudget, GovernanceProposal } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const randomish = () => `${Date.now()}-${Math.random()}`;
const halfAdderCircuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "n1"] },
    { id: "n3", type: "NAND", inputs: ["b", "n1"] },
    { id: "xor", type: "NAND", inputs: ["n2", "n3"] },
    { id: "n5", type: "NAND", inputs: ["n1", "n1"] },
    { id: "sum", type: "OUTPUT", inputs: ["xor"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

function registerIdentity(store: Awaited<ReturnType<typeof start>>["store"], handle: string) {
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

function voter() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    jwk,
    signStatement(statement: unknown): string {
      return signBytes("sha256", Buffer.from(canonicalize(statement)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

function castVote(root: string, who: ReturnType<typeof voter>, choice: string, closesAt: string) {
  const base = {
    kind: "rarext.governance-vote.v1",
    proposalRoot: root,
    choice,
    voter: `anon-${sha256(canonicalize(who.jwk)).slice(0, 8)}`,
    publicKey: who.jwk,
    issuedAt: new Date(Date.parse(closesAt) - 60_000).toISOString(),
    suite: "ecdsa-p256",
  };
  return { ...base, signature: who.signStatement(voteStatement(base as never)) } as never;
}

async function anchorOne(base: Awaited<ReturnType<typeof start>>["base"]) {
  const publish = await post(base, "/v1/publications", {
    author: "operator-alice",
    title: `record ${randomish()}`,
    taskId: "half-adder",
    circuit: halfAdderCircuit,
  });
  const publishText = await publish.text();
  assert.equal(publish.status, 201, publishText);
  const anchor = await post(base, "/v1/anchors", {});
  const anchorText = await anchor.text();
  assert.equal(anchor.status, 201, anchorText);
  return (JSON.parse(anchorText) as { root: string }).root;
}

async function participate(base: Awaited<ReturnType<typeof start>>["base"], store: Awaited<ReturnType<typeof start>>["store"], handle: string, root: string) {
  const participant = registerIdentity(store, handle);
  const assertion = { kind: "rarext.participation.v1", participant: participant.keyId, act: "mirror-verify", root, at: new Date().toISOString() };
  const receipt = await post(base, "/v1/work/participation", { ...assertion, signature: participant.signPayload(assertion) });
  const receiptText = await receipt.text();
  assert.equal(receipt.status, 201, receiptText);
  return participant.keyId;
}

function distributionBudget(from: string, closesAt: string, amount: number, proposalRoot: string): Record<string, unknown> {
  // The wire payload names the proposal by ROOT; the route re-attaches the stored proposal, so the
  // signature covers the exact question the node holds.
  return {
    kind: "rarext.governance-budget.v1",
    version: 1,
    from,
    to: { kind: "receipt-holders", act: "mirror-verify" },
    amount,
    reason: "the readers kept the federation honest",
    payOn: "yes",
    createdAt: new Date(Date.parse(closesAt) - 30_000).toISOString(),
    proposalRoot,
  };
}

function proposalFixture(closesAt: string): GovernanceProposal {
  return {
    kind: "rarext.governance-proposal.v1",
    id: `prop-${sha256(randomish()).slice(0, 12)}`,
    title: "Pay the participants",
    question: "Should the readers who verified mirrors be paid from this pledge?",
    choices: ["yes", "no"],
    closesAt,
    quorum: { kind: "keys", value: 1 },
    policy: { kind: "key" },
  };
}

test("a distribution budget pays receipt-holders evenly, zero-sum, once", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, store, base } = await start();
  try {
    // Two participants hold mirror-verify receipts.
    const root = await anchorOne(base);
    const holderA = await participate(base, store, "reader-a", root);
    const holderB = await participate(base, store, "reader-b", root);

    const pledger = registerIdentity(store, "treasury");
    const created = await post(base, "/v1/governance/proposals", document);
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const proposalRoot = (JSON.parse(createdBody) as { root: string }).root;
    const payload = distributionBudget(pledger.keyId, closesAt, 100, proposalRoot);
    const accepted = await post(base, `/v1/governance/proposals/${proposalRoot}/budget`, { payload: { ...payload }, signature: pledger.signPayload({ ...payload }) });
    const acceptedBody = await accepted.text();
    assert.equal(accepted.status, 201, `ATTACH FAILED: ${acceptedBody}`);

    assert.equal(
      (await post(base, `/v1/governance/proposals/${proposalRoot}/votes`, castVote(proposalRoot, voter(), "yes", closesAt))).status,
      201,
    );

    const executed = await post(base, `/v1/governance/proposals/${proposalRoot}/execute`, {});
    const executedBody = await executed.text();
    assert.equal(executed.status, 201, executedBody);
    const applied = JSON.parse(executedBody) as {
      records: Array<{ keyId: string; bounty: number; action: string; artifactHash: string }>;
      holders: string[];
    };
    // The pledger's single debit + two holder credits, zero-sum.
    const debit = applied.records.filter((record) => record.bounty < 0);
    const credits = applied.records.filter((record) => record.bounty > 0);
    assert.equal(debit.length, 1);
    assert.equal(debit[0]?.bounty, -100);
    assert.equal(credits.length, 2);
    const total = credits.reduce((sum, record) => sum + record.bounty, 0);
    assert.equal(total, 100, "the ledger never mints: credits sum to the debit");
    assert.deepEqual(
      [...credits].sort((a, b) => a.bounty - b.bounty).map((record) => record.bounty),
      [50, 50],
      "an even split when the amount divides",
    );
    assert.equal(applied.holders.length, 2);
    assert.ok(applied.holders.includes(holderA) && applied.holders.includes(holderB));
    assert.ok(credits.every((record) => record.artifactHash === proposalRoot), "every record carries the decision's root");

    // Replay: the same decision is never paid twice.
    const replay = await post(base, `/v1/governance/proposals/${proposalRoot}/execute`, {});
    assert.equal(replay.status, 409);
  } finally {
    await stop(server);
  }
});

test("a remainder goes to the first holder in sorted order, deterministically", () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const proposal = proposalFixture(closesAt);
  const budget = {
    ...distributionBudget("treasury-key", closesAt, 100, "f".repeat(64)),
    proposal,
  } as unknown as GovernanceBudget;
  const records = budgetDistributionRecords(budget, ["holder-b", "holder-a", "holder-c"], "2026-11-01T00:00:00.000Z", sha256);
  const credits = records.filter((record) => record.bounty > 0).sort((a, b) => a.keyId.localeCompare(b.keyId));
  assert.deepEqual(
    credits.map((record) => [record.keyId, record.bounty]),
    [
      ["holder-a", 34],
      ["holder-b", 33],
      ["holder-c", 33],
    ],
    "floor(100/3)=33, and the remainder goes to the first holder in sorted order",
  );
  const debit = records.find((record) => record.bounty < 0);
  assert.equal(debit?.bounty, -100, "zero-sum: the debit equals the sum of the credits");
});

test("a distribution with no holders pays nothing, and says why", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, store, base } = await start();
  try {
    const pledger = registerIdentity(store, "treasury");
    const created = await post(base, "/v1/governance/proposals", document);
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const proposalRoot = (JSON.parse(createdBody) as { root: string }).root;
    const payload = distributionBudget(pledger.keyId, closesAt, 100, proposalRoot);
    assert.equal((await post(base, `/v1/governance/proposals/${proposalRoot}/budget`, { payload: { ...payload }, signature: pledger.signPayload({ ...payload }) })).status, 201);

    assert.equal(
      (await post(base, `/v1/governance/proposals/${proposalRoot}/votes`, castVote(proposalRoot, voter(), "yes", closesAt))).status,
      201,
    );

    const executed = await post(base, `/v1/governance/proposals/${proposalRoot}/execute`, {});
    assert.equal(executed.status, 409);
    assert.match(
      ((await executed.json()) as { error: string }).error,
      /none exist in this ledger: nothing to distribute/,
      "a decision that pays an empty class pays nothing, and says why",
    );
    assert.equal(store.listCredits().length, 0, "nothing was credited");
  } finally {
    await stop(server);
  }
});

test("a receipt spec naming a root pays only that root's holders", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, store, base } = await start();
  try {
    const rootOne = await anchorOne(base);
    const rootTwo = await anchorOne(base);
    await participate(base, store, "reader-one", rootOne);
    const otherHolder = await participate(base, store, "reader-two", rootTwo);

    const pledger = registerIdentity(store, "treasury");
    const created = await post(base, "/v1/governance/proposals", document);
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const proposalRoot = (JSON.parse(createdBody) as { root: string }).root;
    const payload = {
      ...distributionBudget(pledger.keyId, closesAt, 10, proposalRoot),
      to: { kind: "receipt-holders", act: "mirror-verify", root: rootOne },
    };
    assert.equal((await post(base, `/v1/governance/proposals/${proposalRoot}/budget`, { payload: { ...payload }, signature: pledger.signPayload({ ...payload }) })).status, 201);

    assert.equal(
      (await post(base, `/v1/governance/proposals/${proposalRoot}/votes`, castVote(proposalRoot, voter(), "yes", closesAt))).status,
      201,
    );

    const executed = await post(base, `/v1/governance/proposals/${proposalRoot}/execute`, {});
    const executedBody = await executed.text();
    assert.equal(executed.status, 201, executedBody);
    const applied = JSON.parse(executedBody) as { holders: string[] };
    assert.deepEqual(applied.holders.length, 1, "only the named root's holders are paid");
    assert.ok(applied.holders.includes(otherHolder) === false, "the other root's holder is not paid");
  } finally {
    await stop(server);
  }
});
