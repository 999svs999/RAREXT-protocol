import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  GOVERNANCE_BUDGET_KIND,
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  canonicalize,
  voteStatement,
} from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A registered operator, the way the participation rail registers its participant. */
function registerOperator(store: Awaited<ReturnType<typeof start>>["store"], handle: string) {
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
    sign(claim: Record<string, unknown>): string {
      const { signature: _ignored, ...rest } = claim as { signature?: string };
      return signBytes("sha256", Buffer.from(canonicalize(rest)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

function claimFor(operator: string, root: string) {
  return {
    kind: "rarext.anchor-work.v1",
    operator,
    root,
    at: new Date().toISOString(),
  };
}

const halfAdder = {
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

/** Publish a half-adder and anchor it — the work the operator's receipt names. */
async function anchorSomething(base: string): Promise<string> {
  const publish = await post(base, "/v1/publications", {
    author: "operator-alice",
    title: "the root the operator anchored",
    taskId: "half-adder",
    circuit: halfAdder,
  });
  assert.equal(publish.status, 201, await publish.text());
  const anchor = await post(base, "/v1/anchors", {});
  const anchorText = await anchor.text();
  assert.equal(anchor.status, 201, anchorText);
  return (JSON.parse(anchorText) as { root: string }).root;
}

test("an anchor receipt: the operator's work, corroborated, zero-bounty, in the same ledger", async () => {
  const { server, store, base } = await start();
  try {
    const root = await anchorSomething(base);
    const operator = registerOperator(store, "operator-node");

    // The claim: this operator ran the node that anchored this root. The node corroborates it.
    const claim = claimFor(operator.keyId, root);
    const claimed = await post(base, "/v1/work/anchor", { ...claim, signature: operator.sign(claim) });
    const claimedText = await claimed.text();
    assert.equal(claimed.status, 201, claimedText);
    const receipt = (JSON.parse(claimedText) as {
      receipt: {
        keyId: string;
        action: string;
        bounty: number;
        artifactHash: string;
        root: string;
        ledger: { root: string; index: number; proof: string[] };
      };
    }).receipt;

    assert.equal(receipt.action, "anchor", "the receipt names the anchoring act");
    assert.equal(receipt.bounty, 0, "ZERO is the design: the protocol never mints for anchoring");
    assert.equal(receipt.artifactHash, root, "the receipt is FOR the root that was anchored");
    assert.equal(receipt.keyId, operator.keyId);
    assert.match(receipt.root, /^[0-9a-f]{64}$/, "the receipt carries its own recomputable root");
    assert.match(receipt.ledger.root, /^[0-9a-f]{64}$/, "and an inclusion proof into the ledger");
    assert.ok(Number.isInteger(receipt.ledger.index));

    // The same work is never receipted twice — the ledger is a record, not a faucet.
    const again = await post(base, "/v1/work/anchor", { ...claim, signature: operator.sign(claim) });
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /already been receipted/);

    // The operator's earnings view shows the anchoring as its own action, distinct from
    // participation: the two sides of the roles are countable apart.
    const earnings = (await (await fetch(`${base}/v1/work/earnings?keyId=${operator.keyId}`)).json()) as {
      credits: number;
      byAction: Record<string, { credits: number; jobs: number }>;
    };
    assert.equal(earnings.credits, 0, "zero credits earned at record time — nothing minted");
    assert.equal(earnings.byAction.anchor?.jobs, 1, "one anchoring job on the operator's record");
  } finally {
    await stop(server);
  }
});

test("an anchor claim the node cannot corroborate is refused by name", async () => {
  const { server, store, base } = await start();
  try {
    const operator = registerOperator(store, "operator-node");

    // A root this node never anchored: the node will not vouch for work it did not do.
    const foreignClaim = claimFor(operator.keyId, "a".repeat(64));
    const foreign = await post(base, "/v1/work/anchor", { ...foreignClaim, signature: operator.sign(foreignClaim) });
    assert.equal(foreign.status, 404);
    assert.match(((await foreign.json()) as { error: string }).error, /never anchored/);

    // An unregistered key: a receipt binds a real identity.
    const stranger = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const strangerJwk = stranger.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const strangerId = sha256(canonicalize(strangerJwk));
    const root = await anchorSomething(base);
    const strangerClaim = claimFor(strangerId, root);
    const unregistered = await post(base, "/v1/work/anchor", { ...strangerClaim, signature: operator.sign(strangerClaim) });
    assert.equal(unregistered.status, 403);
    assert.match(((await unregistered.json()) as { error: string }).error, /not registered/);

    // A forged signature earns nothing.
    const forgedClaim = claimFor(operator.keyId, root);
    const forged = await post(base, "/v1/work/anchor", { ...forgedClaim, signature: "AAAA" });
    assert.equal(forged.status, 401);
    assert.match(((await forged.json()) as { error: string }).error, /signature does not match/);
  } finally {
    await stop(server);
  }
});

test("a 民主 decision pays the operators it names: receipt-holders with the anchor act", async () => {
  const { server, store, base } = await start();
  try {
    const root = await anchorSomething(base);
    const operator = registerOperator(store, "operator-node");
    const pledger = registerOperator(store, "treasury");

    // The operator's anchoring work leaves its receipt.
    const claim = claimFor(operator.keyId, root);
    const claimed = await post(base, "/v1/work/anchor", { ...claim, signature: operator.sign(claim) });
    assert.equal(claimed.status, 201, await claimed.text());

    // A proposal that would pay the holders of anchor receipts — the class, not the keys.
    const closesAt = new Date(Date.now() - 5_000).toISOString();
    const proposal = {
      kind: GOVERNANCE_PROPOSAL_KIND,
      id: `prop-${sha256(`${root}-anchor-pay`).slice(0, 12)}`,
      title: "Pay the operators who anchored",
      question: "Should the treasury pay every operator whose anchoring this node corroborated?",
      choices: ["yes", "no"],
      closesAt,
      quorum: { kind: "keys", value: 1 },
      policy: { kind: "key" },
    };
    const created = await post(base, "/v1/governance/proposals", proposal);
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const proposalId = (JSON.parse(createdText) as { root: string }).root;

    const budget = {
      kind: GOVERNANCE_BUDGET_KIND,
      version: 1,
      from: pledger.keyId,
      to: { kind: "receipt-holders", act: "anchor" },
      amount: 300,
      reason: "the operators anchored every root the federation serves",
      payOn: "yes",
      createdAt: new Date().toISOString(),
      proposalRoot: proposalId,
    };
    const pledged = await post(base, `/v1/governance/proposals/${proposalId}/budget`, {
      payload: budget,
      signature: pledger.sign(budget),
    });
    assert.equal(pledged.status, 201, await pledged.text());

    // The voter signs inside the window; the tally is "yes"; execute distributes to the CLASS.
    const { generateKeyPairSync: gkps, sign: sb } = await import("node:crypto");
    const { publicKey: vpk, privateKey: vpri } = gkps("ec", { namedCurve: "prime256v1" });
    const voterJwk = vpk.export({ format: "jwk" }) as JsonWebKey;
    const voteStatementValue = {
      kind: GOVERNANCE_VOTE_KIND,
      proposalRoot: proposalId,
      choice: "yes",
      voter: `anon-${sha256(canonicalize(voterJwk)).slice(0, 8)}`,
      publicKey: voterJwk,
      issuedAt: new Date(Date.parse(closesAt) - 60_000).toISOString(),
      suite: "ecdsa-p256",
    };
    const voted = await post(base, `/v1/governance/proposals/${proposalId}/votes`, {
      ...voteStatementValue,
      signature: sb("sha256", Buffer.from(canonicalize(voteStatement(voteStatementValue as never))), { key: vpri, dsaEncoding: "ieee-p1363" }).toString("base64"),
    });
    assert.equal(voted.status, 201, await voted.text());

    const executed = await post(base, `/v1/governance/proposals/${proposalId}/execute`, {});
    const executedText = await executed.text();
    assert.equal(executed.status, 201, executedText);
    const distribution = JSON.parse(executedText) as {
      holders: string[];
      records: Array<{ keyId: string; bounty: number; action: string }>;
    };

    // The class resolved to the operator — the decision named a CLASS and the node found its
    // members in its own ledger. That is the whole point: the pledge never listed a key.
    assert.deepEqual(distribution.holders, [operator.keyId], "the anchor receipt's holder is the class");
    const credited = distribution.records.find((record) => record.keyId === operator.keyId && record.bounty > 0);
    assert.ok(credited, `the operator was not paid: ${JSON.stringify(distribution.records)}`);
    assert.equal(credited?.action, "governance", "the payment is a governance payment, not board work");

    // And it is countable from the operator's side.
    const earnings = (await (await fetch(`${base}/v1/work/earnings?keyId=${operator.keyId}`)).json()) as {
      credits: number;
      byAction: Record<string, { credits: number; jobs: number }>;
    };
    assert.ok(earnings.credits > 0, "the operator's earnings moved when the decision paid");
  } finally {
    await stop(server);
  }
});
