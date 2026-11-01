import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSigner,
  generateAgentKeypair,
  RarextClient,
} from "../src/index.ts";
import type { Circuit } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "../../../apps/api/test/helpers.ts";

const halfAdderCircuit: Circuit = {
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

test("an AI agent runs the whole lifecycle through typed client methods", { timeout: 60_000 }, async () => {
  process.env.RAREXT_REGISTRY_ID = "rarext";
  const { server, store, base } = await start();
  const client = new RarextClient({ baseUrl: base });
  const agent = new AgentSigner(generateAgentKeypair().privateKey);
  try {
    // 1. Join as an identity.
    const identity = await client.registerAgent(agent, "ai-operator");
    assert.equal(identity.handle, "ai-operator");

    // 2. Publish and anchor, so the node has a root to state.
    await client.publishAs(agent, {
      author: "ai-operator",
      title: "the agent's first record",
      taskId: "half-adder",
      circuit: halfAdderCircuit,
    });
    const anchor = await client.anchor();
    assert.equal(anchor.root.length, 64);

    // 3. The journey: the agent asks whether this node is a full node.
    const journey = await client.journey({ root: anchor.root, registry: "rarext", allowPrivate: true });
    assert.equal(journey.ok, true, `the journey refused its own node: ${JSON.stringify(journey.rails)}`);
    assert.deepEqual(
      journey.rails.map((rail) => rail.rail),
      ["binding", "registry", "ledger", "governance", "federation"],
    );

    // 4. Participation: the agent verified a mirror against the anchored root, and the
    //    node corroborates it into a zero-bounty receipt.
    const participation = await client.participate(agent, "mirror-verify", anchor.root);
    assert.equal(participation.receipt.action, "participate");
    assert.equal(participation.receipt.bounty, 0);
    assert.ok(Array.isArray(participation.receipt.ledger?.proof), "the receipt carries its inclusion proof");

    const earnings = await client.earnings(agent.keyId);
    assert.equal(earnings.records.length, 1);
    assert.equal(earnings.records[0]?.action, "participate");

    // 5. The 民主 rail: propose, pledge to the receipt-holders, vote, execute.
    const closesAt = new Date(Date.now() - 5_000).toISOString();
    const proposal = await client.propose({
      kind: "rarext.governance-proposal.v1",
      id: `prop-${Date.now()}`,
      title: "Pay the participants",
      question: "Should the receipt-holders be paid from this pledge?",
      choices: ["yes", "no"],
      closesAt,
      quorum: { kind: "keys", value: 1 },
      policy: { kind: "key" },
    });
    assert.ok(proposal.root.length === 64);

    const pledge = await client.pledgeBudget(agent, {
      proposalRoot: proposal.root,
      to: { kind: "receipt-holders", act: "mirror-verify" },
      amount: 10,
      reason: "the agent pays its own participants",
      payOn: "yes",
    });
    assert.equal((pledge.budget as unknown as { from: string }).from, agent.keyId);

    await client.vote(agent, proposal.root, "yes", closesAt);

    const executed = await client.execute(proposal.root);
    assert.equal(executed.executed, true);
    assert.deepEqual(executed.holders, [agent.keyId], "the agent's own receipt makes it a holder");
    const paid = (executed.records ?? []).find((record) => record.keyId === agent.keyId && (record.bounty as number) > 0);
    assert.ok(paid, "the distribution credited the receipt-holder");

    // 6. The federation rail reflects what the node's decisions admitted (none here, but the
    //    rail answers and parses — the same verdict the journey's fifth rail gave).
    const registries = await client.registries();
    assert.ok(Array.isArray(registries.registries));

    // 7. The receipts ledger moved: the agent was both the pledger and the sole holder, so its
    //    earnings view carries the participation receipt AND the distribution's debit and credit.
    const after = await client.earnings(agent.keyId);
    assert.equal(after.records.length, 3, "participation + the distribution's debit and credit");
    const bountySum = after.records.reduce((sum, record) => sum + record.bounty, 0);
    assert.equal(bountySum, 0, "zero-sum, even when the pledger and the holder are the same key");
  } finally {
    delete process.env.RAREXT_REGISTRY_ID;
    await stop(server);
    void store;
  }
});

test("the journey through the client refuses an empty node, naming the rails", { timeout: 60_000 }, async () => {
  const { server, base } = await start();
  const client = new RarextClient({ baseUrl: base });
  try {
    const journey = await client.journey({ root: "1".repeat(64), registry: "rarext", allowPrivate: true });
    assert.equal(journey.ok, false, "a node with no anchor is not a full node");
    const failed = journey.rails.filter((rail) => !rail.ok).map((rail) => rail.rail);
    assert.ok(failed.includes("binding") && failed.includes("registry"), "the identity rails are the ones that cannot hold");
  } finally {
    await stop(server);
  }
});

test("the client's participation builds a signed assertion the node accepts from a stranger key too", { timeout: 60_000 }, async () => {
  const { server, base } = await start();
  const client = new RarextClient({ baseUrl: base });
  try {
    // The publishing agent and the verifying agent are DIFFERENT keys: participation is
    // open to any registered participant, not only the operator.
    const operator = new AgentSigner(generateAgentKeypair().privateKey);
    await client.registerAgent(operator, "operator");
    await client.publishAs(operator, {
      author: "operator",
      title: "a record worth verifying",
      taskId: "half-adder",
      circuit: halfAdderCircuit,
    });
    const anchor = await client.anchor();

    const reader = new AgentSigner(generateAgentKeypair().privateKey);
    await client.registerAgent(reader, "reader");
    const receipt = await client.participate(reader, "mirror-verify", anchor.root);
    assert.equal(receipt.receipt.keyId, reader.keyId, "the receipt belongs to the participant, not the operator");
    assert.equal(receipt.receipt.bounty, 0);

    // The uncorroborated path through the client: a root the node never anchored is refused,
    // and the typed surface surfaces the refusal as a rejection carrying the node's words.
    await assert.rejects(
      client.participate(operator, "mirror-verify", "1".repeat(64)),
      /never anchored/,
      "the node cannot corroborate a verification of a root it does not hold",
    );
  } finally {
    await stop(server);
  }
});
