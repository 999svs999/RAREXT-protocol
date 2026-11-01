import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import { GOVERNANCE_BUDGET_KIND, GOVERNANCE_PROPOSAL_KIND, GOVERNANCE_VOTE_KIND, canonicalize, voteStatement } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function registered(store: Awaited<ReturnType<typeof start>>["store"], handle: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const keyId = sha256(canonicalize(jwk));
  store.addIdentity({ handle, displayName: handle, keyId, publicKey: jwk, algorithm: "ecdsa-p256", createdAt: new Date().toISOString(), links: [], verified: true } as never);
  return {
    keyId,
    jwk,
    sign(payload: Record<string, unknown>): string {
      const { signature: _ignored, ...rest } = payload as { signature?: string };
      return signBytes("sha256", Buffer.from(canonicalize(rest)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    },
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

interface Statement {
  keyId: string;
  ledger: { root: string; count: number };
  credits: { earned: number; spent: number; net: number };
  holds: Array<{ act: string; receipts: number; roots: string[] }>;
  weight: number;
}

test("the earner's statement: what I hold, what I was paid, and what my standing amounts to", async () => {
  const { server, store, base } = await start();
  try {
    // A statement is about a key; without one there is nothing to state.
    const unnamed = await fetch(`${base}/v1/work/statement`);
    assert.equal(unnamed.status, 400);
    assert.match(((await unnamed.json()) as { error: string }).error, /needs the key/);

    // A key that has done nothing: an empty statement, not a missing one.
    const stranger = registered(store, "stranger");
    const empty = (await (await fetch(`${base}/v1/work/statement?keyId=${stranger.keyId}`)).json()) as Statement;
    assert.deepEqual(empty.holds, [], "no receipts, no classes");
    assert.deepEqual(empty.credits, { earned: 0, spent: 0, net: 0 });
    assert.equal(empty.weight, 0, "a ballot under a work policy would weigh nothing");
    assert.match(empty.ledger.root, /^[0-9a-f]{64}$/, "the statement carries the live commitment");

    // The operator anchors and claims: it HOLDS the anchor class, but nothing is earned yet.
    const publish = await post(base, "/v1/publications", { author: "op-alice", title: "the statement root", taskId: "half-adder", circuit: halfAdder });
    assert.equal(publish.status, 201, await publish.text());
    const anchor = await post(base, "/v1/anchors", {});
    const anchorText = await anchor.text();
    const root = (JSON.parse(anchorText) as { root: string }).root;

    const operator = registered(store, "statement-operator");
    const claim = { kind: "rarext.anchor-work.v1", operator: operator.keyId, root, at: new Date().toISOString() };
    assert.equal((await post(base, "/v1/work/anchor", { ...claim, signature: operator.sign(claim) })).status, 201);

    const holds = (await (await fetch(`${base}/v1/work/statement?keyId=${operator.keyId}`)).json()) as Statement;
    assert.deepEqual(holds.holds, [{ act: "anchor", receipts: 1, roots: [root] }], "the statement names the class and the root");
    assert.equal(holds.credits.earned, 0, "a receipt is not a payment: nothing minted");
    assert.equal(holds.weight, 0);

    // A decision pays the class; the statement moves, and separates earned from net.
    const closesAt = new Date(Date.now() - 5_000).toISOString();
    const proposal = {
      kind: GOVERNANCE_PROPOSAL_KIND,
      id: `prop-${sha256(root).slice(0, 12)}`,
      title: "Pay the anchoring operators",
      question: "Should the treasury pay the operators whose anchoring was corroborated?",
      choices: ["yes", "no"],
      closesAt,
      quorum: { kind: "keys", value: 1 },
      policy: { kind: "key" },
    };
    const created = await post(base, "/v1/governance/proposals", proposal);
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const proposalRoot = (JSON.parse(createdText) as { root: string }).root;

    const treasury = registered(store, "statement-treasury");
    const budget = {
      kind: GOVERNANCE_BUDGET_KIND,
      version: 1,
      from: treasury.keyId,
      to: { kind: "receipt-holders", act: "anchor" },
      amount: 300,
      reason: "the operators anchored the roots the federation serves",
      payOn: "yes",
      createdAt: new Date().toISOString(),
      proposalRoot,
    };
    assert.equal((await post(base, `/v1/governance/proposals/${proposalRoot}/budget`, { payload: budget, signature: treasury.sign(budget) })).status, 201);

    const voter = registered(store, "statement-voter");
    const vote = {
      kind: GOVERNANCE_VOTE_KIND,
      proposalRoot,
      choice: "yes",
      voter: `anon-${sha256(canonicalize(voter.jwk)).slice(0, 8)}`,
      publicKey: voter.jwk,
      issuedAt: new Date(Date.parse(closesAt) - 60_000).toISOString(),
      suite: "ecdsa-p256",
    } as unknown as Parameters<typeof voteStatement>[0];
    assert.equal((await post(base, `/v1/governance/proposals/${proposalRoot}/votes`, { ...vote, signature: voter.sign(voteStatement(vote) as unknown as Record<string, unknown>) })).status, 201);
    assert.equal((await post(base, `/v1/governance/proposals/${proposalRoot}/execute`, {})).status, 201);

    const paid = (await (await fetch(`${base}/v1/work/statement?keyId=${operator.keyId}`)).json()) as Statement;
    assert.equal(paid.credits.earned, 300, "the decision paid the class the statement named");
    assert.equal(paid.credits.spent, 0, "the operator pledged nothing");
    assert.equal(paid.credits.net, 300);
    assert.equal(paid.weight, 300, "and that is exactly what a work-weighted ballot would weigh");

    // The PLEDGER's statement shows the debit separately: a single total would hide it.
    const pledged = (await (await fetch(`${base}/v1/work/statement?keyId=${treasury.keyId}`)).json()) as Statement;
    assert.equal(pledged.credits.spent, 300, "the money it paid is visible as spent");
    assert.equal(pledged.credits.earned, 0);
    assert.equal(pledged.credits.net, -300, "net is negative: it funded a decision");
  } finally {
    await stop(server);
  }
});
